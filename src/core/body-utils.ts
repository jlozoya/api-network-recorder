import { CAPTURABLE_TEXT_CONTENT_TYPES, MAX_BODY_SIZE_BYTES } from "./constants.js"
import type { CapturedBody, HeaderMap } from "./network-types.js"
import { redactJson, redactText } from "./redaction.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const MAX_REPLACEMENT_CHARACTER_RATIO = 0.02
const MAX_CONTROL_CHARACTER_RATIO = 0.05

export const getContentType = (headers: HeaderMap): string => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")
  return entry?.[1]?.toLowerCase() ?? ""
}

export const isTextLikeContentType = (contentType: string): boolean => {
  return CAPTURABLE_TEXT_CONTENT_TYPES.some((item) => contentType.includes(item))
}

const truncateText = (value: string): { value: string; truncated: boolean; sizeBytes: number } => {
  const bytes = encoder.encode(value)
  const sizeBytes = bytes.length
  const truncated = sizeBytes > MAX_BODY_SIZE_BYTES

  return {
    // Omit an incomplete final UTF-8 character instead of adding a replacement character.
    value: truncated
      ? new TextDecoder().decode(bytes.subarray(0, MAX_BODY_SIZE_BYTES), { stream: true })
      : value,
    truncated,
    sizeBytes,
  }
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize))
  }

  return btoa(binary)
}

const looksLikeBinaryText = (value: string): boolean => {
  if (!value) {
    return false
  }

  let replacementCharacters = 0
  let controlCharacters = 0

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0

    if (character === "\uFFFD") {
      replacementCharacters += 1
    } else if (
      (codePoint >= 0x00 && codePoint <= 0x08) ||
      (codePoint >= 0x0e && codePoint <= 0x1f)
    ) {
      controlCharacters += 1
    }
  }

  return (
    replacementCharacters / value.length > MAX_REPLACEMENT_CHARACTER_RATIO ||
    controlCharacters / value.length > MAX_CONTROL_CHARACTER_RATIO
  )
}

export const toCapturedBinaryBody = (
  bytes: Uint8Array,
  sizeBytes = bytes.byteLength,
): CapturedBody => {
  const truncated = sizeBytes > MAX_BODY_SIZE_BYTES
  const safeBytes = truncated ? bytes.slice(0, MAX_BODY_SIZE_BYTES) : bytes

  return {
    kind: "binary",
    value: toBase64(safeBytes),
    truncated,
    sizeBytes,
  }
}

export const toCapturedBase64Body = (value: string): CapturedBody => {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const sizeBytes = Math.floor((value.length * 3) / 4) - padding
  const prefix = atob(value.slice(0, Math.ceil(MAX_BODY_SIZE_BYTES / 3) * 4))
  const bytes = Uint8Array.from(prefix, (character) => character.charCodeAt(0))
  return toCapturedBinaryBody(bytes, sizeBytes)
}

export const toCapturedBodyFromBytes = (
  bytes: ArrayBuffer | Uint8Array,
  contentType?: string | null,
  sizeBytes?: number,
): CapturedBody => {
  const normalizedContentType = contentType?.toLowerCase() ?? ""
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const originalSize = Math.max(sizeBytes ?? view.byteLength, view.byteLength)
  const safeView = view.subarray(0, MAX_BODY_SIZE_BYTES)

  if (normalizedContentType && !isTextLikeContentType(normalizedContentType)) {
    return toCapturedBinaryBody(safeView, originalSize)
  }

  try {
    const text =
      originalSize > safeView.byteLength
        ? new TextDecoder().decode(safeView, { stream: true })
        : decoder.decode(safeView)

    if (looksLikeBinaryText(text)) {
      return toCapturedBinaryBody(safeView, originalSize)
    }

    const body = toCapturedTextBody(text, normalizedContentType)
    return body.kind === "unavailable"
      ? body
      : {
          ...body,
          sizeBytes: originalSize,
          truncated: body.truncated || originalSize > safeView.byteLength,
        }
  } catch {
    return toCapturedBinaryBody(safeView, originalSize)
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
