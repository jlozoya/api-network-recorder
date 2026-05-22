import {
  isTextLikeContentType,
  toCapturedTextBody,
  unavailableBody,
} from "../../core/body-utils.js"
import { MAX_BODY_SIZE_BYTES } from "../../core/constants.js"
import { normalizeEndpointPath } from "../../core/endpoint-utils.js"
import type { CapturedBody, HeaderMap, NetworkRecord } from "../../core/network-types.js"
import { redactHeaders } from "../../core/redaction.js"
import { saveNetworkRecord } from "../../storage/network-record-repository.js"
import { isDebuggerAttached, isDeepCaptureEnabled } from "../debugger/debugger-controller.js"

interface PendingWebRequest {
  requestId: string
  tabId: number | null
  frameId: number | null
  method: string
  url: string
  type: string | null
  startedAt: string
  startedAtMs: number
  requestHeaders: HeaderMap
  requestBody: CapturedBody | null
  responseHeaders: HeaderMap
  status: number | null
  statusText: string | null
  mimeType: string | null
  responseBody: CapturedBody | null
  responseBodyPromise: Promise<void> | null
  fromCache: boolean
}

interface FirefoxStreamFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  write(data: ArrayBuffer | Uint8Array): void
  close(): void
  disconnect(): void
}

interface FirefoxWebRequestApi {
  filterResponseData?: (requestId: string) => FirefoxStreamFilter
}

declare const browser:
  | {
      webRequest?: FirefoxWebRequestApi
    }
  | undefined

const pendingRequests = new Map<string, PendingWebRequest>()
const RESPONSE_BODY_STREAM_TIMEOUT_MS = 5_000

const WEB_REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"],
}

const isCapturableTab = (tabId: number): boolean => {
  return tabId >= 0
}

const shouldSkipSilentCapture = (tabId: number): boolean => {
  return isCapturableTab(tabId) && (isDeepCaptureEnabled() || isDebuggerAttached(tabId))
}

const supportsFirefoxResponseFiltering = (): boolean => {
  return (
    __BROWSER_TARGET__ === "firefox" &&
    typeof browser !== "undefined" &&
    typeof browser.webRequest?.filterResponseData === "function"
  )
}

const headersArrayToMap = (headers?: chrome.webRequest.HttpHeader[]): HeaderMap => {
  const output: HeaderMap = {}

  if (!headers) {
    return output
  }

  for (const header of headers) {
    if (!header.name) {
      continue
    }

    if (typeof header.value === "string") {
      output[header.name] = header.value
    }
  }

  return output
}

const getHeaderValue = (headers: HeaderMap, name: string): string | undefined => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())

  return entry?.[1]
}

const getOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const getTabUrl = async (tabId: number | null): Promise<string | null> => {
  if (typeof tabId !== "number" || tabId < 0) {
    return null
  }

  try {
    const tab = await chrome.tabs.get(tabId)
    return typeof tab.url === "string" ? tab.url : null
  } catch {
    return null
  }
}

const getStatusText = (statusLine?: string): string | null => {
  if (!statusLine) {
    return null
  }

  const parts = statusLine.split(" ")
  return parts.slice(2).join(" ") || statusLine
}

const decodeUploadBytes = (bytes: ArrayBuffer): string | null => {
  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }

  return btoa(binary)
}

const concatChunks = (chunks: Uint8Array[], sizeBytes: number): Uint8Array => {
  const output = new Uint8Array(Math.min(sizeBytes, MAX_BODY_SIZE_BYTES))
  let offset = 0

  for (const chunk of chunks) {
    const available = output.length - offset

    if (available <= 0) {
      break
    }

    const slice = chunk.slice(0, available)
    output.set(slice, offset)
    offset += slice.length
  }

  return output
}

const responseBodyFromBytes = (
  bytes: Uint8Array,
  sizeBytes: number,
  contentType?: string | null,
): CapturedBody => {
  const normalizedContentType = contentType?.toLowerCase() ?? ""

  if (isTextLikeContentType(normalizedContentType)) {
    try {
      const text = new TextDecoder().decode(bytes)
      return toCapturedTextBody(text, normalizedContentType)
    } catch {
      return unavailableBody("Unable to decode Firefox response body")
    }
  }

  return {
    kind: "binary",
    value: toBase64(bytes),
    truncated: sizeBytes > MAX_BODY_SIZE_BYTES,
    sizeBytes,
  }
}

