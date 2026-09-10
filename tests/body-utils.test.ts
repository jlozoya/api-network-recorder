import { describe, expect, test } from "bun:test"
import { BodyBuffer } from "../src/core/body-buffer.ts"
import { MAX_BODY_SIZE_BYTES as LIMIT } from "../src/core/constants.ts"
import {
  toCapturedTextBody,
  toCapturedBodyFromBytes,
  toCapturedBase64Body,
} from "../src/core/body-utils.ts"
import { toCapturedTextBody as pageTextBody } from "../src/injected/page-utils.ts"

for (const [name, capture] of [
  ["background", toCapturedTextBody],
  ["page", pageTextBody],
] as const) {
  describe(name + " text limits", () => {
    test("preserves small text", () => {
      expect(capture("hola é", "text/plain")).toEqual({
        kind: "text",
        value: "hola é",
        truncated: false,
        sizeBytes: 7,
      })
    })
    test("counts bytes rather than UTF-16 characters", () => {
      const body = capture("é".repeat(LIMIT), "text/plain")
      expect(body.kind).toBe("text")
      expect(new TextEncoder().encode(body.value).length).toBe(LIMIT)
      expect(body.sizeBytes).toBe(LIMIT * 2)
      expect(body.truncated).toBe(true)
    })
    test("does not retain partial UTF-8 characters at the boundary", () => {
      const prefix = "a".repeat(LIMIT - 1)
      const body = capture(prefix + "😀", "text/plain")
      expect(body.value).toBe(prefix)
      expect(body.truncated).toBe(true)
    })
    test("does not truncate at exactly the limit", () => {
      expect(capture("a".repeat(LIMIT), "text/plain").truncated).toBe(false)
    })
  })
}

describe("stream buffering", () => {
  test("retains both blocks when the response reaches the exact limit", () => {
    const buffer = new BodyBuffer()
    buffer.append(new Uint8Array(LIMIT / 2).fill(65))
    buffer.append(new Uint8Array(LIMIT / 2).fill(66))
    const bytes = buffer.toBytes()
    expect(bytes.length).toBe(LIMIT)
    expect(bytes[0]).toBe(65)
    expect(bytes[LIMIT / 2]).toBe(66)
    expect(bytes[LIMIT - 1]).toBe(66)
  })
  test("retains a bounded prefix of a single oversized block", () => {
    const buffer = new BodyBuffer()
    buffer.append(new Uint8Array(LIMIT + 50).fill(65))
    buffer.append(new Uint8Array(100).fill(66))
    expect(buffer.toBytes().length).toBe(LIMIT)
    expect(buffer.toBytes()[LIMIT - 1]).toBe(65)
    expect(buffer.sizeBytes).toBe(LIMIT + 150)
    const body = toCapturedBodyFromBytes(buffer.toBytes(), "text/plain", buffer.sizeBytes)
    expect(body.kind).toBe("text")
    expect(body.truncated).toBe(true)
    expect(body.sizeBytes).toBe(LIMIT + 150)
  })
  test("preserves an empty response", () => {
    const buffer = new BodyBuffer()
    expect(buffer.toBytes().length).toBe(0)
    expect(buffer.sizeBytes).toBe(0)
  })
  test("handles a character split between chunks", () => {
    const bytes = new TextEncoder().encode("A😀B")
    const buffer = new BodyBuffer()
    buffer.append(bytes.slice(0, 3))
    buffer.append(bytes.slice(3))
    expect(toCapturedBodyFromBytes(buffer.toBytes(), "text/plain").value).toBe("A😀B")
  })
})

describe("debugger base64 bodies", () => {
  for (const size of [0, 1, 2, 3, LIMIT, LIMIT + 100]) {
    test("reports decoded size and caps payload: " + size, () => {
      const encoded = Buffer.alloc(size, 65).toString("base64")
      const body = toCapturedBase64Body(encoded)
      expect(body.kind).toBe("binary")
      expect(body.sizeBytes).toBe(size)
      expect(body.truncated).toBe(size > LIMIT)
      expect(Buffer.from(body.value, "base64").length).toBe(Math.min(size, LIMIT))
    })
  }
})
