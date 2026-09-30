import { expect, test } from "bun:test"
import { createContext, Script } from "node:vm"
import { resolve } from "node:path"

const bundled = Bun.build({
  entrypoints: [resolve("src/agent/main.ts")],
  target: "browser",
  format: "iife",
  define: { __SUPPORTS_DEEP_CAPTURE__: "true" },
  plugins: [
    {
      name: "agent-ui-storage",
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
              : `
          export const listNetworkRecordPreviews = (...args) => globalThis.listRecords(...args);
          export const getNetworkRecordsByIds = (...args) => globalThis.getRecords(...args);
          export const listSavedSessions = async () => [];
        `,
        }))
      },
    },
  ],
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve: (value: any) => void
  const promise = new Promise<any>((done) => {
    resolve = done
  })
  return { promise, resolve: (value: any) => resolve(value) }
}
class Element {
  value = ""
  textContent = ""
  hidden = false
  disabled = false
  checked = true
  dataset = {}
  children: Element[] = []
  handlers = new Map<string, (event: any) => void>()
  addEventListener(name: string, callback: (event: any) => void) {
    this.handlers.set(name, callback)
  }
  append(child: Element) {
    this.children.push(child)
  }
  replaceChildren() {
    this.children = []
  }
}
const createUi = async (
  listRecords = async (..._args: any[]) => [] as any[],
  getRecords = async (..._args: any[]) => [] as any[],
) => {
  const elements = new Map<string, Element>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  element("pageSize").value = "10"
  element("method").value = "ALL"
  element("statusGroup").value = "all"
  const timers = new Map<number, () => void>()
  let timerId = 0
  const settings = {
    captureLimit: 50,
    capturePaused: false,
    captureActiveSince: null as string | null,
    deepCaptureEnabled: false,
    ignoredDomains: ["excluded.test"],
    ignoredTabIds: [42],
  }
  const context = createContext({
    console,
    listRecords,
    getRecords,
    URL,
    document: { getElementById: element, createElement: () => new Element() },
    setTimeout: (callback: () => void) => {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
    chrome: {
      runtime: {
        getURL: (path: string) => "chrome-extension://test/" + path,
        sendMessage: async () => ({ ok: true, data: [] }),
      },
      storage: {
        local: {
          get: async () => ({ apiNetworkRecorderSettings: structuredClone(settings) }),
          set: async (value: any) => {
            Object.assign(settings, value.apiNetworkRecorderSettings)
          },
        },
        onChanged: { addListener() {} },
      },
    },
  })
  const result = await bundled
  if (!result.success) throw new Error(String(result.logs))
  new Script(await result.outputs[0]!.text()).runInContext(context)
  await flush()
  const trigger = (id: string, event = "click") =>
    element(id).handlers.get(event)!({ preventDefault() {} })
  const json = (id: string) => JSON.parse(element(id).textContent)
  return { element, trigger, json, settings, timers }
}
const preview = (id: string) => ({ id, method: "GET", url: "https://api.test/" + id, status: 200 })

test("AI access keeps the latest search when an older search finishes last", async () => {
  const old = deferred()
  const ui = await createUi(async (filters) =>
    filters.search === "old" ? old.promise : [preview(filters.search || "initial")],
  )
  ui.element("search").value = "old"
  ui.trigger("searchForm", "submit")
  ui.element("search").value = "new"
  ui.trigger("searchForm", "submit")
  await flush()
  expect(ui.json("requestsJson").records[0].id).toBe("new")
  old.resolve([preview("stale")])
  await flush()
  expect(ui.json("requestsJson").records[0].id).toBe("new")
  expect(ui.timers.size).toBe(0)
})

test("AI access invalidates a pending detail read when the session changes", async () => {
  const pending = deferred()
  const requested: any[] = []
  const ui = await createUi(
    async () => [preview("one")],
    async (ids, session) => {
      requested.push({ ids, session })
      return session
        ? [{ id: "one", responseBody: { kind: "text", value: "saved" } }]
        : pending.promise
    },
  )
  ui.element("requestId").value = "one"
  ui.trigger("requestForm", "submit")
  ui.element("session").value = "saved-session"
  ui.trigger("session", "change")
  await flush()
  expect(ui.json("requestJson")).toBeNull()
  ui.element("requestId").value = "one"
  ui.trigger("requestForm", "submit")
  await flush()
  expect(ui.json("requestJson").data.responseBody.value).toBe("saved")
  pending.resolve([{ id: "one", responseBody: { kind: "text", value: "stale live" } }])
  await flush()
  expect(ui.json("requestJson").sessionId).toBe("saved-session")
  expect(ui.json("requestJson").data.responseBody.value).toBe("saved")
  expect(requested).toEqual([
    { ids: ["one"], session: undefined },
    { ids: ["one"], session: "saved-session" },
  ])
  expect(ui.timers.size).toBe(0)
})

test("AI recording controls preserve exclusions and do not reset an active recording", async () => {
  const ui = await createUi()
  ui.trigger("startRecording")
  expect(ui.json("captureStatus")).toBeNull()
  expect(ui.element("startRecording").disabled).toBe(true)
  await flush()
  expect(ui.json("captureStatus").ok).toBe(true)
  expect(ui.settings.captureActiveSince).toBeNull()
  ui.trigger("stopRecording")
  await flush()
  expect(ui.settings.capturePaused).toBe(true)
  ui.trigger("startRecording")
  await flush()
  expect(ui.settings.capturePaused).toBe(false)
  const activeSince = ui.settings.captureActiveSince
  expect(activeSince).toBeString()
  ui.trigger("startRecording")
  await flush()
  expect(ui.settings.captureActiveSince).toBe(activeSince)
  expect(ui.settings.ignoredDomains).toEqual(["excluded.test"])
  expect(ui.settings.ignoredTabIds).toEqual([42])
  expect(ui.settings.captureLimit).toBe(50)
})
