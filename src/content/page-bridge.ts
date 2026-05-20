import type { ExtensionMessage } from "../core/message-types.js"

const EXTENSION_SOURCE = "API_NETWORK_RECORDER"

const sendToBackground = async (message: ExtensionMessage): Promise<void> => {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      return
    }

    await chrome.runtime.sendMessage(message)
  } catch {
    // Content scripts can outlive an extension reload or run before Chrome wakes the service worker.
    // Dropping the page-level capture is preferable to logging warnings into the host page console.
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) {
    return
  }

  if (!event.data || typeof event.data !== "object") {
    return
  }

  const data = event.data as {
    source?: string
    message?: ExtensionMessage
  }

  if (data.source !== EXTENSION_SOURCE) {
    return
  }

  if (!data.message) {
    return
  }

  void sendToBackground(data.message)
})