const withResponseBodyTimeout = (promise: Promise<void>): Promise<void> => {
  return new Promise((resolve) => {
    let settled = false

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }, RESPONSE_BODY_STREAM_TIMEOUT_MS)

    promise.finally(() => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutId)
      resolve()
    })
  })
}

const requestBodyFromDetails = (
  requestBody: chrome.webRequest.WebRequestBody | null | undefined,
): CapturedBody | null => {
  if (!requestBody) {
    return null
  }

  if (requestBody.formData) {
    const form: Record<string, string> = {}

    for (const [key, values] of Object.entries(requestBody.formData)) {
      form[key] = values.join(", ")
    }

    return {
      kind: "form-data",
      value: form,
      truncated: false,
      sizeBytes: JSON.stringify(form).length,
    }
  }

  const rawBytes = requestBody.raw?.find((item) => item.bytes)?.bytes

  if (!rawBytes) {
    return null
  }

  const text = decodeUploadBytes(rawBytes)

  if (!text) {
    return unavailableBody("Unable to decode request body")
  }

  return toCapturedTextBody(text)
}

type WebRequestInitialDetails =
  | chrome.webRequest.WebRequestHeadersDetails
  | chrome.webRequest.WebResponseHeadersDetails
  | chrome.webRequest.WebResponseCacheDetails

const getPendingOrCreate = (details: WebRequestInitialDetails): PendingWebRequest => {
  const existing = pendingRequests.get(details.requestId)

  if (existing) {
    return existing
  }

  const pending: PendingWebRequest = {
    requestId: details.requestId,
    tabId: isCapturableTab(details.tabId) ? details.tabId : null,
    frameId: typeof details.frameId === "number" ? details.frameId : null,
    method: details.method,
    url: details.url,
    type: typeof details.type === "string" ? details.type : null,
    startedAt: new Date(details.timeStamp).toISOString(),
    startedAtMs: performance.now(),
    requestHeaders: {},
    requestBody: null,
    responseHeaders: {},
    status: null,
    statusText: null,
    mimeType: null,
    responseBody: null,
    responseBodyPromise: null,
    fromCache: false,
  }

  pendingRequests.set(details.requestId, pending)

  return pending
}

const finalizeRequest = async (requestId: string, error?: string): Promise<void> => {
  const pending = pendingRequests.get(requestId)

  if (!pending) {
    return
  }

  pendingRequests.delete(requestId)

  if (pending.responseBodyPromise) {
    await withResponseBodyTimeout(pending.responseBodyPromise)
  }

  const requestContentType = getHeaderValue(pending.requestHeaders, "content-type")
  const responseContentType = getHeaderValue(pending.responseHeaders, "content-type")

  const record: NetworkRecord = {
    id: crypto.randomUUID(),
    source: "web-request",
    tabId: pending.tabId,
    frameId: pending.frameId,
    pageUrl: await getTabUrl(pending.tabId),
    origin: getOrigin(pending.url),
    method: pending.method,
    url: pending.url,
    requestHeaders: redactHeaders(pending.requestHeaders),
    requestBody:
      pending.requestBody?.kind === "text" && requestContentType
        ? toCapturedTextBody(pending.requestBody.value, requestContentType)
        : pending.requestBody,
    status: pending.status,
    statusText: pending.statusText,
    responseHeaders: redactHeaders(pending.responseHeaders),
    responseBody:
      pending.responseBody ??
      unavailableBody(
        supportsFirefoxResponseFiltering()
          ? "Firefox response body stream was unavailable for this request."
          : "Response body is unavailable in silent webRequest capture. Enable deep capture to inspect response bodies.",
      ),
    resourceType: pending.type,
    mimeType: responseContentType ?? pending.mimeType,
    startedAt: pending.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - pending.startedAtMs),
    metadata: {
      requestId: pending.requestId,
      fromDiskCache: pending.fromCache,
      normalizedEndpoint: normalizeEndpointPath(pending.url),
    },
  }

  if (error) {
    record.error = error
  }

  await saveNetworkRecord(record)
}

