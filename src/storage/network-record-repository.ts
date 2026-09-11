import {
  toRecordPreview,
  type NetworkRecordPreview,
  type SavedSession,
} from "../core/record-preview.js"
import { createNetworkRecordSummary, type NetworkRecordSummary } from "../core/network-summary.js"
import type { ListNetworkRecordsPayload } from "../core/message-types.js"
import { isProbablyApiRecord } from "../core/endpoint-utils.js"
import type { NetworkRecord } from "../core/network-types.js"
import { getCaptureSettings, isUrlIgnoredByDomains } from "./capture-settings.js"
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

export const trimNetworkRecords = async (): Promise<void> => {
  const settings = await getCaptureSettings()
  const db = await getDb()
  const transaction = db.transaction(["networkRecords", "recordPreviews"], "readwrite")
  // Walk newest first; pinned records do not consume the rolling capture allowance.
  let cursor = await transaction
    .objectStore("recordPreviews")
    .index("by-startedAt")
    .openCursor(null, "prev")
  let retainedApi = 0
  let retainedOther = 0
  while (cursor) {
    if (!cursor.value.pinned) {
      // API-like records get their own allowance. Page assets (scripts, images,
      // fonts) burn through a shared budget in seconds, which would delete the
      // requests the inspector is showing while they are still on screen.
      const retained = isProbablyApiRecord(cursor.value) ? ++retainedApi : ++retainedOther

      if (retained > settings.captureLimit) {
        await transaction.objectStore("networkRecords").delete(cursor.value.id)
        await cursor.delete()
      }
    }
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

  if (typeof record.tabId === "number" && settings.ignoredTabIds.includes(record.tabId)) {
    return
  }

  if (
    isUrlIgnoredByDomains(record.url, settings.ignoredDomains) ||
    isUrlIgnoredByDomains(record.pageUrl, settings.ignoredDomains)
  ) {
    return
  }

  const db = await getDb()
  const transaction = db.transaction(["networkRecords", "recordPreviews"], "readwrite")
  const previous = await transaction.objectStore("recordPreviews").get(record.id)
  await transaction.objectStore("networkRecords").put(record)
  await transaction.objectStore("recordPreviews").put(toRecordPreview(record, previous?.pinned))
  await transaction.done
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

const recordMatchesFilters = (record: NetworkRecord, filters: NetworkRecordFilters): boolean => {
  if (filters.apiOnly && !isProbablyApiRecord(record)) {
    return false
  }

  if (
    filters.method &&
    filters.method !== "ALL" &&
    record.method.toUpperCase() !== filters.method
  ) {
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
  const transaction = db.transaction(["networkRecords", "recordPreviews"], "readwrite")
  let cursor = await transaction.objectStore("recordPreviews").openCursor()
  while (cursor) {
    if (!cursor.value.pinned) {
      await transaction.objectStore("networkRecords").delete(cursor.value.id)
      await cursor.delete()
    }
    cursor = await cursor.continue()
  }
  await transaction.done
}

// The popup only needs counts. Never send request/response bodies through runtime messaging.
export const getNetworkRecordSummary = async (): Promise<NetworkRecordSummary> => {
  const db = await getDb()
  const result = createNetworkRecordSummary()
  let cursor = await db
    .transaction("recordPreviews")
    .store.index("by-startedAt")
    .openCursor(null, "prev")
  while (cursor) {
    result.add(cursor.value)
    cursor = await cursor.continue()
  }
  return result.summary
}

export const getNetworkRecordsByIds = async (
  ids: string[],
  sessionId?: string,
): Promise<NetworkRecord[]> => {
  const db = await getDb()
  const tx = db.transaction(["networkRecords", "sessionRecords"])
  const records = await Promise.all(
    ids.map(async (id) =>
      sessionId
        ? (await tx.objectStore("sessionRecords").get([sessionId, id]))?.record
        : await tx.objectStore("networkRecords").get(id),
    ),
  )
  await tx.done
  if (records.some((record) => !record))
    throw new Error("Some requests expired. Refresh the list and try again.")
  return records as NetworkRecord[]
}

export const listNetworkRecordPreviews = async (
  options?: ListNetworkRecordsPayload,
  sessionId?: string,
): Promise<NetworkRecordPreview[]> => {
  const settings = await getCaptureSettings()
  const limit = Math.max(
    1,
    Math.min(options?.limit ?? settings.captureLimit, settings.captureLimit),
  )
  const filters: NetworkRecordFilters = {
    apiOnly: options?.apiOnly ?? false,
    method: options?.method?.trim().toUpperCase(),
    source: options?.source ?? "all",
    host: options?.host?.trim().toLowerCase(),
    statusGroup: options?.statusGroup ?? "all",
    search: options?.search?.trim().toLowerCase(),
  }
  const db = await getDb()
  const tx = db.transaction([
    "recordPreviews",
    "networkRecords",
    "sessionPreviews",
    "sessionRecords",
  ])
  const results: NetworkRecordPreview[] = []
  const metadataFilters = { ...filters, search: undefined }
  let unpinned = 0
  let cursor = sessionId
    ? await tx.objectStore("sessionPreviews").index("by-session").openCursor(sessionId)
    : await tx.objectStore("recordPreviews").index("by-startedAt").openCursor(null, "prev")
  while (cursor) {
    const preview = cursor.value
    if (
      (sessionId || preview.pinned || unpinned < limit) &&
      recordMatchesFilters(preview, metadataFilters)
    ) {
      let matches = !filters.search || recordMatchesFilters(preview, filters)
      // Body search is opt-in by typing a query; routine refreshes never deserialize bodies.
      if (!matches) {
        const record = sessionId
          ? (await tx.objectStore("sessionRecords").get([sessionId, preview.id]))?.record
          : await tx.objectStore("networkRecords").get(preview.id)
        matches = Boolean(record && recordMatchesFilters(record, filters))
      }
      if (matches) {
        results.push(preview)
        if (!preview.pinned) unpinned++
      }
    }
    cursor = await cursor.continue()
  }
  await tx.done
  return results.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export const setNetworkRecordPinned = async (id: string, pinned: boolean): Promise<void> => {
  const db = await getDb()
  const tx = db.transaction("recordPreviews", "readwrite")
  const preview = await tx.store.get(id)
  if (!preview) throw new Error("This request has expired. Refresh the list.")
  await tx.store.put({ ...preview, pinned })
  await tx.done
  if (!pinned) await trimNetworkRecords()
}

export const listSavedSessions = async (): Promise<SavedSession[]> =>
  (await (await getDb()).getAll("sessions")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export const saveSession = async (
  name: string,
  ids: string[],
  sourceSessionId?: string,
): Promise<SavedSession> => {
  const cleanName = name.trim().slice(0, 120)
  if (!cleanName || !ids.length)
    throw new Error("Enter a session name and capture at least one request.")
  const session: SavedSession = {
    id: crypto.randomUUID(),
    name: cleanName,
    createdAt: new Date().toISOString(),
    count: ids.length,
  }
  const db = await getDb()
  const tx = db.transaction(
    ["sessions", "sessionRecords", "sessionPreviews", "networkRecords"],
    "readwrite",
  )
  try {
    for (const id of ids) {
      const record = sourceSessionId
        ? (await tx.objectStore("sessionRecords").get([sourceSessionId, id]))?.record
        : await tx.objectStore("networkRecords").get(id)
      if (!record) throw new Error("A request expired before saving. Refresh and try again.")
      await tx.objectStore("sessionRecords").put({ sessionId: session.id, id, record })
      await tx
        .objectStore("sessionPreviews")
        .put({ ...toRecordPreview(record), sessionId: session.id })
    }
    await tx.objectStore("sessions").put(session)
    await tx.done
    return session
  } catch (error) {
    try {
      tx.abort()
    } catch {}
    await tx.done.catch(() => {})
    throw error
  }
}

export const deleteSavedSession = async (id: string): Promise<void> => {
  const db = await getDb()
  const tx = db.transaction(["sessions", "sessionRecords", "sessionPreviews"], "readwrite")
  for (const name of ["sessionRecords", "sessionPreviews"] as const) {
    let cursor = await tx.objectStore(name).index("by-session").openCursor(id)
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
  }
  await tx.objectStore("sessions").delete(id)
  await tx.done
}
