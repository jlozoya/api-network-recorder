import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"

const directory = mkdtempSync(join(tmpdir(), "recorder-installer-check-"))
try {
  const installer = readFileSync(resolve("release/api-network-recorder-windows-x64-setup.exe"))
  // IExpress embeds a standard cabinet. Extract it without launching installation.
  let position = installer.indexOf(Buffer.from("MSCF"))
  while (position >= 0) {
    const size = installer.readUInt32LE(position + 8)
    if (
      size >= 36 &&
      position + size <= installer.length &&
      installer[position + 24] === 3 &&
      installer[position + 25] === 1
    )
      break
    position = installer.indexOf(Buffer.from("MSCF"), position + 4)
  }
  assert(position >= 0, "Installer cabinet missing")
  const size = installer.readUInt32LE(position + 8)
  const cabinet = join(directory, "payload.cab")
  writeFileSync(cabinet, installer.subarray(position, position + size))
  const expanded = spawnSync("expand.exe", ["-F:*", cabinet, directory], {
    windowsHide: true,
    encoding: "utf8",
  })
  assert.equal(expanded.status, 0, expanded.stderr)
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  assert.equal(
    hash(readFileSync(join(directory, "api-network-recorder-bridge.exe"))),
    hash(readFileSync(resolve("dist/native/api-network-recorder-bridge.exe"))),
  )
  assert.equal(
    readFileSync(join(directory, "THIRD_PARTY_NOTICES.txt"), "utf8"),
    readFileSync("THIRD_PARTY_NOTICES.txt", "utf8"),
  )
  assert.equal(
    readFileSync("release/api-network-recorder-windows-x64-setup.exe.sha256", "utf8").split(" ")[0],
    hash(installer),
  )
  console.log(
    "PASS: installer contains the tested executable and license notices; checksum matches",
  )
} finally {
  assert(resolve(directory).startsWith(resolve(tmpdir()) + "\\recorder-installer-check-"))
  rmSync(directory, { recursive: true, force: true })
}
