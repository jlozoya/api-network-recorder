import { withTimeout } from "../core/async-utils.js"
import type { CaptureTabStatus } from "../core/capture-tab-status.js"
import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import { getCaptureSettings, setCaptureSettings } from "../storage/capture-settings.js"
import "./agent.css"

const element = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id)
  if (!result) throw new Error(`Missing #${id}`)
  return result as T
}
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

element("deepControls").hidden = !__SUPPORTS_DEEP_CAPTURE__

const badge = (id: string, text: string, state: string): void => {
  element(id).textContent = text
  element(id).dataset.state = state
}

// The local integration is available in Chrome; Firefox keeps capture controls.
const integration = document.getElementById("localIntegration")
if (integration) {
  integration.hidden = !__SUPPORTS_DEEP_CAPTURE__
  let integrationBusy = false
  const integrationButtons = ["connectIntegration", "disconnectIntegration", "refreshIntegration"]
  const updateIntegration = async (enabled?: boolean): Promise<void> => {
    if (integrationBusy) return
    integrationBusy = true
    integrationButtons.forEach((id) => {
      element<HTMLButtonElement>(id).disabled = true
    })
    badge("integrationBadge", "Checking…", "pending")
    element("integrationNotice").dataset.state = "pending"
    element("integrationNotice").textContent = "Checking connection…"
    try {
      const state = await sendMessage<{ connected: boolean; status: string }>(
        enabled === undefined
          ? { type: "GET_NATIVE_BRIDGE_STATUS" }
          : { type: "SET_NATIVE_BRIDGE_ENABLED", payload: { enabled } },
      )
      element("integrationNotice").textContent = state.status
      element("integrationNotice").dataset.state = "idle"
      badge(
        "integrationBadge",
        state.connected
          ? "Connected"
          : state.status === "Connecting"
            ? "Connecting…"
            : "Not connected",
        state.connected ? "active" : "idle",
      )
      element("connectIntegration").hidden = state.connected
      element("disconnectIntegration").hidden = !state.connected && state.status !== "Connecting"
    } catch (error) {
      element("integrationNotice").textContent = errorText(error)
      element("integrationNotice").dataset.state = "error"
      badge("integrationBadge", "Connection unavailable", "error")
    } finally {
      integrationBusy = false
      integrationButtons.forEach((id) => {
        element<HTMLButtonElement>(id).disabled = false
      })
    }
  }
  element("connectIntegration").addEventListener("click", () => {
    void updateIntegration(true)
  })
  element("disconnectIntegration").addEventListener("click", () => {
    void updateIntegration(false)
  })
  element("refreshIntegration").addEventListener("click", () => {
    void updateIntegration()
  })
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
  badge(
    "recordingBadge",
    settings.capturePaused ? "Paused" : "Recording",
    settings.capturePaused ? "idle" : "active",
  )
  badge(
    "deepBadge",
    settings.deepCaptureEnabled ? "Enabled" : "Disabled",
    settings.deepCaptureEnabled ? "active" : "idle",
  )
  element("startRecording").hidden = !settings.capturePaused
  element("stopRecording").hidden = settings.capturePaused
  element("startDeepCapture").hidden = settings.deepCaptureEnabled
  element("stopDeepCapture").hidden = !settings.deepCaptureEnabled
}
const captureAction = async (action?: () => Promise<unknown>): Promise<void> => {
  if (captureBusy) return
  captureBusy = true
  captureButtons.forEach((id) => {
    element<HTMLButtonElement>(id).disabled = true
  })
  element("captureNotice").textContent = "Updating capture status…"
  element("captureNotice").dataset.state = "pending"
  badge("recordingBadge", "Checking…", "pending")
  badge("deepBadge", "Checking…", "pending")
  writeJson("captureStatus", null)
  try {
    if (action) await withTimeout(action(), 35000, "Capture control")
    await refreshCapture()
    element("captureNotice").dataset.state = "idle"
  } catch (error) {
    element("captureNotice").textContent = errorText(error)
    element("captureNotice").dataset.state = "error"
    badge("recordingBadge", "Status unavailable", "error")
    badge("deepBadge", "Status unavailable", "error")
    // Allow either action when the actual state could not be read.
    captureButtons.forEach((id) => {
      element(id).hidden = false
    })
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

// Reflect capture changes from other extension pages.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.apiNetworkRecorderSettings && !captureBusy)
    void captureAction()
})
void captureAction()
