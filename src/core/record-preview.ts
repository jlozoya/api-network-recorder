import type { NetworkRecord } from "./network-types.js"

// Bodies are deliberately absent from list reads. Fetch the record before inspecting/exporting it.
export interface NetworkRecordPreview extends NetworkRecord {
  requestBody: null
  responseBody: null
  detailsLoaded: false
  hasRequestBody: boolean
  hasResponseBody: boolean
  pinned: boolean
}
export const toRecordPreview = (record: NetworkRecord, pinned = false): NetworkRecordPreview => ({
  ...record,
  requestBody: null,
  responseBody: null,
  detailsLoaded: false,
  pinned,
  hasRequestBody: Boolean(record.requestBody && record.requestBody.kind !== "unavailable"),
  hasResponseBody: Boolean(record.responseBody && record.responseBody.kind !== "unavailable"),
})
export interface SavedSession {
  id: string
  name: string
  createdAt: string
  count: number
}
