import type { CaptureTabStatus } from "../../core/capture-tab-status.js"
import { withTimeout } from "../../core/async-utils.js"
import {
  getCaptureSettings,
  isUrlIgnoredByDomains,
  setCaptureSettings,
} from "../../storage/capture-settings.js"
import { handleDebuggerEvent, clearDebuggerRequestsForTab } from "./debugger-events.js"
import { syncPageCapture } from "./page-capture.js"

const attachedTabs = new Set<number>()
const pendingAttachTabs = new Map<number, Promise<void>>()
let captureGeneration = 0
const captureErrors = new Map<number, string>()
let deepCaptureEnabled = false
let stoppingDebuggerCaptureForAllTabs = false

const NETWORK_ENABLE_OPTIONS = {
  maxTotalBufferSize: 100_000_000,
  maxResourceBufferSize: 10_000_000,
}

const getDebuggerApi = (): typeof chrome.debugger | null => {
  return typeof chrome !== "undefined" && chrome.debugger ? chrome.debugger : null
}

const isDebuggerCaptureSupported = (): boolean => {
  return Boolean(getDebuggerApi())
}

const getCaptureIneligibleReason = (url?: string): string | null => {
  const invalidUrlReason = "Only HTTP and HTTPS pages can be captured."
  if (!url) return invalidUrlReason

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return invalidUrlReason
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalidUrlReason

  // Chromium protects both Web Store domains, including their subdomains.
  const host = parsed.hostname.replace(/\.$/, "")
  if (
    ["chromewebstore.google.com", "chrome.google.com"].some(
      (domain) => host === domain || host.endsWith("." + domain),
    )
  ) {
    return "Chrome Web Store pages do not allow deep capture."
  }
  return null
}

const isCapturableUrl = (url?: string): boolean => getCaptureIneligibleReason(url) === null

// url is the last committed page; new tabs and navigations may only have pendingUrl.
const getCaptureUrl = (tab: chrome.tabs.Tab | null): string | undefined => tab?.pendingUrl || tab?.url

const getTab = async (tabId: number): Promise<chrome.tabs.Tab | null> => {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

const debuggerApi = getDebuggerApi()

const notifyPageCapture = (tabId: number, enabled: boolean): void => {
  if (typeof chrome.tabs.sendMessage !== "function") return
  void chrome.tabs.sendMessage(tabId, { type: "PAGE_CAPTURE_STATE", enabled }).catch(() => {
    // The new document's content script may not exist yet; it also queries this state on load.
  })
}

const setDeepCaptureEnabled = async (enabled: boolean): Promise<void> => {
  deepCaptureEnabled = enabled
  await setCaptureSettings({
    deepCaptureEnabled: enabled,
  })
  await syncPageCapture(enabled)
}

const captureSettingsReady = debuggerApi
  ? getCaptureSettings()
      .then(async (settings) => {
        deepCaptureEnabled = settings.deepCaptureEnabled
        await syncPageCapture(deepCaptureEnabled)
      })
      .catch(() => {
        deepCaptureEnabled = false
      })
  : Promise.resolve()

const getCapturableTabs = async (): Promise<Array<chrome.tabs.Tab & { id: number }>> => {
  const tabs = await chrome.tabs.query({})

  return tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => {
    return typeof tab.id === "number" && isCapturableUrl(getCaptureUrl(tab))
  })
}

const refreshAttachedTabsFromDebugger = async (tabId?: number): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()
  if (!activeDebuggerApi) {
    attachedTabs.clear()
    return
  }
  // onDetach keeps known sessions current. Checking a popup must not re-enable Network
  // on every tab, or wait for an unrelated tab's debugger to respond.
  if (typeof tabId === "number" && attachedTabs.has(tabId)) return
  const knownTabs = new Set(attachedTabs)
  const targets = await withTimeout(activeDebuggerApi.getTargets(), 3000, "Debugger targets")
  const candidates = targets.filter(
    (target) =>
      target.attached &&
      typeof target.tabId === "number" &&
      isCapturableUrl(target.url) &&
      (tabId === undefined || target.tabId === tabId),
  )
  for (const knownTab of knownTabs) {
    if (
      (tabId === undefined || knownTab === tabId) &&
      !candidates.some((target) => target.tabId === knownTab)
    ) {
      attachedTabs.delete(knownTab)
    }
  }
  await Promise.all(
    candidates.map(async (target) => {
      const targetTabId = target.tabId!
      if (attachedTabs.has(targetTabId)) return
      try {
        await withTimeout(
          activeDebuggerApi.sendCommand(
            { tabId: targetTabId },
            "Network.enable",
            NETWORK_ENABLE_OPTIONS,
          ),
          3000,
          "Debugger session check",
        )
        attachedTabs.add(targetTabId)
        notifyPageCapture(targetTabId, false)
      } catch {
        // Other debuggers may own these targets. Only track sessions we can command.
      }
    }),
  )
}

