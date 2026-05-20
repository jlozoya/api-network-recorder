import { openDB, type DBSchema, type IDBPDatabase } from "idb"

import type { NetworkRecord } from "../core/network-types.js"

const DATABASE_NAME = "api-network-recorder-v2"
const DATABASE_VERSION = 1

interface ApiRecorderDb extends DBSchema {
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
    upgrade(db) {
      if (db.objectStoreNames.contains("networkRecords")) {
        return
      }

      const store = db.createObjectStore("networkRecords", {
        keyPath: "id",
      })

      store.createIndex("by-startedAt", "startedAt")
      store.createIndex("by-url", "url")
      store.createIndex("by-method", "method")
      store.createIndex("by-status", "status")
      store.createIndex("by-tabId", "tabId")
    },
    blocked() {
      console.warn(
        "[API Network Recorder] IndexedDB open is blocked. Close old inspector tabs and reload the extension.",
      )
    },
    blocking() {
      console.warn(
        "[API Network Recorder] This IndexedDB connection is blocking another tab. Close old inspector tabs.",
      )
    },
    terminated() {
      console.warn("[API Network Recorder] IndexedDB connection was terminated.")
    },
  }).then((db) => {
    dbInstance = db
    return db
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
