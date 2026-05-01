import type { HeaderMap } from "../../core/network-types.js"

export interface PendingDebuggerRequest {
  requestId: string
  tabId: number
  method: string
  url: string
  startedAt: string
  startedAtMs: number
  requestHeaders: HeaderMap
  requestBody: string | null
  resourceType: string | null
  responseHeaders: HeaderMap
  status: number | null
  statusText: string | null
  mimeType: string | null
}