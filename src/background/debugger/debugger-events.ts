import { toCapturedTextBody, unavailableBody } from "../../core/body-utils.js"
import type { HeaderMap, NetworkRecord } from "../../core/network-types.js"
import { normalizeEndpointPath } from "../../core/endpoint-utils.js"
import { redactHeaders } from "../../core/redaction.js"
import { saveNetworkRecord } from "../../storage/network-record-repository.js"
import type { PendingDebuggerRequest } from "./debugger-types.js"

const pendingRequests = new Map<string, PendingDebuggerRequest>()

const normalizeHeaders = (headers: unknown): HeaderMap => {
  if (!headers || typeof headers !== "object") {
    return {}
  }

  const output: HeaderMap = {}

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    output[key] = String(value)
  }

  return output
}

const getString = (value: unknown, fallback = ""): string => {
  return typeof value === "string" ? value : fallback
}

const getNumber = (value: unknown): number | null => {
  return typeof value === "number" ? value : null
}

const getBoolean = (value: unknown): boolean => {
  return typeof value === "boolean" ? value : false
}

const getOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const getTabUrl = async (tabId: number): Promise<string | null> => {
  try {
    const tab = await chrome.tabs.get(tabId)
    return typeof tab.url === "string" ? tab.url : null
  } catch {
    return null
  }
}

const getRequestContentType = (headers: HeaderMap): string | undefined => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")
  return entry?.[1]
}

const buildMetadata = (
  pending: PendingDebuggerRequest,
  encodedDataLength?: number,
): NonNullable<NetworkRecord["metadata"]> => {
  const metadata: NonNullable<NetworkRecord["metadata"]> = {
    requestId: pending.requestId,
    fromDiskCache: pending.fromDiskCache,
    normalizedEndpoint: normalizeEndpointPath(pending.url),
  }

  if (pending.protocol) {
    metadata.protocol = pending.protocol
  }

  if (typeof encodedDataLength === "number") {
    metadata.encodedDataLength = encodedDataLength
  }

  return metadata
}

const buildRecord = async (
  pending: PendingDebuggerRequest,
  responseBody: NetworkRecord["responseBody"],
  error?: string,
  encodedDataLength?: number,
): Promise<NetworkRecord> => {
  const completedAt = new Date().toISOString()
  const durationMs = Math.round(performance.now() - pending.startedAtMs)
  const requestContentType = getRequestContentType(pending.requestHeaders)

  const record: NetworkRecord = {
    id: crypto.randomUUID(),
    source: "debugger",
    tabId: pending.tabId,
    frameId: pending.frameId,
    pageUrl: pending.pageUrl ?? (await getTabUrl(pending.tabId)),
    origin: pending.origin,
    method: pending.method,
    url: pending.url,
    requestHeaders: pending.requestHeaders,
    requestBody:
      pending.requestBody === null
        ? null
        : toCapturedTextBody(pending.requestBody, requestContentType),
    status: pending.status,
    statusText: pending.statusText,
    responseHeaders: pending.responseHeaders,
    responseBody,
    resourceType: pending.resourceType,
    mimeType: pending.mimeType,
    startedAt: pending.startedAt,
    completedAt,
    durationMs,
    metadata: buildMetadata(pending, encodedDataLength),
  }

  if (error) {
    record.error = error
  }

  return record
}

export const handleDebuggerEvent = async (
  tabId: number,
  method: string,
  params: unknown,
): Promise<void> => {
  const event = params as Record<string, unknown>
  const requestId = getString(event.requestId)

  if (!requestId) {
    return
  }

  if (method === "Network.requestWillBeSent") {
    const request = event.request as Record<string, unknown> | undefined
    const url = getString(request?.url)
    const frameId = getNumber(event.frameId)
    const documentUrl = getString(event.documentURL, "")

    pendingRequests.set(requestId, {
      requestId,
      tabId,
      frameId,
      method: getString(request?.method, "GET"),
      url,
      pageUrl: documentUrl || null,
      origin: getOrigin(url),
      startedAt: new Date().toISOString(),
      startedAtMs: performance.now(),
      requestHeaders: redactHeaders(normalizeHeaders(request?.headers)),
      requestBody: typeof request?.postData === "string" ? request.postData : null,
      resourceType: typeof event.type === "string" ? event.type : null,
      responseHeaders: {},
      status: null,
      statusText: null,
      mimeType: null,
      protocol: null,
      fromDiskCache: false,
    })

    return
  }

  if (method === "Network.responseReceived") {
    const pending = pendingRequests.get(requestId)

    if (!pending) {
      return
    }

    const response = event.response as Record<string, unknown> | undefined

    pending.responseHeaders = redactHeaders(normalizeHeaders(response?.headers))
    pending.status = getNumber(response?.status)
    pending.statusText = getString(response?.statusText, "")
    pending.mimeType = typeof response?.mimeType === "string" ? response.mimeType : null
    pending.protocol = typeof response?.protocol === "string" ? response.protocol : null
    pending.fromDiskCache = getBoolean(response?.fromDiskCache)

    return
  }

  if (method === "Network.loadingFinished") {
    const pending = pendingRequests.get(requestId)

    if (!pending) {
      return
    }

    pendingRequests.delete(requestId)

    let responseBody: NetworkRecord["responseBody"] = unavailableBody("Response body unavailable")

    try {
      const result = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        {
          requestId,
        },
      )

      const bodyResult = result as {
        body?: string
        base64Encoded?: boolean
      }

      if (bodyResult.base64Encoded) {
        responseBody = {
          kind: "binary",
          value: bodyResult.body ?? "",
          truncated: false,
          sizeBytes: bodyResult.body?.length ?? 0,
        }
      } else {
        responseBody = toCapturedTextBody(bodyResult.body ?? "", pending.mimeType ?? undefined)
      }
    } catch {
      responseBody = unavailableBody("Chrome debugger could not read response body")
    }

    const encodedDataLength = getNumber(event.encodedDataLength)
    const record = await buildRecord(
      pending,
      responseBody,
      undefined,
      encodedDataLength ?? undefined,
    )

    await saveNetworkRecord(record)
    return
  }

  if (method === "Network.loadingFailed") {
    const pending = pendingRequests.get(requestId)

    if (!pending) {
      return
    }

    pendingRequests.delete(requestId)

    const errorText = getString(event.errorText, "Chrome debugger reported a failed request")
    const record = await buildRecord(pending, unavailableBody(errorText), errorText)

    await saveNetworkRecord(record)
  }
}