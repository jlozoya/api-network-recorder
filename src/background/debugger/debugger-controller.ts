import { handleDebuggerEvent } from "./debugger-events.js"

const attachedTabs = new Set<number>()
const pendingAttachTabs = new Set<number>()

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

if (debuggerApi) {
  debuggerApi.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId !== "number") {
      return
    }

    void handleDebuggerEvent(source.tabId, method, params)
  })

  debuggerApi.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") {
      attachedTabs.delete(source.tabId)
      pendingAttachTabs.delete(source.tabId)
    }
  })
}

export const startDebuggerCapture = async (tabId: number): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()

  if (!activeDebuggerApi) {
    throw new Error("Deep capture is not supported in this browser.")
  }

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

    await activeDebuggerApi.sendCommand(target, "Network.enable", {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 10_000_000,
    })
  } finally {
    pendingAttachTabs.delete(tabId)
  }
}

export const stopDebuggerCapture = async (tabId: number): Promise<void> => {
  const activeDebuggerApi = getDebuggerApi()

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

export const isDebuggerAttached = (tabId: number): boolean => {
  return attachedTabs.has(tabId)
}

export const getDebuggerCaptureStatus = (tabId: number): {
  supported: boolean
  attached: boolean
} => {
  return {
    supported: isDebuggerCaptureSupported(),
    attached: isDebuggerAttached(tabId),
  }
}