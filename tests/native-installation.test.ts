import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { integrationPaths, type PlatformContext } from "../native/platform.ts"
import { configureIntegration, uninstallIntegration } from "../native/install.ts"
import { HOST_NAME, pipeForProfile } from "../native/config.ts"

test("platform paths respect Linux XDG directories and keep macOS Chrome registration under Application Support", () => {
  const home = resolve("test-home")
  const data = resolve("test-data")
  const config = resolve("test-config")
  expect(integrationPaths({ platform: "linux", home, env: {} }).directory).toBe(
    join(home, ".local", "share", "api-network-recorder"),
  )
  const linux = integrationPaths({
    platform: "linux",
    home,
    env: { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config },
  })
  expect(linux.directory).toBe(join(data, "api-network-recorder"))
  expect(linux.chrome).toBe(join(config, "google-chrome"))
  expect(
    integrationPaths({ platform: "linux", home, env: { XDG_DATA_HOME: "relative" } }).directory,
  ).toBe(join(home, ".local", "share", "api-network-recorder"))
  const mac = integrationPaths({ platform: "darwin", home, env: {} })
  expect(mac.directory).toBe(join(home, "Library", "Application Support", "ApiNetworkRecorder"))
  expect(mac.chrome).toBe(join(home, "Library", "Application Support", "Google", "Chrome"))
  expect(mac.executable.endsWith(".exe")).toBe(false)
  expect(() => integrationPaths({ platform: "freebsd", home, env: {} })).toThrow("Unsupported")
})

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} installs, upgrades and removes native registration while preserving user files`, () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-unix-install-"))
    const context: PlatformContext = { platform, home: root, env: {} }
    const paths = integrationPaths(context)
    const extensionId = "a".repeat(32)
    const manifest = join(paths.chrome, "NativeMessagingHosts", `${HOST_NAME}.json`)
    try {
      mkdirSync(paths.directory, { recursive: true })
      writeFileSync(paths.executable, "synthetic executable")
      mkdirSync(join(paths.chrome, "Default"), { recursive: true })
      writeFileSync(
        join(paths.chrome, "Default", "Preferences"),
        JSON.stringify({
          extensions: {
            settings: { [extensionId]: { manifest: { name: "API Network Recorder" } } },
          },
        }),
      )
      mkdirSync(paths.codex, { recursive: true })
      const configPath = join(paths.codex, "config.toml")
      const original = 'model = "test-model"\n[mcp_servers.other]\ncommand = "other"\n'
      writeFileSync(configPath, original)
      configureIntegration(undefined, false, undefined, context)
      const first = JSON.parse(readFileSync(join(paths.directory, "bridge.json"), "utf8"))
      expect(first.allowControls).toBe(false)
      expect(JSON.parse(readFileSync(manifest, "utf8")).path).toBe(paths.executable)
      expect(JSON.parse(readFileSync(manifest, "utf8")).allowed_origins).toEqual([
        `chrome-extension://${extensionId}/`,
      ])
      expect(readFileSync(configPath, "utf8")).toContain(original)
      expect(readFileSync(configPath + ".api-recorder-backup", "utf8")).toBe(original)
      const skill = join(paths.codex, "skills", "api-network-recorder")
      writeFileSync(join(skill, "SKILL.md"), "Customized skill")
      writeFileSync(join(skill, "notes.txt"), "User notes")
      configureIntegration(extensionId, true, undefined, context)
      const updated = JSON.parse(readFileSync(join(paths.directory, "bridge.json"), "utf8"))
      expect(updated.token).toBe(first.token)
      expect(updated.allowControls).toBe(true)
      expect(
        readFileSync(configPath, "utf8").match(/\[mcp_servers.api-network-recorder\]/g)?.length,
      ).toBe(1)
      if (process.platform !== "win32") {
        expect(statSync(paths.directory).mode & 0o777).toBe(0o700)
        expect(statSync(join(paths.directory, "bridge.json")).mode & 0o777).toBe(0o600)
        expect(statSync(manifest).mode & 0o777).toBe(0o600)
      }
      uninstallIntegration(context)
      expect(existsSync(manifest)).toBe(false)
      expect(existsSync(join(paths.directory, "bridge.json"))).toBe(false)
      expect(readFileSync(configPath, "utf8").trim()).toBe(original.trim())
      expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe("Customized skill")
      expect(readFileSync(join(skill, "notes.txt"), "utf8")).toBe("User notes")
      expect(existsSync(join(skill, "scripts", "invoke-recorder.sh"))).toBe(false)
      expect(existsSync(paths.executable)).toBe(true)
      uninstallIntegration(context)
    } finally {
      expect(
        resolve(root).startsWith(resolve(tmpdir()) + "/") ||
          resolve(root).startsWith(resolve(tmpdir()) + "\\"),
      ).toBe(true)
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test.skipIf(process.platform === "win32")(
  "Unix socket paths stay below the macOS limit even with a long installation path",
  () => {
    const previous = process.env.API_RECORDER_HOME
    try {
      process.env.API_RECORDER_HOME = "/tmp/" + "long-home-".repeat(30)
      const socket = pipeForProfile("11111111-1111-4111-8111-111111111111")
      expect(Buffer.byteLength(socket)).toBeLessThan(104)
      expect(socket).toStartWith("/tmp/api-recorder-")
    } finally {
      if (previous === undefined) delete process.env.API_RECORDER_HOME
      else process.env.API_RECORDER_HOME = previous
    }
  },
)
