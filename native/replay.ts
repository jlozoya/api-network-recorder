import { createHash, randomUUID } from "node:crypto"
import { request as httpRequest, validateHeaderName, validateHeaderValue } from "node:http"
import { request as httpsRequest } from "node:https"
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib"
import type { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { z } from "zod"
import type { NetworkRecord, CapturedBody, HeaderMap } from "../src/core/network-types.js"
import { compareRecords } from "../src/core/compare-records.js"
import { profileIdSchema } from "./config.js"

const MAX_BODY = 1024 * 1024
const MAX_HEADERS = 64 * 1024
const secretHeader = (name: string) =>
  /authorization|cookie|token|csrf|api[-_]?key|session/i.test(name)
const managedHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
  "te",
  "trailer",
  "accept-encoding",
])
const headerSchema = z
  .record(z.string().max(256), z.string().max(MAX_HEADERS))
  .refine((value) => Object.keys(value).length <= 128, "Too many headers")
const referenceSchema = z
  .object({
    id: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .strict()
export const replayInputSchema = z
  .object({
    profileId: profileIdSchema,
    request: referenceSchema,
    authentication: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }).strict(),
      z
        .object({
          mode: z.literal("captured"),
          request: referenceSchema,
          headerNames: z.array(z.string().min(1).max(256)).min(1).max(32),
        })
        .strict(),
    ]),
    url: z.string().max(16384).optional(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
    // These replace/remove non-credential headers. Credentials only come from the explicit auth record.
    headers: headerSchema.optional(),
    removeHeaders: z.array(z.string().max(256)).max(128).optional(),
    // null explicitly clears the body; omitted uses the complete captured body.
    body: z.string().max(MAX_BODY).nullable().optional(),
    timeoutMs: z.number().int().min(100).max(20000).default(10000),
    maxResponseBytes: z.number().int().min(1).max(MAX_BODY).default(MAX_BODY),
  })
  .strict()
export type ReplayInput = z.infer<typeof replayInputSchema>
export interface ReplayPlan {
  url: string
  method: string
  headers: HeaderMap
  body: string | null
  requestHash: string
  input: ReplayInput
  original: NetworkRecord
}

const requestUrl = (value: string) => {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("Replay requires an HTTP(S) URL without credentials or fragment")
  return url
}
const checkedHeaders = (headers: HeaderMap): HeaderMap => {
  const result: HeaderMap = Object.create(null)
  for (const [name, value] of Object.entries(headers)) {
    validateHeaderName(name)
    validateHeaderValue(name, value)
    const key = name.toLowerCase()
    if (Object.hasOwn(result, key)) throw new Error("Duplicate header: " + key)
    result[key] = value
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_HEADERS)
    throw new Error("Request headers exceed 64 KiB")
  return result
}
const captureHeaders = (headers: HeaderMap) =>
  checkedHeaders(
    Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(":"))),
  )
export const redactHeaders = (headers: HeaderMap, extra: string[] = []): HeaderMap =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      secretHeader(key) || extra.includes(key.toLowerCase()) ? "[REDACTED]" : value,
    ]),
  )

const capturedBody = (record: NetworkRecord): string | null => {
  const body = record.requestBody
  if (!body) {
    if (!["GET", "HEAD", "OPTIONS"].includes(record.method.toUpperCase()))
      throw new Error("Captured request body is missing; supply body explicitly (null for no body)")
    return null
  }
  if (body.kind === "unavailable" || body.truncated)
    throw new Error("Captured request body is unavailable or truncated; supply a complete body")
  if (body.kind === "text") return body.value
  if (body.kind === "json") return JSON.stringify(body.value)
  if (
    body.kind === "form-data" &&
    /application\/x-www-form-urlencoded/i.test(
      Object.entries(record.requestHeaders).find(
        ([k]) => k.toLowerCase() === "content-type",
      )?.[1] ?? "",
    )
  )
    return new URLSearchParams(body.value).toString()
  throw new Error("Binary/multipart captures require an explicit replacement body")
}

