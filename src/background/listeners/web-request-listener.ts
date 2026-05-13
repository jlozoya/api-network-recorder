import { toCapturedTextBody, unavailableBody } from "../../core/body-utils.js"
import { normalizeEndpointPath } from "../../core/endpoint-utils.js"
import type { CapturedBody, HeaderMap, NetworkRecord } from "../../core/network-types.js"
import { redactHeaders } from "../../core/redaction.js"
import { saveNetworkRecord } from "../../storage/network-record-repository.js"

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
  fromCache: boolean
}

const pendingRequests = new Map<string, PendingWebRequest>()

const WEB_REQUEST_FILTER: chrome.webRequest.RequestFilter = {
  urls: ["http://*/*", "https://*/*"],
}

const isCapturableTab = (tabId: number): boolean => {
  return tabId >= 0
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
    responseBody: unavailableBody(
      "Response body is unavailable in silent webRequest capture. Enable deep capture to inspect response bodies.",
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

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId)) {
      return
    }

    pendingRequests.set(details.requestId, {
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
      fromCache: false,
    })
  },
  WEB_REQUEST_FILTER,
  ["requestBody"],
)

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId)) {
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
    if (!isCapturableTab(details.tabId)) {
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

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId)) {
      return
    }

    const pending = getPendingOrCreate(details)

    pending.status = details.statusCode
    pending.statusText = getStatusText(details.statusLine)
    pending.fromCache = Boolean(details.fromCache)

    void finalizeRequest(details.requestId)
  },
  WEB_REQUEST_FILTER,
)

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!isCapturableTab(details.tabId)) {
      return
    }

    void finalizeRequest(details.requestId, details.error)
  },
  WEB_REQUEST_FILTER,
)