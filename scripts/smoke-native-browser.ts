import { spawn, spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const root = mkdtempSync(join(tmpdir(), "recorder-native-browser-"))
const profile = join(root, "profile"),
  home = join(root, "bridge"),
  extension = join(root, "extension")
mkdirSync(profile)
mkdirSync(home)
cpSync(resolve("dist/chrome"), extension, { recursive: true })
const hostName = "com.api_network_recorder.smoke_" + randomUUID().replaceAll("-", "")
const background = join(extension, "assets", "background.js")
const source = readFileSync(background, "utf8")
assert(
  source.includes("com.api_network_recorder.bridge"),
  "Native bridge absent from production build",
)
writeFileSync(background, source.replaceAll("com.api_network_recorder.bridge", hostName))
const fixture = await Bun.build({
  entrypoints: [resolve("scripts/inspector-browser-fixture.ts")],
  target: "browser",
  format: "esm",
})
assert(fixture.success, String(fixture.logs))
writeFileSync(
  join(extension, "assets", "native-smoke-fixture.js"),
  await fixture.outputs[0]!.text(),
)
const token = randomBytes(32).toString("hex")
const binary = resolve("dist/native/api-network-recorder-bridge.exe")
const manifestPath = join(root, "native-host.json")
const env = { ...process.env, API_RECORDER_HOME: home }
const browser = spawn(
  process.env.BROWSER_BINARY || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore", env },
)
const key = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${hostName}`
const waitFor = async <T>(
  read: () => Promise<T> | T,
  accepts: (value: T) => boolean,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + 15000
  do {
    try {
      const value = await read()
      if (accepts(value)) return value
    } catch {}
    await new Promise((resolveResult) => setTimeout(resolveResult, 100))
  } while (Date.now() < deadline)
  throw new Error("Timeout: " + label)
}
let socket: WebSocket | undefined
let client: Client | undefined
let registryAdded = false
try {
  const port = await waitFor(
    () => readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0],
    Boolean,
    "Browser start",
  )
  const base = `http://127.0.0.1:${port}`
  const targets = () =>
    fetch(base + "/json/list").then((response) => response.json()) as Promise<any[]>
  const worker = await waitFor(
    targets,
    (items) =>
      items.some((item) => item.type === "service_worker" && item.url.includes("/background.js")),
    "Extension worker",
  )
  const extensionId = new URL(
    worker.find((item) => item.type === "service_worker" && item.url.includes("/background.js"))
      .url,
  ).hostname
  writeFileSync(
    join(home, "bridge.json"),
    JSON.stringify({ token, extensionIds: [extensionId], allowControls: true }),
  )
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: hostName,
      description: "Isolated integration test",
      path: binary,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  )
  const registry = spawnSync(
    "reg.exe",
    ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
    { windowsHide: true },
  )
  assert.equal(registry.status, 0)
  registryAdded = true
  const tab = (await fetch(
    base + "/json/new?" + encodeURIComponent(`chrome-extension://${extensionId}/agent.html`),
    { method: "PUT" },
  ).then((response) => response.json())) as any
  socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise<void>((resolveResult, reject) => {
    socket!.onopen = () => resolveResult()
    socket!.onerror = () => reject(new Error("Test browser connection failed"))
  })
  let sequence = 0
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)),
      call = pending.get(message.id)
    if (!call) return
    clearTimeout(call.timer)
    pending.delete(message.id)
    if (message.error) call.reject(new Error(JSON.stringify(message.error)))
    else call.resolve(message.result)
  }
  const command = (method: string, params: object) =>
    new Promise<any>((resolveResult, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Test browser command timed out"))
        }, 15000)
      pending.set(id, { resolve: resolveResult, reject, timer })
      socket!.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression: string) => {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await waitFor(
    () => evaluate('document.getElementById("connectIntegration") !== null'),
    Boolean,
    "Integration UI",
  )
  await evaluate(
    'chrome.runtime.sendMessage({type:"SET_NATIVE_BRIDGE_ENABLED",payload:{enabled:true}})',
  )
  await waitFor(
    () => evaluate('chrome.runtime.sendMessage({type:"GET_NATIVE_BRIDGE_STATUS"})'),
    (value) => value?.data?.connected === true,
    "Native host connection",
  )
  const sessionId = await evaluate(
    '(async () => { const fixture = await import("./assets/native-smoke-fixture.js"); return fixture.seedAgent() })()',
  )
  client = new Client({ name: "native-browser-smoke", version: "1" })
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["--mcp"],
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      stderr: "pipe",
    }),
  )
  const call = async (name: string, args: object = {}) => {
    const result = await client!.callTool({ name, arguments: args })
    assert(!result.isError, JSON.stringify(result))
    return JSON.parse((result.content as any)[0].text)
  }
  assert.equal((await call("list_profiles")).profiles.length, 1)
  const records = await call("search_requests", { search: "bodyOnlyNeedle", pageSize: 10 })
  assert.equal(records.total, 30)
  assert.equal(records.records.length, 10)
  assert(records.hasMore)
  const detail = await call("get_request", { id: "agent-30" })
  assert.equal(detail.id, "agent-30")
  assert(detail.responseBody)
  assert((await call("list_sessions")).some((session: any) => session.id === sessionId))
  assert.equal((await call("search_requests", { sessionId })).total, 2)
  await call("stop_recording")
  assert.equal((await call("capture_status")).settings.capturePaused, true)
  await call("start_recording")
  assert.equal((await call("capture_status")).settings.capturePaused, false)
  writeFileSync(
    join(home, "bridge.json"),
    JSON.stringify({ token, extensionIds: [extensionId], allowControls: false }),
  )
  await evaluate(
    'chrome.runtime.sendMessage({type:"SET_NATIVE_BRIDGE_ENABLED",payload:{enabled:false}})',
  )
  await waitFor(
    () => call("list_profiles"),
    (value) => value.profiles.length === 0,
    "Disconnect",
  )
  await evaluate(
    'chrome.runtime.sendMessage({type:"SET_NATIVE_BRIDGE_ENABLED",payload:{enabled:true}})',
  )
  await waitFor(
    () => evaluate('chrome.runtime.sendMessage({type:"GET_NATIVE_BRIDGE_STATUS"})'),
    (value) => value?.data?.connected,
    "Reconnect read-only",
  )
  assert((await client.callTool({ name: "stop_recording", arguments: {} })).isError)
  assert.equal((await call("get_request", { id: "agent-30" })).id, "agent-30")
  assert.deepEqual(readdirSync(home).sort(), ["bridge.json", "connections"])
  console.log(
    "PASS: compiled MCP -> authenticated native host -> real extension in an isolated Edge profile; body search, full details, saved sessions, controls, revocation/reconnection and read-only permission.",
  )
} finally {
  await client?.close()
  socket?.close()
  if (browser.exitCode === null) {
    browser.kill()
    await new Promise<void>((resolveResult) => browser.once("exit", () => resolveResult()))
  }
  if (registryAdded) spawnSync("reg.exe", ["DELETE", key, "/f"], { windowsHide: true })
  assert(
    resolve(root).startsWith(resolve(tmpdir()) + "\\recorder-native-browser-"),
    "Unsafe test cleanup path",
  )
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
