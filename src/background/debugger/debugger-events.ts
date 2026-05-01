import { toCapturedTextBody, unavailableBody } from "../../core/body-utils.js"
import type { HeaderMap, NetworkRecord } from "../../core/network-types.js"
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

    pendingRequests.set(requestId, {
      requestId,
      tabId,
      method: getString(request?.method, "GET"),
      url: getString(request?.url),
      startedAt: new Date().toISOString(),
      startedAtMs: performance.now(),
      requestHeaders: redactHeaders(normalizeHeaders(request?.headers)),
      requestBody: typeof request?.postData === "string" ? request.postData : null,
      resourceType: typeof event.type === "string" ? event.type : null,
      responseHeaders: {},
      status: null,
      statusText: null,
      mimeType: null,
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

    return
  }

  if (method === "Network.loadingFinished") {
    const pending = pendingRequests.get(requestId)

    if (!pending) {
      return
    }

    pendingRequests.delete(requestId)

    const completedAt = new Date().toISOString()
    const durationMs = Math.round(performance.now() - pending.startedAtMs)

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

    const requestContentType =
      pending.requestHeaders["content-type"] ??
      pending.requestHeaders["Content-Type"] ??
      undefined

    const record: NetworkRecord = {
      id: crypto.randomUUID(),
      source: "debugger",
      tabId,
      pageUrl: null,
      origin: null,
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
      metadata: {
        requestId,
      },
    }

    await saveNetworkRecord(record)
  }
}