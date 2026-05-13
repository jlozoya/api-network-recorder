import type { ManifestV3 } from "./src/manifest.js"

export const manifest: ManifestV3 = {
  manifest_version: 3,
  name: "API Network Recorder",
  version: "0.1.0",
  description:
    "Capture authorized API requests and responses for debugging, documentation, and API analysis.",
  permissions: ["activeTab", "storage", "tabs", "webRequest", "debugger"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "assets/background.js",
    type: "module",
  },
  action: {
    default_title: "API Network Recorder",
    default_popup: "popup.html",
  },
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["assets/content.js"],
      run_at: "document_start",
      all_frames: true,
      world: "ISOLATED",
    },
  ],
}