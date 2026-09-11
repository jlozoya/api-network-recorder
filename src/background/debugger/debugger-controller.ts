import type { CaptureTabStatus } from "../../core/capture-tab-status.js"
import { withTimeout } from "../../core/async-utils.js"
import {
  getCaptureSettings,
  isUrlIgnoredByDomains,
  setCaptureSettings,
} from "../../storage/capture-settings.js"
import { handleDebuggerEvent } from "./debugger-events.js"

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

const isCapturableUrl = (url?: string): boolean => {
  if (!url) {
    return false
  }

  return url.startsWith("http://") || url.startsWith("https://")
}

const getTab = async (tabId: number): Promise<chrome.tabs.Tab | null> => {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

const debuggerApi = getDebuggerApi()

const setDeepCaptureEnabled = async (enabled: boolean): Promise<void> => {
  deepCaptureEnabled = enabled
  await setCaptureSettings({
    deepCaptureEnabled: enabled,
  })
}

const getCapturableTabs = async (): Promise<Array<chrome.tabs.Tab & { id: number }>> => {
  const tabs = await chrome.tabs.query({
    url: ["http://*/*", "https://*/*"],
  })

  return tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => {
    return typeof tab.id === "number" && isCapturableUrl(tab.url)
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
      attachedTabs.delete(source.tabId)
      pendingAttachTabs.delete(source.tabId)
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

  void getCaptureSettings()
    .then(async (settings) => {
      deepCaptureEnabled = settings.deepCaptureEnabled

      if (deepCaptureEnabled) {
        await startDebuggerCaptureForAllTabs()
      }
    })
    .catch(() => {
      deepCaptureEnabled = false
    })
}

const connectDebuggerToTab = async (tabId: number, generation: number): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()
  if (!activeDebuggerApi) throw new Error("Deep capture is not supported in this browser.")

  const [tab, settings] = await withTimeout(
    Promise.all([getTab(tabId), getCaptureSettings()]),
    3000,
    "Capture tab lookup",
  )
  if (!tab || !isCapturableUrl(tab.url))
    throw new Error("Deep capture only works on http/https tabs.")
  if (
    settings.ignoredTabIds.includes(tabId) ||
    isUrlIgnoredByDomains(tab.url, settings.ignoredDomains)
  ) {
    throw new Error("This tab is ignored. Remove its ignore rule before starting deep capture.")
  }
  await refreshAttachedTabsFromDebugger(tabId)
  if (generation !== captureGeneration) throw new Error("Deep capture was stopped.")
  if (attachedTabs.has(tabId)) return

  const target: chrome.debugger.Debuggee = { tabId }
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
  } catch (error) {
    expired = true
    attachedTabs.delete(tabId)
    if (ownsTarget)
      await withTimeout(activeDebuggerApi.detach(target), 3000, "Debugger cleanup").catch(() => {})
    throw error
  }
}

const attachDebuggerToTab = (tabId: number): Promise<void> => {
  if (attachedTabs.has(tabId)) return Promise.resolve()
  const pending = pendingAttachTabs.get(tabId)
  if (pending) return pending
  captureErrors.delete(tabId)
  const operation = connectDebuggerToTab(tabId, captureGeneration)
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
      !isUrlIgnoredByDomains(tab.url, settings.ignoredDomains),
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
  const wasEnabled = deepCaptureEnabled
  captureErrors.clear()
  const generation = captureGeneration
  await setDeepCaptureEnabled(true)
  try {
    await startDebuggerCaptureForAllTabs()
  } catch (error) {
    if (generation === captureGeneration) await setDeepCaptureEnabled(wasEnabled)
    throw error
  }
}

export const stopDebuggerCapture = async (tabId: number): Promise<void> => {
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

export const ensureDebuggerCaptureForTab = async (tabId: number): Promise<void> => {
  if (!deepCaptureEnabled) {
    return
  }

  await attachDebuggerToTab(tabId)
}

export const isDeepCaptureEnabled = (): boolean => {
  return deepCaptureEnabled
}

export const isDebuggerAttached = (tabId: number): boolean => {
  return attachedTabs.has(tabId)
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
      let state: CaptureTabStatus["state"] = "off"
      let reason = "Deep capture is off."
      if (!isDebuggerCaptureSupported()) {
        state = "unsupported"
        reason = "This browser does not support deep capture."
      } else if (!isCapturableUrl(tab.url)) {
        state = "ineligible"
        reason = "Only HTTP and HTTPS pages can be captured."
      } else if (
        settings.ignoredTabIds.includes(tab.id) ||
        isUrlIgnoredByDomains(tab.url, settings.ignoredDomains)
      ) {
        state = "ignored"
        reason = settings.ignoredTabIds.includes(tab.id) ? "Tab exclusion" : "Domain exclusion"
      } else if (attachedTabs.has(tab.id)) {
        state = "attached"
        reason = settings.capturePaused
          ? "Debugger connected; recording is paused."
          : (captureErrors.get(tab.id) ?? "Debugger connected; capturing new requests.")
      } else if (pendingAttachTabs.has(tab.id)) {
        state = "pending"
        reason = "Connecting to the debugger…"
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
        url: tab.url ?? "",
        state,
        reason,
      }
    })
}
