import { runAgentAction } from "./agent-actions.js"

export const NATIVE_HOST = "com.api_network_recorder.bridge"
const ALARM = "native-bridge-reconnect"
let port: chrome.runtime.Port | null = null
let generation = 0
let connecting = false
let status = "Installer not connected"

export const getNativeBridgeStatus = () => ({
  connected: port !== null && status === "Connected",
  status,
})

export const connectNativeBridge = async (): Promise<void> => {
  if (
    __BROWSER_TARGET__ !== "chrome" ||
    typeof chrome.runtime.connectNative !== "function" ||
    connecting ||
    port
  )
    return
  connecting = true
  const currentGeneration = generation
  try {
    const stored = await chrome.storage.local.get(["nativeBridgeEnabled", "nativeBridgeProfileId"])
    if (stored.nativeBridgeEnabled === false || currentGeneration !== generation) return
    const profileId =
      typeof stored.nativeBridgeProfileId === "string"
        ? stored.nativeBridgeProfileId
        : crypto.randomUUID()
    await chrome.storage.local.set({ nativeBridgeProfileId: profileId })
    if (currentGeneration !== generation) return
    const connection = chrome.runtime.connectNative(NATIVE_HOST)
    port = connection
    status = "Connecting"
    const readyTimeout = setTimeout(() => {
      if (port === connection && status === "Connecting") connection.disconnect()
    }, 10000)
    connection.onDisconnect.addListener(() => {
      clearTimeout(readyTimeout)
      const reason = chrome.runtime.lastError?.message
      if (port === connection) {
        port = null
        status = reason ? "Install the local integration to connect" : "Disconnected"
      }
    })
    let allowControls = false
    connection.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object" || port !== connection) return
      const packet = message as {
        type?: unknown
        id?: unknown
        method?: unknown
        args?: unknown
        allowControls?: unknown
      }
      if (packet.type === "ready") {
        clearTimeout(readyTimeout)
        allowControls = packet.allowControls === true
        status = "Connected"
        return
      }
      if (packet.type !== "call" || typeof packet.id !== "string" || packet.id.length > 100) return
      void runAgentAction(packet.method, packet.args, allowControls)
        .then((result) => {
          if (port === connection) connection.postMessage({ type: "result", id: packet.id, result })
        })
        .catch((error: unknown) => {
          if (port === connection)
            connection.postMessage({
              type: "result",
              id: packet.id,
              error: error instanceof Error ? error.message : String(error),
            })
        })
    })
    connection.postMessage({ type: "hello", profileId, extensionId: chrome.runtime.id })
  } finally {
    connecting = false
  }
}

export const setNativeBridgeEnabled = async (enabled: boolean): Promise<void> => {
  generation++
  await chrome.storage.local.set({ nativeBridgeEnabled: enabled })
  if (!enabled) {
    const connection = port
    port = null
    status = "Disabled"
    connection?.disconnect()
  } else {
    const connection = port
    port = null
    connection?.disconnect()
    await connectNativeBridge()
  }
}

if (__BROWSER_TARGET__ === "chrome" && chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void connectNativeBridge().catch(() => {})
  })
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 })
  void connectNativeBridge().catch(() => {})
}
