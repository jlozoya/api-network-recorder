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
      name: "agent-ui-styles",
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, () => ({ path: "styles", namespace: "test" }))
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "js", contents: "" }))
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
  textContent = ""
  hidden = false
  disabled = false
  dataset: Record<string, string> = {}
  handlers = new Map<string, (event: any) => void>()
  addEventListener(name: string, callback: (event: any) => void) {
    this.handlers.set(name, callback)
  }
}
const createUi = async (
  options: {
    sendMessage?: (message: any) => Promise<any>
  } = {},
) => {
  const elements = new Map<string, Element>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
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
    URL,
    document: { getElementById: element },
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
        sendMessage:
          options.sendMessage ??
          (async (message: any) => ({
            ok: true,
            data:
              message.type === "GET_NATIVE_BRIDGE_STATUS"
                ? { connected: false, status: "Disabled" }
                : [],
          })),
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
test("AI recording controls preserve exclusions and do not reset an active recording", async () => {
  const ui = await createUi()
  expect(ui.element("recordingBadge").textContent).toBe("Recording")
  expect(ui.element("startRecording").hidden).toBe(true)
  expect(ui.element("stopRecording").hidden).toBe(false)
  ui.trigger("startRecording")
  expect(ui.json("captureStatus")).toBeNull()
  expect(ui.element("startRecording").disabled).toBe(true)
  await flush()
  expect(ui.json("captureStatus").ok).toBe(true)
  expect(ui.settings.captureActiveSince).toBeNull()
  ui.trigger("stopRecording")
  await flush()
  expect(ui.settings.capturePaused).toBe(true)
  expect(ui.element("recordingBadge").textContent).toBe("Paused")
  expect(ui.element("startRecording").hidden).toBe(false)
  expect(ui.element("stopRecording").hidden).toBe(true)
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

test("AI connection controls serialize actions and recover after a status error", async () => {
  const pending = deferred()
  const calls: any[] = []
  const ui = await createUi({
    sendMessage: async (message) => {
      if (message.type === "GET_CAPTURE_TABS_STATUS") return { ok: true, data: [] }
      calls.push(message)
      if (message.type === "GET_NATIVE_BRIDGE_STATUS")
        return { ok: true, data: { connected: true, status: "Connected" } }
      return pending.promise
    },
  })
  expect(ui.element("integrationBadge").textContent).toBe("Connected")
  expect(ui.element("connectIntegration").hidden).toBe(true)
  expect(ui.element("disconnectIntegration").hidden).toBe(false)
  ui.trigger("disconnectIntegration")
  ui.trigger("connectIntegration")
  expect(calls.length).toBe(2)
  expect(calls[1].payload.enabled).toBe(false)
  expect(ui.element("refreshIntegration").disabled).toBe(true)
  pending.resolve({ ok: false, error: "Connection unavailable" })
  await flush()
  expect(ui.element("integrationBadge").dataset.state).toBe("error")
  expect(ui.element("refreshIntegration").disabled).toBe(false)
  ui.trigger("refreshIntegration")
  await flush()
  expect(ui.element("integrationBadge").textContent).toBe("Connected")
})
