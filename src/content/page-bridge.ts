import type { ExtensionMessage } from "../core/message-types.js"

const EXTENSION_SOURCE = "API_NETWORK_RECORDER"

interface ExtensionEnvelope {
  source: typeof EXTENSION_SOURCE
  message: Extract<ExtensionMessage, { type: "NETWORK_RECORD_CREATED" }>
}

const isNetworkRecordMessage = (
  value: unknown,
): value is Extract<ExtensionMessage, { type: "NETWORK_RECORD_CREATED" }> => {
  if (!value || typeof value !== "object") {
    return false
  }

  const message = value as {
    type?: unknown
    payload?: unknown
  }

  return message.type === "NETWORK_RECORD_CREATED" && Boolean(message.payload)
}

const isExtensionEnvelope = (value: unknown): value is ExtensionEnvelope => {
  if (!value || typeof value !== "object") {
    return false
  }

  const envelope = value as {
    source?: unknown
    message?: unknown
  }

  return envelope.source === EXTENSION_SOURCE && isNetworkRecordMessage(envelope.message)
}

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
  try {
    const data = event.data

    if (event.source !== window || !isExtensionEnvelope(data)) {
      return
    }

    void sendToBackground(data.message).catch(() => {
      // Keep extension messaging failures out of host page consoles.
    })
  } catch {
    // Host pages can send arbitrary window messages; ignore anything that does not match our bridge.
  }
})
