import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import assert from "node:assert/strict"

const profile = await mkdtemp(join(tmpdir(), "api-recorder-smoke-"))
const extension = resolve("dist/chrome")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/api")
      return Response.json({ capture: "global-smoke", ok: true })
    return new Response(
      '<!doctype html><title>Recorder smoke test</title><body><script>fetch("/api?" + location.search).then(r => r.json()).then(data => document.body.textContent = JSON.stringify(data))</script>',
      { headers: { "content-type": "text/html" } },
    )
  },
})
const browser = spawn(
  process.env.BROWSER_BINARY ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "--disable-extensions-except=" + extension,
    "--load-extension=" + extension,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
)
const sockets: WebSocket[] = []
const connect = async (url: string) => {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const calls = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let id = 0
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("CDP connection failed"))
  })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data))
    const call = calls.get(message.id)
    if (!call) return
    calls.delete(message.id)
    clearTimeout(call.timer)
    if (message.error) call.reject(new Error(JSON.stringify(message.error)))
    else call.resolve(message.result)
  }
  socket.onclose = () => {
    for (const call of calls.values()) {
      clearTimeout(call.timer)
      call.reject(new Error("Browser connection closed"))
    }
    calls.clear()
  }
  return (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const callId = ++id
      const timer = setTimeout(() => {
        calls.delete(callId)
        reject(new Error(method + " timed out"))
      }, 35000)
      calls.set(callId, { resolve, reject, timer })
      socket.send(JSON.stringify({ id: callId, method, params }))
    })
}
const waitFor = async (
  read: () => Promise<any>,
  accepts: (value: any) => boolean,
  label: string,
) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (accepts(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(label + " was not ready")
}
let browserCommand: Awaited<ReturnType<typeof connect>> | undefined
try {
  let port = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!
      break
    } catch {
      await Bun.sleep(100)
    }
  }
  assert(port, "Browser did not expose a debug port")
  const base = "http://127.0.0.1:" + port
  const version = await (await fetch(base + "/json/version")).json()
  browserCommand = await connect(version.webSocketDebuggerUrl)
  const worker = await waitFor(
    async () =>
      (await (await fetch(base + "/json/list")).json()).find(
        (target: any) =>
          target.type === "service_worker" && target.url.endsWith("/assets/background.js"),
      ),
    Boolean,
    "Extension",
  )
  const extensionUrl = worker.url.slice(0, worker.url.indexOf("/assets/"))
  const { targetId } = await browserCommand("Target.createTarget", {
    url: extensionUrl + "/popup.html",
  })
  const targets = await (await fetch(base + "/json/list")).json()
  const command = await connect(
    targets.find((target: any) => target.id === targetId).webSocketDebuggerUrl,
  )
  const evaluate = async (expression: string) => {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const message = async (value: object) => {
    const response = await evaluate("chrome.runtime.sendMessage(" + JSON.stringify(value) + ")")
    assert.equal(response.ok, true, response.error)
    return response.data
  }
  const fixture = "http://127.0.0.1:" + server.port
  const createTab = async (url: string, active = false) =>
    evaluate("chrome.tabs.create(" + JSON.stringify({ url, active }) + ").then(tab => tab.id)")
  const first = await createTab(fixture + "/first")
  const second = await createTab(fixture + "/second")
  const ignored = await createTab("http://localhost:" + server.port + "/ignored", true)
  await message({
    type: "SET_CAPTURE_SETTINGS",
    payload: { ignoredTabIds: [ignored], ignoredDomains: ["localhost"] },
  })
  await command("Page.reload")
  await waitFor(
    () => evaluate("document.querySelector('#toggleDeepCapture')?.textContent"),
    (text) => text === "Start deep capture",
    "Global start button",
  )
  // Exercise the actual popup button while the current tab is ignored.
  await evaluate("document.querySelector('#toggleDeepCapture').click()")
  const status = await waitFor(
    () => message({ type: "GET_CAPTURE_STATUS", payload: {} }),
    (value) => value.attachedCount >= 2,
    "Global capture",
  )
  assert.equal(
    (await message({ type: "GET_CAPTURE_STATUS", payload: { tabId: ignored } })).attached,
    false,
  )
  await waitFor(
    () => evaluate("document.querySelector('#captureBadge').textContent"),
    (text) => text === "Deep capture on",
    "Global status badge",
  )
  const future = await createTab(fixture + "/future")
  await waitFor(
    () => message({ type: "GET_CAPTURE_STATUS", payload: { tabId: future } }),
    (value) => value.attached,
    "New tab capture",
  )
  for (const tabId of [first, second, future])
    await evaluate(
      "chrome.tabs.update(" +
        tabId +
        "," +
        JSON.stringify({ url: fixture + "/?after-start=" + tabId }) +
        ")",
    )
  const records = await waitFor(
    () => message({ type: "GET_RECORDS", payload: { source: "debugger", apiOnly: false } }),
    (records) =>
      [first, second, future].every((tabId) =>
        records.some(
          (record) =>
            record.tabId === tabId &&
            record.url.includes("/api?") &&
            JSON.stringify(record.responseBody).includes("global-smoke"),
        ),
      ),
    "Response bodies in all allowed tabs",
  )
  assert(!records.some((record: any) => record.tabId === ignored))
  const settings = await message({ type: "GET_CAPTURE_SETTINGS" })
  assert.deepEqual(settings.ignoredTabIds, [ignored])
  assert.deepEqual(settings.ignoredDomains, ["localhost"])
  await evaluate("document.querySelector('#toggleDeepCapture').click()")
  await waitFor(
    () => message({ type: "GET_CAPTURE_STATUS", payload: {} }),
    (value) => !value.enabled && value.attachedCount === 0,
    "Global stop",
  )
  console.log(
    "PASS: popup starts globally from an ignored tab; 3 allowed tabs capture real JSON; exclusions preserved; global stop works.",
  )
  console.log(
    JSON.stringify({ initialAttachedTabs: status.attachedCount, capturedTabs: 3, ignoredTabs: 1 }),
  )
} finally {
  if (browserCommand) await browserCommand("Browser.close").catch(() => {})
  browser.kill()
  for (const socket of sockets) socket.close()
  server.stop(true)
  // Remove only this test's generated profile in the temporary directory.
  if (resolve(dirname(profile)) === resolve(tmpdir()) && profile.includes("api-recorder-smoke-")) {
    await Bun.sleep(300)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => {},
    )
  }
}
