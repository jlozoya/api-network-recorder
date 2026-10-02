import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { PassThrough } from "node:stream"
import { createConnection } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { encodeFrame, readFrames } from "../native/framing.ts"
import { integrationPaths } from "../native/platform.ts"
import {
  updateCodexConfig,
  removeCodexConfig,
  detectExtensionIds,
  configureIntegration,
} from "../native/install.ts"

const extensionId = "a".repeat(32)
const bridgeBinary = process.env.RECORDER_NATIVE_BINARY
const launch = (args: string[]) =>
  bridgeBinary
    ? { command: resolve(bridgeBinary), args }
    : { command: process.execPath, args: [resolve("native/main.ts"), ...args] }
const runtimeEnv = (home: string) =>
  Object.fromEntries([
    ...[
      "PATH",
      "SystemRoot",
      "SYSTEMROOT",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOME",
      "TEMP",
      "TMP",
    ].flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])),
    ["API_RECORDER_HOME", home],
  ])
const waitFor = async (read: () => boolean, label: string) => {
  const until = Date.now() + 7000
  while (!read()) {
    if (Date.now() > until) throw new Error(`Timeout: ${label}`)
    await new Promise((resolveResult) => setTimeout(resolveResult, 20))
  }
}
test("native framing handles split Unicode packets and rejects oversized frames", () => {
  const stream = new PassThrough()
  const messages: unknown[] = [],
    errors: Error[] = []
  readFrames(
    stream,
    (message) => messages.push(message),
    (error) => errors.push(error),
  )
  const frame = encodeFrame({ text: "México 🧪" })
  for (const byte of frame) stream.write(Buffer.from([byte]))
  expect(messages).toEqual([{ text: "México 🧪" }])
  stream.write(Buffer.from([255, 255, 255, 255]))
  expect(errors[0]?.message).toContain("length")
})
test("installer preserves unrelated Codex configuration and updates its own entry idempotently", () => {
  const original = 'model = "user-model"\n[mcp_servers.other]\ncommand = "other.exe"\n'
  const first = updateCodexConfig(original, "C:\\Users\\Example User\\bridge.exe")
  const updated = updateCodexConfig(first, "D:\\Updated\\bridge.exe")
  expect(updated).toContain(original)
  expect(updated.match(/\[mcp_servers.api-network-recorder\]/g)?.length).toBe(1)
  expect(updated).toContain(JSON.stringify("D:\\Updated\\bridge.exe"))
  expect(removeCodexConfig(updated).trim()).toBe(original.trim())
  expect(() =>
    updateCodexConfig('[mcp_servers.api-network-recorder]\ncommand="custom"', "new.exe"),
  ).toThrow("unmanaged")
  expect(() => updateCodexConfig("invalid = [", "new.exe")).toThrow()
})

