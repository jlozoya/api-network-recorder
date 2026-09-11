import { groupRecordsByEndpoint, inferJsonSchema, type EndpointGroup } from "./endpoint-utils.js"
import type { CapturedBody, HeaderMap, NetworkRecord } from "./network-types.js"

const header = (headers: HeaderMap, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
const contentFor = (records: NetworkRecord[], side: "request" | "response") => {
  const content: Record<string, { schema: unknown; examples: Record<string, { value: unknown }> }> =
    Object.create(null)
  for (const record of records) {
    const body: CapturedBody | null = side === "request" ? record.requestBody : record.responseBody
    if (!body || body.kind === "unavailable" || body.kind === "binary" || body.truncated) continue
    const headers = side === "request" ? record.requestHeaders : record.responseHeaders
    const mime = (
      header(headers, "content-type") ??
      (side === "response" ? record.mimeType : null) ??
      (body.kind === "json"
        ? "application/json"
        : body.kind === "form-data"
          ? "multipart/form-data"
          : "text/plain")
    )
      .split(";")[0]!
      .trim()
      .toLowerCase()
    if (!mime.includes("/")) continue
    const schema = inferJsonSchema(body.value)
    const entry = (content[mime] ??= { schema, examples: Object.create(null) })
    const schemas =
      "anyOf" in (entry.schema as object)
        ? (entry.schema as { anyOf: unknown[] }).anyOf
        : [entry.schema]
    if (!schemas.some((item) => JSON.stringify(item) === JSON.stringify(schema)))
      entry.schema = { anyOf: [...schemas, schema] }
    if (
      Object.keys(entry.examples).length < 5 &&
      !Object.values(entry.examples).some(
        (item) => JSON.stringify(item.value) === JSON.stringify(body.value),
      )
    )
      entry.examples["sample" + (Object.keys(entry.examples).length + 1)] = { value: body.value }
  }
  return Object.keys(content).length ? { content } : {}
}

// A document represents exactly one origin. Never silently overwrite a foreign API.
export const exportOpenApiDraft = (input: EndpointGroup[]): string => {
  const groups = groupRecordsByEndpoint(input.flatMap((group) => group.records))
  const origins = [...new Set(groups.map((group) => group.origin))]
  if (origins.length > 1)
    throw new Error("Select one API origin or export separate OpenAPI documents.")
  const paths: Record<string, Record<string, unknown>> = Object.create(null)
  for (const group of groups) {
    const method = group.method.toLowerCase()
    if (
      !["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(method) ||
      !group.normalizedPath.startsWith("/")
    )
      continue
    const parameters: unknown[] = [...group.normalizedPath.matchAll(/\{([^}]+)\}/g)].map(
      (match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }),
    )
    const query = new Map<string, string[]>()
    for (const record of group.records) {
      try {
        for (const [key, value] of new URL(record.url).searchParams) {
          const values = query.get(key) ?? []
          if (!values.includes(value)) values.push(value)
          query.set(key, values)
        }
      } catch {}
    }
    for (const [name, values] of query)
      parameters.push({
        name,
        in: "query",
        required: false,
        schema: { type: "string" },
        example: values[0],
      })
    const responses: Record<string, unknown> = Object.create(null)
    for (const status of group.statuses.filter((status) => status >= 100 && status <= 599)) {
      const samples = group.records.filter((record) => record.status === status)
      responses[String(status)] = {
        description: "Observed " + status,
        ...(status === 204 || status === 304 || method === "head"
          ? {}
          : contentFor(samples, "response")),
      }
    }
    if (!Object.keys(responses).length)
      responses.default = { description: "No HTTP response was captured." }
    const requestBody = contentFor(group.records, "request")
    paths[group.normalizedPath] ??= Object.create(null)
    paths[group.normalizedPath]![method] = {
      summary: group.method + " " + group.normalizedPath,
      description: "Inferred from " + group.count + " observed calls. Review schemas before use.",
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody.content ? { requestBody } : {}),
      responses,
    }
  }
  return JSON.stringify(
    {
      openapi: "3.1.0",
      info: { title: "Observed API \u2014 " + (origins[0] ?? "empty"), version: "0.1.0" },
      servers: origins.map((url) => ({ url })),
      paths,
    },
    null,
    2,
  )
}

export const exportOpenApiDrafts = (
  groups: EndpointGroup[],
): Array<{ origin: string; filename: string; content: string }> => {
  const byOrigin = new Map<string, EndpointGroup[]>()
  for (const group of groupRecordsByEndpoint(groups.flatMap((group) => group.records))) {
    const entries = byOrigin.get(group.origin) ?? []
    entries.push(group)
    byOrigin.set(group.origin, entries)
  }
  return [...byOrigin].map(([origin, entries], index) => ({
    origin,
    filename: "openapi-" + (index + 1) + "-" + origin.replace(/[^a-z0-9.-]/gi, "_") + ".json",
    content: exportOpenApiDraft(entries),
  }))
}
