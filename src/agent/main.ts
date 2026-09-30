import { withTimeout } from "../core/async-utils.js"
import type { CaptureTabStatus } from "../core/capture-tab-status.js"
import type {
  ExtensionMessage,
  ExtensionResponse,
  ListNetworkRecordsPayload,
} from "../core/message-types.js"
import type { NetworkRecordPreview } from "../core/record-preview.js"
import { getCaptureSettings, setCaptureSettings } from "../storage/capture-settings.js"
import {
  getNetworkRecordsByIds,
  listNetworkRecordPreviews,
  listSavedSessions,
} from "../storage/network-record-repository.js"
import "./agent.css"

const element = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id)
  if (!result) throw new Error(`Missing #${id}`)
  return result as T
}
const value = (id: string): string => element<HTMLInputElement | HTMLSelectElement>(id).value
const writeJson = (id: string, data: unknown): void => {
  // Captured URLs, headers and bodies must never be interpreted as HTML.
  element(id).textContent = JSON.stringify(data, null, 2)
}
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
const sendMessage = async <T>(message: ExtensionMessage): Promise<T> => {
  const response = await withTimeout(
    chrome.runtime.sendMessage(message) as Promise<ExtensionResponse<T>>,
    30000,
    message.type,
  )
  if (!response) throw new Error("The extension did not respond. Reload the extension and retry.")
  if (!response.ok) throw new Error(response.error)
  return response.data
}

element<HTMLInputElement>("agentUrl").value = chrome.runtime.getURL("agent.html")
element("deepControls").hidden = !__SUPPORTS_DEEP_CAPTURE__

// Optional so older test fixtures and Firefox keep their existing capture interface.
const integration = document.getElementById("localIntegration")
if (integration) {
  integration.hidden = !__SUPPORTS_DEEP_CAPTURE__
  const updateIntegration = async (enabled?: boolean): Promise<void> => {
    try {
      const state = await sendMessage<{ connected: boolean; status: string }>(
        enabled === undefined
          ? { type: "GET_NATIVE_BRIDGE_STATUS" }
          : { type: "SET_NATIVE_BRIDGE_ENABLED", payload: { enabled } },
      )
      element("integrationNotice").textContent = state.status
    } catch (error) {
      element("integrationNotice").textContent = errorText(error)
    }
  }
  element("connectIntegration").addEventListener("click", () => { void updateIntegration(true) })
  element("disconnectIntegration").addEventListener("click", () => { void updateIntegration(false) })
  element("refreshIntegration").addEventListener("click", () => { void updateIntegration() })
  if (__SUPPORTS_DEEP_CAPTURE__) void updateIntegration()
}

let captureBusy = false
const captureButtons = [
  "startRecording",
  "stopRecording",
  "refreshStatus",
  "startDeepCapture",
  "stopDeepCapture",
]
const refreshCapture = async (): Promise<void> => {
  const [settings, tabs] = await withTimeout(
    Promise.all([
      getCaptureSettings(),
      sendMessage<CaptureTabStatus[]>({ type: "GET_CAPTURE_TABS_STATUS" }),
    ]),
    35000,
    "Capture status",
  )
  writeJson("captureStatus", {
    ok: true,
    data: { settings, deepCaptureSupported: __SUPPORTS_DEEP_CAPTURE__, tabs },
  })
  element("captureNotice").textContent =
    `${settings.capturePaused ? "Recording stopped" : "Recording active"}. Deep capture ${settings.deepCaptureEnabled ? "enabled" : "disabled"}.`
}
const captureAction = async (action?: () => Promise<unknown>): Promise<void> => {
  if (captureBusy) return
  captureBusy = true
  captureButtons.forEach((id) => {
    element<HTMLButtonElement>(id).disabled = true
  })
  element("captureNotice").textContent = "Updating capture status…"
  writeJson("captureStatus", null)
  try {
    if (action) await withTimeout(action(), 35000, "Capture control")
    await refreshCapture()
  } catch (error) {
    element("captureNotice").textContent = errorText(error)
    writeJson("captureStatus", { ok: false, error: errorText(error) })
  } finally {
    captureBusy = false
    captureButtons.forEach((id) => {
      element<HTMLButtonElement>(id).disabled = false
    })
  }
}
element("startRecording").addEventListener("click", () => {
  void captureAction(async () => {
    const settings = await getCaptureSettings()
    if (settings.capturePaused)
      await setCaptureSettings({
        capturePaused: false,
        captureActiveSince: new Date().toISOString(),
      })
  })
})
element("stopRecording").addEventListener("click", () => {
  void captureAction(() => setCaptureSettings({ capturePaused: true, captureActiveSince: null }))
})
element("refreshStatus").addEventListener("click", () => {
  void captureAction()
})
element("startDeepCapture").addEventListener("click", () => {
  void captureAction(() => sendMessage({ type: "START_DEBUGGER_CAPTURE_ALL" }))
})
element("stopDeepCapture").addEventListener("click", () => {
  void captureAction(() => sendMessage({ type: "STOP_DEBUGGER_CAPTURE" }))
})

