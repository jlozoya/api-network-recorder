import { stopDebuggerCapture } from "../debugger/debugger-controller.js"

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopDebuggerCapture(tabId).catch(() => {
    // Tab may not be attached.
  })
})