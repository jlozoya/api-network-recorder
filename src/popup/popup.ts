import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { NetworkRecordSummary } from "../core/network-summary.js"
import { withTimeout } from "../core/async-utils.js"
import type { CaptureLimit, CaptureSettings } from "../storage/capture-settings.js"
import { normalizeIgnoredDomain } from "../storage/capture-settings.js"

const sendMessage = async <T>(message: ExtensionMessage): Promise<T> => {
  const response = (await withTimeout(
    chrome.runtime.sendMessage(message),
    message.type === "CLEAR_RECORDS"
      ? 35000
      : ["START_DEBUGGER_CAPTURE", "START_DEBUGGER_CAPTURE_ALL", "STOP_DEBUGGER_CAPTURE"].includes(
            message.type,
          )
        ? 30000
        : 10000,
    message.type,
  )) as ExtensionResponse<T>

  if (!response) throw new Error("The extension did not respond. Reload the extension and retry.")

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.data
}

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
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

const setButtonBusy = (selector: string, busy: boolean, busyText: string): void => {
  const button = document.querySelector<HTMLButtonElement>(selector)

  if (!button) {
    return
  }

  if (busy) {
    button.dataset.defaultText = button.textContent ?? ""
    button.textContent = busyText
    button.disabled = true
    return
  }

  button.textContent = button.dataset.defaultText || button.textContent
  button.disabled = false
  delete button.dataset.defaultText
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
  button.textContent = ignored ? "Capture this tab again" : "Ignore this tab"
  button.disabled = false
  button.dataset.active = String(ignored)
}

const getTabDomain = (tab: CaptureTargetTab | null): string | null => {
  return tab ? normalizeIgnoredDomain(getHost(tab.url)) : null
}

