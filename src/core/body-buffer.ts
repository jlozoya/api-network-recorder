import { MAX_BODY_SIZE_BYTES } from "./constants.js"

/** Retain only the response prefix while counting every byte received. */
export class BodyBuffer {
  private chunks: Uint8Array[] = []
  private retainedBytes = 0
  sizeBytes = 0
  append(bytes: Uint8Array): void {
    this.sizeBytes += bytes.byteLength
    const remaining = MAX_BODY_SIZE_BYTES - this.retainedBytes
    if (remaining <= 0) return
    const chunk = bytes.slice(0, remaining)
    this.chunks.push(chunk)
    this.retainedBytes += chunk.byteLength
  }
  toBytes(): Uint8Array {
    const output = new Uint8Array(this.retainedBytes)
    let offset = 0
    for (const chunk of this.chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }
}
