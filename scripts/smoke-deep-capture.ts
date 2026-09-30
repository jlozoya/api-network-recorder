import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import assert from "node:assert/strict"
import { runAgentSmoke } from "./agent-browser-smoke.js"

const fixtureBundlePath = resolve("dist/chrome/assets/inspector-smoke.js")
const fixtureBundle = await Bun.build({
  entrypoints: [resolve("scripts/inspector-browser-fixture.ts")],
  target: "browser",
  format: "esm",
  plugins: [
    {
      name: "isolated-migration-db",
      setup(build) {
        build.onLoad({ filter: /storage[\\/]db\.ts$/ }, async (args) => ({
          loader: "ts",
          contents: (await readFile(args.path, "utf8")).replace(
            'const DATABASE_NAME = "api-network-recorder-v2"',
            'const DATABASE_NAME = globalThis.__recorderSmokeDbName ?? "api-network-recorder-v2"',
          ),
        }))
      },
    },
  ],
})
assert(fixtureBundle.success, String(fixtureBundle.logs))
await writeFile(fixtureBundlePath, await fixtureBundle.outputs[0]!.text())
const profile = await mkdtemp(join(tmpdir(), "api-recorder-smoke-"))
const extension = resolve("dist/chrome")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/api")
      return Response.json({ capture: "global-smoke", ok: true })
    if (new URL(request.url).pathname === "/instant-post")
      return new Response('<!doctype html><title>Immediate POST calls</title><script>fetch("/api?initial-post", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"first-post"})}); const xhr = new XMLHttpRequest(); xhr.open("POST", "/api?initial-xhr"); xhr.setRequestHeader("Content-Type", "application/json"); xhr.send(JSON.stringify({name:"first-xhr"}));</script>', { headers: { "content-type": "text/html" } })
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
  const popupTarget = await waitFor(
    async () =>
      (await (await fetch(base + "/json/list")).json()).find(
        (target: any) => target.id === targetId && target.url === extensionUrl + "/popup.html",
      ),
    Boolean,
    "Popup target",
  )
  let command = await connect(popupTarget.webSocketDebuggerUrl)
  const evaluate = async (expression: string) => {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await waitFor(() => evaluate('typeof chrome?.tabs === "object"'), Boolean, "Extension APIs")
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
  await evaluate('globalThis.__navigationTrace = []; chrome.debugger.onEvent.addListener((source, method, params) => { if (method.startsWith("Network.")) globalThis.__navigationTrace.push({ tabId: source.tabId, method, requestId: params.requestId, url: params.request?.url ?? params.response?.url }); })')
  const instantTabs = await Promise.all([
    createTab(fixture + "/?first-load=one"),
    createTab(fixture + "/?first-load=two"),
  ])
  await waitFor(
    () => message({ type: "GET_RECORDS", payload: { apiOnly: false } }),
    (captured) => instantTabs.every((tabId) => captured.some((record: any) =>
      record.tabId === tabId && record.url.includes("first-load=") && record.url.includes("/api?") &&
      JSON.stringify(record.responseBody).includes("global-smoke"))),
    "API bodies on the first load of newly opened tabs (without polling capture status)",
  ).catch(async (error) => {
    console.log("New-tab capture diagnostics", JSON.stringify({
      records: (await message({ type: "GET_RECORDS", payload: { apiOnly: false } }) as any[]).filter((record) => instantTabs.includes(record.tabId)).map((record) => ({ source: record.source, url: record.url, body: record.responseBody })),
      tabs: (await message({ type: "GET_CAPTURE_TABS_STATUS" }) as any[]).filter((tab) => instantTabs.includes(tab.tabId)),
      events: (await evaluate('globalThis.__navigationTrace')).filter((event: any) => instantTabs.includes(event.tabId)),
    }))
    throw error
  })
  const beforeReload = new Set((await message({ type: "GET_RECORDS" }) as any[]).map((record) => record.id))
  await evaluate("chrome.tabs.reload(" + first + ")")
  await waitFor(
    () => message({ type: "GET_RECORDS", payload: { source: "debugger", apiOnly: false } }),
    (captured) => captured.some((record: any) => record.tabId === first && !beforeReload.has(record.id) &&
      record.url.includes("/api?") && JSON.stringify(record.responseBody).includes("global-smoke")),
    "API bodies after reloading an attached tab",
  )
  console.log("PASS: first-load API bodies in new tabs and response bodies after reload without checking debugger status.")
  const instantPost = await createTab(fixture + "/instant-post")
  await waitFor(
    () => message({ type: "GET_RECORDS", payload: { apiOnly: false } }),
    (captured) => ["post", "xhr"].every((kind) => captured.some((record: any) =>
      record.tabId === instantPost && record.url.includes("initial-" + kind) && record.method === "POST" &&
      record.requestBody?.value?.name === "first-" + kind && JSON.stringify(record.responseBody).includes("global-smoke"))),
    "Immediate fetch and XHR POST calls preserve request and response bodies",
  )
  const beforeRecovery = new Set((await message({ type: "GET_RECORDS" }) as any[]).map((record) => record.id))
  await evaluate("chrome.debugger.sendCommand({ tabId: " + first + " }, 'Network.disable')")
  await evaluate("chrome.tabs.reload(" + first + ")")
  await waitFor(
    () => message({ type: "GET_RECORDS", payload: { apiOnly: false } }),
    (captured) => captured.some((record: any) => record.tabId === first && !beforeRecovery.has(record.id) &&
      record.url.includes("/api?") && JSON.stringify(record.responseBody).includes("global-smoke")),
    "Reload preserves response bodies while restoring the Network domain",
  )
  await evaluate("chrome.scripting.executeScript({ target: { tabId: " + first + " }, world: 'MAIN', func: () => new Promise(resolve => setTimeout(() => fetch('/api?after-recovery').then(r => r.json()).then(resolve), 200)) })")
  await waitFor(
    () => message({ type: "GET_RECORDS", payload: { source: "debugger", apiOnly: false } }),
    (captured) => captured.some((record: any) => record.tabId === first && record.url.includes("after-recovery") && JSON.stringify(record.responseBody).includes("global-smoke")),
    "Reload re-enables debugger capture for subsequent API requests without a popup/status repair",
  )
  const settings = await message({ type: "GET_CAPTURE_SETTINGS" })
  assert.deepEqual(settings.ignoredTabIds, [ignored])
  assert.deepEqual(settings.ignoredDomains, ["localhost"])
  await evaluate("document.querySelector('#toggleDeepCapture').click()")
  await waitFor(
    () => message({ type: "GET_CAPTURE_STATUS", payload: {} }),
    (value) => !value.enabled && value.attachedCount === 0,
    "Global stop",
  )
  assert.deepEqual(await evaluate('chrome.scripting.getRegisteredContentScripts({ ids: ["deep-capture-first-requests"] })'), [])
  const stoppedPage = await evaluate("chrome.scripting.executeScript({ target: { tabId: " + instantPost + " }, world: 'MAIN', func: async () => { const events = []; const handler = event => { if (event.data?.source === 'API_NETWORK_RECORDER' && event.data.message?.payload.url.includes('after-stop')) events.push(event.data); }; window.addEventListener('message', handler); const response = await fetch('/api?after-stop'); const body = await response.json(); await new Promise(resolve => setTimeout(resolve, 100)); window.removeEventListener('message', handler); return { events, body }; } })")
  assert.equal(stoppedPage[0].result.body.capture, "global-smoke")
  assert.deepEqual(stoppedPage[0].result.events, [])
  console.log("PASS: immediate fetch/XHR POST bodies; recovery of disabled Network after reload; stop unregisters future hooks and disables existing page hooks.")
  console.log(
    "PASS: popup starts globally from an ignored tab; 3 allowed tabs capture real JSON; exclusions preserved; global stop works.",
  )
  console.log(
    JSON.stringify({ initialAttachedTabs: status.attachedCount, capturedTabs: 3, ignoredTabs: 1 }),
  )

  const tabStatuses = await message({ type: "GET_CAPTURE_TABS_STATUS" })
  assert.equal(tabStatuses.find((tab: any) => tab.tabId === ignored).state, "ignored")
  assert.equal(tabStatuses.find((tab: any) => tab.tabId === first).state, "off")
  // Load a test-only bundle. A separate module instance uses an isolated v1 database.
  const migration = await evaluate(
    '(async () => { globalThis.__recorderSmokeDbName = "api-recorder-migration-smoke"; const fixture = await import("./assets/inspector-smoke.js?migration"); delete globalThis.__recorderSmokeDbName; return fixture.migrationAndRetention() })()',
  )
  assert.equal(migration.migrated, true)
  console.log("PASS: isolated IndexedDB migration and retention.")
  await evaluate(
    '(async () => { const fixture = await import("./assets/inspector-smoke.js"); await fixture.seedInspector() })()',
  )
  console.log("PASS: inspector fixture seeded.")
  const { targetId: appTargetId } = await browserCommand("Target.createTarget", {
    url: extensionUrl + "/app.html",
  })
  const appTarget = await waitFor(
    async () =>
      (await (await fetch(base + "/json/list")).json()).find(
        (target: any) => target.id === appTargetId && target.url === extensionUrl + "/app.html",
      ),
    Boolean,
    "Inspector target",
  )
  command = await connect(appTarget.webSocketDebuggerUrl)
  if (process.env.SMOKE_REDUCED_MOTION === "1") {
    await command("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    })
  }
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 3,
    "Inspector records",
  )
  assert(
    !(await evaluate('document.querySelector(".details").textContent.includes("bodyOnlyNeedle")')),
    "Bodies rendered before selection",
  )
  await evaluate("document.querySelector('[data-id=\"ui-a\"]').click()")
  await waitFor(
    () => evaluate('document.querySelector(".details").textContent'),
    (text) => text.includes("bodyOnlyNeedle"),
    "Lazy details",
  )
  assert(
    !(await evaluate('Boolean(document.querySelector(".details script"))')),
    "Captured HTML was injected",
  )
  // Reproduce a browser-denied capture without changing the temporary profile's data.
  await evaluate(`
    globalThis.__originalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      if (message.type === "START_DEBUGGER_CAPTURE_ALL")
        return Promise.resolve({ ok: false, error: "The extensions gallery cannot be scripted." });
      return globalThis.__originalSendMessage.call(chrome.runtime, message, ...args);
    };
    document.querySelector("#toggleDeepCapture").click();
  `)
  try {
    await waitFor(
      () => evaluate('document.querySelector(".notice")?.textContent'),
      (text) => text?.includes("The extensions gallery cannot be scripted."),
      "Recoverable capture error",
    )
    assert.equal(await evaluate('document.querySelectorAll(".record[data-id]").length'), 3)
    assert.equal(await evaluate('document.querySelector(".record.selected")?.dataset.id'), "ui-a")
    assert(await evaluate('document.querySelector(".details").textContent.includes("bodyOnlyNeedle")'))
    assert.equal(await evaluate('Boolean(document.querySelector(".fatal, #resetLocalDb"))'), false)
    assert.equal(await evaluate('document.querySelector("#toggleDeepCapture").disabled'), false)
    const captureErrorScreenshot = await command("Page.captureScreenshot", { format: "png" })
    await writeFile(
      resolve("dist/capture-error-smoke.png"),
      Buffer.from(captureErrorScreenshot.data, "base64"),
    )
    await evaluate('document.querySelector("#dismissNotice").click()')
    assert.equal(await evaluate('Boolean(document.querySelector(".notice"))'), false)
    console.log("PASS: capture denial preserves the inspector, selected record and details; notice can be dismissed.")
  } finally {
    await evaluate(`
      chrome.runtime.sendMessage = globalThis.__originalSendMessage;
      delete globalThis.__originalSendMessage;
    `)
  }
  await evaluate('document.querySelector("#pinRequest").click()')
  await waitFor(
    () => evaluate('document.querySelector("#pinRequest")?.textContent'),
    (text) => text === "Unpin request",
    "Pinned request",
  )
  await evaluate(
    'document.querySelector("#setBaseline").click(); document.querySelector(\'[data-id="ui-b"]\').click()',
  )
  await waitFor(
    () => evaluate('document.querySelector(".details").textContent'),
    (text) => text.includes('"name": "ui-b"'),
    "Second request details",
  )
  await evaluate('document.querySelector("#compareRequest").click()')
  assert(
    await evaluate(
      'document.querySelector("dialog").textContent.includes("/responseBody/value/number")',
    ),
  )
  await evaluate(
    'document.querySelector("dialog").close(); const input = document.querySelector("#sessionName"); input.value = "UI saved session"; input.dispatchEvent(new Event("input")); document.querySelector("#saveSession").click()',
  )
  const savedId = await waitFor(
    () => evaluate("document.querySelector('#sessionSelect option:nth-child(2)')?.value"),
    Boolean,
    "Saved session option",
  )
  await evaluate('document.querySelector("#clear").click()')
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 1,
    "Clear preserves pin",
  )
  await evaluate(
    'const select = document.querySelector("#sessionSelect"); select.value = ' +
      JSON.stringify(savedId) +
      '; select.dispatchEvent(new Event("change"))',
  )
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 3,
    "Open saved session",
  )
  await evaluate("document.querySelector('[data-id=\"ui-b\"]').click()")
  await waitFor(
    () => evaluate('document.querySelector(".details").textContent'),
    (text) => text.includes('"name": "ui-b"'),
    "Saved response body",
  )
  await evaluate('document.querySelector("#exportOpenApi").click()')
  assert.equal(await evaluate('document.querySelectorAll("dialog [data-origin]").length'), 2)
  await evaluate(
    'document.querySelector("dialog").close(); document.querySelector("#captureTabs").click()',
  )
  await waitFor(
    () => evaluate('document.querySelectorAll(".tabStatus").length'),
    (count) => count > 0,
    "Tab diagnostics",
  )
  await evaluate('document.querySelector("dialog").close()')

  await evaluate(
    '(() => { const liveSessionSelect = document.querySelector("#sessionSelect"); liveSessionSelect.value = ""; liveSessionSelect.dispatchEvent(new Event("change")) })()',
  )
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 1,
    "Return to live capture",
  )
  await evaluate(`
    globalThis.__listScrollCalls = [];
    globalThis.__listScrollSamples = [];
    globalThis.__originalList = document.querySelector(".list");
    globalThis.__originalRow = document.querySelector(".record");
    const nativeScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function(optionsOrX, y) {
      if (this.classList?.contains("list")) {
        const options = typeof optionsOrX === "object"
          ? optionsOrX
          : { left: optionsOrX, top: y };
        globalThis.__listScrollCalls.push({ ...options });
        if (options.behavior === "smooth") {
          // Record the real starting offset before the browser scrolls. Windows
          // preferences and headless runners may complete native motion in one frame.
          globalThis.__listScrollSamples.push({ top: this.scrollTop, connected: this.isConnected });
          const started = performance.now();
          const sample = () => {
            globalThis.__listScrollSamples.push({ top: this.scrollTop, connected: this.isConnected });
            if (performance.now() - started < 1200) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }
      }
      return nativeScrollTo.apply(this, arguments);
    };
  `)
  await evaluate(
    '(async () => { const fixture = await import("./assets/inspector-smoke.js?scroll"); await fixture.addInspectorRecords("scroll", 30, 100) })()',
  )
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 31,
    "Top-pinned refresh",
  )
  assert(
    await evaluate(
      'globalThis.__listScrollCalls.some(call => call.top === 0 && call.behavior === "smooth")',
    ),
    "A top-pinned list did not smoothly reveal new records",
  )

  await waitFor(
    () => evaluate('document.querySelector(".list").scrollTop === 0 && globalThis.__listScrollSamples.at(-1)?.top === 0'),
    Boolean,
    "Native smooth scrolling finishes",
  )
  assert(
    await evaluate('globalThis.__originalList === document.querySelector(".list") && globalThis.__originalRow.isConnected'),
    "Live refresh replaced the list or an existing row",
  )
  assert(
    await evaluate('new Set(globalThis.__listScrollSamples.map(sample => sample.top)).size > 1 && globalThis.__listScrollSamples.every(sample => sample.connected)'),
    "Native smooth scroll did not reach the top on the original list",
  )

  const beforeScroll = await evaluate(`
    (async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector(".list");
      list.scrollTop = Math.min(500, list.scrollHeight - list.clientHeight);
      const top = list.getBoundingClientRect().top;
      const item = [...list.querySelectorAll(".record[data-id]")]
        .find(candidate => candidate.getBoundingClientRect().bottom > top);
      item.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const restoredList = document.querySelector(".list");
      const restoredItem = restoredList.querySelector('[data-id="' + item.dataset.id + '"]');
      globalThis.__listScrollCalls = [];
      return {
        id: item.dataset.id,
        offset: restoredItem.getBoundingClientRect().top - restoredList.getBoundingClientRect().top,
        scrollTop: restoredList.scrollTop,
      };
    })()
  `)
  assert(beforeScroll.scrollTop > 8, "Scroll fixture did not move away from the top")
  await evaluate(
    '(async () => { const fixture = await import("./assets/inspector-smoke.js?scroll"); await fixture.addInspectorRecords("later", 1, 200) })()',
  )
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 32,
    "Scrolled refresh",
  )
  const anchorId = JSON.stringify(beforeScroll.id)
  const afterScroll = await evaluate(`
    (async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector(".list");
      const id = ${anchorId};
      const item = list.querySelector('[data-id="' + id + '"]');
      return {
        id,
        offset: item?.getBoundingClientRect().top - list.getBoundingClientRect().top,
        scrollTop: list.scrollTop,
        smoothCalls: globalThis.__listScrollCalls.length,
      };
    })()
  `)
  assert.equal(afterScroll.id, beforeScroll.id)
  assert(Math.abs(afterScroll.offset - beforeScroll.offset) <= 1, "Scrolled anchor moved")
  assert(afterScroll.scrollTop > 8, "Scrolled list jumped to the top")
  assert.equal(afterScroll.smoothCalls, 0, "Scrolled list triggered automatic scrolling")
  const selectedAtTop = await evaluate(`
    (async () => {
      const list = document.querySelector(".list");
      list.scrollTop = 0;
      const item = list.querySelector(".record[data-id]");
      item.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return item.dataset.id;
    })()
  `)
  await waitFor(
    () => evaluate('document.querySelector(".details").textContent'),
    (text) => text.includes(selectedAtTop),
    "Selected top request details",
  )
  await evaluate(`
    globalThis.__listScrollCalls = [];
    globalThis.__selectedNode = document.querySelector(".record.selected");
    globalThis.__detailNode = document.querySelector(".details").firstElementChild;
    globalThis.__insertAnimations = [];
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("record")) {
            globalThis.__insertAnimations.push(...node.getAnimations());
          }
        }
      }
    });
    observer.observe(document.querySelector(".list"), { childList: true });
  `)
  await evaluate(
    '(async () => { const fixture = await import("./assets/inspector-smoke.js?scroll"); await fixture.addInspectorRecords("selection-refresh", 1, 300) })()',
  )
  await waitFor(
    () => evaluate('document.querySelectorAll(".record[data-id]").length'),
    (count) => count === 33,
    "Selected top request refresh",
  )
  await waitFor(
    () => evaluate('document.querySelector(".list").scrollTop'),
    (top) => top === 0,
    "Selected request refresh animation finishes",
  )
  assert(
    await evaluate('globalThis.__selectedNode === document.querySelector(".record.selected") && globalThis.__detailNode === document.querySelector(".details").firstElementChild'),
    "Live refresh replaced the selected row or its unchanged details",
  )
  assert(
    await evaluate('window.matchMedia("(prefers-reduced-motion: reduce)").matches ? globalThis.__insertAnimations.length === 0 : globalThis.__insertAnimations.length > 0'),
    "New record animations did not respect the reduced-motion preference",
  )
  const selectedAfterRefresh = await evaluate(`
    (async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const list = document.querySelector(".list");
      const item = list.querySelector(".record.selected");
      return {
        id: item?.dataset.id,
        offset: item?.getBoundingClientRect().top - list.getBoundingClientRect().top,
        smoothCalls: globalThis.__listScrollCalls.length,
        details: document.querySelector(".details").textContent,
      };
    })()
  `)
  await evaluate(
    '(async () => { const fixture = await import("./assets/inspector-smoke.js?scroll"); await fixture.addInspectorRecords("retention-refresh", 75, 400); await fixture.trimInspectorRecords() })()',
  )
  await waitFor(
    () => evaluate('Boolean(document.querySelector(\'[data-id="retention-refresh-74"]\'))'),
    Boolean,
    "Refresh after selected request expires",
  )
  assert.equal(
    await evaluate('document.querySelector(".record.selected")?.dataset.id'),
    selectedAtTop,
    "Automatic retention cleared the selected request",
  )
  assert(
    await evaluate('document.querySelector(".details").textContent.includes(' + JSON.stringify(selectedAtTop) + ')'),
    "Automatic retention cleared the selected details",
  )
  assert.equal(selectedAfterRefresh.id, selectedAtTop, "Selected request lost its highlight")
  assert(selectedAfterRefresh.offset > 0, "New record was not revealed above the selection")
  assert.equal(selectedAfterRefresh.smoothCalls, 1, "Selection disabled the smooth refresh animation")
  assert(selectedAfterRefresh.details.includes(selectedAtTop), "Selected request lost its details")
  // The test bundle is removed below; production releases contain only the built extension.
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  )
  const screenshot = await command("Page.captureScreenshot", { format: "png" })
  await writeFile(resolve("dist/inspector-smoke.png"), Buffer.from(screenshot.data, "base64"))
  console.log(
    "PASS: v1 migration; metadata lists; pinned retention; atomic snapshots; body search; lazy inspector details; comparison; session reopen; per-origin export; tab diagnostics; stable list and detail nodes; native smooth scrolling; animated new records; selection retention.",
  )
  await evaluate('document.querySelector("#openAgent").click()')
  const agentTarget = await waitFor(
    async () => (await (await fetch(base + "/json/list")).json()).find((target: any) => target.url === extensionUrl + "/agent.html"),
    Boolean,
    "AI access opened from inspector",
  )
  command = await connect(agentTarget.webSocketDebuggerUrl)
  await waitFor(() => evaluate('Boolean(document.getElementById("searchForm"))'), Boolean, "AI access page")
  await runAgentSmoke(evaluate, waitFor)
  await command("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false })
  await writeFile(resolve("dist/agent-smoke.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"))
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), "AI access overflows on mobile")
  await writeFile(resolve("dist/agent-mobile-smoke.png"), Buffer.from((await command("Page.captureScreenshot", { format: "png" })).data, "base64"))
} finally {
  if (browserCommand) await browserCommand("Browser.close").catch(() => {})
  await unlink(fixtureBundlePath).catch(() => {})
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
