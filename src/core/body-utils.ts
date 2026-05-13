import { CAPTURABLE_TEXT_CONTENT_TYPES, MAX_BODY_SIZE_BYTES } from "./constants.js"
import type { CapturedBody, HeaderMap } from "./network-types.js"
import { redactJson, redactText } from "./redaction.js"

const encoder = new TextEncoder()

export const getContentType = (headers: HeaderMap): string => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")
  return entry?.[1]?.toLowerCase() ?? ""
}

export const isTextLikeContentType = (contentType: string): boolean => {
  return CAPTURABLE_TEXT_CONTENT_TYPES.some((item) => contentType.includes(item))
}

const truncateText = (value: string): { value: string; truncated: boolean; sizeBytes: number } => {
  const sizeBytes = encoder.encode(value).length
  const truncated = sizeBytes > MAX_BODY_SIZE_BYTES

  return {
    value: truncated ? value.slice(0, MAX_BODY_SIZE_BYTES) : value,
    truncated,
    sizeBytes,
  }
}

export const toCapturedTextBody = (value: string, contentType?: string): CapturedBody => {
  const normalizedContentType = contentType?.toLowerCase() ?? ""
  const redacted = redactText(value)
  const safe = truncateText(redacted)

  if (normalizedContentType.includes("application/json")) {
    try {
      return {
        kind: "json",
        value: redactJson(JSON.parse(safe.value)),
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