export const buildReplayPlan = (
  input: ReplayInput,
  original: NetworkRecord,
  auth?: NetworkRecord,
): ReplayPlan => {
  const sourceUrl = requestUrl(original.url)
  const target = requestUrl(input.url ?? original.url)
  if (sourceUrl.origin !== target.origin)
    throw new Error("Replay target must have the same origin as the captured request")
  const authNames =
    input.authentication.mode === "captured"
      ? input.authentication.headerNames.map((name) => name.toLowerCase())
      : []
  const sourceHeaders = captureHeaders(original.requestHeaders)
  // Never inherit source-session credentials, including names explicitly selected as authentication.
  const headers: HeaderMap = Object.fromEntries(
    Object.entries(sourceHeaders).filter(
      ([key]) =>
        !secretHeader(key) &&
        !authNames.includes(key) &&
        !managedHeaders.has(key) &&
        !key.startsWith("sec-"),
    ),
  )
  // Connection may nominate additional hop-by-hop headers.
  for (const key of (sourceHeaders.connection ?? "").split(","))
    delete headers[key.trim().toLowerCase()]
  for (const name of input.removeHeaders ?? []) {
    validateHeaderName(name)
    delete headers[name.toLowerCase()]
  }
  for (const [key, value] of Object.entries(checkedHeaders(input.headers ?? {}))) {
    if (
      secretHeader(key) ||
      authNames.includes(key) ||
      managedHeaders.has(key) ||
      key.startsWith("sec-")
    )
      throw new Error(
        "Header must be browser-managed or supplied by the authentication record: " + key,
      )
    headers[key] = value
  }
  if (input.authentication.mode === "captured") {
    if (!auth || requestUrl(auth.url).origin !== target.origin)
      throw new Error("Authentication record must belong to the same origin")
    const authHeaders = captureHeaders(auth.requestHeaders)
    for (const key of authNames) {
      validateHeaderName(key)
      if (managedHeaders.has(key) || key.startsWith("sec-"))
        throw new Error("Cannot select a transport header for authentication: " + key)
      if (!authHeaders[key]) throw new Error("Authentication header is missing: " + key)
      headers[key] = authHeaders[key]!
    }
  }
  headers["accept-encoding"] = "identity"
  const method = input.method ?? original.method.toUpperCase()
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method))
    throw new Error("Unsupported replay method")
  const body = input.body !== undefined ? input.body : capturedBody(original)
  if (body !== null && Buffer.byteLength(body) > MAX_BODY) throw new Error("Body exceeds 1 MiB")
  if (body !== null && ["GET", "HEAD"].includes(method))
    throw new Error("GET/HEAD cannot have a body")
  checkedHeaders(headers)
  const url = target.href
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        url,
        method,
        headers: Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
        body,
        input,
        sourceStartedAt: original.startedAt,
        authStartedAt: auth?.startedAt ?? null,
      }),
    )
    .digest("hex")
  return { url, method, headers, body, requestHash, input, original }
}

export const previewReplay = (plan: ReplayPlan, allowed: boolean) => ({
  requestHash: plan.requestHash,
  replayAllowed: allowed,
  origin: new URL(plan.url).origin,
  url: plan.url,
  method: plan.method,
  headers: redactHeaders(
    plan.headers,
    plan.input.authentication.mode === "captured"
      ? plan.input.authentication.headerNames.map((name) => name.toLowerCase())
      : [],
  ),
  body: plan.body,
  bodyBytes: plan.body === null ? 0 : Buffer.byteLength(plan.body),
  source: {
    profileId: plan.input.profileId,
    ...plan.input.request,
    capturedAt: plan.original.startedAt,
  },
  authentication: plan.input.authentication,
  timeoutMs: plan.input.timeoutMs,
  maxResponseBytes: plan.input.maxResponseBytes,
  followsRedirects: false,
  sessionMode: "Captured credentials snapshot; does not use current browser cookies",
})

export interface ReplayResult {
  id: string
  requestHash: string
  profileId: string
  source: ReplayInput["request"]
  authentication: ReplayInput["authentication"]
  record: Omit<NetworkRecord, "source"> & { source: "replay" }
  comparison: ReturnType<typeof compareRecords>
  historySaved?: boolean
  historyWarning?: string
}