test("installer writes an isolated installation, preserves Codex settings and updates permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-install-test-"))
  const previousHome = process.env.API_RECORDER_HOME
  const previousCodex = process.env.CODEX_HOME
  try {
    process.env.API_RECORDER_HOME = join(root, "app")
    process.env.CODEX_HOME = join(root, "codex")
    mkdirSync(process.env.API_RECORDER_HOME)
    mkdirSync(process.env.CODEX_HOME)
    writeFileSync(integrationPaths().executable, "test executable")
    const configPath = join(process.env.CODEX_HOME, "config.toml")
    const original = 'model = "test-model"\n[mcp_servers.other]\ncommand="other.exe"\n'
    writeFileSync(configPath, original)
    const manifests: string[] = []
    configureIntegration(extensionId, false, (manifest) => {
      manifests.push(manifest)
    })
    const first = JSON.parse(
      readFileSync(join(process.env.API_RECORDER_HOME, "bridge.json"), "utf8"),
    )
    expect(first.allowControls).toBe(false)
    expect(first.token).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(configPath + ".api-recorder-backup", "utf8")).toBe(original)
    expect(readFileSync(configPath, "utf8")).toContain(original)
    expect(
      readFileSync(
        join(process.env.CODEX_HOME, "skills", "api-network-recorder", "SKILL.md"),
        "utf8",
      ),
    ).toContain("name: api-network-recorder")
    expect(JSON.parse(readFileSync(manifests[0], "utf8")).allowed_origins).toEqual([
      `chrome-extension://${extensionId}/`,
    ])
    configureIntegration(extensionId, true, () => {})
    const second = JSON.parse(
      readFileSync(join(process.env.API_RECORDER_HOME, "bridge.json"), "utf8"),
    )
    expect(second.token).toBe(first.token)
    expect(second.allowControls).toBe(true)
    expect(
      readFileSync(configPath, "utf8").match(/\[mcp_servers.api-network-recorder\]/g)?.length,
    ).toBe(1)
  } finally {
    if (previousHome === undefined) delete process.env.API_RECORDER_HOME
    else process.env.API_RECORDER_HOME = previousHome
    if (previousCodex === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodex
    rmSync(root, { recursive: true, force: true })
  }
})
test("installer detects only API Network Recorder extension IDs from Chrome metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-detection-"))
  try {
    mkdirSync(join(root, "Default"))
    writeFileSync(
      join(root, "Default", "Secure Preferences"),
      JSON.stringify({
        extensions: {
          settings: {
            [extensionId]: { manifest: { name: "API Network Recorder" } },
            ["b".repeat(32)]: { manifest: { name: "Other extension" } },
            malformed: { manifest: { name: "API Network Recorder" } },
          },
        },
      }),
    )
    expect(detectExtensionIds(root)).toEqual([extensionId])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("MCP stdio routes concurrent calls through authenticated native IPC and isolates profiles", async () => {
  const home = mkdtempSync(join(tmpdir(), "recorder-native-test-"))
  const token = randomBytes(32).toString("hex")
  writeFileSync(
    join(home, "bridge.json"),
    JSON.stringify({ token, extensionIds: [extensionId], allowControls: false }),
  )
  const hosts: ReturnType<typeof spawn>[] = []
  const clients: Client[] = []
  let forwarded = 0
  const host = async (profileId: string) => {
    const program = launch([`chrome-extension://${extensionId}/`])
    const child = spawn(program.command, program.args, {
      env: runtimeEnv(home),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    hosts.push(child)
    let ready = false
    let stderr = ""
    child.stderr!.on("data", (bytes) => {
      stderr += String(bytes)
    })
    readFrames(
      child.stdout!,
      (message) => {
        if (message.type === "ready") ready = true
        if (message.type === "call") {
          forwarded++
          const result =
            message.method === "get_request"
              ? {
                  id: message.args.id,
                  responseBody: {
                    kind: "json",
                    value: { synthetic: "México 🧪" },
                    truncated: false,
                    sizeBytes: 42,
                  },
                }
              : { profileId, method: message.method, args: message.args }
          child.stdin!.write(encodeFrame({ type: "result", id: message.id, result }))
        }
      },
      (error) => {
        stderr += error.message
      },
    )
    child.stdin!.write(encodeFrame({ type: "hello", profileId, extensionId }))
    await waitFor(() => ready || child.exitCode !== null, "Native host ready")
    expect(stderr).toBe("")
    expect(ready).toBe(true)
    return JSON.parse(readFileSync(join(home, "connections", profileId + ".json"), "utf8"))
  }
  const mcp = async () => {
    const client = new Client({ name: "recorder-test", version: "1" })
    await client.connect(
      new StdioClientTransport({ ...launch(["--mcp"]), env: runtimeEnv(home), stderr: "pipe" }),
    )
    clients.push(client)
    return client
  }
  const body = (result: any) => JSON.parse(result.content[0].text)
  try {
    const firstId = randomUUID()
    const connection = await host(firstId)
    const client = await mcp()
    const list = await client.listTools()
    expect(list.tools.some((tool) => tool.name === "search_requests")).toBe(true)
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client.callTool({ name: "get_request", arguments: { id: String(i) } }),
      ),
    )
    expect(responses.map((response) => body(response).id)).toEqual(
      Array.from({ length: 8 }, (_, i) => String(i)),
    )
    expect(body(responses[0]).responseBody.value.synthetic).toBe("México 🧪")
    if (bridgeBinary && process.platform === "win32") {
      const invokeSkill = (tool: string, args: object) =>
        new Promise<{ code: number | null; result: any }>((resolveResult, reject) => {
          const child = spawn(
            "pwsh.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              resolve("skills/api-network-recorder/scripts/invoke-recorder.ps1"),
              "-BridgePath",
              resolve(bridgeBinary),
              "-Tool",
              tool,
              "-ArgumentsJson",
              JSON.stringify(args),
            ],
            { env: runtimeEnv(home), windowsHide: true },
          )
          let output = "",
            error = ""
          child.stdout!.on("data", (bytes) => {
            output += String(bytes)
          })
          child.stderr!.on("data", (bytes) => {
            error += String(bytes)
          })
          child.on("error", reject)
          child.on("exit", (code) => {
            try {
              expect(error).toBe("")
              resolveResult({ code, result: JSON.parse(output) })
            } catch (failure) {
              reject(failure)
            }
          })
        })
      const read = await invokeSkill("get_request", { id: "skill-México-🧪" })
      expect(read.code).toBe(0)
      expect(read.result.id).toBe("skill-México-🧪")
      expect(read.result.responseBody.value.synthetic).toBe("México 🧪")
      const denied = await invokeSkill("start_recording", {})
      expect(denied.code).toBe(1)
      expect(denied.result.error).toContain("permission")
    }
    if (bridgeBinary) {
      const invoke = async (tool: string, args: object) => {
        const child = Bun.spawn([resolve(bridgeBinary), "--call", tool, JSON.stringify(args)], {
          env: runtimeEnv(home),
          stdout: "pipe",
          stderr: "pipe",
        })
        const output = await new Response(child.stdout).text()
        expect(await new Response(child.stderr).text()).toBe("")
        return { code: await child.exited, result: JSON.parse(output) }
      }
      const read = await invoke("get_request", { id: "terminal-México-🧪" })
      expect(read.code).toBe(0)
      expect(read.result.responseBody.value.synthetic).toBe("México 🧪")
      const denied = await invoke("start_recording", {})
      expect(denied.code).toBe(1)
      expect(denied.result.error).toContain("permission")
    }
    const count = forwarded
    const denied = await client.callTool({ name: "start_recording", arguments: {} })
    expect(denied.isError).toBe(true)
    expect(forwarded).toBe(count)
    expect(
      body(await client.callTool({ name: "search_requests", arguments: {} })).args.pageSize,
    ).toBe(25)
    await new Promise<void>((resolveResult, reject) => {
      const socket = createConnection(connection.pipe)
      socket.on("error", reject)
      socket.on("connect", () =>
        socket.write(
          encodeFrame({ token: "0".repeat(64), method: "get_request", args: { id: "x" } }),
        ),
      )
      readFrames(
        socket,
        (message) => {
          expect(message.error).toContain("Unauthorized")
          socket.destroy()
          resolveResult()
        },
        reject,
      )
    })
    expect(forwarded).toBe(count + 1)
    const secondId = randomUUID()
    writeFileSync(
      join(home, "bridge.json"),
      JSON.stringify({ token, extensionIds: [extensionId], allowControls: true }),
    )
    await host(secondId)
    expect(
      body(await client.callTool({ name: "list_profiles", arguments: {} })).profiles.length,
    ).toBe(2)
    expect((await client.callTool({ name: "capture_status", arguments: {} })).isError).toBe(true)
    expect(
      body(await client.callTool({ name: "capture_status", arguments: { profileId: secondId } }))
        .profileId,
    ).toBe(secondId)
    expect(
      (await client.callTool({ name: "start_recording", arguments: { profileId: secondId } }))
        .isError,
    ).not.toBe(true)
    if (process.platform !== "win32") {
      // A crashed Chrome host leaves its Unix socket behind; reconnection must recover it.
      const crashed = hosts[hosts.length - 1]!
      crashed.kill("SIGKILL")
      await waitFor(() => crashed.signalCode !== null, "Crashed host exit")
      await host(secondId)
      expect(
        body(await client.callTool({ name: "capture_status", arguments: { profileId: secondId } }))
          .profileId,
      ).toBe(secondId)
    }
    const beforeRevocation = forwarded
    writeFileSync(
      join(home, "bridge.json"),
      JSON.stringify({ token, extensionIds: [extensionId], allowControls: false }),
    )
    expect(
      (await client.callTool({ name: "start_recording", arguments: { profileId: secondId } }))
        .isError,
    ).toBe(true)
    expect(forwarded).toBe(beforeRevocation)
    writeFileSync(
      join(home, "bridge.json"),
      JSON.stringify({ token, extensionIds: [], allowControls: false }),
    )
    expect(
      (await client.callTool({ name: "capture_status", arguments: { profileId: firstId } }))
        .isError,
    ).toBe(true)
    writeFileSync(
      join(home, "bridge.json"),
      JSON.stringify({
        token: randomBytes(32).toString("hex"),
        extensionIds: [extensionId],
        allowControls: false,
      }),
    )
    expect(
      (await client.callTool({ name: "capture_status", arguments: { profileId: firstId } }))
        .isError,
    ).toBe(true)
  } finally {
    for (const client of clients) await client.close()
    for (const child of hosts) {
      child.stdin?.end()
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, "Host shutdown")
    }
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
