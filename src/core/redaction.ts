import { SENSITIVE_HEADER_NAMES } from "./constants.js"
import type { HeaderMap } from "./network-types.js"

const REDACTED = "[REDACTED]"

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
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, `"access_token":"${REDACTED}"`)
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, `"refresh_token":"${REDACTED}"`)
    .replace(/"id_token"\s*:\s*"[^"]+"/gi, `"id_token":"${REDACTED}"`)
}