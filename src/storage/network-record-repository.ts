import type { ListNetworkRecordsPayload } from "../core/message-types.js"
import { isProbablyApiRecord } from "../core/endpoint-utils.js"
import type { NetworkRecord } from "../core/network-types.js"
import { getCaptureSettings } from "./capture-settings.js"
import { getDb } from "./db.js"

const trimNetworkRecords = async (): Promise<void> => {
  const settings = await getCaptureSettings()
  const db = await getDb()

  const records = await db.getAllFromIndex("networkRecords", "by-startedAt")
  const excess = records.length - settings.captureLimit

  if (excess <= 0) {
    return
  }

  const recordsToDelete = records.slice(0, excess)

  await Promise.all(recordsToDelete.map((record) => db.delete("networkRecords", record.id)))
}

export const saveNetworkRecord = async (record: NetworkRecord): Promise<void> => {
  const db = await getDb()
  await db.put("networkRecords", record)
  await trimNetworkRecords()
}

const recordMatchesStatusGroup = (
  record: NetworkRecord,
  statusGroup: ListNetworkRecordsPayload["statusGroup"],
): boolean => {
  if (!statusGroup || statusGroup === "all") {
    return true
  }

  if (statusGroup === "error") {
    return Boolean(record.error) || record.status === null
  }

  if (typeof record.status !== "number") {
    return false
  }

  if (statusGroup === "success") {
    return record.status >= 200 && record.status < 300
  }

  if (statusGroup === "redirect") {
    return record.status >= 300 && record.status < 400
  }

  if (statusGroup === "client-error") {
    return record.status >= 400 && record.status < 500
  }

  if (statusGroup === "server-error") {
    return record.status >= 500
  }

  return true
}

const getSearchText = (record: NetworkRecord): string => {
  return [
    record.method,
    record.url,
    record.origin ?? "",
    record.pageUrl ?? "",
    String(record.status ?? ""),
    record.statusText ?? "",
    record.mimeType ?? "",
    record.resourceType ?? "",
    record.error ?? "",
    record.requestBody ? JSON.stringify(record.requestBody) : "",
    record.responseBody ? JSON.stringify(record.responseBody) : "",
  ]
    .join(" ")
    .toLowerCase()
}

const getRecordHost = (record: NetworkRecord): string => {
  try {
    return new URL(record.url).host
  } catch {
    return ""
  }
}

const getRecordsNewestFirst = async (): Promise<NetworkRecord[]> => {
  const db = await getDb()

  try {
    const records = await db.getAllFromIndex("networkRecords", "by-startedAt")
    return records.reverse()
  } catch {
    const records = await db.getAll("networkRecords")
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
}

export const listNetworkRecords = async (
  options?: ListNetworkRecordsPayload,
): Promise<NetworkRecord[]> => {
  const settings = await getCaptureSettings()
  const limit = Math.min(options?.limit ?? settings.captureLimit, settings.captureLimit)
  const search = options?.search?.trim().toLowerCase()
  const method = options?.method?.trim().toUpperCase()
  const source = options?.source ?? "all"
  const host = options?.host?.trim().toLowerCase()
  const statusGroup = options?.statusGroup ?? "all"
  const apiOnly = options?.apiOnly ?? false

  const records = await getRecordsNewestFirst()

  return records
    .filter((record) => {
      if (apiOnly && !isProbablyApiRecord(record)) {
        return false
      }

      if (method && method !== "ALL" && record.method.toUpperCase() !== method) {
        return false
      }

      if (source !== "all" && record.source !== source) {
        return false
      }

      if (host && !getRecordHost(record).includes(host)) {
        return false
      }

      if (!recordMatchesStatusGroup(record, statusGroup)) {
        return false
      }

      if (search && !getSearchText(record).includes(search)) {
        return false
      }

      return true
    })
    .slice(0, limit)
}

export const clearNetworkRecords = async (): Promise<void> => {
  const db = await getDb()
  await db.clear("networkRecords")
}