if (debuggerApi) {
  debuggerApi.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId !== "number") {
      return
    }

    const tabId = source.tabId
    void handleDebuggerEvent(tabId, method, params).catch((error: unknown) => {
      captureErrors.set(tabId, error instanceof Error ? error.message : String(error))
    })
  })

  debuggerApi.onDetach.addListener((source, reason) => {
    if (typeof source.tabId === "number") {
      clearDebuggerRequestsForTab(source.tabId)
      attachedTabs.delete(source.tabId)
      notifyPageCapture(source.tabId, true)
      pendingAttachTabs.delete(source.tabId)
      if (reason === "target_closed" && !stoppingDebuggerCaptureForAllTabs) {
        void ensureDebuggerCaptureForTab(source.tabId).catch(() => {
          // A closed tab disappears; a replacement target is also retried on navigation.
        })
      }
    }

    if (reason !== "canceled_by_user" || stoppingDebuggerCaptureForAllTabs) {
      return
    }

    void stopDebuggerCaptureForAllTabs().catch(() => {
      deepCaptureEnabled = false
      attachedTabs.clear()
      pendingAttachTabs.clear()
    })
  })
}

if (debuggerApi) {
  void refreshAttachedTabsFromDebugger().catch(() => {
    attachedTabs.clear()
  })

  void captureSettingsReady
    .then(async () => {
      if (deepCaptureEnabled && !stoppingDebuggerCaptureForAllTabs) {
        await startDebuggerCaptureForAllTabs()
      }
    })
    .catch(() => {
      deepCaptureEnabled = false
    })
}

const connectDebuggerToTab = async (
  tabId: number,
  generation: number,
  refreshNetwork: boolean,
): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()
  if (!activeDebuggerApi) throw new Error("Deep capture is not supported in this browser.")

  const [tab, settings] = await withTimeout(
    Promise.all([getTab(tabId), getCaptureSettings()]),
    3000,
    "Capture tab lookup",
  )
  const captureUrl = getCaptureUrl(tab)
  const ineligibleReason = getCaptureIneligibleReason(captureUrl)
  if (ineligibleReason) throw new Error(ineligibleReason)
  if (
    settings.ignoredTabIds.includes(tabId) ||
    isUrlIgnoredByDomains(captureUrl, settings.ignoredDomains)
  ) {
    throw new Error("This tab is ignored. Remove its ignore rule before starting deep capture.")
  }
  if (generation !== captureGeneration) throw new Error("Deep capture was stopped.")
  const target: chrome.debugger.Debuggee = { tabId }
  if (attachedTabs.has(tabId)) {
    if (!refreshNetwork) return
    try {
      await withTimeout(
        activeDebuggerApi.sendCommand(target, "Network.enable", NETWORK_ENABLE_OPTIONS),
        5000,
        "Network.enable after navigation for tab " + tabId,
      )
      if (generation !== captureGeneration) throw new Error("Deep capture was stopped.")
      notifyPageCapture(tabId, false)
      return
    } catch {
      attachedTabs.delete(tabId)
      // This was our session. Drop a stale connection before retrying its replacement.
      await withTimeout(activeDebuggerApi.detach(target), 3000, "Navigation debugger cleanup").catch(
        () => {},
      )
      if (generation !== captureGeneration) throw new Error("Deep capture was stopped.")
    }
  }
  let expired = false
  let ownsTarget = false
  const attaching = activeDebuggerApi.attach(target, "1.3").then(async () => {
    ownsTarget = true
    if (expired || generation !== captureGeneration) {
      await activeDebuggerApi.detach(target).catch(() => {})
      throw new Error("Deep capture was stopped before the connection completed.")
    }
  })
  try {
    await withTimeout(attaching, 5000, "Debugger attach for tab " + tabId)
    await withTimeout(
      activeDebuggerApi.sendCommand(target, "Network.enable", NETWORK_ENABLE_OPTIONS),
      5000,
      "Network.enable for tab " + tabId,
    )
    if (generation !== captureGeneration) throw new Error("Deep capture was stopped.")
    attachedTabs.add(tabId)
    notifyPageCapture(tabId, false)
  } catch (error) {
    expired = true
    attachedTabs.delete(tabId)
    if (ownsTarget)
      await withTimeout(activeDebuggerApi.detach(target), 3000, "Debugger cleanup").catch(() => {})
    throw error
  }
}

