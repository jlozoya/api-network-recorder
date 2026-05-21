import type { CapturedBody, HeaderMap } from "../core/network-types.js"
import type { ExtensionMessage } from "../core/message-types.js"

export const EXTENSION_SOURCE = "API_NETWORK_RECORDER"

const MAX_BODY_SIZE_BYTES = 2 * 1024 * 1024
const REDACTED = "[REDACTED]"
const encoder = new TextEncoder()

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
  "x-stytch-session",
  "stytch-session",
])

const SENSITIVE_BODY_KEYS = new Set([
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "id_token",
  "idToken",
  "token",
  "jwt",
  "password",
  "passcode",
  "otp",
  "mfa",
  "totp",
  "code",
  "secret",
  "client_secret",
  "clientSecret",
  "api_key",
  "apiKey",
])

const toSafeText = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }

  if (value === null || value === undefined) {
    return ""
  }

  try {
    return String(value)
  } catch {
    return ""
  }
}

const redactJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item))
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}

    for (const [key, itemValue] of Object.entries(value)) {
      output[key] = SENSITIVE_BODY_KEYS.has(key) ? REDACTED : redactJsonValue(itemValue)
    }

    return output
  }

  if (typeof value === "string") {
    return redactText(value)
  }

  return value
}

export const redactText = (value: unknown): string => {
  return toSafeText(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/Basic\s+[A-Za-z0-9+/=-]+/gi, `Basic ${REDACTED}`)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, `"access_token":"${REDACTED}"`)
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, `"refresh_token":"${REDACTED}"`)
    .replace(/"id_token"\s*:\s*"[^"]+"/gi, `"id_token":"${REDACTED}"`)
    .replace(/"password"\s*:\s*"[^"]+"/gi, `"password":"${REDACTED}"`)
    .replace(/"passcode"\s*:\s*"[^"]+"/gi, `"passcode":"${REDACTED}"`)
    .replace(/"otp"\s*:\s*"[^"]+"/gi, `"otp":"${REDACTED}"`)
    .replace(/"totp"\s*:\s*"[^"]+"/gi, `"totp":"${REDACTED}"`)
    .replace(/"client_secret"\s*:\s*"[^"]+"/gi, `"client_secret":"${REDACTED}"`)
    .replace(/"api_key"\s*:\s*"[^"]+"/gi, `"api_key":"${REDACTED}"`)
}

export const redactHeaders = (headers: HeaderMap): HeaderMap => {
  const output: HeaderMap = {}

  for (const [key, value] of Object.entries(headers)) {
    output[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : redactText(value)
  }

  return output
}

const truncateText = (value: unknown): { value: string; truncated: boolean; sizeBytes: number } => {
  const text = toSafeText(value)
  const sizeBytes = encoder.encode(text).length
  const truncated = sizeBytes > MAX_BODY_SIZE_BYTES

  return {
    value: truncated ? text.slice(0, MAX_BODY_SIZE_BYTES) : text,
    truncated,
    sizeBytes,
  }
}

export const toCapturedTextBody = (value: unknown, contentType?: string): CapturedBody => {
  const normalizedContentType = contentType?.toLowerCase() ?? ""
  const redacted = redactText(value)
  const safe = truncateText(redacted)

  if (normalizedContentType.includes("application/json")) {
    try {
      return {
        kind: "json",
        value: redactJsonValue(JSON.parse(safe.value)),
        truncated: safe.truncated,
        sizeBytes: safe.sizeBytes,
      }
    } catch {
      return {
        kind: "text",
        value: safe.value,
        truncated: safe.truncated,
        sizeBytes: safe.sizeBytes,
      }
    }
  }

  if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
    try {
      const form: Record<string, string> = {}

      for (const [key, formValue] of new URLSearchParams(safe.value).entries()) {
        form[key] = redactText(formValue)
      }

      return {
        kind: "form-data",
        value: form,
        truncated: safe.truncated,
        sizeBytes: safe.sizeBytes,
      }
    } catch {
      return {
        kind: "text",
        value: safe.value,
        truncated: safe.truncated,
        sizeBytes: safe.sizeBytes,
      }
    }
  }

  return {
    kind: "text",
    value: safe.value,
    truncated: safe.truncated,
    sizeBytes: safe.sizeBytes,
  }
}

export const unavailableBody = (reason: string): CapturedBody => ({
  kind: "unavailable",
  reason,
})

export const postNetworkRecordMessage = (message: ExtensionMessage): void => {
  try {
    window.postMessage(
      {
        source: EXTENSION_SOURCE,
        message,
      },
      "*",
    )
  } catch {
    // Recording should never break the host page if posting back to the extension fails.
  }
}
