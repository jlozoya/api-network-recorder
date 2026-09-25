import { beforeEach, expect, mock, spyOn, test } from "bun:test"
import { MAX_BODY_SIZE_BYTES as LIMIT } from "../src/core/constants.ts"
import { createNetworkRecordSummary } from "../src/core/network-summary.ts"
import { pageMessage } from "./record-fixture.ts"

const records = []
mock.module("../src/storage/network-record-repository.ts", () => ({
  saveNetworkRecord: async (record) => {
    records.push(record)
  },
  listNetworkRecords: async () => records,
  getNetworkRecordSummary: async () => {
    const result = createNetworkRecordSummary()
    records.forEach(result.add)
    return result.summary
  },
  clearNetworkRecords: async () => {
    records.length = 0
  },
}))
const event = () => {
  const listeners = []
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.map((listener) => listener(...args)),
  }
}
const attached = new Set<number>()
const tabUrls = new Map<number, string>()
const attachFailures = new Set<number>()
const attachGates = new Map<number, Promise<void>>()
let stallResponseBody = false
const enableFailures = new Set<number>()
const streams = new Map()
const detached = []
let storage = {}
const webRequest = {
  onBeforeRequest: event(),
  onBeforeSendHeaders: event(),
  onHeadersReceived: event(),
  onCompleted: event(),
  onErrorOccurred: event(),
}
const runtime = { onMessage: event() }
const debuggerApi = {
  onEvent: event(),
  onDetach: event(),
  getTargets: async () =>
    [...attached].map((tabId) => ({ tabId, attached: true, url: "https://example.test/" })),
  attach: mock(async ({ tabId }) => {
    await attachGates.get(tabId)
    if (attachFailures.has(tabId)) throw new Error("Debugger unavailable")
    attached.add(tabId)
  }),
  detach: async ({ tabId }) => {
    detached.push(tabId)
    attached.delete(tabId)
  },
  sendCommand: mock(async ({ tabId }, method) => {
    if (method === "Network.enable" && enableFailures.has(tabId))
      throw new Error("Network.enable failed")
    if (method === "Network.getResponseBody" && stallResponseBody) return new Promise(() => {})
    if (method === "Network.getResponseBody")
      return { base64Encoded: true, body: Buffer.alloc(LIMIT + 10, 65).toString("base64") }
    return {}
  }),
}
Object.assign(globalThis, {
  __BROWSER_TARGET__: "firefox",
  chrome: {
    webRequest,
    runtime,
    debugger: debuggerApi,
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      query: async () =>
        [1, 2].map((id) => ({ id, url: tabUrls.get(id) ?? "https://example.test/" })),
      get: async (id) => ({ id, url: tabUrls.get(id) ?? "https://example.test/" }),
    },
    storage: {
      local: {
        get: async () => structuredClone(storage),
        set: async (value) => {
          Object.assign(storage, value)
        },
      },
    },
  },
  browser: {
    webRequest: {
      filterResponseData: (id) => {
        const stream = {
          ondata: null,
          onstop: null,
          onerror: null,
          forwarded: [],
          closed: false,
          write(data) {
            this.forwarded.push(data)
          },
          close() {
            this.closed = true
          },
          disconnect() {},
        }
        streams.set(id, stream)
        return stream
      },
    },
  },
})
const controller = await import("../src/background/debugger/debugger-controller.ts")
const { handleDebuggerEvent } = await import("../src/background/debugger/debugger-events.ts")
await import("../src/background/listeners/web-request-listener.ts")
await import("../src/background/listeners/runtime-listener.ts")
await import("../src/background/listeners/tab-listener.ts")
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
await settle()
beforeEach(async () => {
  enableFailures.clear()
  attachFailures.clear()
  attachGates.clear()
  stallResponseBody = false
  await controller.stopDebuggerCaptureForAllTabs()
  tabUrls.clear()
  debuggerApi.attach.mockClear()
  records.length = 0
  streams.clear()
  detached.length = 0
  storage = {}
})
const request = (requestId, tabId = 2) => ({
  requestId,
  tabId,
  frameId: 0,
  method: "GET",
  url: "https://example.test/api/items",
  type: "xmlhttprequest",
  timeStamp: Date.now(),
})
const finishSilent = async (details, chunks = [new TextEncoder().encode("ok")]) => {
  webRequest.onBeforeRequest.emit(details)
  webRequest.onHeadersReceived.emit({
    ...details,
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: [{ name: "content-type", value: "text/plain" }],
  })
  const stream = streams.get(details.requestId)
  for (const chunk of chunks) stream.ondata({ data: chunk.buffer })
  stream.onstop()
  webRequest.onCompleted.emit({ ...details, statusCode: 200, statusLine: "HTTP/1.1 200 OK" })
  await settle()
  return stream
}