const setIgnoreDomainButtonState = (
  settings: CaptureSettings,
  tab: CaptureTargetTab | null,
): void => {
  const button = document.querySelector<HTMLButtonElement>("#toggleIgnoreDomain")

  if (!button) {
    return
  }

  const domain = getTabDomain(tab)

  if (!domain) {
    button.textContent = "Open a web tab"
    button.disabled = true
    button.dataset.active = "false"
    return
  }

  const ignored = settings.ignoredDomains.includes(domain)
  button.textContent = ignored ? `Stop ignoring ${domain}` : `Ignore (${domain})`
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

interface CaptureStatusData {
  attached: boolean
  enabled?: boolean
  attachedCount?: number
  pendingCount?: number
  error?: string | null
  disabled: boolean
  busyText?: string
}

const fetchCaptureStatus = async (): Promise<CaptureStatusData> => {
  if (!__SUPPORTS_DEEP_CAPTURE__) {
    return { attached: false, disabled: false }
  }

  const status = await sendMessage<{
    supported: boolean
    attached: boolean
    enabled: boolean
    attachedCount: number
    pendingCount: number
    error: string | null
  }>({
    type: "GET_CAPTURE_STATUS",
    payload: {},
  })

  if (!status.supported) {
    return { attached: false, disabled: true, busyText: "Unsupported" }
  }

  return {
    attached: status.attached,
    enabled: status.enabled,
    attachedCount: status.attachedCount,
    pendingCount: status.pendingCount,
    error: status.error,
    disabled: false,
  }
}

const applyCaptureStatus = (data: CaptureStatusData): boolean => {
  const button = document.querySelector<HTMLButtonElement>("#toggleDeepCapture")
  if (button) delete button.dataset.retry
  const enabled = data.enabled ?? data.attached
  setCaptureBadge(data.attached)
  if (!data.attached && enabled) {
    setText(
      "#captureBadge",
      data.attachedCount
        ? "Deep capture on other tabs"
        : data.pendingCount
          ? "Deep capture starting"
          : data.error
            ? "Deep capture not connected"
            : "Deep capture waiting for tabs",
    )
  }
  if (data.error) setError(data.error)
  setDeepCaptureButtonState(
    enabled,
    data.busyText
      ? { disabled: data.disabled, busyText: data.busyText }
      : { disabled: data.disabled },
  )

  return enabled
}

const buildSummaryText = (summary: NetworkRecordSummary): string => {
  return (
    summary.total +
    " stored records. " +
    summary.api +
    " API-like. " +
    summary.deep +
    " deep. " +
    summary.errors +
    " errors. " +
    summary.hosts +
    " hosts."
  )
}

const refresh = async (options?: { clearError?: boolean }): Promise<void> => {
  if (options?.clearError ?? true) setError(null)
  const errors: string[] = []
  const report = (error: unknown): void => {
    errors.push(error instanceof Error ? error.message : String(error))
    setError(errors.join("\n"))
  }
  const tabPromise = withTimeout(getCaptureTargetTab(), 10000, "Tab lookup")
  const settingsPromise = sendMessage<CaptureSettings>({ type: "GET_CAPTURE_SETTINGS" })

  // Each section renders as soon as it is ready. A slow DB must not hide capture status.
  await Promise.all([
    sendMessage<NetworkRecordSummary>({ type: "GET_RECORD_SUMMARY" })
      .then((summary) => setText("#summary", buildSummaryText(summary)))
      .catch((error: unknown) => {
        setText("#summary", "Record summary unavailable.")
        report(error)
      }),
    Promise.all([settingsPromise, tabPromise])
      .then(([settings, tab]) => {
        const select = document.querySelector<HTMLSelectElement>("#captureLimit")
        if (select) select.value = String(settings.captureLimit)
        setIgnoredTabButtonState(settings, tab)
        setIgnoreDomainButtonState(settings, tab)
        renderIgnoredDomains(settings)
      })
      .catch((error: unknown) => {
        setText("#toggleIgnoreTab", "Tab settings unavailable")
        setText("#toggleIgnoreDomain", "Domain settings unavailable")
        report(error)
      }),
    fetchCaptureStatus()
      .then(applyCaptureStatus)
      .catch((error: unknown) => {
        setText("#captureBadge", "Status unavailable")
        setDeepCaptureButtonState(false, { busyText: "Retry capture status" })
        const button = document.querySelector<HTMLButtonElement>("#toggleDeepCapture")
        if (button) button.dataset.retry = "true"
        report(error)
      }),
  ])
}

const refreshAfterClearTimeout = async (): Promise<void> => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(1000)
    await refresh()

    const summary = document.querySelector("#summary")?.textContent ?? ""

    if (summary.startsWith("0 stored records.")) {
      return
    }
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
    setError(null)
    setButtonBusy("#clear", true, "Clearing...")

    await sendMessage<null>({
      type: "CLEAR_RECORDS",
    })

    await refresh()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (message.includes("CLEAR_RECORDS timed out")) {
      await refreshAfterClearTimeout()
      return
    }

    setError(message)
    await refresh({ clearError: false })
  } finally {
    setButtonBusy("#clear", false, "Clear records")
  }
})

document.querySelector("#toggleDeepCapture")?.addEventListener("click", async () => {
  if (document.querySelector<HTMLButtonElement>("#toggleDeepCapture")?.dataset.retry === "true") {
    await refresh()
    return
  }
  if (!__SUPPORTS_DEEP_CAPTURE__) {
    return
  }

  try {
    setError(null)

    const isAttached = applyCaptureStatus(await fetchCaptureStatus())

    setDeepCaptureButtonState(isAttached, {
      disabled: true,
      busyText: isAttached ? "Stopping..." : "Starting...",
    })

    if (isAttached) {
      await sendMessage<null>({
        type: "STOP_DEBUGGER_CAPTURE",
      })
    } else {
      await sendMessage<null>({
        type: "START_DEBUGGER_CAPTURE_ALL",
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

document.querySelector("#toggleIgnoreDomain")?.addEventListener("click", async () => {
  try {
    const [settings, tab] = await Promise.all([
      sendMessage<CaptureSettings>({
        type: "GET_CAPTURE_SETTINGS",
      }),
      getCaptureTargetTab(),
    ])

    const domain = getTabDomain(tab)

    if (!domain) {
      throw new Error("Open an http/https page before ignoring a domain.")
    }

    const ignoredDomains = settings.ignoredDomains.includes(domain)
      ? settings.ignoredDomains.filter((item) => item !== domain)
      : Array.from(new Set([...settings.ignoredDomains, domain]))

    await sendMessage<CaptureSettings>({
      type: "SET_CAPTURE_SETTINGS",
      payload: {
        ignoredDomains,
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
