import { openDB, type DBSchema } from "idb"

import type { NetworkRecord } from "../core/network-types.js"

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

export const getDb = () => {
  return openDB<ApiRecorderDb>("api-network-recorder", 1, {
    upgrade(db) {
      const store = db.createObjectStore("networkRecords", {
        keyPath: "id",
      })

      store.createIndex("by-startedAt", "startedAt")
      store.createIndex("by-url", "url")
      store.createIndex("by-method", "method")
      store.createIndex("by-status", "status")
      store.createIndex("by-tabId", "tabId")
    },
  })
}