test("retains silent capture in tabs where debugger attach fails", async () => {
  attachFailures.add(2)
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(controller.isDeepCaptureEnabled()).toBe(true)
  expect(controller.getDebuggerCaptureStatus(1).attached).toBe(true)
  expect(controller.getDebuggerCaptureStatus(2).attached).toBe(false)
  webRequest.onBeforeRequest.emit(request("attached-tab", 1))
  expect(streams.has("attached-tab")).toBe(false)
  await finishSilent(request("fallback-tab", 2))
  expect(records).toHaveLength(1)
  expect(records[0].source).toBe("web-request")
  expect(records[0].responseBody.value).toBe("ok")
})
test("keeps fallback when every debugger attach fails", async () => {
  attachFailures.add(1)
  attachFailures.add(2)
  await expect(controller.startDebuggerCaptureForAllAvailableTabs()).rejects.toThrow()
  expect(controller.isDeepCaptureEnabled()).toBe(false)
  await finishSilent(request("all-failed", 1))
  expect(records).toHaveLength(1)
})
test.each([
  "https://chromewebstore.google.com/",
  "https://chromewebstore.google.com/detail/example/id",
  "https://chrome.google.com/webstore/detail/example/id",
  "https://chrome.google.com/",
  "https://sub.chromewebstore.google.com/",
  "https://sub.chrome.google.com/webstore/",
])("global capture skips restricted store page %s", async (url) => {
  tabUrls.set(1, url)
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(debuggerApi.attach.mock.calls.map(([target]) => target.tabId)).toEqual([2])
  const statuses = await controller.getCaptureTabStatuses()
  expect(statuses.find((tab) => tab.tabId === 1)).toMatchObject({
    state: "ineligible",
    reason: "Chrome Web Store pages do not allow deep capture.",
  })
  expect(statuses.find((tab) => tab.tabId === 2)?.state).toBe("attached")
})

test("store-only startup stays enabled for future eligible tabs", async () => {
  tabUrls.set(1, "https://chromewebstore.google.com/")
  tabUrls.set(2, "https://chrome.google.com/webstore/")
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(controller.isDeepCaptureEnabled()).toBe(true)
  expect(controller.getDebuggerCaptureStatus().attachedCount).toBe(0)
  expect(debuggerApi.attach).not.toHaveBeenCalled()
  chrome.tabs.onCreated.emit({ id: 3, url: "https://example.test/" })
  await settle()
  expect(controller.isDebuggerAttached(3)).toBe(true)
  chrome.tabs.onUpdated.emit(1, { url: tabUrls.get(1) }, { status: "loading" })
  await settle()
  expect(debuggerApi.attach.mock.calls.map(([target]) => target.tabId)).toEqual([3])
})

test("starting a store tab directly reports why it cannot be captured", async () => {
  tabUrls.set(1, "https://chromewebstore.google.com/")
  await expect(controller.startDebuggerCapture(1)).rejects.toThrow(
    "Chrome Web Store pages do not allow deep capture.",
  )
  expect(debuggerApi.attach).not.toHaveBeenCalled()
  expect(controller.isDeepCaptureEnabled()).toBe(false)
})

test.each([
  "https://example.test/?next=https://chromewebstore.google.com/",
  "https://chromewebstore.google.com.example.test/",
  "https://chrome.google.com.example.test/webstore/",
  "http://localhost:3000/",
])("store exclusions preserve eligible URL %s", async (url) => {
  tabUrls.set(1, url)
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(controller.isDebuggerAttached(1)).toBe(true)
})

