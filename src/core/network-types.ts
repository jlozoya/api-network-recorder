export type CaptureSource = "fetch" | "xhr" | "debugger"

export type HeaderMap = Record<string, string>

export interface NetworkRecord {
  id: string
  source: CaptureSource
  tabId: number | null
  frameId?: number | null

  pageUrl: string | null
  origin: string | null

  method: string
  url: string

  requestHeaders: HeaderMap
  requestBody: CapturedBody | null

  status: number | null
  statusText: string | null
  responseHeaders: HeaderMap
  responseBody: CapturedBody | null

  resourceType?: string | null
  mimeType?: string | null

  startedAt: string
  completedAt: string
  durationMs: number | null

  error?: string | null

  metadata?: {
    requestId?: string
    protocol?: string
    fromDiskCache?: boolean
    encodedDataLength?: number
  }
}

export type CapturedBody =
  | {
      kind: "text"
      value: string
      truncated: boolean
      sizeBytes: number
    }
  | {
      kind: "json"
      value: unknown
      truncated: boolean
      sizeBytes: number
    }
  | {
      kind: "form-data"
      value: Record<string, string>
      truncated: boolean
      sizeBytes: number
    }
  | {
      kind: "binary"
      value: string
      truncated: boolean
      sizeBytes: number
    }
  | {
      kind: "unavailable"
      reason: string
    }