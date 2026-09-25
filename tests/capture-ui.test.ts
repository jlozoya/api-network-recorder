import { expect, test } from "bun:test"
import { createContext, Script } from "node:vm"
import { resolve } from "node:path"

const bundles = new Map<string, Promise<string>>()
const bundle = (entry: string) => {
  if (!bundles.has(entry))
    bundles.set(
      entry,
      (async () => {
        const result = await Bun.build({
          entrypoints: [resolve("src/" + entry)],
          target: "browser",
          format: "iife",
          define: {
            __SUPPORTS_DEEP_CAPTURE__: "true",
            __BROWSER_TARGET__: JSON.stringify("chrome"),
          },
          plugins: [
            {
              name: "ui-test-storage",
              setup(build) {
                build.onResolve({ filter: /network-record-repository\.js$/ }, () => ({
                  path: "records",
                  namespace: "test",
                }))
                build.onResolve({ filter: /\.css$/ }, () => ({ path: "styles", namespace: "test" }))
                build.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({
                  loader: "js",
                  contents:
                    path === "styles"
                      ? ""
                      : "export const listNetworkRecords = async () => []; export const listNetworkRecordPreviews = (...args) => globalThis.testListRecords(...args); export const getNetworkRecordsByIds = async () => []; export const listSavedSessions = async () => []; export const saveSession = async () => {}; export const deleteSavedSession = async () => {}; export const setNetworkRecordPinned = async () => {}; export const clearNetworkRecords = async () => {};",
                }))
              },
            },
          ],
        })
        if (!result.success) throw new Error(String(result.logs))
        return result.outputs[0].text()
      })(),
    )
  return bundles.get(entry)!
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
class Element {
  textContent = ""
  innerHTML = ""
  value = ""
  hidden = false
  disabled = false
  dataset = {}
  handlers = new Map()
  addEventListener(name, callback) {
    this.handlers.set(name, callback)
  }
  removeAttribute() {}
  setAttribute() {}
  focus() {}
  contains() {
    return false
  }
}
const createUi = async (
  entry,
  sendMessage,
  tabs = [{ id: 1, url: "https://example.test/" }],
  testListRecords = async () => [],
) => {
  const selectors = entry.startsWith("popup")
    ? [
        "#captureBadge",
        "#summary",
        "#error",
        "#captureLimit",
        "#toggleIgnoreTab",
        "#toggleIgnoreDomain",
        "#ignoredDomains",
        "#toggleDeepCapture",
        ".deepCapture",
      ]
    : ["#app", "#toggleDeepCapture", "#search"]
  const elements = new Map(selectors.map((selector) => [selector, new Element()]))
  if (elements.has("#summary")) elements.get("#summary").textContent = "Loading..."
  if (elements.has("#captureBadge")) elements.get("#captureBadge").textContent = "Checking"
  const timers = new Map()
  const intervals = []
  let timerId = 0
  const settings = {
    captureLimit: 50,
    capturePaused: false,
    captureActiveSince: null,
    deepCaptureEnabled: false,
    ignoredDomains: [],
    ignoredTabIds: [],
  }
  const context = createContext({
    console,
    testListRecords,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    HTMLElement: Element,
    HTMLButtonElement: Element,
    HTMLInputElement: Element,
    HTMLSelectElement: Element,
    HTMLTextAreaElement: Element,
    document: {
      querySelector: (selector) => elements.get(selector) ?? null,
      querySelectorAll: () => [],
      activeElement: null,
      hidden: false,
    },
    setTimeout: (callback, duration) => {
      const id = ++timerId
      timers.set(id, { callback, duration })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => {
      intervals.push(callback)
      return intervals.length
    },
    requestAnimationFrame: (callback) => {
      callback()
      return ++timerId
    },
    cancelAnimationFrame: () => {},
    getSelection: () => null,
    chrome: {
      runtime: { sendMessage: (message) => sendMessage(message, settings) },
      tabs: { query: async () => tabs },
      storage: {
        local: {
          get: async () => ({ apiNetworkRecorderSettings: structuredClone(settings) }),
          set: async (value) => Object.assign(settings, value.apiNetworkRecorderSettings),
        },
      },
    },
  })
  context.window = context
  new Script(await bundle(entry)).runInContext(context)
  await flush()
  return { elements, timers, intervals, settings }
}
const success = (data) => ({ ok: true, data })
const defaultReply = (message, settings) =>
  message.type === "GET_CAPTURE_SETTINGS"
    ? success(settings)
    : message.type === "GET_CAPTURE_STATUS"
      ? success({ supported: true, attached: true, enabled: true })
      : success({ total: 0, api: 0, deep: 0, errors: 0, hosts: 0 })

test("popup shows deep capture while record summary is still loading", async () => {
  let resolveSummary
  const pending = new Promise((resolve) => {
    resolveSummary = resolve
  })
  const requested = []
  const ui = await createUi("popup/popup.ts", async (message, settings) => {
    requested.push(message.type)
    return message.type === "GET_RECORD_SUMMARY" ? pending : defaultReply(message, settings)
  })
  expect(ui.elements.get("#captureBadge").textContent).toBe("Deep capture on")
  expect(ui.elements.get("#toggleDeepCapture").textContent).toBe("Stop deep capture")
  expect(ui.elements.get("#summary").textContent).toBe("Loading...")
  expect(ui.elements.get("#toggleIgnoreTab").textContent).toBe("Ignore this tab")
  expect(requested).not.toContain("GET_RECORDS")
  resolveSummary(success({ total: 2, api: 2, deep: 2, errors: 0, hosts: 1 }))
  await flush()
  expect(ui.elements.get("#summary").textContent).toContain("2 deep")
})
test("a summary error does not hide capture state or disable the stop button", async () => {
  const ui = await createUi("popup/popup.ts", async (message, settings) => {
    if (message.type === "GET_RECORD_SUMMARY") throw new Error("Database busy")
    return defaultReply(message, settings)
  })
  expect(ui.elements.get("#captureBadge").textContent).toBe("Deep capture on")
  expect(ui.elements.get("#toggleDeepCapture").disabled).toBe(false)
  expect(ui.elements.get("#summary").textContent).toBe("Record summary unavailable.")
  expect(ui.elements.get("#error").textContent).toContain("Database busy")
})
test("an unresponsive status request times out and can be retried without toggling capture", async () => {
  let stalled = true
  const requested = []
  const ui = await createUi("popup/popup.ts", async (message, settings) => {
    requested.push(message.type)
    if (message.type === "GET_CAPTURE_STATUS" && stalled) return new Promise(() => {})
    return defaultReply(message, settings)
  })
  for (const timer of [...ui.timers.values()]) if (timer.duration === 10000) timer.callback()
  await flush()
  expect(ui.elements.get("#captureBadge").textContent).toBe("Status unavailable")
  expect(ui.elements.get("#toggleDeepCapture").textContent).toBe("Retry capture status")
  stalled = false
  await ui.elements.get("#toggleDeepCapture").handlers.get("click")()
  expect(ui.elements.get("#captureBadge").textContent).toBe("Deep capture on")
  expect(requested).not.toContain("STOP_DEBUGGER_CAPTURE")
  expect(requested).not.toContain("START_DEBUGGER_CAPTURE")
})
test("popup allows stopping global capture even when its selected tab is not attached", async () => {
  const ui = await createUi("popup/popup.ts", async (message, settings) => {
    if (message.type === "GET_CAPTURE_STATUS")
      return success({ supported: true, attached: false, enabled: true })
    return defaultReply(message, settings)
  })
  expect(ui.elements.get("#toggleDeepCapture").textContent).toBe("Stop deep capture")
})
test("inspector finishes its busy state even when capture produces no new records", async () => {
  const ui = await createUi("app/main.ts", async (message, settings) => {
    if (message.type === "START_DEBUGGER_CAPTURE_ALL") settings.deepCaptureEnabled = true
    return success(null)
  })
  expect(ui.elements.get("#app").innerHTML).toContain("Start deep capture")
  ui.elements.get("#toggleDeepCapture").handlers.get("click")()
  expect(ui.elements.get("#app").innerHTML).toContain("Working...")
  await flush()
  expect(ui.elements.get("#app").innerHTML).toContain("Stop deep capture")
  expect(ui.elements.get("#app").innerHTML).not.toContain("Working...")
})
test("capture failures keep the inspector usable and allow retrying start and stop", async () => {
  let fail = true
  const failure = "The extensions gallery cannot be scripted."
  const ui = await createUi("app/main.ts", async (message, settings) => {
    if (fail) return { ok: false, error: failure }
    settings.deepCaptureEnabled = message.type === "START_DEBUGGER_CAPTURE_ALL"
    return success(null)
  })
  const toggle = async () => {
    ui.elements.get("#toggleDeepCapture").handlers.get("click")()
    await flush()
  }
  const expectUsable = () => {
    const html = ui.elements.get("#app").innerHTML
    expect(html).toContain('class="layout"')
    expect(html).toContain('id="search"')
    expect(html).toContain('id="captureTabs"')
    expect(html).not.toContain("Unable to load API Network Recorder")
    expect(html).not.toContain("Reset local DB")
    expect(html).not.toContain("Working...")
    return html
  }
  await toggle()
  expect(expectUsable()).toContain(failure)
  expect(expectUsable()).toContain("Start deep capture")
  fail = false
  await toggle()
  expect(expectUsable()).toContain("Stop deep capture")
  expect(expectUsable()).not.toContain(failure)
  fail = true
  await toggle()
  expect(expectUsable()).toContain(failure)
  expect(expectUsable()).toContain("Stop deep capture")
  fail = false
  await toggle()
  expect(expectUsable()).toContain("Start deep capture")
  expect(expectUsable()).not.toContain(failure)
})

test("inspector refreshes changed capture settings without new records", async () => {
  const ui = await createUi("app/main.ts", async () => success(null))
  ui.settings.deepCaptureEnabled = true
  ui.intervals[0]()
  await flush()
  expect(ui.elements.get("#app").innerHTML).toContain("Stop deep capture")
})

test("popup does not claim a working connection merely because capture is enabled", async () => {
  const ui = await createUi("popup/popup.ts", async (message, settings) => {
    if (message.type === "GET_CAPTURE_STATUS")
      return success({
        supported: true,
        attached: false,
        enabled: true,
        attachedCount: 0,
        pendingCount: 0,
        error: "Network.enable failed",
      })
    return defaultReply(message, settings)
  })
  expect(ui.elements.get("#captureBadge").textContent).toBe("Deep capture not connected")
  expect(ui.elements.get("#error").textContent).toBe("Network.enable failed")
})

test("popup starts global capture from an ignored tab without changing exclusions", async () => {
  const requested = []
  const ui = await createUi("popup/popup.ts", async (message, settings) => {
    requested.push(message)
    settings.ignoredDomains = ["example.test"]
    if (message.type === "START_DEBUGGER_CAPTURE_ALL") {
      settings.deepCaptureEnabled = true
      return success(null)
    }
    if (message.type === "GET_CAPTURE_STATUS")
      return success({
        supported: true,
        attached: settings.deepCaptureEnabled,
        enabled: settings.deepCaptureEnabled,
        attachedCount: settings.deepCaptureEnabled ? 2 : 0,
        pendingCount: 0,
        error: null,
      })
    return defaultReply(message, settings)
  })
  await ui.elements.get("#toggleDeepCapture").handlers.get("click")()
  expect(requested.some((message) => message.type === "START_DEBUGGER_CAPTURE_ALL")).toBe(true)
  expect(requested.some((message) => message.type === "START_DEBUGGER_CAPTURE")).toBe(false)
  expect(
    requested
      .filter((message) => message.type === "GET_CAPTURE_STATUS")
      .every((message) => message.payload.tabId === undefined),
  ).toBe(true)
  expect(ui.settings.ignoredDomains).toEqual(["example.test"])
  expect(ui.elements.get("#captureBadge").textContent).toBe("Deep capture on")
  expect(ui.elements.get("#error").textContent).toBe("")
})
test("global capture remains available without a web tab in the current window", async () => {
  const requested = []
  const ui = await createUi(
    "popup/popup.ts",
    async (message, settings) => {
      requested.push(message.type)
      if (message.type === "START_DEBUGGER_CAPTURE_ALL") {
        settings.deepCaptureEnabled = true
        return success(null)
      }
      if (message.type === "GET_CAPTURE_STATUS")
        return success({
          supported: true,
          attached: false,
          enabled: settings.deepCaptureEnabled,
          attachedCount: 0,
          pendingCount: 0,
          error: null,
        })
      return defaultReply(message, settings)
    },
    [],
  )
  expect(ui.elements.get("#toggleDeepCapture").disabled).toBe(false)
  await ui.elements.get("#toggleDeepCapture").handlers.get("click")()
  expect(requested).toContain("START_DEBUGGER_CAPTURE_ALL")
  expect(ui.elements.get("#captureBadge").textContent).toBe("Deep capture waiting for tabs")
})

test("inspector debounces search and ignores an older query that finishes last", async () => {
  let finishOld
  const requested = []
  const preview = (id) => ({
    id,
    method: "GET",
    url: "https://api.test/" + id,
    source: "fetch",
    status: 200,
    completedAt: "2026-09-10",
    startedAt: "2026-09-10",
    requestBody: null,
    responseBody: null,
    requestHeaders: {},
    responseHeaders: {},
    detailsLoaded: false,
    pinned: false,
  })
  const ui = await createUi("app/main.ts", defaultReply, undefined, async (options) => {
    requested.push(options.search)
    if (options.search === "old")
      return await new Promise((resolve) => {
        finishOld = resolve
      })
    return options.search === "new" ? [preview("new-result")] : []
  })
  const search = ui.elements.get("#search")
  const input = (value) => {
    search.value = value
    search.handlers.get("input")({ target: search })
  }
  const debounce = () => {
    const entry = [...ui.timers].find(([, timer]) => timer.duration === 300)
    expect(entry).toBeDefined()
    ui.timers.delete(entry[0])
    entry[1].callback()
  }
  input("o")
  input("ol")
  input("old")
  expect(requested).toEqual([""])
  expect([...ui.timers.values()].filter((timer) => timer.duration === 300)).toHaveLength(1)
  debounce()
  await flush()
  input("new")
  debounce()
  await flush()
  expect(ui.elements.get("#app").innerHTML).toContain("new-result")
  finishOld([preview("stale-result")])
  await flush()
  expect(ui.elements.get("#app").innerHTML).toContain("new-result")
  expect(ui.elements.get("#app").innerHTML).not.toContain("stale-result")
})