test("detaches if Network.enable fails and keeps silent capture", async () => {
  enableFailures.add(2)
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(detached).toContain(2)
  expect(controller.isDebuggerAttached(2)).toBe(false)
  await finishSilent(request("enable-failed"))
  expect(records).toHaveLength(1)
})
test("Firefox preserves exact-limit blocks and forwards all bytes to the page", async () => {
  const first = new Uint8Array(LIMIT / 2).fill(65)
  const second = new Uint8Array(LIMIT / 2).fill(66)
  const stream = await finishSilent(request("exact"), [first, second])
  const body = records[0].responseBody
  expect(body.kind).toBe("text")
  expect(body.value).toBe("A".repeat(LIMIT / 2) + "B".repeat(LIMIT / 2))
  expect(body.truncated).toBe(false)
  expect(stream.forwarded).toEqual([first.buffer, second.buffer])
  expect(stream.closed).toBe(true)
})
test("Firefox keeps only the prefix but reports the full response size", async () => {
  const stream = await finishSilent(request("oversized"), [new Uint8Array(LIMIT + 99).fill(65)])
  expect(records[0].responseBody.value.length).toBe(LIMIT)
  expect(records[0].responseBody.truncated).toBe(true)
  expect(records[0].responseBody.sizeBytes).toBe(LIMIT + 99)
  expect(stream.forwarded[0].byteLength).toBe(LIMIT + 99)
})
test("debugger response handler applies the binary size limit", async () => {
  await handleDebuggerEvent(1, "Network.requestWillBeSent", {
    requestId: "binary",
    request: { url: "https://example.test/api", method: "GET" },
  })
  await handleDebuggerEvent(1, "Network.loadingFinished", { requestId: "binary" })
  expect(records).toHaveLength(1)
  expect(records[0].responseBody.truncated).toBe(true)
  expect(records[0].responseBody.sizeBytes).toBe(LIMIT + 10)
  expect(Buffer.from(records[0].responseBody.value, "base64").length).toBe(LIMIT)
})
test("runtime rejects malformed page payloads before persistence", async () => {
  const response = mock(() => {})
  runtime.onMessage.emit(
    { type: "NETWORK_RECORD_CREATED", payload: { url: 123 } },
    { tab: { id: 1 }, url: "https://example.test/" },
    response,
  )
  await settle()
  expect(records).toHaveLength(0)
  expect(response.mock.calls[0][0].ok).toBe(false)
})
test("runtime replaces page-controlled IDs and frame context", async () => {
  const response = mock(() => {})
  const message = pageMessage()
  const sender = {
    tab: { id: 8 },
    frameId: 3,
    url: "https://actual.test/frame",
    origin: "https://actual.test",
  }
  runtime.onMessage.emit(message, sender, response)
  runtime.onMessage.emit(message, sender, response)
  await settle()
  expect(records).toHaveLength(2)
  expect(records[0].id).not.toBe(message.payload.id)
  expect(records[0].id).not.toBe(records[1].id)
  expect(records[0].tabId).toBe(8)
  expect(records[0].frameId).toBe(3)
  expect(records[0].pageUrl).toBe(sender.url)
  expect(response.mock.calls[0][0].ok).toBe(true)
})

