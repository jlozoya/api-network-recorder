import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { HOST_NAME } from "../native/config.js"
import { integrationPaths } from "../native/platform.js"
import { skillAssets } from "../native/skill.js"
import { nativeBinary, nativeTarget } from "./native-target.js"

export const verifyUnixInstaller = async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "recorder-installer-check-"))
  try {
    const name = `api-network-recorder-${nativeTarget()}`
    const archive = resolve("release", `${name}.tar.gz`)
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
    assert.equal(
      readFileSync(archive + ".sha256", "utf8").split(" ")[0],
      hash(readFileSync(archive)),
    )
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", directory], { encoding: "utf8" })
    assert.equal(extracted.status, 0, extracted.stderr)
    const payload = join(directory, name)
    const binary = join(payload, "api-network-recorder-bridge")
    assert.equal(hash(readFileSync(binary)), hash(readFileSync(nativeBinary())))
    assert.equal(statSync(binary).mode & 0o111, 0o111)
    assert.equal(
      readFileSync(join(payload, "THIRD_PARTY_NOTICES.txt"), "utf8"),
      readFileSync("THIRD_PARTY_NOTICES.txt", "utf8"),
    )
    // Every installation write stays in a temporary home, including Chrome registration.
    const home = join(directory, "home with spaces")
    const env = {
      ...process.env,
      HOME: home,
      API_RECORDER_HOME: join(home, "app"),
      CODEX_HOME: join(home, "codex"),
      XDG_CONFIG_HOME: join(home, "config"),
    }
    const paths = integrationPaths({ platform: process.platform, home, env })
    const original = 'model = "test-model"\n[mcp_servers.other]\ncommand = "other"\n'
    mkdirSync(paths.codex, { recursive: true })
    const config = join(paths.codex, "config.toml")
    writeFileSync(config, original)
    const run = (script: string, args: string[] = []) =>
      spawnSync("sh", [join(payload, script), ...args], { env, encoding: "utf8", timeout: 20000 })
    const denied = run("install.sh")
    assert.notEqual(denied.status, 0, "Noninteractive installation needs explicit authorization")
    assert(!existsSync(paths.executable))
    const extensionId = "a".repeat(32)
    const installed = run("install.sh", ["--accept-access", `--extension-id=${extensionId}`])
    assert.equal(installed.status, 0, installed.stderr)
    const bridge = join(paths.directory, "bridge.json")
    const token = JSON.parse(readFileSync(bridge, "utf8")).token
    assert.equal(JSON.parse(readFileSync(bridge, "utf8")).allowControls, false)
    assert.equal(statSync(bridge).mode & 0o777, 0o600)
    assert.equal(statSync(paths.directory).mode & 0o777, 0o700)
    const manifest = join(paths.chrome, "NativeMessagingHosts", `${HOST_NAME}.json`)
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).path, paths.executable)
    assert(readFileSync(config, "utf8").includes(original))
    for (const [relative, content] of Object.entries(skillAssets))
      assert.equal(
        readFileSync(join(paths.codex, "skills", "api-network-recorder", relative), "utf8"),
        content,
      )
    const client = new Client({ name: "installer-check", version: "1" })
    try {
      await client.connect(
        new StdioClientTransport({
          command: paths.executable,
          args: ["--mcp"],
          env,
          stderr: "pipe",
        }),
      )
      const tools = await client.listTools()
      assert(tools.tools.some((tool) => tool.name === "search_requests"))
      const result = await client.callTool({ name: "list_profiles", arguments: {} })
      assert(!result.isError)
    } finally {
      await client.close()
    }
    const skillClient = join(
      paths.codex,
      "skills",
      "api-network-recorder",
      "scripts",
      "invoke-recorder.sh",
    )
    const profiles = spawnSync("sh", [skillClient, "list_profiles"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    })
    assert.equal(profiles.status, 0, profiles.stderr)
    assert.deepEqual(JSON.parse(profiles.stdout).profiles, [])
    const upgraded = run("install.sh", [
      "--accept-access",
      "--allow-controls",
      `--extension-id=${extensionId}`,
    ])
    assert.equal(upgraded.status, 0, upgraded.stderr)
    assert.equal(JSON.parse(readFileSync(bridge, "utf8")).token, token)
    assert.equal(JSON.parse(readFileSync(bridge, "utf8")).allowControls, true)
    const removed = run("uninstall.sh")
    assert.equal(removed.status, 0, removed.stderr)
    assert(!existsSync(bridge))
    assert(!existsSync(manifest))
    assert.equal(readFileSync(config, "utf8").trim(), original.trim())
    assert.equal(readFileSync(config + ".api-recorder-backup", "utf8"), original)
    console.log(
      "PASS: Unix archive, permissions, install, MCP handshake, skill client, upgrade and uninstall",
    )
  } finally {
    assert(resolve(directory).startsWith(resolve(tmpdir()) + sep + "recorder-installer-check-"))
    rmSync(directory, { recursive: true, force: true })
  }
}