const startFirefoxResponseBodyCapture = (pending: PendingWebRequest): void => {
  if (!supportsFirefoxResponseFiltering()) {
    return
  }

  const filterResponseData =
    typeof browser === "undefined" ? undefined : browser.webRequest?.filterResponseData

  if (!filterResponseData) {
    return
  }

  const chunks: Uint8Array[] = []
  let sizeBytes = 0

  try {
    const filter = filterResponseData(pending.requestId)

    pending.responseBodyPromise = new Promise<void>((resolve) => {
      filter.ondata = (event) => {
        const chunk = new Uint8Array(event.data)
        sizeBytes += chunk.byteLength

        if (concatChunks(chunks, sizeBytes).length < MAX_BODY_SIZE_BYTES) {
          chunks.push(chunk)
        }

        filter.write(event.data)
      }

      filter.onstop = () => {
        pending.responseBody = responseBodyFromBytes(
          concatChunks(chunks, sizeBytes),
          sizeBytes,
          pending.mimeType,
        )
        filter.close()
        resolve()
      }

      filter.onerror = () => {
        pending.responseBody = unavailableBody("Firefox response body stream failed")
        filter.disconnect()
        resolve()
      }
    })
  } catch {
    pending.responseBody = unavailableBody("Firefox response body stream could not be opened")
    pending.responseBodyPromise = Promise.resolve()
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId) || shouldSkipSilentCapture(details.tabId)) {
      return
    }

    const pending: PendingWebRequest = {
      requestId: details.requestId,
      tabId: details.tabId,
      frameId: typeof details.frameId === "number" ? details.frameId : null,
      method: details.method,
      url: details.url,
      type: typeof details.type === "string" ? details.type : null,
      startedAt: new Date(details.timeStamp).toISOString(),
      startedAtMs: performance.now(),
      requestHeaders: {},
      requestBody: requestBodyFromDetails(details.requestBody),
      responseHeaders: {},
      status: null,
      statusText: null,
      mimeType: null,
      responseBody: null,
      responseBodyPromise: null,
      fromCache: false,
    }

    pendingRequests.set(details.requestId, pending)
    startFirefoxResponseBodyCapture(pending)
  },
  WEB_REQUEST_FILTER,
  supportsFirefoxResponseFiltering() ? ["requestBody", "blocking"] : ["requestBody"],
)

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId) || shouldSkipSilentCapture(details.tabId)) {
      return
    }

    const pending = getPendingOrCreate(details)
    pending.requestHeaders = headersArrayToMap(details.requestHeaders)
  },
  WEB_REQUEST_FILTER,
  ["requestHeaders"],
)

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId) || shouldSkipSilentCapture(details.tabId)) {
      return
    }

    const pending = getPendingOrCreate(details)

    pending.responseHeaders = headersArrayToMap(details.responseHeaders)
    pending.status = details.statusCode
    pending.statusText = getStatusText(details.statusLine)
    pending.mimeType = getHeaderValue(pending.responseHeaders, "content-type") ?? null
  },
  WEB_REQUEST_FILTER,
  ["responseHeaders"],
)

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isCapturableTab(details.tabId)) {
    return
  }

  if (shouldSkipSilentCapture(details.tabId)) {
    pendingRequests.delete(details.requestId)
    return
  }

  const pending = getPendingOrCreate(details)

  pending.status = details.statusCode
  pending.statusText = getStatusText(details.statusLine)
  pending.fromCache = Boolean(details.fromCache)

  void finalizeRequest(details.requestId)
}, WEB_REQUEST_FILTER)

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (!isCapturableTab(details.tabId)) {
    return
  }

  if (shouldSkipSilentCapture(details.tabId)) {
    pendingRequests.delete(details.requestId)
    return
  }

  void finalizeRequest(details.requestId, details.error)
}, WEB_REQUEST_FILTER)
