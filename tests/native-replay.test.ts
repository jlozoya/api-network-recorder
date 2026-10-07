import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { gzipSync } from "node:zlib"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { buildReplayPlan, previewReplay, replayInputSchema, sendReplay } from "../native/replay.ts"
import { configSchema, replayOriginSchema } from "../native/config.ts"
import { configureReplay } from "../native/replay-tools.ts"
import type { NetworkRecord } from "../src/core/network-types.ts"

const profileId = randomUUID()
const captured = (url: string, overrides: Partial<NetworkRecord> = {}): NetworkRecord => ({
  id: "source",
  source: "debugger",
  tabId: 1,
  pageUrl: url,
  origin: new URL(url).origin,
  method: "POST",
  url,
  requestHeaders: {
    "Content-Type": "application/json",
    Cookie: "account=owner-fixture",
    "X-CSRF-Token": "owner-csrf-fixture",
    "Content-Length": "99",
    Host: "old.test",
    ":authority": "old.test",
    ":method": "POST",
    "Accept-Encoding": "gzip",
    "Sec-Fetch-Site": "same-origin",
  },
  requestBody: { kind: "json", value: { price: 100 }, truncated: false, sizeBytes: 13 },
  status: 200,
  statusText: "OK",
  responseHeaders: { "set-cookie": "owner-secret-fixture" },
  responseBody: { kind: "json", value: { permitted: true }, truncated: false, sizeBytes: 18 },
  startedAt: "2026-10-01T00:00:00.000Z",
  completedAt: "2026-10-01T00:00:01.000Z",
  durationMs: 1000,
  ...overrides,
})
const input = (extra: object = {}) =>
  replayInputSchema.parse({
    profileId,
    request: { id: "source" },
    authentication: {
      mode: "captured",
      request: { id: "staff" },
      headerNames: ["cookie", "x-csrf-token"],
    },
    ...extra,
  })
const auth = (url: string) =>
  captured(url, {
    id: "staff",
    requestHeaders: { Cookie: "account=staff-fixture", "X-CSRF-Token": "staff-csrf-fixture" },
  })

test("replay credentials come exclusively from the explicit authentication record", () => {
  const url = "https://example.test/api/products"
  const plan = buildReplayPlan(input({ body: '{"price":101}' }), captured(url), auth(url))
  expect(plan.headers.cookie).toBe("account=staff-fixture")
  expect(plan.headers["x-csrf-token"]).toBe("staff-csrf-fixture")
  expect(plan.headers.host).toBeUndefined()
  expect(plan.headers[":authority"]).toBeUndefined()
  expect(plan.headers["content-length"]).toBeUndefined()
  expect(plan.headers["sec-fetch-site"]).toBeUndefined()
  expect(JSON.stringify(previewReplay(plan, true))).not.toContain("staff-fixture")
  expect(
    buildReplayPlan(input({ authentication: { mode: "none" } }), captured(url)).headers.cookie,
  ).toBeUndefined()
  expect(() =>
    buildReplayPlan(input({ headers: { Cookie: "injected" } }), captured(url), auth(url)),
  ).toThrow("authentication")
  expect(() => buildReplayPlan(input(), captured(url), auth("https://other.test/api"))).toThrow(
    "same origin",
  )
  expect(() =>
    buildReplayPlan(input({ url: "https://other.test/api" }), captured(url), auth(url)),
  ).toThrow("same origin")
  expect(() =>
    buildReplayPlan(
      input({ headers: { "x-test": "a\r\nInjected: yes" } }),
      captured(url),
      auth(url),
    ),
  ).toThrow()
})

test("replay refuses incomplete captures and fingerprints edits and auth snapshots", () => {
  const url = "https://example.test/api"
  const incomplete = captured(url, {
    requestBody: {
      kind: "text",
      value: "partial",
      truncated: true,
      sizeBytes: 99,
    },
  })
  expect(() => buildReplayPlan(input(), incomplete, auth(url))).toThrow("truncated")
  expect(() => buildReplayPlan(input(), captured(url, { requestBody: null }), auth(url))).toThrow(
    "missing",
  )
  expect(buildReplayPlan(input({ body: null }), incomplete, auth(url)).body).toBeNull()
  const original = buildReplayPlan(input(), captured(url), auth(url))
  expect(
    buildReplayPlan(input({ body: '{"price":102}' }), captured(url), auth(url)).requestHash,
  ).not.toBe(original.requestHash)
  expect(
    buildReplayPlan(input(), captured(url), {
      ...auth(url),
      requestHeaders: {
        Cookie: "different-staff",
        "X-CSRF-Token": "staff-csrf-fixture",
      },
    }).requestHash,
  ).not.toBe(original.requestHash)
})

