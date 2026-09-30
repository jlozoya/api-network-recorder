import type { Readable, Writable } from "node:stream"

export const MAX_FRAME = 16 * 1024 * 1024
export const encodeFrame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  if (body.length > MAX_FRAME) throw new Error("Bridge response exceeded its size limit")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

export const readFrames = (
  stream: Readable,
  onMessage: (message: any) => void,
  onError: (error: Error) => void,
): void => {
  let buffer = Buffer.alloc(0)
  stream.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (length === 0 || length > MAX_FRAME) throw new Error("Invalid bridge frame length")
        if (buffer.length < length + 4) return
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"))
        buffer = buffer.subarray(length + 4)
        onMessage(message)
      }
    } catch (error) {
      buffer = Buffer.alloc(0)
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
  stream.on("end", () => {
    if (buffer.length) onError(new Error("Incomplete bridge frame"))
  })
}
export const writeFrame = (stream: Writable, value: unknown): void => {
  stream.write(encodeFrame(value))
}
