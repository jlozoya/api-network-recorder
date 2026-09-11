import type { CapturedBody, NetworkRecord } from "./network-types.js"

export interface EndpointGroup {
  key: string
  method: string
  origin: string
  path: string
  normalizedPath: string
  count: number
  records: NetworkRecord[]
  statuses: number[]
  firstSeenAt: string
  lastSeenAt: string
  averageDurationMs: number | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i
const NUMERIC_ID_RE = /^\d+$/
const HASH_RE = /^[A-Za-z0-9_-]{18,}$/

export const isProbablyApiRecord = (record: NetworkRecord): boolean => {
  const resourceType = record.resourceType?.toLowerCase() ?? ""
  const mimeType = record.mimeType?.toLowerCase() ?? ""
  const url = record.url.toLowerCase()

  if (resourceType === "fetch" || resourceType === "xhr") {
    return true
  }

  if (resourceType === "xmlhttprequest") {
    return true
  }

  if (mimeType.includes("application/json") || mimeType.includes("application/graphql")) {
    return true
  }

  if (
    url.endsWith(".js") ||
    url.endsWith(".css") ||
    url.endsWith(".png") ||
    url.endsWith(".jpg") ||
    url.endsWith(".jpeg") ||
    url.endsWith(".webp") ||
    url.endsWith(".svg") ||
    url.endsWith(".ico") ||
    url.endsWith(".woff") ||
    url.endsWith(".woff2") ||
    url.endsWith(".map")
  ) {
    return false
  }

  return url.includes("/api/") || url.includes("/graphql")
}

export const normalizeEndpointPath = (url: string): string => {
  try {
    const parsed = new URL(url)

    const names = new Map<string, number>()
    const parameter = (name: string) => {
      const count = (names.get(name) ?? 0) + 1
      names.set(name, count)
      return `{${name}${count > 1 ? count : ""}}`
    }
    return parsed.pathname
      .split("/")
      .map((part) => {
        if (!part) return part

        if (UUID_RE.test(part)) return parameter("uuid")
        if (OBJECT_ID_RE.test(part)) return parameter("id")
        if (NUMERIC_ID_RE.test(part)) return parameter("id")
        if (HASH_RE.test(part)) return parameter("token")

        return part
      })
      .join("/")
  } catch {
    return url
  }
}

export const getRecordOrigin = (record: NetworkRecord): string => {
  try {
    return new URL(record.url).origin
  } catch {
    return "unknown"
  }
}

export const getRecordPath = (record: NetworkRecord): string => {
  try {
    return new URL(record.url).pathname
  } catch {
    return record.url
  }
}

export const groupRecordsByEndpoint = (records: NetworkRecord[]): EndpointGroup[] => {
  const groups = new Map<string, EndpointGroup>()
  const totals = new Map<string, { sum: number; count: number }>()

  for (const record of records) {
    const origin = getRecordOrigin(record)
    const normalizedPath = normalizeEndpointPath(record.url)
    const key = `${record.method.toUpperCase()} ${origin}${normalizedPath}`
    const existing = groups.get(key)
    const status = record.status
    const duration = record.durationMs
    const total = totals.get(key) ?? { sum: 0, count: 0 }
    if (typeof duration === "number") {
      total.sum += duration
      total.count++
    }
    totals.set(key, total)

    if (!existing) {
      groups.set(key, {
        key,
        method: record.method.toUpperCase(),
        origin,
        path: getRecordPath(record),
        normalizedPath,
        count: 1,
        records: [record],
        statuses: typeof status === "number" ? [status] : [],
        firstSeenAt: record.startedAt,
        lastSeenAt: record.completedAt,
        averageDurationMs: typeof duration === "number" ? duration : null,
      })

      continue
    }

    existing.count += 1
    existing.records.push(record)
    existing.firstSeenAt =
      existing.firstSeenAt < record.startedAt ? existing.firstSeenAt : record.startedAt
    existing.lastSeenAt =
      existing.lastSeenAt > record.completedAt ? existing.lastSeenAt : record.completedAt

    if (typeof status === "number" && !existing.statuses.includes(status)) {
      existing.statuses.push(status)
      existing.statuses.sort((a, b) => a - b)
    }

    existing.averageDurationMs = total.count ? Math.round(total.sum / total.count) : null
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count)
}

export const hasCapturedBody = (body: CapturedBody | null): boolean => {
  return Boolean(body && body.kind !== "unavailable")
}

export const getBestRequestSample = (records: NetworkRecord[]): NetworkRecord | undefined => {
  return records.find((record) => hasCapturedBody(record.requestBody)) ?? records[0]
}

export const getBestResponseSample = (records: NetworkRecord[]): NetworkRecord | undefined => {
  return records.find((record) => hasCapturedBody(record.responseBody)) ?? records[0]
}

const bodyToExample = (body: CapturedBody | null): unknown => {
  if (!body) return null

  if (body.kind === "json" || body.kind === "form-data") {
    return body.value
  }

  if (body.kind === "text") {
    return body.value
  }

  if (body.kind === "binary") {
    return "[binary]"
  }

  return body.reason
}

export const inferJsonSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? inferJsonSchema(value[0]) : {},
    }
  }

  if (value === null) {
    return {
      type: "null",
    }
  }

  if (typeof value === "object") {
    const properties: Record<string, unknown> = Object.create(null)
    const required: string[] = []

    for (const [key, itemValue] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = inferJsonSchema(itemValue)

      if (itemValue !== null && itemValue !== undefined) {
        required.push(key)
      }
    }

    return {
      type: "object",
      properties,
      required,
    }
  }

  return {
    type: typeof value,
  }
}

export const exportEndpointMarkdown = (groups: EndpointGroup[]): string => {
  return groups
    .map((group) => {
      const requestSample = getBestRequestSample(group.records)
      const responseSample = getBestResponseSample(group.records)
      const requestExample = bodyToExample(requestSample?.requestBody ?? null)
      const responseExample = bodyToExample(responseSample?.responseBody ?? null)

      return [
        `## ${group.method} ${group.normalizedPath}`,
        "",
        `**Origin:** ${group.origin}`,
        `**Observed calls:** ${group.count}`,
        `**Observed statuses:** ${group.statuses.length ? group.statuses.join(", ") : "n/a"}`,
        `**Average duration:** ${group.averageDurationMs ?? "n/a"}ms`,
        "",
        "### Sample request",
        "",
        "```json",
        JSON.stringify(requestExample, null, 2),
        "```",
        "",
        "### Sample response",
        "",
        "```json",
        JSON.stringify(responseExample, null, 2),
        "```",
      ].join("\n")
    })
    .join("\n\n---\n\n")
}

export { exportOpenApiDraft, exportOpenApiDrafts } from "./export-openapi.js"
