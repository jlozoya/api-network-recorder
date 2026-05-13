import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { NetworkRecord } from "../core/network-types.js"
import type { CaptureLimit, CaptureSettings } from "../storage/capture-settings.js"

const sendMessage = async <T>(message: ExtensionMessage): Promise<T> => {
  const response = (await chrome.runtime.sendMessage(message)) as ExtensionResponse<T>

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.data
}

const setText = (selector: string, value: string): void => {
  const element = document.querySelector(selector)

  if (element) {
    element.textContent = value
  }
}

const setError = (message: string | null): void => {
  const element = document.querySelector<HTMLElement>("#error")

  if (!element) {
    return
  }

  if (!message) {
    element.hidden = true
    element.textContent = ""
    return
  }

  element.hidden = false
  element.textContent = message
}

const getActiveTabId = async (): Promise<number | null> => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  })

  return typeof tab?.id === "number" ? tab.id : null
}

const setCaptureBadge = (attached: boolean): void => {
  const badge = document.querySelector<HTMLElement>("#captureBadge")

  if (!badge) {
    return
  }

  badge.textContent = attached ? "Deep capture on" : "Silent capture"
  badge.dataset.active = String(attached)
}

const setDeepCaptureButtonState = (
  attached: boolean,
  options?: {
    disabled?: boolean
    busyText?: string
  },
): void => {
  const button = document.querySelector<HTMLButtonElement>("#toggleDeepCapture")

  if (!button) {
    return
  }

  if (options?.busyText) {
    button.textContent = options.busyText
  } else {
    button.textContent = attached ? "Stop deep capture" : "Start deep capture"
  }

  button.disabled = options?.disabled ?? false
  button.dataset.active = String(attached)
}

const refreshCaptureStatus = async (): Promise<boolean> => {
  const tabId = await getActiveTabId()

  if (typeof tabId !== "number") {
    setCaptureBadge(false)
    setDeepCaptureButtonState(false, { disabled: true, busyText: "No active tab" })
    return false
  }

  const status = await sendMessage<{ attached: boolean }>({
    type: "GET_CAPTURE_STATUS",
    payload: {
      tabId,
    },
  })

  setCaptureBadge(status.attached)
  setDeepCaptureButtonState(status.attached)

  return status.attached
}

const refreshSettings = async (): Promise<void> => {
  const settings = await sendMessage<CaptureSettings>({
    type: "GET_CAPTURE_SETTINGS",
  })

  const select = document.querySelector<HTMLSelectElement>("#captureLimit")

  if (select) {
    select.value = String(settings.captureLimit)
  }
}

const refreshSummary = async (): Promise<void> => {
  const records = await sendMessage<NetworkRecord[]>({
    type: "GET_RECORDS",
    payload: {
      limit: 1000,
      apiOnly: false,
    },
  })

  const apiRecords = records.filter((record) => {
    const resourceType = record.resourceType?.toLowerCase() ?? ""
    const mimeType = record.mimeType?.toLowerCase() ?? ""

    return (
      resourceType === "xmlhttprequest" ||
      resourceType === "fetch" ||
      resourceType === "xhr" ||
      mimeType.includes("json")
    )
  })

  const deepRecords = records.filter((record) => record.source === "debugger").length
  const errors = records.filter((record) => record.error || record.status === null).length
  const hosts = new Set(
    records
      .map((record) => {
        try {
          return new URL(record.url).host
        } catch {
          return null
        }
      })
      .filter((host): host is string => Boolean(host)),
  )

  setText(
    "#summary",
    `${records.length} stored records. ${apiRecords.length} API-like. ${deepRecords} deep. ${errors} errors. ${hosts.size} hosts.`,
  )
}

const refresh = async (): Promise<void> => {
  try {
    setError(null)
    await Promise.all([refreshSummary(), refreshSettings(), refreshCaptureStatus()])
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  }
}

document.querySelector("#openApp")?.addEventListener("click", () => {
  void sendMessage<null>({
    type: "OPEN_APP",
  }).catch((error: unknown) => {
    setError(error instanceof Error ? error.message : String(error))
  })
})

document.querySelector("#clear")?.addEventListener("click", async () => {
  try {
    await sendMessage<null>({
      type: "CLEAR_RECORDS",
    })

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  }
})

document.querySelector("#toggleDeepCapture")?.addEventListener("click", async () => {
  try {
    setError(null)

    const tabId = await getActiveTabId()

    if (typeof tabId !== "number") {
      throw new Error("No active tab found.")
    }

    const isAttached = await refreshCaptureStatus()

    setDeepCaptureButtonState(isAttached, {
      disabled: true,
      busyText: isAttached ? "Stopping..." : "Starting...",
    })

    if (isAttached) {
      await sendMessage<null>({
        type: "STOP_DEBUGGER_CAPTURE",
        payload: {
          tabId,
        },
      })
    } else {
      await sendMessage<null>({
        type: "START_DEBUGGER_CAPTURE",
        payload: {
          tabId,
        },
      })
    }

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
    await refresh()
  }
})

document.querySelector("#captureLimit")?.addEventListener("change", async (event) => {
  try {
    const target = event.target

    if (!(target instanceof HTMLSelectElement)) {
      return
    }

    await sendMessage<CaptureSettings>({
      type: "SET_CAPTURE_SETTINGS",
      payload: {
        captureLimit: Number(target.value) as CaptureLimit,
      },
    })

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  }
})

void refresh()