import {
  ensureDebuggerCaptureForTab,
  stopDebuggerCapture,
} from "../debugger/debugger-controller.js"

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopDebuggerCapture(tabId).catch(() => {
    // Tab may not be attached.
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return
  }

  void ensureDebuggerCaptureForTab(
    tabId,
    Boolean(changeInfo.url) || changeInfo.status === "loading",
  ).catch(() => {
    // The tab may not be capturable yet, or another debugger may own it.
  })
})

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") {
    return
  }

  void ensureDebuggerCaptureForTab(tab.id).catch(() => {
    // The tab may not have navigated to a capturable URL yet.
  })
})
