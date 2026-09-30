import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { appDirectory, extensionIdSchema, HOST_NAME, MCP_NAME, configSchema } from "./config.js"

export const detectExtensionIds = (userData: string): string[] => {
  if (!existsSync(userData)) return []
  const ids = new Set<string>()
  for (const entry of readdirSync(userData, { withFileTypes: true })) {
    if (!entry.isDirectory() || (entry.name !== "Default" && !/^Profile \d+$/.test(entry.name)))
      continue
    for (const name of ["Secure Preferences", "Preferences"]) {
      try {
        const data = JSON.parse(readFileSync(join(userData, entry.name, name), "utf8"))
        for (const [id, value] of Object.entries(data.extensions?.settings || {})) {
          if (!extensionIdSchema.safeParse(id).success || !value || typeof value !== "object")
            continue
          const settings = value as { manifest?: { name?: string }; path?: string }
          let manifest = settings.manifest
          if (!manifest && settings.path) {
            const folder = resolve(userData, entry.name, settings.path)
            try {
              manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"))
            } catch {}
          }
          if (manifest?.name === "API Network Recorder") ids.add(id)
        }
      } catch {
        /* A profile may not have an extensions preferences file yet. */
      }
    }
  }
  return [...ids]
}

const BEGIN = "# BEGIN API Network Recorder integration"
const END = "# END API Network Recorder integration"
export const updateCodexConfig = (original: string, executable: string): string => {
  const runtime = globalThis as unknown as { Bun: { TOML: { parse: (text: string) => unknown } } }
  runtime.Bun.TOML.parse(original)
  const block = `${BEGIN}\n[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(executable)}\nargs = ["--mcp"]\n${END}`
  const start = original.indexOf(BEGIN)
  if (start >= 0) {
    const end = original.indexOf(END, start)
    if (end < 0)
      throw new Error("Existing integration configuration is incomplete; repair it before updating")
    return original.slice(0, start) + block + original.slice(end + END.length)
  }
  if (
    /^\s*\[mcp_servers\.(?:api-network-recorder|"api-network-recorder"|'api-network-recorder')\]/m.test(
      original,
    )
  )
    throw new Error(
      "An unmanaged api-network-recorder MCP already exists. Rename or remove that entry before installation.",
    )
  return original + (original.endsWith("\n") || !original ? "" : "\n") + "\n" + block + "\n"
}

const registerChromeHost = (manifest: string): void => {
  const registry = spawnSync(
    "reg.exe",
    [
      "ADD",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifest,
      "/f",
    ],
    { windowsHide: true },
  )
  if (registry.status !== 0) throw new Error("Could not register the Chrome native host")
}
export const configureIntegration = (
  extensionId: string | undefined,
  allowControls: boolean,
  registerHost = registerChromeHost,
): void => {
  const directory = appDirectory()
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error("LOCALAPPDATA is missing")
  const extensionIds = extensionId
    ? [extensionIdSchema.parse(extensionId)]
    : detectExtensionIds(join(localAppData, "Google", "Chrome", "User Data"))
  if (!extensionIds.length)
    throw new Error(
      "Install API Network Recorder in Chrome first, or enter its extension ID in the installer.",
    )
  mkdirSync(directory, { recursive: true })
  const executable = join(directory, "api-network-recorder-bridge.exe")
  if (!existsSync(executable)) throw new Error("Bridge executable was not installed")
  const codexDir = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
  const configPath = join(codexDir, "config.toml")
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : ""
  const updated = updateCodexConfig(original, executable)
  let token = randomBytes(32).toString("hex")
  try {
    token = configSchema.parse(
      JSON.parse(readFileSync(join(directory, "bridge.json"), "utf8")),
    ).token
  } catch {}
  const bridgeConfig = { token, extensionIds, allowControls }
  writeFileSync(join(directory, "bridge.json"), JSON.stringify(bridgeConfig, null, 2), {
    mode: 0o600,
  })
  writeFileSync(
    join(directory, "native-host.json"),
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "API Network Recorder local AI integration",
        path: executable,
        type: "stdio",
        allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
      },
      null,
      2,
    ),
  )
  registerHost(join(directory, "native-host.json"))
  mkdirSync(codexDir, { recursive: true })
  if (original && !existsSync(configPath + ".api-recorder-backup"))
    writeFileSync(configPath + ".api-recorder-backup", original, { mode: 0o600 })
  const temporaryConfig = configPath + ".api-recorder-tmp"
  writeFileSync(temporaryConfig, updated, { mode: 0o600 })
  renameSync(temporaryConfig, configPath)
}

