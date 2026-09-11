import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import {
  toRecordPreview,
  type NetworkRecordPreview,
  type SavedSession,
} from "../core/record-preview.js"

import type { NetworkRecord } from "../core/network-types.js"

const DATABASE_NAME = "api-network-recorder-v2"
const DATABASE_VERSION = 2

interface ApiRecorderDb extends DBSchema {
  recordPreviews: { key: string; value: NetworkRecordPreview; indexes: { "by-startedAt": string } }
  sessions: { key: string; value: SavedSession }
  sessionRecords: {
    key: [string, string]
    value: { sessionId: string; id: string; record: NetworkRecord }
    indexes: { "by-session": string }
  }
  sessionPreviews: {
    key: [string, string]
    value: NetworkRecordPreview & { sessionId: string }
    indexes: { "by-session": string }
  }

  networkRecords: {
    key: string
    value: NetworkRecord
    indexes: {
      "by-startedAt": string
      "by-url": string
      "by-method": string
      "by-status": number
      "by-tabId": number
    }
  }
}

let dbPromise: Promise<IDBPDatabase<ApiRecorderDb>> | null = null
let dbInstance: IDBPDatabase<ApiRecorderDb> | null = null

export const getDb = () => {
  dbPromise ??= openDB<ApiRecorderDb>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains("networkRecords")) {
        const store = db.createObjectStore("networkRecords", { keyPath: "id" })
        store.createIndex("by-startedAt", "startedAt")
        store.createIndex("by-url", "url")
        store.createIndex("by-method", "method")
        store.createIndex("by-status", "status")
        store.createIndex("by-tabId", "tabId")
      }
      if (!db.objectStoreNames.contains("recordPreviews")) {
        db.createObjectStore("recordPreviews", { keyPath: "id" }).createIndex(
          "by-startedAt",
          "startedAt",
        )
        // Backfill in the version-change transaction: old records and bodies remain intact.
        void (async () => {
          let cursor = await transaction.objectStore("networkRecords").openCursor()
          while (cursor) {
            await transaction.objectStore("recordPreviews").put(toRecordPreview(cursor.value))
            cursor = await cursor.continue()
          }
        })().catch(() => transaction.abort())
      }
      if (!db.objectStoreNames.contains("sessions"))
        db.createObjectStore("sessions", { keyPath: "id" })
      for (const name of ["sessionRecords", "sessionPreviews"] as const) {
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath: ["sessionId", "id"] }).createIndex(
            "by-session",
            "sessionId",
          )
      }
    },
    blocked() {
      console.warn(
        "[API Network Recorder] IndexedDB open is blocked. Close old inspector tabs and reload the extension.",
      )
    },
    blocking() {
      dbInstance?.close()
      dbInstance = null
      dbPromise = null
      console.warn(
        "[API Network Recorder] This IndexedDB connection is blocking another tab. Close old inspector tabs.",
      )
    },
    terminated() {
      console.warn("[API Network Recorder] IndexedDB connection was terminated.")
    },
  })
    .then((db) => {
      dbInstance = db
      return db
    })
    .catch((error: unknown) => {
      dbPromise = null
      throw error
    })

  return dbPromise
}

export const resetDb = async (): Promise<void> => {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }

  dbPromise = null

  const deleteRequest = indexedDB.deleteDatabase(DATABASE_NAME)

  await new Promise<void>((resolve, reject) => {
    deleteRequest.onsuccess = () => resolve()
    deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error("Unable to delete DB"))
    deleteRequest.onblocked = () => {
      reject(new Error("Database reset is blocked. Close old inspector tabs and retry."))
    }
  })
}
