# API Network Recorder

API Network Recorder is a browser extension for capturing, inspecting, filtering, and exporting API/network traffic from web pages.

It supports separate builds for Chrome and Firefox.

## Features

- Capture API-like network requests.
- Inspect request headers, request body, response headers, and response body when available.
- Filter records by search text, HTTP method, status group, source, host, and API-only mode.
- Group captured traffic by endpoint.
- Export captured data as:
  - JSON
  - Markdown API documentation
  - OpenAPI draft
- Pause and continue live listening in the inspector UI.
- Separate build outputs for Chrome and Firefox.
- Release ZIP generation for browser store uploads.

## Browser Support

### Chrome

Chrome supports both capture modes:

- Silent capture through `webRequest`.
- Deep capture through `chrome.debugger`.

Deep capture allows reading response bodies when supported by the browser and permissions.

### Firefox

Firefox supports silent capture through `webRequest`.

Deep capture is disabled in Firefox because `chrome.debugger` is not supported with the same behavior as Chrome.

Firefox builds use:

```json
{
  "background": {
    "scripts": ["assets/background.js"],
    "type": "module"
  }
}