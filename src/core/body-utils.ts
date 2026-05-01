import { CAPTURABLE_TEXT_CONTENT_TYPES, MAX_BODY_SIZE_BYTES } from "./constants.js"
import type { CapturedBody, HeaderMap } from "./network-types.js"
import { redactText } from "./redaction.js"

const encoder = new TextEncoder()

export const getContentType = (headers: HeaderMap): string => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")
  return entry?.[1]?.toLowerCase() ?? ""
}

export const isTextLikeContentType = (contentType: string): boolean => {
  return CAPTURABLE_TEXT_CONTENT_TYPES.some((item) => contentType.includes(item))
}

export const toCapturedTextBody = (value: string, contentType?: string): CapturedBody => {
  const redacted = redactText(value)
  const sizeBytes = encoder.encode(redacted).length
  const truncated = sizeBytes > MAX_BODY_SIZE_BYTES
  const safeValue = truncated ? redacted.slice(0, MAX_BODY_SIZE_BYTES) : redacted

  if (contentType?.includes("application/json")) {
    try {
      return {
        kind: "json",
        value: JSON.parse(safeValue),
        truncated,
        sizeBytes,
      }
    } catch {
      return {
        kind: "text",
        value: safeValue,
        truncated,
        sizeBytes,
      }
    }
  }

  return {
    kind: "text",
    value: safeValue,
    truncated,
    sizeBytes,
  }
}

export const unavailableBody = (reason: string): CapturedBody => ({
  kind: "unavailable",
  reason,
})