test("old installations deny replay by default and origin scopes are exact", () => {
  const config = configSchema.parse({
    token: "0".repeat(64),
    extensionIds: ["a".repeat(32)],
    allowControls: true,
  })
  expect(config.allowReplay).toBe(false)
  expect(config.replayOrigins).toEqual([])
  for (const value of [
    "https://example.test/",
    "https://example.test/path",
    "https://user:pass@example.test",
    "file:///tmp",
    "https://example.test?query",
    "https://example.test#fragment",
  ])
    expect(replayOriginSchema.safeParse(value).success).toBe(false)
  expect(replayOriginSchema.parse("https://example.test")).toBe("https://example.test")
})

test("replay configuration grants explicit origins and preserves capture access and identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "recorder-replay-config-"))
  const previous = process.env.API_RECORDER_HOME
  try {
    process.env.API_RECORDER_HOME = directory
    const file = join(directory, "bridge.json")
    const original = { token: "0".repeat(64), extensionIds: ["a".repeat(32)], allowControls: false }
    writeFileSync(file, JSON.stringify(original))
    expect(() => configureReplay(true, [])).toThrow("at least one")
    expect(() => configureReplay(true, ["https://example.test/path"])).toThrow()
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original)
    configureReplay(true, ["https://example.test"])
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      ...original,
      allowReplay: true,
      replayOrigins: ["https://example.test"],
    })
    configureReplay(false, [])
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      ...original,
      allowReplay: false,
      replayOrigins: [],
    })
  } finally {
    if (previous === undefined) delete process.env.API_RECORDER_HOME
    else process.env.API_RECORDER_HOME = previous
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test path")
    rmSync(directory, { recursive: true, force: true })
  }
})

test("native replay sends one request, returns redirects, caps decoded bodies and times out", async () => {
  const requests: Array<{ url: string; cookie: string | undefined; body: string }> = []
  const server = createServer(async (request, response) => {
    let data = ""
    for await (const chunk of request) data += chunk
    requests.push({ url: request.url!, cookie: request.headers.cookie, body: data })
    if (request.url === "/redirect") {
      response.writeHead(302, {
        location: "/must-not-follow",
        "set-cookie": "session=secret-fixture",
      })
      response.end()
    } else if (request.url === "/large") {
      response.writeHead(200, { "content-encoding": "gzip" })
      response.end(gzipSync("x".repeat(4000)))
    } else if (request.url === "/slow") {
      response.writeHead(200)
      response.write("partial")
    } else if (request.url === "/utf8") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.end("á")
    } else if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.end(Buffer.from([0, 255, 254]))
    } else {
      response.writeHead(403, { "content-type": "application/json" })
      response.end(JSON.stringify({ permitted: false }))
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const origin = "http://127.0.0.1:" + address.port
  try {
    const run = (path: string, options: object = {}) =>
      sendReplay(buildReplayPlan(input(options), captured(origin + path), auth(origin + "/auth")))
    const result = await run("/api", { body: '{"price":101}' })
    expect(result.record.status).toBe(403)
    expect(result.record.responseBody?.kind).toBe("json")
    expect(requests[0]).toEqual({
      url: "/api",
      cookie: "account=staff-fixture",
      body: '{"price":101}',
    })
    expect(result.comparison.differences.some((item) => item.path === "/status")).toBe(true)
    expect(JSON.stringify(result)).not.toContain("owner-fixture")
    expect(JSON.stringify(result)).not.toContain("staff-fixture")
    const redirect = await run("/redirect")
    expect(redirect.record.status).toBe(302)
    expect(redirect.record.responseHeaders["set-cookie"]).toBe("[REDACTED]")
    expect(requests.some((item) => item.url === "/must-not-follow")).toBe(false)
    const large = await run("/large", { maxResponseBytes: 100 })
    expect(large.record.responseBody).toMatchObject({ truncated: true, sizeBytes: 100 })
    const slow = await run("/slow", { timeoutMs: 100 })
    expect(slow.record.error).toBe("Replay timed out")
    const utf8 = await run("/utf8", { maxResponseBytes: 1 })
    expect(utf8.record.responseBody).toMatchObject({ kind: "text", value: "", truncated: true })
    const binary = await run("/binary")
    expect(binary.record.responseBody).toMatchObject({
      kind: "binary",
      value: Buffer.from([0, 255, 254]).toString("base64"),
      truncated: false,
    })
    expect(requests).toHaveLength(6)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
