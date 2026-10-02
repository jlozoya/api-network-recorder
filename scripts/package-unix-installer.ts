import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { nativeBinary, nativeTarget } from "./native-target.js"

export const packageUnixInstaller = (): void => {
  const target = nativeTarget()
  if (target === "windows-x64" || process.platform === "win32")
    throw new Error("Package Unix installers on macOS or Linux to preserve executable permissions")
  const name = `api-network-recorder-${target}`
  const staging = resolve("dist", "installers")
  const directory = join(staging, name)
  mkdirSync(directory, { recursive: true })
  copyFileSync(nativeBinary(target), join(directory, "api-network-recorder-bridge"))
  chmodSync(join(directory, "api-network-recorder-bridge"), 0o755)
  for (const script of ["install.sh", "uninstall.sh"]) {
    // Always package LF shell scripts, even when the source was checked out with CRLF.
    writeFileSync(
      join(directory, script),
      readFileSync(join("installer", script), "utf8").replaceAll("\r\n", "\n"),
      { mode: 0o755 },
    )
    chmodSync(join(directory, script), 0o755)
  }
  copyFileSync("THIRD_PARTY_NOTICES.txt", join(directory, "THIRD_PARTY_NOTICES.txt"))
  copyFileSync("LICENSE", join(directory, "LICENSE"))
  writeFileSync(
    join(directory, "README.txt"),
    `API Network Recorder — ${target}\n\nInstall the extension in Google Chrome first.\nRun: sh install.sh\nThe installer asks for access to stored API calls and optional capture controls.\nFor noninteractive read-only installation: sh install.sh --accept-access\nFor an undetected extension, add --extension-id=YOUR_ID.\nRestart Codex once and keep Chrome open. No sudo or separate runtime is required.\n\nUninstall: sh uninstall.sh\nBrowser records and customized skill files are preserved.\nThe installed executable and configuration backup remain and may be deleted manually.\n`,
  )
  mkdirSync("release", { recursive: true })
  const output = resolve("release", `${name}.tar.gz`)
  const result = spawnSync("tar", ["-czf", output, "-C", staging, name], { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar exited with ${result.status}`)
  const hash = createHash("sha256").update(readFileSync(output)).digest("hex")
  writeFileSync(output + ".sha256", `${hash}  ${name}.tar.gz\n`)
  console.log(`Created ${output}`)
}