test("checking capture status does not re-enable Network on attached tabs", async () => {
  await controller.startDebuggerCaptureForAllAvailableTabs()
  debuggerApi.sendCommand.mockClear()
  const status = await controller.getFreshDebuggerCaptureStatus(1)
  expect(status.attached).toBe(true)
  expect(status.enabled).toBe(true)
  expect(debuggerApi.sendCommand).not.toHaveBeenCalled()
})
test("status of one tab does not wait for commands to an unrelated debugger", async () => {
  await controller.startDebuggerCaptureForAllAvailableTabs()
  // Simulate an external target that is not tracked by the extension.
  attached.add(99)
  debuggerApi.sendCommand.mockClear()
  const status = await controller.getFreshDebuggerCaptureStatus(3)
  expect(status.attached).toBe(false)
  expect(status.enabled).toBe(true)
  expect(debuggerApi.sendCommand).not.toHaveBeenCalled()
  attached.delete(99)
})
test("popup summary message contains counts and no captured bodies", async () => {
  const record = pageMessage().payload
  record.resourceType = "fetch"
  record.responseBody.value = "x".repeat(LIMIT)
  records.push(record)
  const response = mock(() => {})
  runtime.onMessage.emit({ type: "GET_RECORD_SUMMARY" }, {}, response)
  await settle()
  expect(response.mock.calls[0][0].data).toEqual({ total: 1, api: 1, deep: 0, errors: 0, hosts: 1 })
  expect(JSON.stringify(response.mock.calls[0][0]).length).toBeLessThan(200)
})

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const within = async (operation: Promise<unknown>, timeout = 200) => {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Unrelated tab blocked start")), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
test("starting the selected tab responds without waiting for another tab", async () => {
  const other = gate()
  attachGates.set(2, other.promise)
  try {
    await within(controller.startDebuggerCapture(1))
    expect(controller.isDebuggerAttached(1)).toBe(true)
    await settle()
    expect(controller.getDebuggerCaptureStatus(2).attached).toBe(false)
    expect(controller.getDebuggerCaptureStatus(2).pendingCount).toBe(1)
  } finally {
    other.release()
    await controller.ensureDebuggerCaptureForTab(2)
  }
})
test("all-tab startup connects healthy tabs while another connection is pending", async () => {
  const first = gate()
  attachGates.set(1, first.promise)
  const starting = controller.startDebuggerCaptureForAllAvailableTabs()
  try {
    await settle()
    expect(controller.isDebuggerAttached(2)).toBe(true)
    expect(controller.isDebuggerAttached(1)).toBe(false)
  } finally {
    first.release()
    await starting
  }
})
test("concurrent starts wait for the same tab connection rather than reporting early success", async () => {
  const pending = gate()
  attachGates.set(1, pending.promise)
  let secondFinished = false
  const first = controller.startDebuggerCapture(1)
  const second = controller.startDebuggerCapture(1).then(() => {
    secondFinished = true
  })
  try {
    await settle()
    expect(secondFinished).toBe(false)
    expect(controller.isDebuggerAttached(1)).toBe(false)
  } finally {
    pending.release()
    await Promise.all([first, second])
    await controller.ensureDebuggerCaptureForTab(2)
  }
})
test("stop during startup prevents a late connection from enabling capture again", async () => {
  const pending = gate()
  attachGates.set(1, pending.promise)
  const starting = controller.startDebuggerCapture(1).catch((error) => error)
  await settle()
  const stopping = controller.stopDebuggerCaptureForAllTabs()
  await settle()
  pending.release()
  expect(await starting).toBeInstanceOf(Error)
  await stopping
  expect(controller.isDeepCaptureEnabled()).toBe(false)
  expect(controller.isDebuggerAttached(1)).toBe(false)
  expect(attached.has(1)).toBe(false)
})
test("a stalled attach reports its stage and cleans up when it completes late", async () => {
  const pending = gate()
  attachGates.set(1, pending.promise)
  const realSetTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) =>
    realSetTimeout(callback, ms === 5000 ? 5 : ms, ...args),
  )
  try {
    await expect(controller.startDebuggerCapture(1)).rejects.toThrow(
      "Debugger attach for tab 1 timed out",
    )
    expect(controller.getDebuggerCaptureStatus(1).error).toContain("Debugger attach")
    expect(controller.isDebuggerAttached(1)).toBe(false)
    pending.release()
    await settle()
    expect(attached.has(1)).toBe(false)
  } finally {
    pending.release()
    timer.mockRestore()
  }
})
test("a stalled response-body command still stores the deep record with a reason", async () => {
  stallResponseBody = true
  const realSetTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) =>
    realSetTimeout(callback, ms === 5000 ? 5 : ms, ...args),
  )
  try {
    await handleDebuggerEvent(1, "Network.requestWillBeSent", {
      requestId: "stalled-body",
      request: { url: "https://example.test/api", method: "GET" },
    })
    await handleDebuggerEvent(1, "Network.loadingFinished", { requestId: "stalled-body" })
    expect(records).toHaveLength(1)
    expect(records[0].source).toBe("debugger")
    expect(records[0].responseBody.kind).toBe("unavailable")
    expect(records[0].responseBody.reason).toContain("Network.getResponseBody timed out")
  } finally {
    timer.mockRestore()
    stallResponseBody = false
  }
})

test("global startup skips ignored tabs and reports healthy capture globally", async () => {
  storage = { apiNetworkRecorderSettings: { ignoredTabIds: [1] } }
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(controller.isDebuggerAttached(1)).toBe(false)
  expect(controller.isDebuggerAttached(2)).toBe(true)
  expect(controller.getDebuggerCaptureStatus().attached).toBe(true)
  expect(controller.getDebuggerCaptureStatus().attachedCount).toBe(1)
})
test("global capture waits for new eligible tabs when all existing tabs are ignored", async () => {
  storage = { apiNetworkRecorderSettings: { ignoredTabIds: [1, 2] } }
  await controller.startDebuggerCaptureForAllAvailableTabs()
  expect(controller.isDeepCaptureEnabled()).toBe(true)
  expect(controller.getDebuggerCaptureStatus().attachedCount).toBe(0)
  chrome.tabs.onCreated.emit({ id: 3, url: "https://example.test/new" })
  await settle()
  expect(controller.isDebuggerAttached(3)).toBe(true)
  expect(controller.isDebuggerAttached(1)).toBe(false)
  expect(controller.isDebuggerAttached(2)).toBe(false)
})
