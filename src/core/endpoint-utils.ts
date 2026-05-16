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

    return parsed.pathname
      .split("/")
      .map((part) => {
        if (!part) return part

        if (UUID_RE.test(part)) return "{uuid}"
        if (OBJECT_ID_RE.test(part)) return "{id}"
        if (NUMERIC_ID_RE.test(part)) return "{id}"
        if (HASH_RE.test(part)) return "{token}"

        return part
      })
      .join("/")
  } catch {
    return url
  }
}

export const getRecordOrigin = (record: NetworkRecord): string => {
  if (record.origin) {
    return record.origin
  }

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

  for (const record of records) {
    const origin = getRecordOrigin(record)
    const normalizedPath = normalizeEndpointPath(record.url)
    const key = `${record.method.toUpperCase()} ${origin}${normalizedPath}`
    const existing = groups.get(key)
    const status = record.status
    const duration = record.durationMs

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
    existing.lastSeenAt = record.completedAt

    if (typeof status === "number" && !existing.statuses.includes(status)) {
      existing.statuses.push(status)
      existing.statuses.sort((a, b) => a - b)
    }

    const durations = existing.records
      .map((item) => item.durationMs)
      .filter((item): item is number => typeof item === "number")

    existing.averageDurationMs = durations.length
      ? Math.round(durations.reduce((sum, item) => sum + item, 0) / durations.length)
      : null
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

const bodyToSchema = (body: CapturedBody | null): unknown => {
  if (!body || body.kind !== "json") {
    return undefined
  }

  return inferJsonSchema(body.value)
}

const inferJsonSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? inferJsonSchema(value[0]) : {},
    }
  }

  if (value === null) {
    return {
      nullable: true,
    }
  }

  if (typeof value === "object") {
    const properties: Record<string, unknown> = {}
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

export const exportOpenApiDraft = (groups: EndpointGroup[]): string => {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const group of groups) {
    const sample = getBestResponseSample(group.records)
    const path = group.normalizedPath.replaceAll("{id}", "{id}").replaceAll("{uuid}", "{uuid}")
    const method = group.method.toLowerCase()

    paths[path] ??= {}
    paths[path][method] = {
      summary: `${group.method} ${group.normalizedPath}`,
      description: `Observed ${group.count} call(s) from local browser traffic.`,
      responses: Object.fromEntries(
        (group.statuses.length ? group.statuses : [200]).map((status) => [
          String(status),
          {
            description: `Observed ${status}`,
            content: {
              "application/json": {
                schema: bodyToSchema(sample?.responseBody ?? null) ?? {},
                example: bodyToExample(sample?.responseBody ?? null),
              },
            },
          },
        ]),
      ),
    }
  }

  return JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "Observed API",
        version: "0.1.0",
      },
      paths,
    },
    null,
    2,
  )
}
