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
```

## Inspector workflow

- Lists read a lightweight IndexedDB index; request and response bodies load when you select a request. Search is debounced and still searches captured bodies.
- **Export OpenAPI** offers one document per request origin. Responses use examples from the matching status and content type. Path parameters, observed query parameters, and request bodies are included. These are inferred drafts, not authoritative API contracts.
- **Copy cURL** supports Bash and PowerShell 7.3+. Multipart fields use literal form values with a fresh boundary. Captured file names do not include file contents. Bash exports containing Unicode use a UTF-8 heredoc to avoid Git for Windows argument recoding.
- **Tab status** shows connected, pending, excluded, failed, unsupported, and ineligible tabs. It refreshes while the dialog is open.
- **Pin request** keeps a live request outside the rolling retention limit. **Clear unpinned** preserves pins; unpin a request to return it to normal retention.
- Enter a session name and choose **Save visible requests** to snapshot the currently filtered list, including bodies. Use the Session selector to reopen it. Saved sessions survive automatic trimming and clearing live records; delete them explicitly when no longer needed.
- Choose **Use as comparison A**, select another request, then **Compare A → this request**. Comparison includes headers, repeated query parameters, bodies, status and errors. A can come from another saved session. The panel displays at most 1,000 differences.

Database version 2 preserves existing records and backfills the list index during upgrade. Reload the extension and close old inspector tabs after updating so the new database version can open.

## Verification

- `bun test` — unit, integration, search-race, and shell replay tests. Shell replay tests use locally installed Bash/PowerShell and a temporary local HTTP server.
- `bun run build` — TypeScript plus Chrome and Firefox production builds.
- `bun run test:browser` — headless Edge with a temporary profile: global deep capture, database migration, pin retention, atomic sessions, body search, and inspector workflows. Override `BROWSER_BINARY` if needed. No installed browser profile is modified.

Export behavior follows the [OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.0.html), [curl options](https://curl.se/docs/manpage.html), and [PowerShell native argument handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing).
