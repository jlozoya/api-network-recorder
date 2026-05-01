import { handleDebuggerEvent } from "./debugger-events.js"

const attachedTabs = new Set<number>()

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") {
    return
  }

  void handleDebuggerEvent(source.tabId, method, params)
})

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attachedTabs.delete(source.tabId)
  }
})

export const startDebuggerCapture = async (tabId: number): Promise<void> => {
  if (attachedTabs.has(tabId)) {
    return
  }

  const target: chrome.debugger.Debuggee = { tabId }

  await chrome.debugger.attach(target, "1.3")

  attachedTabs.add(tabId)

  await chrome.debugger.sendCommand(target, "Network.enable", {
    maxTotalBufferSize: 100_000_000,
    maxResourceBufferSize: 10_000_000,
  })
}

export const stopDebuggerCapture = async (tabId: number): Promise<void> => {
  if (!attachedTabs.has(tabId)) {
    return
  }

  const target: chrome.debugger.Debuggee = { tabId }

  try {
    await chrome.debugger.detach(target)
  } finally {
    attachedTabs.delete(tabId)
  }
}

export const isDebuggerAttached = (tabId: number): boolean => {
  return attachedTabs.has(tabId)
}