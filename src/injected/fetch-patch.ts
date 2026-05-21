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

const readRequestInitBody = async (
  body: BodyInit | null | undefined,
  contentType?: string,
): Promise<NetworkRecord["requestBody"]> => {
  try {
    if (!body) {
      return null
    }

    if (typeof body === "string") {
      return toCapturedTextBody(body, contentType)
    }

    if (body instanceof URLSearchParams) {
      return toCapturedTextBody(body.toString(), "application/x-www-form-urlencoded")
    }

    if (body instanceof FormData) {
      const form: Record<string, string> = {}

      for (const [key, value] of body.entries()) {
        form[key] = value instanceof File ? `[File: ${value.name}]` : String(value)
      }

      return {
        kind: "form-data",
        value: form,
        truncated: false,
        sizeBytes: JSON.stringify(form).length,
      }
    }

    if (body instanceof Blob) {
      return toCapturedTextBody(await body.text(), body.type || contentType)
    }

    if (body instanceof ArrayBuffer) {
      return unavailableBody(`Binary request body: ${body.byteLength} bytes`)
    }

    if (ArrayBuffer.isView(body)) {
      return unavailableBody(`Binary request body: ${body.byteLength} bytes`)
    }

    return unavailableBody("Unsupported fetch request body type")
  } catch {
    return unavailableBody("Unable to read request body")
  }
}

interface FetchSnapshot {
  method: string
  url: string
  headers: HeaderMap
  requestBody: Promise<NetworkRecord["requestBody"]>
}

const getHeaderValue = (headers: Headers, name: string): string | undefined => {
  return headers.get(name) ?? undefined
}

const snapshotFetchRequest = (input: RequestInfo | URL, init?: RequestInit): FetchSnapshot => {
  const headers = input instanceof Request ? new Headers(input.headers) : new Headers()

  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const body =
    init && "body" in init
      ? readRequestInitBody(init.body, getHeaderValue(headers, "content-type"))
      : input instanceof Request
        ? readRequestBody(input.clone())
        : Promise.resolve(null)

  return {
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    url: input instanceof Request ? input.url : new URL(String(input), location.href).href,
    headers: redactHeaders(headersToMap(headers)),
    requestBody: body,
  }
}

const fallbackFetchSnapshot = (): FetchSnapshot => ({
  method: "GET",
  url: location.href,
  headers: {},
  requestBody: Promise.resolve(null),
})

const safeSnapshotFetchRequest = (input: RequestInfo | URL, init?: RequestInit): FetchSnapshot => {
  try {
    return snapshotFetchRequest(input, init)
  } catch {
    return fallbackFetchSnapshot()
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
  request: FetchSnapshot,
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
    requestHeaders: request.headers,
    requestBody: await request.requestBody,
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
  request: FetchSnapshot,
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
    requestHeaders: request.headers,
    requestBody: await request.requestBody,
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

  window.fetch = function patchedFetch(
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startedAtMs = performance.now()
    const startedAt = new Date().toISOString()
    const request = safeSnapshotFetchRequest(input, init)

    try {
      const responsePromise = originalFetch.call(this, input, init)

      void responsePromise.then(
        (response) => {
          void recordFetchResponse(request, response, startedAt, startedAtMs).catch(() => {
            // Recording should never break the host page.
          })
        },
        (error: unknown) => {
          void recordFetchError(request, error, startedAt, startedAtMs).catch(() => {
            // Preserve the original fetch failure.
          })
        },
      )

      return responsePromise
    } catch (error) {
      void recordFetchError(request, error, startedAt, startedAtMs).catch(() => {
        // Preserve the original fetch failure.
      })

      return Promise.reject(error)
    }
  }
}
