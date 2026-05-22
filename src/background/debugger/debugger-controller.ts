import { getCaptureSettings, setCaptureSettings } from "../../storage/capture-settings.js"
import { handleDebuggerEvent } from "./debugger-events.js"

const attachedTabs = new Set<number>()
const pendingAttachTabs = new Set<number>()
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

const refreshAttachedTabsFromDebugger = async (): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()

  if (!activeDebuggerApi) {
    attachedTabs.clear()
    return
  }

  const targets = await activeDebuggerApi.getTargets()
  const verifiedTabs = new Set<number>()

  for (const target of targets) {
    if (!target.attached || typeof target.tabId !== "number" || !isCapturableUrl(target.url)) {
      continue
    }

    try {
      await activeDebuggerApi.sendCommand(
        { tabId: target.tabId },
        "Network.enable",
        NETWORK_ENABLE_OPTIONS,
      )
      verifiedTabs.add(target.tabId)
    } catch {
      // Another debugger may own this target. Only track tabs this extension can command.
    }
  }

  attachedTabs.clear()

  for (const tabId of verifiedTabs) {
    attachedTabs.add(tabId)
  }
}

if (debuggerApi) {
  debuggerApi.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId !== "number") {
      return
    }

    void handleDebuggerEvent(source.tabId, method, params)
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

const attachDebuggerToTab = async (tabId: number): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()

  if (!activeDebuggerApi) {
    throw new Error("Deep capture is not supported in this browser.")
  }

  await refreshAttachedTabsFromDebugger()

  if (attachedTabs.has(tabId) || pendingAttachTabs.has(tabId)) {
    return
  }

  const tab = await getTab(tabId)

  if (!isCapturableUrl(tab?.url)) {
    throw new Error("Deep capture only works on http/https tabs.")
  }

  pendingAttachTabs.add(tabId)

  const target: chrome.debugger.Debuggee = { tabId }

  try {
    await activeDebuggerApi.attach(target, "1.3")

    attachedTabs.add(tabId)

    await activeDebuggerApi.sendCommand(target, "Network.enable", NETWORK_ENABLE_OPTIONS)
  } finally {
    pendingAttachTabs.delete(tabId)
  }
}

export const startDebuggerCaptureForAllTabs = async (): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()

  if (!activeDebuggerApi) {
    throw new Error("Deep capture is not supported in this browser.")
  }

  await refreshAttachedTabsFromDebugger()

  const tabs = await getCapturableTabs()
  const failures: string[] = []

  for (const tab of tabs) {
    try {
      await attachDebuggerToTab(tab.id)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (failures.length === tabs.length && tabs.length > 0) {
    throw new Error(failures[0] ?? "Unable to start deep capture.")
  }
}

export const startDebuggerCapture = async (tabId: number): Promise<void> => {
  await attachDebuggerToTab(tabId)
  await setDeepCaptureEnabled(true)
  await startDebuggerCaptureForAllTabs()
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
    await activeDebuggerApi.detach(target)
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

  try {
    await setDeepCaptureEnabled(false)
    await refreshAttachedTabsFromDebugger().catch(() => {
      attachedTabs.clear()
    })

    const tabIds = Array.from(attachedTabs)

    for (const tabId of tabIds) {
      await stopDebuggerCapture(tabId).catch(() => {
        attachedTabs.delete(tabId)
        pendingAttachTabs.delete(tabId)
      })
    }
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
  tabId: number,
): {
  supported: boolean
  attached: boolean
} => {
  return {
    supported: isDebuggerCaptureSupported(),
    attached: deepCaptureEnabled || isDebuggerAttached(tabId),
  }
}

export const getFreshDebuggerCaptureStatus = async (
  tabId: number,
): Promise<{
  supported: boolean
  attached: boolean
}> => {
  if (isDebuggerCaptureSupported()) {
    await refreshAttachedTabsFromDebugger().catch(() => {
      attachedTabs.delete(tabId)
    })
  }

  return getDebuggerCaptureStatus(tabId)
}
