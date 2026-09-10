import { MAX_BODY_SIZE_BYTES } from "./constants.js"
import type { ExtensionMessage } from "./message-types.js"

const encoder = new TextEncoder()
const MAX_HEADER_BYTES = 64 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_BODY_SIZE_BYTES / 3) * 4
const MAX_RECORD_BYTES = MAX_BASE64_LENGTH * 2 + MAX_HEADER_BYTES * 4
const RECORD_KEYS = new Set([
  "id",
  "source",
  "frameId",
  "pageUrl",
  "origin",
  "method",
  "url",
  "requestHeaders",
  "requestBody",
  "status",
  "statusText",
  "responseHeaders",
  "responseBody",
  "resourceType",
  "mimeType",
  "startedAt",
  "completedAt",
  "durationMs",
  "error",
  "metadata",
])

const isObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const isString = (value: unknown, limit = 32768): value is string =>
  typeof value === "string" && value.length <= limit && encoder.encode(value).length <= limit
const nullableString = (value: unknown): boolean => value === null || isString(value)
const optionalString = (value: unknown): boolean => value === undefined || nullableString(value)
const isSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
const hasOnlyKeys = (value: Record<string, unknown>, keys: Set<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key))
const serializedSize = (value: unknown): number => encoder.encode(JSON.stringify(value)).length

// Limit nesting and node count before serialization; reject cycles and non-JSON values.
const isJsonTree = (value: unknown): boolean => {
  let nodes = 0
  let bytes = 0
  const spend = (size: number): boolean => {
    bytes += size
    return bytes <= MAX_RECORD_BYTES
  }
  const seen = new WeakSet<object>()
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 100000 || depth > 32) return false
    if (item === null || typeof item === "boolean") return spend(5)
    if (typeof item === "string")
      return isString(item, MAX_BASE64_LENGTH) && spend(serializedSize(item))
    if (typeof item === "number") return Number.isFinite(item) && spend(String(item).length)
    if (!Array.isArray(item) && !isObject(item)) return false
    if (seen.has(item) || !spend(2)) return false
    seen.add(item)
    const valid = Array.isArray(item)
      ? item.every((child) => spend(1) && visit(child, depth + 1))
      : Object.entries(item).every(
          ([key, child]) =>
            isString(key) && spend(serializedSize(key) + 2) && visit(child, depth + 1),
        )
    seen.delete(item)
    return valid
  }
  return visit(value, 0)
}

const isHeaders = (value: unknown): boolean =>
  isObject(value) &&
  Object.keys(value).length <= 256 &&
  Object.entries(value).every(
    ([key, entry]) => isString(key, 256) && isString(entry, MAX_HEADER_BYTES),
  ) &&
  serializedSize(value) <= MAX_HEADER_BYTES

const isBody = (value: unknown): boolean => {
  if (value === null) return true
  if (!isObject(value)) return false
  if (value.kind === "unavailable") {
    return hasOnlyKeys(value, new Set(["kind", "reason"])) && isString(value.reason)
  }
  if (
    !hasOnlyKeys(value, new Set(["kind", "value", "truncated", "sizeBytes"])) ||
    typeof value.truncated !== "boolean" ||
    !isSize(value.sizeBytes)
  )
    return false
  if (value.kind === "text") return isString(value.value, MAX_BODY_SIZE_BYTES)
  if (value.kind === "binary") {
    if (
      !isString(value.value, MAX_BASE64_LENGTH) ||
      value.value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.value)
    )
      return false
    const padding = value.value.endsWith("==") ? 2 : value.value.endsWith("=") ? 1 : 0
    return (value.value.length * 3) / 4 - padding <= MAX_BODY_SIZE_BYTES
  }
  if (value.kind === "form-data") {
    return (
      isObject(value.value) &&
      Object.values(value.value).every((entry) => typeof entry === "string") &&
      serializedSize(value.value) <= MAX_BODY_SIZE_BYTES
    )
  }
  return value.kind === "json" && serializedSize(value.value) <= MAX_BODY_SIZE_BYTES
}

const isTimestamp = (value: unknown): boolean => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
const isUrl = (value: unknown): boolean => {
  if (!isString(value) || !value) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}
const isMetadata = (value: unknown): boolean => {
  if (value === undefined) return true
  if (
    !isObject(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        "requestId",
        "protocol",
        "fromDiskCache",
        "encodedDataLength",
        "normalizedEndpoint",
      ]),
    )
  )
    return false
  return (
    (value.requestId === undefined || isString(value.requestId)) &&
    (value.protocol === undefined || isString(value.protocol)) &&
    (value.normalizedEndpoint === undefined || isString(value.normalizedEndpoint)) &&
    (value.fromDiskCache === undefined || typeof value.fromDiskCache === "boolean") &&
    (value.encodedDataLength === undefined || isSize(value.encodedDataLength))
  )
}

export const isPageNetworkRecordMessage = (
  message: unknown,
): message is Extract<ExtensionMessage, { type: "NETWORK_RECORD_CREATED" }> => {
  try {
    if (!isObject(message) || message.type !== "NETWORK_RECORD_CREATED") return false
    const record = message.payload
    if (!isObject(record) || !hasOnlyKeys(record, RECORD_KEYS) || !isJsonTree(record)) return false
    return (
      isString(record.id, 128) &&
      record.id.length > 0 &&
      (record.source === "fetch" || record.source === "xhr") &&
      (record.frameId === undefined || record.frameId === null || isSize(record.frameId)) &&
      (record.pageUrl === null || isUrl(record.pageUrl)) &&
      nullableString(record.origin) &&
      isString(record.method, 32) &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(record.method) &&
      isUrl(record.url) &&
      isHeaders(record.requestHeaders) &&
      isHeaders(record.responseHeaders) &&
      isBody(record.requestBody) &&
      isBody(record.responseBody) &&
      (record.status === null || (isSize(record.status) && record.status <= 599)) &&
      nullableString(record.statusText) &&
      optionalString(record.resourceType) &&
      optionalString(record.mimeType) &&
      optionalString(record.error) &&
      isTimestamp(record.startedAt) &&
      isTimestamp(record.completedAt) &&
      (record.durationMs === null ||
        (typeof record.durationMs === "number" &&
          Number.isFinite(record.durationMs) &&
          record.durationMs >= 0)) &&
      isMetadata(record.metadata)
    )
  } catch {
    return false
  }
}