export const removeCodexConfig = (original: string): string => {
  const start = original.indexOf(BEGIN)
  if (start < 0) return original
  const end = original.indexOf(END, start)
  if (end < 0) throw new Error("Integration configuration is incomplete")
  return original.slice(0, start) + original.slice(end + END.length).replace(/^\r?\n/, "")
}
export const uninstallIntegration = (): void => {
  const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml")
  if (existsSync(configPath))
    writeFileSync(configPath, removeCodexConfig(readFileSync(configPath, "utf8")), { mode: 0o600 })
  spawnSync(
    "reg.exe",
    ["DELETE", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, "/f"],
    { windowsHide: true },
  )
  try {
    unlinkSync(join(appDirectory(), "bridge.json"))
  } catch {}
  spawnSync(
    "reg.exe",
    [
      "DELETE",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ApiNetworkRecorderBridge",
      "/f",
    ],
    { windowsHide: true },
  )
}

const showMessage = (message: string, buttons = "OK"): string => {
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${message.replaceAll("'", "''")}', 'API Network Recorder', '${buttons}', 'Information').ToString()`
  const response = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, encoding: "utf8" },
  )
  if (response.status !== 0) throw new Error("Could not display the installation dialog")
  return response.stdout.trim()
}
export const installInteractive = (): void => {
  try {
    const controls = showMessage(
      "Allow AI agents to start and stop recording and deep capture? Choose No for read-only access to captured API records.",
      "YesNoCancel",
    )
    if (controls === "Cancel") return
    const directory = appDirectory()
    mkdirSync(directory, { recursive: true })
    const executable = join(directory, "api-network-recorder-bridge.exe")
    if (resolve(executable) !== resolve(process.execPath))
      copyFileSync(process.execPath, executable)
    const notices = join(dirname(process.execPath), "THIRD_PARTY_NOTICES.txt")
    if (existsSync(notices) && resolve(notices) !== resolve(directory, "THIRD_PARTY_NOTICES.txt"))
      copyFileSync(notices, join(directory, "THIRD_PARTY_NOTICES.txt"))
    configureIntegration(undefined, controls === "Yes")
    const uninstallKey =
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ApiNetworkRecorderBridge"
    for (const [name, value] of Object.entries({
      DisplayName: "API Network Recorder AI Integration",
      DisplayVersion: "0.4.2",
      Publisher: "API Network Recorder",
      UninstallString: `"${executable}" --uninstall-ui`,
    })) {
      const result = spawnSync(
        "reg.exe",
        ["ADD", uninstallKey, "/v", name, "/t", "REG_SZ", "/d", value, "/f"],
        { windowsHide: true },
      )
      if (result.status !== 0) throw new Error("Could not register the uninstaller")
    }
    showMessage(
      "Integration installed. Restart Codex once. Chrome connects automatically within one minute. After updating an unpacked extension, reload it once to enable the nativeMessaging permission.",
    )
  } catch (error) {
    showMessage(
      `Installation could not finish: ${error instanceof Error ? error.message : String(error)}\nClose Chrome and Codex before upgrading. Install the extension in Chrome before running the installer.`,
    )
    process.exitCode = 1
  }
}
export const uninstallInteractive = (): void => {
  if (
    showMessage(
      "Disconnect API Network Recorder from Codex and Chrome? Captured browser records will be preserved.",
      "YesNo",
    ) !== "Yes"
  )
    return
  uninstallIntegration()
  showMessage(
    "Integration disconnected. Restart Codex and Chrome to close existing connections. Captured records remain in the browser.",
  )
}
