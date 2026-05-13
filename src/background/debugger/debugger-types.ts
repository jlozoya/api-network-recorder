import type { HeaderMap } from "../../core/network-types.js"

export interface PendingDebuggerRequest {
  requestId: string
  tabId: number
  frameId: number | null
  method: string
  url: string
  pageUrl: string | null
  origin: string | null
  startedAt: string
  startedAtMs: number
  requestHeaders: HeaderMap
  requestBody: string | null
  resourceType: string | null
  responseHeaders: HeaderMap
  status: number | null
  statusText: string | null
  mimeType: string | null
  protocol: string | null
  fromDiskCache: boolean
}