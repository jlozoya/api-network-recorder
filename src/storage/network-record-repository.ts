import type { NetworkRecord } from "../core/network-types.js"
import { getDb } from "./db.js"

export const saveNetworkRecord = async (record: NetworkRecord): Promise<void> => {
  const db = await getDb()
  await db.put("networkRecords", record)
}

export const listNetworkRecords = async (options?: {
  limit?: number
  search?: string
}): Promise<NetworkRecord[]> => {
  const limit = options?.limit ?? 250
  const search = options?.search?.trim().toLowerCase()

  const db = await getDb()
  const records = await db.getAllFromIndex("networkRecords", "by-startedAt")

  return records
    .reverse()
    .filter((record) => {
      if (!search) return true

      return [
        record.method,
        record.url,
        String(record.status ?? ""),
        record.statusText ?? "",
        record.mimeType ?? "",
        record.error ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(search)
    })
    .slice(0, limit)
}

export const clearNetworkRecords = async (): Promise<void> => {
  const db = await getDb()
  await db.clear("networkRecords")
}