import type { ExtensionMessage } from "../core/message-types.js"
import type { HeaderMap, NetworkRecord } from "../core/network-types.js"
import {
  postNetworkRecordMessage,
  redactHeaders,
  toCapturedTextBody,
  unavailableBody,
} from "./page-utils.js"

const headersToMap = (headers: Headers): HeaderMap => {
  const output: HeaderMap = {}

  headers.forEach((value, key) => {
    output[key] = value
  })

  return output
}

const readRequestBody = async (request: Request): Promise<NetworkRecord["requestBody"]> => {
  try {
    const clone = request.clone()
    const text = await clone.text()

    if (!text) {
      return null
    }

    return toCapturedTextBody(text, clone.headers.get("content-type") ?? undefined)
  } catch {
    return unavailableBody("Unable to read request body")
  }
}

const postRecord = (record: Omit<NetworkRecord, "tabId">): void => {
  const message: ExtensionMessage = {
    type: "NETWORK_RECORD_CREATED",
    payload: record,
  }

  postNetworkRecordMessage(message)
}

const recordFetchResponse = async (
  request: Request,
  response: Response,
  startedAt: string,
  startedAtMs: number,
): Promise<void> => {
  const responseClone = response.clone()

  let responseBody: NetworkRecord["responseBody"]

  try {
    const contentType = responseClone.headers.get("content-type") ?? ""
    const text = await responseClone.text()
    responseBody = toCapturedTextBody(text, contentType)
  } catch {
    responseBody = unavailableBody("Unable to read response body")
  }

  postRecord({
    id: crypto.randomUUID(),
    source: "fetch",
    pageUrl: location.href,
    origin: location.origin,
    method: request.method,
    url: request.url,
    requestHeaders: redactHeaders(headersToMap(request.headers)),
    requestBody: await readRequestBody(request),
    status: response.status,
    statusText: response.statusText,
    responseHeaders: redactHeaders(headersToMap(response.headers)),
    responseBody,
    resourceType: "fetch",
    mimeType: response.headers.get("content-type"),
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAtMs),
  })
}

const recordFetchError = async (
  request: Request,
  error: unknown,
  startedAt: string,
  startedAtMs: number,
): Promise<void> => {
  postRecord({
    id: crypto.randomUUID(),
    source: "fetch",
    pageUrl: location.href,
    origin: location.origin,
    method: request.method,
    url: request.url,
    requestHeaders: redactHeaders(headersToMap(request.headers)),
    requestBody: await readRequestBody(request),
    status: null,
    statusText: null,
    responseHeaders: {},
    responseBody: null,
    resourceType: "fetch",
    mimeType: null,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAtMs),
    error: error instanceof Error ? error.message : String(error),
  })
}

export const patchFetch = (): void => {
  const originalFetch = window.fetch

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAtMs = performance.now()
    const startedAt = new Date().toISOString()
    const request = input instanceof Request ? input : new Request(input, init)

    try {
      const response = await originalFetch(input, init)

      void recordFetchResponse(request, response, startedAt, startedAtMs).catch(() => {
        // Recording should never break the host page.
      })

      return response
    } catch (error) {
      void recordFetchError(request, error, startedAt, startedAtMs).catch(() => {
        // Preserve the original fetch failure.
      })

      throw error
    }
  }
}
