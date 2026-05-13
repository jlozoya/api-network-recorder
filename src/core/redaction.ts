import { SENSITIVE_BODY_KEYS, SENSITIVE_HEADER_NAMES } from "./constants.js"
import type { HeaderMap } from "./network-types.js"

const REDACTED = "[REDACTED]"

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

export const redactJson = (value: unknown): unknown => {
  return redactJsonValue(value)
}

export const redactHeaders = (headers: HeaderMap): HeaderMap => {
  const output: HeaderMap = {}

  for (const [key, value] of Object.entries(headers)) {
    output[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : redactText(value)
  }

  return output
}

export const redactText = (value: string): string => {
  return value
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