interface SearchSnapshot {
  filters: ListNetworkRecordsPayload
  sessionId: string
  pageSize: number
}
const readSearch = (): SearchSnapshot => ({
  filters: {
    search: value("search"),
    method: value("method"),
    statusGroup: value("statusGroup") as NonNullable<ListNetworkRecordsPayload["statusGroup"]>,
    host: value("host"),
    apiOnly: element<HTMLInputElement>("apiOnly").checked,
    limit: 1000,
  },
  sessionId: value("session"),
  pageSize: Number(value("pageSize")),
})
let snapshot = readSearch()
let previews: NetworkRecordPreview[] = []
let offset = 0
let searchGeneration = 0
let detailGeneration = 0
const clearDetail = (): void => {
  detailGeneration++
  element<HTMLInputElement>("requestId").value = ""
  element("detailNotice").textContent = "Select a request or enter its ID."
  writeJson("requestJson", null)
}
const loadRequest = async (id: string, sessionId: string): Promise<void> => {
  const generation = ++detailGeneration
  element<HTMLInputElement>("requestId").value = id
  element("detailNotice").textContent = "Loading request…"
  writeJson("requestJson", null)
  try {
    const [record] = await withTimeout(
      getNetworkRecordsByIds([id], sessionId || undefined),
      30000,
      "Request details",
    )
    if (generation !== detailGeneration) return
    writeJson("requestJson", { ok: true, sessionId: sessionId || null, data: record })
    element("detailNotice").textContent = `Request ${id}`
  } catch (error) {
    if (generation !== detailGeneration) return
    writeJson("requestJson", { ok: false, error: errorText(error) })
    element("detailNotice").textContent = errorText(error)
  }
}
const renderPage = (): void => {
  const page = previews.slice(offset, offset + snapshot.pageSize)
  const list = element("requestList")
  list.replaceChildren()
  for (const record of page) {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.dataset.requestId = record.id
    button.textContent = `Open request ${record.id} · ${record.method} ${record.url} · ${record.status ?? "no status"}`
    const sessionId = snapshot.sessionId
    button.addEventListener("click", () => {
      void loadRequest(record.id, sessionId)
    })
    item.append(button)
    list.append(item)
  }
  writeJson("requestsJson", {
    ok: true,
    sessionId: snapshot.sessionId || null,
    filters: snapshot.filters,
    total: previews.length,
    offset,
    pageSize: snapshot.pageSize,
    hasMore: offset + page.length < previews.length,
    records: page.map((record) => ({
      id: record.id,
      method: record.method,
      url: record.url,
      status: record.status,
      statusText: record.statusText,
      source: record.source,
      tabId: record.tabId,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      error: record.error ?? null,
      hasRequestBody: record.hasRequestBody,
      hasResponseBody: record.hasResponseBody,
      pinned: record.pinned,
    })),
  })
  element("listNotice").textContent = previews.length
    ? `${offset + 1}–${offset + page.length} of ${previews.length} matching stored requests. Newest first.`
    : "No matching stored requests. Change filters or start recording and use your application."
  element<HTMLButtonElement>("previousPage").disabled = offset === 0
  element<HTMLButtonElement>("nextPage").disabled = offset + page.length >= previews.length
}
const searchRequests = async (): Promise<void> => {
  const generation = ++searchGeneration
  const next = readSearch()
  offset = 0
  previews = []
  // A selection belongs to both its ID and its session. Invalidate pending detail reads.
  clearDetail()
  element("requestList").replaceChildren()
  writeJson("requestsJson", null)
  element("listNotice").textContent = "Loading requests…"
  element<HTMLButtonElement>("previousPage").disabled = true
  element<HTMLButtonElement>("nextPage").disabled = true
  try {
    const records = await withTimeout(
      listNetworkRecordPreviews(next.filters, next.sessionId || undefined),
      30000,
      "Search requests",
    )
    if (generation !== searchGeneration) return
    snapshot = next
    previews = records
    renderPage()
  } catch (error) {
    if (generation !== searchGeneration) return
    element("listNotice").textContent = errorText(error)
    writeJson("requestsJson", { ok: false, error: errorText(error) })
  }
}
const loadSessions = async (): Promise<void> => {
  try {
    const sessions = await withTimeout(listSavedSessions(), 30000, "Saved sessions")
    for (const session of sessions) {
      const option = document.createElement("option")
      option.value = session.id
      option.textContent = `${session.name} (${session.count})`
      element("session").append(option)
    }
  } catch (error) {
    element("sessionNotice").hidden = false
    element("sessionNotice").textContent = `Saved sessions unavailable: ${errorText(error)}`
  }
}
element("searchForm").addEventListener("submit", (event) => {
  event.preventDefault()
  void searchRequests()
})
element("session").addEventListener("change", () => {
  void searchRequests()
})
element("previousPage").addEventListener("click", () => {
  offset = Math.max(0, offset - snapshot.pageSize)
  renderPage()
})
element("nextPage").addEventListener("click", () => {
  if (offset + snapshot.pageSize < previews.length) offset += snapshot.pageSize
  renderPage()
})
element("requestForm").addEventListener("submit", (event) => {
  event.preventDefault()
  const id = value("requestId").trim()
  if (id) void loadRequest(id, value("session"))
})
// Reflect changes from other extension pages without replacing request snapshots.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.apiNetworkRecorderSettings && !captureBusy)
    void captureAction()
})
void captureAction()
void searchRequests()
void loadSessions()
