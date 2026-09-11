import type { NetworkRecord } from "./network-types.js"
export interface RecordDifference {
  path: string
  kind: "added" | "removed" | "changed"
  before: unknown
  after: unknown
}
const headers = (value: Record<string, string>) =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]))
const query = (url: string) => {
  const result: Record<string, string[]> = Object.create(null)
  try {
    for (const [key, value] of new URL(url).searchParams) (result[key] ??= []).push(value)
  } catch {}
  return result
}
const comparable = (record: NetworkRecord) => ({
  method: record.method,
  url: record.url,
  status: record.status,
  error: record.error ?? null,
  parameters: query(record.url),
  requestHeaders: headers(record.requestHeaders),
  requestBody: record.requestBody,
  responseHeaders: headers(record.responseHeaders),
  responseBody: record.responseBody,
})
export const compareRecords = (
  before: NetworkRecord,
  after: NetworkRecord,
  limit = 1000,
): { differences: RecordDifference[]; truncated: boolean } => {
  const differences: RecordDifference[] = []
  let truncated = false
  const walk = (
    a: unknown,
    b: unknown,
    path: string,
    hasA = true,
    hasB = true,
    depth = 0,
  ): void => {
    if (Object.is(a, b) && hasA === hasB) return
    if (differences.length >= limit) {
      truncated = true
      return
    }
    if (
      hasA &&
      hasB &&
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object" &&
      Array.isArray(a) === Array.isArray(b) &&
      depth < 50
    ) {
      const left = a as Record<string, unknown>,
        right = b as Record<string, unknown>
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(
          left[key],
          right[key],
          path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
          Object.hasOwn(left, key),
          Object.hasOwn(right, key),
          depth + 1,
        )
        if (truncated) break
      }
      return
    }
    differences.push({
      path,
      kind: !hasA ? "added" : !hasB ? "removed" : "changed",
      before: a,
      after: b,
    })
  }
  walk(comparable(before), comparable(after), "")
  return { differences, truncated }
}