const attachDebuggerToTab = (tabId: number, refreshNetwork = false): Promise<void> => {
  const pending = pendingAttachTabs.get(tabId)
  if (pending) return pending
  if (attachedTabs.has(tabId) && !refreshNetwork) return Promise.resolve()
  captureErrors.delete(tabId)
  const operation = connectDebuggerToTab(tabId, captureGeneration, refreshNetwork)
    .catch((error: unknown) => {
      captureErrors.set(tabId, error instanceof Error ? error.message : String(error))
      throw error
    })
    .finally(() => {
      if (pendingAttachTabs.get(tabId) === operation) pendingAttachTabs.delete(tabId)
    })
  pendingAttachTabs.set(tabId, operation)
  return operation
}

export const startDebuggerCaptureForAllTabs = async (): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()

  if (!activeDebuggerApi) {
    throw new Error("Deep capture is not supported in this browser.")
  }

  const [availableTabs, settings] = await Promise.all([getCapturableTabs(), getCaptureSettings()])
  const tabs = availableTabs.filter(
    (tab) =>
      !settings.ignoredTabIds.includes(tab.id) &&
      !isUrlIgnoredByDomains(getCaptureUrl(tab), settings.ignoredDomains),
  )
  // Keep the global switch enabled for future eligible tabs, even when all current tabs are ignored.
  if (!tabs.length) return
  const results = await Promise.allSettled(tabs.map((tab) => attachDebuggerToTab(tab.id)))
  const successful = results.some((result) => result.status === "fulfilled")
  if (!successful) {
    const failed = results.find((result) => result.status === "rejected")
    throw failed?.reason ?? new Error("Unable to start deep capture.")
  }
}

export const startDebuggerCapture = async (tabId: number): Promise<void> => {
  await captureSettingsReady
  const generation = captureGeneration
  await attachDebuggerToTab(tabId)
  if (generation !== captureGeneration) throw new Error("Deep capture was stopped.")
  await setDeepCaptureEnabled(true)
  // Confirm the chosen tab immediately; slow unrelated tabs must not delay this reply.
  void startDebuggerCaptureForAllTabs().catch((error: unknown) => {
    console.warn("[API Network Recorder] Additional tabs could not start deep capture.", error)
  })
}

export const startDebuggerCaptureForAllAvailableTabs = async (): Promise<void> => {
  await captureSettingsReady
  const wasEnabled = deepCaptureEnabled
  captureErrors.clear()
  const generation = captureGeneration
  try {
    await setDeepCaptureEnabled(true)
    await startDebuggerCaptureForAllTabs()
  } catch (error) {
    if (generation === captureGeneration) await setDeepCaptureEnabled(wasEnabled)
    throw error
  }
}

export const stopDebuggerCapture = async (tabId: number): Promise<void> => {
  clearDebuggerRequestsForTab(tabId)
  const activeDebuggerApi = getDebuggerApi()

  if (!activeDebuggerApi || !attachedTabs.has(tabId)) {
    if (activeDebuggerApi) {
      await refreshAttachedTabsFromDebugger().catch(() => {
        attachedTabs.delete(tabId)
      })
    }
  }

  if (!activeDebuggerApi || !attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId)
    pendingAttachTabs.delete(tabId)
    return
  }

  const target: chrome.debugger.Debuggee = { tabId }

  try {
    await withTimeout(activeDebuggerApi.detach(target), 3000, "Debugger detach for tab " + tabId)
  } finally {
    attachedTabs.delete(tabId)
    pendingAttachTabs.delete(tabId)
  }
}

