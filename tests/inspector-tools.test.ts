import { expect, test } from "bun:test"
import {
  groupRecordsByEndpoint,
  exportOpenApiDraft,
  exportOpenApiDrafts,
  normalizeEndpointPath,
} from "../src/core/endpoint-utils.ts"
import { recordToCurl } from "../src/core/export-curl.ts"
import { compareRecords } from "../src/core/compare-records.ts"
import { toRecordPreview } from "../src/core/record-preview.ts"
import type { NetworkRecord } from "../src/core/network-types.ts"

const json = (value: unknown) => ({ kind: "json" as const, value, sizeBytes: 10, truncated: false })
const record = (changes: Partial<NetworkRecord> = {}): NetworkRecord => ({
  id: "one",
  source: "fetch",
  tabId: 1,
  pageUrl: "https://page.test",
  origin: "https://page.test",
  method: "POST",
  url: "https://api.test/users/1",
  requestHeaders: {},
  responseHeaders: {},
  requestBody: json({ name: "Ada" }),
  responseBody: json({ ok: true }),
  status: 200,
  statusText: "OK",
  startedAt: "2026-09-10T00:00:00Z",
  completedAt: "2026-09-10T00:00:01Z",
  durationMs: 1000,
  ...changes,
})
test("OpenAPI splits origins and refuses an ambiguous single document", () => {
  const groups = groupRecordsByEndpoint([
    record(),
    record({ url: "https://other.test/users/2", responseBody: json({ other: true }) }),
  ])
  expect(groups).toHaveLength(2)
  expect(() => exportOpenApiDraft(groups)).toThrow("Select one API origin")
  const drafts = exportOpenApiDrafts(groups)
  expect(drafts).toHaveLength(2)
  expect(JSON.parse(drafts[0]!.content).servers).toEqual([{ url: "https://api.test" }])
  expect(
    JSON.parse(drafts[1]!.content).paths["/users/{id}"].post.responses[200].content[
      "application/json"
    ].examples.sample1.value,
  ).toEqual({ other: true })
})
test("OpenAPI response examples stay with their status and content type", () => {
  const groups = groupRecordsByEndpoint([
    record(),
    record({
      status: 400,
      responseHeaders: { "Content-Type": "text/plain; charset=utf-8" },
      responseBody: { kind: "text", value: "Invalid", sizeBytes: 7, truncated: false },
    }),
  ])
  const operation = JSON.parse(exportOpenApiDraft(groups)).paths["/users/{id}"].post
  expect(operation.responses[200].content["application/json"].examples.sample1.value).toEqual({
    ok: true,
  })
  expect(operation.responses[400].content["text/plain"].examples.sample1.value).toBe("Invalid")
  expect(operation.responses[400].content["application/json"]).toBeUndefined()
  expect(operation.requestBody.content["application/json"]).toBeDefined()
})
test("OpenAPI declares distinct path parameters and observed query parameters", () => {
  const url = "https://api.test/users/1/items/2?tag=a&tag=b"
  expect(normalizeEndpointPath(url)).toBe("/users/{id}/items/{id2}")
  const operation = JSON.parse(exportOpenApiDraft(groupRecordsByEndpoint([record({ url })]))).paths[
    "/users/{id}/items/{id2}"
  ].post
  expect(operation.parameters.map((item) => item.name)).toEqual(["id", "id2", "tag"])
  expect(operation.parameters[0].required).toBe(true)
})
test("OpenAPI represents null with JSON Schema and preserves hostile property names", () => {
  const value = JSON.parse('{"__proto__":null}')
  const document = JSON.parse(
    exportOpenApiDraft(groupRecordsByEndpoint([record({ responseBody: json(value) })])),
  )
  expect(
    document.paths["/users/{id}"].post.responses[200].content["application/json"].schema.properties
      .__proto__,
  ).toEqual({ type: "null" })
})
test("OpenAPI does not fabricate 200 or examples for missing/truncated bodies", () => {
  const operation = JSON.parse(
    exportOpenApiDraft(
      groupRecordsByEndpoint([
        record({ status: null, responseBody: { kind: "unavailable", reason: "No body" } }),
      ]),
    ),
  ).paths["/users/{id}"].post
  expect(operation.responses[200]).toBeUndefined()
  expect(operation.responses.default.content).toBeUndefined()
  const truncated = record({
    responseBody: { ...json({ cut: true }), truncated: true },
    status: 204,
  })
  expect(
    JSON.parse(exportOpenApiDraft(groupRecordsByEndpoint([truncated]))).paths["/users/{id}"].post
      .responses[204].content,
  ).toBeUndefined()
})
test("endpoint dates and duration are independent of input order", () => {
  const entries = [
    record(),
    record({
      startedAt: "2026-09-09T00:00:00Z",
      completedAt: "2026-09-09T00:00:01Z",
      durationMs: null,
    }),
    record({ durationMs: 2000 }),
  ]
  const [group] = groupRecordsByEndpoint(entries)
  expect(group!.firstSeenAt).toBe("2026-09-09T00:00:00Z")
  expect(group!.lastSeenAt).toBe("2026-09-10T00:00:01Z")
  expect(group!.averageDurationMs).toBe(1500)
})
test("cURL reconstructs multipart with literal values and an automatic boundary", () => {
  const command = recordToCurl(
    record({
      requestHeaders: {
        "Content-Type": "multipart/form-data; boundary=old",
        "Content-Length": "999",
        "X-Test": "it's ok",
      },
      requestBody: {
        kind: "form-data",
        value: { field: "@literal;type=text/plain" },
        sizeBytes: 1,
        truncated: false,
      },
    }),
  )
  expect(command).toContain("--form-string 'field=@literal;type=text/plain'")
  expect(command).not.toContain("boundary=old")
  expect(command).not.toContain("Content-Length")
  expect(command).toContain("it'\\''s ok")
})
test("cURL retains urlencoded forms and explicitly selects PowerShell native argument handling", () => {
  const request = record({
    requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
    requestBody: { kind: "form-data", value: { name: "a & b" }, sizeBytes: 1, truncated: false },
  })
  expect(recordToCurl(request)).toContain("--data-raw 'name=a+%26+b'")
  const command = recordToCurl(
    record({ requestBody: json({ name: "O'Brien", unicode: "\u00E1" }) }),
    "powershell",
  )
  expect(command).toContain("curl.exe")
  expect(command).toContain("$PSNativeCommandArgumentPassing = 'Standard'")
  expect(command).toContain("O''Brien")
  expect(command).toContain('"unicode":"\u00E1"')
})
test("comparison normalizes header casing and preserves repeated parameters", () => {
  const before = record({
    requestHeaders: { Authorization: "a" },
    url: "https://api.test/?tag=a&tag=b",
  })
  const after = record({
    requestHeaders: { authorization: "a" },
    url: "https://api.test/?tag=a&tag=c",
    responseBody: json({ ok: false }),
  })
  const changes = compareRecords(before, after).differences
  expect(changes.some((item) => item.path.startsWith("/requestHeaders"))).toBe(false)
  expect(changes.find((item) => item.path === "/parameters/tag/1")?.after).toBe("c")
  expect(changes.find((item) => item.path === "/responseBody/value/ok")?.before).toBe(true)
})
test("comparison distinguishes added, removed, null and absent; limits large output", () => {
  const result = compareRecords(
    record({ requestBody: json({ deleted: 1, nullish: null }) }),
    record({ requestBody: json({ added: 2 }) }),
  )
  expect(result.differences.find((item) => item.path.endsWith("/deleted"))?.kind).toBe("removed")
  expect(result.differences.find((item) => item.path.endsWith("/added"))?.kind).toBe("added")
  expect(compareRecords(record(), record({ method: "GET", status: 500 }), 1).truncated).toBe(true)
})
test("list previews omit bodies but preserve availability and pins", () => {
  const preview = toRecordPreview(record(), true)
  expect(preview.requestBody).toBeNull()
  expect(preview.responseBody).toBeNull()
  expect(preview.hasResponseBody).toBe(true)
  expect(preview.pinned).toBe(true)
  expect(preview.detailsLoaded).toBe(false)
})
