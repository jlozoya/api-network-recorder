import { expect, test } from "bun:test"
import { isPageNetworkRecordMessage as valid } from "../src/core/record-validation.ts"
import { MAX_BODY_SIZE_BYTES as LIMIT } from "../src/core/constants.ts"
import { pageMessage } from "./record-fixture.ts"

test("accepts valid page records", () => {
  expect(valid(pageMessage())).toBe(true)
})
for (const [field, value] of [
  ["url", 123],
  ["url", "not a URL"],
  ["method", "GET; command"],
  ["startedAt", "yesterday"],
  ["completedAt", "2026-02-30T00:00:00.000Z"],
  ["status", "200"],
  ["durationMs", -1],
  ["requestHeaders", { foo: 123 }],
  ["source", "debugger"],
  ["tabId", 42],
  ["unknownField", {}],
  ["responseBody", { kind: "text", value: {}, truncated: false, sizeBytes: 0 }],
  [
    "responseBody",
    { kind: "text", value: "a".repeat(LIMIT + 1), truncated: true, sizeBytes: LIMIT + 1 },
  ],
  ["responseBody", { kind: "binary", value: "!!!!", truncated: false, sizeBytes: 3 }],
] as const) {
  test("rejects invalid " + field + " (" + typeof value + ")", () => {
    const message = pageMessage()
    Object.assign(message.payload, { [field]: value })
    expect(valid(message)).toBe(false)
  })
}
test("rejects missing required fields", () => {
  const message = pageMessage()
  delete message.payload.requestBody
  expect(valid(message)).toBe(false)
})
test("rejects cycles and excessive nesting without throwing", () => {
  const message = pageMessage()
  message.payload.requestBody.value.self = message.payload
  expect(valid(message)).toBe(false)
  let value = {}
  for (let i = 0; i < 40; i++) value = { child: value }
  message.payload.requestBody.value = value
  expect(valid(message)).toBe(false)
})
test("accepts supported body variants", () => {
  for (const body of [
    null,
    { kind: "unavailable", reason: "unavailable" },
    { kind: "binary", value: "QQ==", truncated: false, sizeBytes: 1 },
    { kind: "form-data", value: { password: "FAKE_PASSWORD" }, truncated: false, sizeBytes: 25 },
  ]) {
    const message = pageMessage()
    message.payload.responseBody = body
    expect(valid(message)).toBe(true)
  }
})