// One HTTP request; TLS validation stays enabled and redirects are returned, never followed.
export const sendReplay = async (plan: ReplayPlan): Promise<ReplayResult> => {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const id = randomUUID()
  const extraSecrets =
    plan.input.authentication.mode === "captured"
      ? plan.input.authentication.headerNames.map((name) => name.toLowerCase())
      : []
  const record: ReplayResult["record"] = {
    id,
    source: "replay",
    tabId: null,
    pageUrl: plan.original.pageUrl,
    origin: new URL(plan.url).origin,
    method: plan.method,
    url: plan.url,
    requestHeaders: redactHeaders(plan.headers, extraSecrets),
    requestBody:
      plan.body === null
        ? null
        : {
            kind: "text",
            value: plan.body,
            truncated: false,
            sizeBytes: Buffer.byteLength(plan.body),
          },
    status: null,
    statusText: null,
    responseHeaders: {},
    responseBody: null,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
  }
  await new Promise<void>((resolve) => {
    let settled = false
    let responseStream: Readable | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        // Transport errors can contain URLs or headers. Keep the public message generic.
        record.error =
          error.message === "Replay timed out" ? error.message : "HTTP transport failed"
        record.responseBody = { kind: "unavailable", reason: record.error }
      }
      responseStream?.destroy()
      request.destroy()
      resolve()
    }
    const request = (new URL(plan.url).protocol === "https:" ? httpsRequest : httpRequest)(
      plan.url,
      { method: plan.method, headers: plan.headers },
      (response) => {
        record.status = response.statusCode ?? null
        record.statusText = response.statusMessage ?? null
        record.responseHeaders = redactHeaders(
          Object.fromEntries(
            Object.entries(response.headers)
              .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
              .map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : value]),
          ),
          extraSecrets,
        )
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase()
        const decoder =
          encoding === "gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : null
        responseStream = decoder ? response.pipe(decoder) : response
        response.on("error", finish)
        response.on("aborted", () => finish(new Error("Aborted")))
        const chunks: Buffer[] = []
        let size = 0
        const complete = (truncated: boolean) => {
          const bytes = Buffer.concat(chunks)
          const textDecoder = new StringDecoder("utf8")
          const value = textDecoder.write(bytes) + (truncated ? "" : textDecoder.end())
          const contentType = String(response.headers["content-type"] ?? "")
          const textual =
            !contentType || /text\/|json|xml|javascript|x-www-form-urlencoded/i.test(contentType)
          let body: CapturedBody = textual
            ? { kind: "text", value, truncated, sizeBytes: bytes.length }
            : {
                kind: "binary",
                value: bytes.toString("base64"),
                truncated,
                sizeBytes: bytes.length,
              }
          if (!truncated && /json/i.test(contentType)) {
            try {
              body = { ...body, kind: "json", value: JSON.parse(value) }
            } catch {}
          }
          record.responseBody = body
          finish()
        }
        responseStream.on("error", finish)
        responseStream.on("data", (chunk: Buffer) => {
          if (settled) return
          const remaining = plan.input.maxResponseBytes - size
          chunks.push(chunk.subarray(0, remaining))
          size += Math.min(chunk.length, remaining)
          if (chunk.length > remaining) complete(true)
        })
        responseStream.on("end", () => {
          if (!settled) complete(false)
        })
      },
    )
    const timer = setTimeout(() => finish(new Error("Replay timed out")), plan.input.timeoutMs)
    request.on("error", finish)
    request.end(plan.body ?? undefined)
  })
  record.completedAt = new Date().toISOString()
  record.durationMs = Date.now() - started
  return {
    id,
    requestHash: plan.requestHash,
    profileId: plan.input.profileId,
    source: plan.input.request,
    authentication: plan.input.authentication,
    record,
    comparison: compareRecords(
      {
        ...plan.original,
        requestHeaders: redactHeaders(plan.original.requestHeaders, extraSecrets),
        responseHeaders: redactHeaders(plan.original.responseHeaders, extraSecrets),
      },
      { ...record, source: plan.original.source },
      200,
    ),
  }
}
