import type { ExtensionMessage } from "../core/message-types.js"
import type { HeaderMap, NetworkRecord } from "../core/network-types.js"
import {
  EXTENSION_SOURCE,
  redactHeaders,
  toCapturedTextBody,
  unavailableBody,
} from "./page-utils.js"

const parseResponseHeaders = (rawHeaders: string): HeaderMap => {
  const headers: HeaderMap = {}

  for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(":")

    if (index === -1) {
      continue
    }

    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()

    headers[key] = value
  }

  return headers
}

const getHeaderValue = (headers: HeaderMap, name: string): string | undefined => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())

  return entry?.[1]
}

const postRecord = (record: Omit<NetworkRecord, "tabId">): void => {
  const message: ExtensionMessage = {
    type: "NETWORK_RECORD_CREATED",
    payload: record,
  }

  try {
    window.postMessage(
      {
        source: EXTENSION_SOURCE,
        message,
      },
      window.location.origin,
    )
  } catch {
    // Recording should never break the host page if posting back to the extension fails.
  }
}

const canReadResponseText = (xhr: XMLHttpRequest): boolean => {
  return xhr.responseType === "" || xhr.responseType === "text"
}

export const patchXhr = (): void => {
  const OriginalXMLHttpRequest = window.XMLHttpRequest

  const PatchedXMLHttpRequest = function PatchedXMLHttpRequest(): XMLHttpRequest {
    const xhr = new OriginalXMLHttpRequest()

    let method = "GET"
    let url = ""
    let startedAt = ""
    let startedAtMs = 0
    let requestBody: NetworkRecord["requestBody"] = null

    const requestHeaders: HeaderMap = {}

    const originalOpen = xhr.open.bind(xhr)

    xhr.open = function patchedOpen(
      nextMethod: string,
      nextUrl: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      method = nextMethod
      url = new URL(String(nextUrl), location.href).href

      originalOpen(nextMethod, nextUrl, async ?? true, username, password)
    }

    const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr)

    xhr.setRequestHeader = function patchedSetRequestHeader(name: string, value: string): void {
      requestHeaders[name] = value
      originalSetRequestHeader(name, value)
    }

    const originalSend = xhr.send.bind(xhr)

    xhr.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
      startedAt = new Date().toISOString()
      startedAtMs = performance.now()

      const requestContentType = getHeaderValue(requestHeaders, "content-type")

      if (typeof body === "string") {
        requestBody = toCapturedTextBody(body, requestContentType)
      } else if (body instanceof FormData) {
        const form: Record<string, string> = {}

        for (const [key, value] of body.entries()) {
          form[key] = value instanceof File ? `[File: ${value.name}]` : String(value)
        }

        requestBody = {
          kind: "form-data",
          value: form,
          truncated: false,
          sizeBytes: JSON.stringify(form).length,
        }
      } else if (body instanceof URLSearchParams) {
        requestBody = toCapturedTextBody(body.toString(), "application/x-www-form-urlencoded")
      } else if (body) {
        requestBody = unavailableBody("Unsupported XHR request body type")
      }

      xhr.addEventListener("loadend", () => {
        try {
          const responseHeaders = parseResponseHeaders(xhr.getAllResponseHeaders())
          const contentType = xhr.getResponseHeader("content-type") ?? ""

          let responseBody: NetworkRecord["responseBody"]

          if (canReadResponseText(xhr)) {
            try {
              responseBody =
                typeof xhr.responseText === "string"
                  ? toCapturedTextBody(xhr.responseText, contentType)
                  : unavailableBody("XHR responseText is unavailable")
            } catch {
              responseBody = unavailableBody("Unable to read XHR response body")
            }
          } else {
            responseBody = unavailableBody(`XHR responseType '${xhr.responseType}' is not text`)
          }

          postRecord({
            id: crypto.randomUUID(),
            source: "xhr",
            pageUrl: location.href,
            origin: location.origin,
            method,
            url,
            requestHeaders: redactHeaders(requestHeaders),
            requestBody,
            status: xhr.status,
            statusText: xhr.statusText,
            responseHeaders: redactHeaders(responseHeaders),
            responseBody,
            resourceType: "xhr",
            mimeType: contentType,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startedAtMs),
          })
        } catch {
          // Recording should never break the host page.
        }
      })

      originalSend(body)
    }

    return xhr
  }

  Object.setPrototypeOf(PatchedXMLHttpRequest, OriginalXMLHttpRequest)
  PatchedXMLHttpRequest.prototype = OriginalXMLHttpRequest.prototype

  window.XMLHttpRequest = PatchedXMLHttpRequest as unknown as typeof XMLHttpRequest
}
