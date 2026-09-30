import { withTimeout } from "../../core/async-utils.js"

const SCRIPT_ID = "deep-capture-first-requests"
let updates: Promise<void> = Promise.resolve()

// Chrome installs this before site scripts run, including on future tabs and reloads.
// The debugger itself can only connect asynchronously after a tab exists.
export const syncPageCapture = (enabled: boolean): Promise<void> => {
  const operation = updates
    .catch(() => {})
    .then(async () => {
      if (!chrome.scripting) return
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })
      if (enabled && !scripts.length) {
        await chrome.scripting.registerContentScripts([
          {
            id: SCRIPT_ID,
            matches: ["http://*/*", "https://*/*"],
            excludeMatches: [
              "*://chrome.google.com/*",
              "*://*.chrome.google.com/*",
              "*://chromewebstore.google.com/*",
              "*://*.chromewebstore.google.com/*",
            ],
            js: ["assets/injected.js"],
            allFrames: true,
            runAt: "document_start",
            world: "MAIN",
            persistAcrossSessions: true,
          },
        ])
      } else if (!enabled && scripts.length) {
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] })
      }
    })
  // Serialize the actual operation, even if the caller's timeout expires first.
  // Otherwise a slow registration could complete after a subsequent unregister.
  updates = operation
  return withTimeout(operation, 5000, "Early page capture")
}
