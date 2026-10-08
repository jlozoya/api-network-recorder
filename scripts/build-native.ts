import { mkdirSync, existsSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { nativeBinary, nativeTarget, nativeTargets } from "./native-target.js"

const target = nativeTarget()
const run = (command: string, args: string[]) =>
  new Promise<void>((resolveResult, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0 ? resolveResult() : reject(new Error(`${command} exited with ${code}`)),
    )
  })
const directory = resolve(".cache/bun-baseline-1.3.14")
const runtime = join(directory, "package", "bin", "bun.exe")
if (target === "windows-x64" && process.platform !== "win32")
  throw new Error("Build the Windows bridge on Windows")
if (target === "windows-x64" && !existsSync(runtime)) {
  mkdirSync(directory, { recursive: true })
  const response = await fetch(
    "https://registry.npmjs.org/@oven/bun-windows-x64-baseline/-/bun-windows-x64-baseline-1.3.14.tgz",
  )
  if (!response.ok) throw new Error("Could not download the official Bun baseline runtime")
  const bytes = Buffer.from(await response.arrayBuffer())
  const integrity = createHash("sha512").update(bytes).digest("base64")
  if (
    integrity !==
    "uIjLUC1S9DWgICzuoMba7vurBJnBruE4S5CxnvmZkdqWVXRzx1Rgu636HoH+k0qeaQCFh3jeG3JQ1y6fRHv0sw=="
  )
    throw new Error("Bun runtime integrity mismatch")
  const archive = join(directory, "runtime.tgz")
  writeFileSync(archive, bytes)
  await run("tar.exe", ["-xf", archive, "-C", directory])
}
await run(process.execPath, [
  "build",
  "--compile",
  `--target=${nativeTargets[target]}`,
  ...(target === "windows-x64" ? [`--compile-executable-path=${runtime}`] : []),
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  ...(target === "windows-x64"
    ? [
        "--windows-hide-console",
        "--windows-title=API Network Recorder AI Integration",
        "--windows-version=0.4.6.0",
      ]
    : []),
  "native/main.ts",
  "--outfile",
  nativeBinary(target),
])
