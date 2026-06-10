import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { NetworkRecord } from "../core/network-types.js"
import type { CaptureLimit, CaptureSettings } from "../storage/capture-settings.js"
import { normalizeIgnoredDomain } from "../storage/capture-settings.js"

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

const setIgnoreError = (message: string | null): void => {
  const element = document.querySelector<HTMLElement>("#ignoreError")
  const input = document.querySelector<HTMLInputElement>("#domainInput")

  if (!element) {
    return
  }

  if (!message) {
    element.hidden = true
    element.textContent = ""
    input?.removeAttribute("aria-invalid")
    return
  }

  element.hidden = false
  element.textContent = message
  input?.setAttribute("aria-invalid", "true")
  input?.focus()
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

const setDeepCaptureControlsVisible = (visible: boolean): void => {
  const section = document.querySelector<HTMLElement>(".deepCapture")

  if (section) {
    section.hidden = !visible
  }
}

interface CaptureTargetTab {
  id: number
  url: string
}

const isCapturableUrl = (url?: string): url is string => {
  return Boolean(url?.startsWith("http://") || url?.startsWith("https://"))
}

const getCaptureTargetTab = async (): Promise<CaptureTargetTab | null> => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  })

  if (typeof tab?.id === "number" && isCapturableUrl(tab.url)) {
    return {
      id: tab.id,
      url: tab.url,
    }
  }

  const fallbackTabs = await chrome.tabs.query({
    currentWindow: true,
    url: ["http://*/*", "https://*/*"],
  })
  const [fallbackTab] = fallbackTabs
    .filter((item): item is chrome.tabs.Tab & CaptureTargetTab => {
      return typeof item.id === "number" && isCapturableUrl(item.url)
    })
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))

  return fallbackTab
    ? {
        id: fallbackTab.id,
        url: fallbackTab.url,
      }
    : null
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

const getHost = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const setIgnoredTabButtonState = (
  settings: CaptureSettings,
  tab: CaptureTargetTab | null,
): void => {
  const button = document.querySelector<HTMLButtonElement>("#toggleIgnoreTab")

  if (!button) {
    return
  }

  if (!tab) {
    button.textContent = "Open a web tab"
    button.disabled = true
    button.dataset.active = "false"
    return
  }

  const ignored = settings.ignoredTabIds.includes(tab.id)
  button.textContent = ignored ? "Capture this tab again" : `Ignore this tab (${getHost(tab.url)})`
  button.disabled = false
  button.dataset.active = String(ignored)
}

const renderIgnoredDomains = (settings: CaptureSettings): void => {
  const container = document.querySelector<HTMLElement>("#ignoredDomains")

  if (!container) {
    return
  }

  if (!settings.ignoredDomains.length) {
    container.innerHTML = `<p>No ignored domains.</p>`
    return
  }

  container.innerHTML = settings.ignoredDomains
    .map(
      (domain) => `
        <button class="domainChip" data-domain="${escapeHtml(domain)}" type="button" title="Remove ${escapeHtml(domain)}">
          <span>${escapeHtml(domain)}</span>
          <strong aria-hidden="true">x</strong>
        </button>
      `,
    )
    .join("")
}

const refreshCaptureStatus = async (): Promise<boolean> => {
  if (!__SUPPORTS_DEEP_CAPTURE__) {
    setCaptureBadge(false)
    return false
  }

  const tab = await getCaptureTargetTab()

  if (!tab) {
    setCaptureBadge(false)
    setDeepCaptureButtonState(false, { disabled: true, busyText: "Open a web tab" })
    return false
  }

  const status = await sendMessage<{ supported: boolean; attached: boolean }>({
    type: "GET_CAPTURE_STATUS",
    payload: {
      tabId: tab.id,
    },
  })

  if (!status.supported) {
    setCaptureBadge(false)
    setDeepCaptureButtonState(false, { disabled: true, busyText: "Unsupported" })
    return false
  }

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

  setIgnoredTabButtonState(settings, await getCaptureTargetTab())
  renderIgnoredDomains(settings)
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

const refresh = async (options?: { clearError?: boolean }): Promise<void> => {
  try {
    if (options?.clearError ?? true) {
      setError(null)
    }

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
  if (!__SUPPORTS_DEEP_CAPTURE__) {
    return
  }

  try {
    setError(null)

    const tab = await getCaptureTargetTab()

    if (!tab) {
      throw new Error("Open an http/https page before starting deep capture.")
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
          tabId: tab.id,
        },
      })
    } else {
      await sendMessage<null>({
        type: "START_DEBUGGER_CAPTURE",
        payload: {
          tabId: tab.id,
        },
      })
    }

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
    await refresh({ clearError: false })
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

document.querySelector("#toggleIgnoreTab")?.addEventListener("click", async () => {
  try {
    const [settings, tab] = await Promise.all([
      sendMessage<CaptureSettings>({
        type: "GET_CAPTURE_SETTINGS",
      }),
      getCaptureTargetTab(),
    ])

    if (!tab) {
      throw new Error("Open an http/https page before ignoring a tab.")
    }

    const ignoredTabIds = settings.ignoredTabIds.includes(tab.id)
      ? settings.ignoredTabIds.filter((tabId) => tabId !== tab.id)
      : [...settings.ignoredTabIds, tab.id]

    await sendMessage<CaptureSettings>({
      type: "SET_CAPTURE_SETTINGS",
      payload: {
        ignoredTabIds,
      },
    })

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  }
})

document.querySelector("#addDomainForm")?.addEventListener("submit", async (event) => {
  event.preventDefault()

  try {
    setIgnoreError(null)

    const input = document.querySelector<HTMLInputElement>("#domainInput")
    const domain = normalizeIgnoredDomain(input?.value ?? "")

    if (!domain) {
      setIgnoreError("Enter a valid domain to ignore.")
      return
    }

    const settings = await sendMessage<CaptureSettings>({
      type: "GET_CAPTURE_SETTINGS",
    })

    await sendMessage<CaptureSettings>({
      type: "SET_CAPTURE_SETTINGS",
      payload: {
        ignoredDomains: Array.from(new Set([...settings.ignoredDomains, domain])),
      },
    })

    if (input) {
      input.value = ""
    }

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  }
})

document.querySelector("#domainInput")?.addEventListener("input", () => {
  setIgnoreError(null)
})

document.querySelector("#ignoredDomains")?.addEventListener("click", async (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest(".domainChip") : null

  if (!(button instanceof HTMLButtonElement)) {
    return
  }

  try {
    const domain = button.dataset.domain

    if (!domain) {
      return
    }

    const settings = await sendMessage<CaptureSettings>({
      type: "GET_CAPTURE_SETTINGS",
    })

    await sendMessage<CaptureSettings>({
      type: "SET_CAPTURE_SETTINGS",
      payload: {
        ignoredDomains: settings.ignoredDomains.filter((item) => item !== domain),
      },
    })

    await refresh()
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  }
})

setDeepCaptureControlsVisible(__SUPPORTS_DEEP_CAPTURE__)

void refresh()
