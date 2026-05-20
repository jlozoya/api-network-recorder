import type { ListNetworkRecordsPayload } from "../core/message-types.js"
import { isProbablyApiRecord } from "../core/endpoint-utils.js"
import type { NetworkRecord } from "../core/network-types.js"
import { getCaptureSettings } from "./capture-settings.js"
import { getDb } from "./db.js"

const TRIM_EVERY_WRITES = 25

let writesSinceLastTrim = 0
let trimPromise: Promise<void> | null = null

interface NetworkRecordFilters {
  apiOnly: boolean
  method: string | undefined
  source: NetworkRecord["source"] | "all"
  host: string | undefined
  statusGroup: ListNetworkRecordsPayload["statusGroup"]
  search: string | undefined
}

const trimNetworkRecords = async (): Promise<void> => {
  const settings = await getCaptureSettings()
  const db = await getDb()
  const count = await db.count("networkRecords")
  const excess = count - settings.captureLimit

  if (excess <= 0) {
    return
  }

  const transaction = db.transaction("networkRecords", "readwrite")
  const index = transaction.store.index("by-startedAt")
  let cursor = await index.openCursor()
  let deleted = 0

  while (cursor && deleted < excess) {
    await cursor.delete()
    deleted += 1
    cursor = await cursor.continue()
  }

  await transaction.done
}

const maybeTrimNetworkRecords = async (): Promise<void> => {
  writesSinceLastTrim += 1

  if (writesSinceLastTrim < TRIM_EVERY_WRITES && trimPromise) {
    return
  }

  if (writesSinceLastTrim < TRIM_EVERY_WRITES) {
    return
  }

  writesSinceLastTrim = 0
  trimPromise ??= trimNetworkRecords().finally(() => {
    trimPromise = null
  })

  await trimPromise
}

export const saveNetworkRecord = async (record: NetworkRecord): Promise<void> => {
  const settings = await getCaptureSettings()

  if (settings.capturePaused) {
    return
  }

  if (settings.captureActiveSince && record.startedAt < settings.captureActiveSince) {
    return
  }

  const db = await getDb()
  await db.put("networkRecords", record)
  await maybeTrimNetworkRecords()
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

const recordMatchesFilters = (
  record: NetworkRecord,
  filters: NetworkRecordFilters,
): boolean => {
  if (filters.apiOnly && !isProbablyApiRecord(record)) {
    return false
  }

  if (filters.method && filters.method !== "ALL" && record.method.toUpperCase() !== filters.method) {
    return false
  }

  if (filters.source !== "all" && record.source !== filters.source) {
    return false
  }

  if (filters.host && !getRecordHost(record).includes(filters.host)) {
    return false
  }

  if (!recordMatchesStatusGroup(record, filters.statusGroup)) {
    return false
  }

  if (filters.search && !getSearchText(record).includes(filters.search)) {
    return false
  }

  return true
}

const getRecordsNewestFirst = async (
  limit: number,
  filters: NetworkRecordFilters,
): Promise<NetworkRecord[]> => {
  const db = await getDb()
  const records: NetworkRecord[] = []

  try {
    let cursor = await db
      .transaction("networkRecords")
      .store.index("by-startedAt")
      .openCursor(null, "prev")

    while (cursor && records.length < limit) {
      if (recordMatchesFilters(cursor.value, filters)) {
        records.push(cursor.value)
      }

      cursor = await cursor.continue()
    }

    return records
  } catch {
    const fallbackRecords = await db.getAll("networkRecords")

    return fallbackRecords
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .filter((record) => recordMatchesFilters(record, filters))
      .slice(0, limit)
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

  return getRecordsNewestFirst(limit, {
    apiOnly,
    method,
    source,
    host,
    statusGroup,
    search,
  })
}

export const clearNetworkRecords = async (): Promise<void> => {
  const db = await getDb()
  await db.clear("networkRecords")
}