export const stopDebuggerCaptureForAllTabs = async (): Promise<void> => {
  if (stoppingDebuggerCaptureForAllTabs) {
    return
  }

  stoppingDebuggerCaptureForAllTabs = true
  captureGeneration += 1

  try {
    await captureSettingsReady
    await setDeepCaptureEnabled(false)
    await Promise.allSettled([...pendingAttachTabs.values()])
    await refreshAttachedTabsFromDebugger().catch(() => {
      attachedTabs.clear()
    })

    const tabIds = Array.from(attachedTabs)

    await Promise.all(
      tabIds.map((tabId) =>
        stopDebuggerCapture(tabId).catch(() => {
          attachedTabs.delete(tabId)
        }),
      ),
    )
    captureErrors.clear()
  } finally {
    stoppingDebuggerCaptureForAllTabs = false
  }
}

export const ensureDebuggerCaptureForTab = async (
  tabId: number,
  refreshNetwork = false,
): Promise<void> => {
  await captureSettingsReady
  if (!deepCaptureEnabled || stoppingDebuggerCaptureForAllTabs) {
    return
  }

  await attachDebuggerToTab(tabId, refreshNetwork)
}

export const isDeepCaptureEnabled = (): boolean => {
  return deepCaptureEnabled
}

export const isDebuggerAttached = (tabId: number): boolean => {
  return attachedTabs.has(tabId) && !pendingAttachTabs.has(tabId)
}

export const getDebuggerCaptureStatus = (
  tabId?: number,
): {
  supported: boolean
  attached: boolean
  enabled: boolean
  attachedCount: number
  pendingCount: number
  error: string | null
} => {
  return {
    supported: isDebuggerCaptureSupported(),
    attached: tabId === undefined ? attachedTabs.size > 0 : isDebuggerAttached(tabId),
    enabled: deepCaptureEnabled || attachedTabs.size > 0,
    attachedCount: attachedTabs.size,
    pendingCount: pendingAttachTabs.size,
    error:
      tabId === undefined
        ? attachedTabs.size
          ? null
          : (captureErrors.values().next().value ?? null)
        : (captureErrors.get(tabId) ?? null),
  }
}

export const getFreshDebuggerCaptureStatus = async (
  tabId?: number,
): Promise<ReturnType<typeof getDebuggerCaptureStatus>> => {
  if (isDebuggerCaptureSupported()) {
    await refreshAttachedTabsFromDebugger(tabId).catch(() => {
      if (tabId !== undefined) attachedTabs.delete(tabId)
    })
  }

  return getDebuggerCaptureStatus(tabId)
}

export const getCaptureTabStatuses = async (): Promise<CaptureTabStatus[]> => {
  const [tabs, settings] = await Promise.all([chrome.tabs.query({}), getCaptureSettings()])
  return tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number")
    .map((tab) => {
      const captureUrl = getCaptureUrl(tab)
      const ineligibleReason = getCaptureIneligibleReason(captureUrl)
      let state: CaptureTabStatus["state"] = "off"
      let reason = "Deep capture is off."
      if (!isDebuggerCaptureSupported()) {
        state = "unsupported"
        reason = "This browser does not support deep capture."
      } else if (ineligibleReason) {
        state = "ineligible"
        reason = ineligibleReason
      } else if (
        settings.ignoredTabIds.includes(tab.id) ||
        isUrlIgnoredByDomains(captureUrl, settings.ignoredDomains)
      ) {
        state = "ignored"
        reason = settings.ignoredTabIds.includes(tab.id) ? "Tab exclusion" : "Domain exclusion"
      } else if (pendingAttachTabs.has(tab.id)) {
        state = "pending"
        reason = "Connecting to the debugger…"
      } else if (attachedTabs.has(tab.id)) {
        state = "attached"
        reason = settings.capturePaused
          ? "Debugger connected; recording is paused."
          : (captureErrors.get(tab.id) ?? "Debugger connected; capturing new requests.")
      } else if (captureErrors.has(tab.id)) {
        state = "failed"
        reason = captureErrors.get(tab.id)!
      } else if (deepCaptureEnabled) {
        state = "pending"
        reason = "Waiting for connection or page navigation."
      }
      return {
        tabId: tab.id,
        title: tab.title ?? "Untitled tab",
        url: captureUrl ?? "",
        state,
        reason,
      }
    })
}
