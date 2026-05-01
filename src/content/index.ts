import { EXTENSION_SOURCE } from "../core/constants.js"
import type { ExtensionMessage } from "../core/message-types.js"

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