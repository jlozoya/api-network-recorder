import type { ExtensionMessage } from "../core/message-types.js"
import "./page-bridge.js"

const EXTENSION_SOURCE = "API_NETWORK_RECORDER"

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) {
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

  chrome.runtime.sendMessage(data.message).catch((error: unknown) => {
    console.warn(
      "[API Network Recorder] Failed to send message to background service worker.",
      error,
    )
  })
})
