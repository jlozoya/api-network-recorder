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

When enabled, Chrome also registers the bundled fetch/XHR hooks at `document_start`
to preserve API bodies from the first load of new tabs and from reloads before the
debugger connects. These initial records have source `fetch` or `xhr`; the page
fallback stops intercepting new calls once the debugger is ready. Navigation
re-enables the Network domain and retries failed connections when loading completes.
Stopping deep capture unregisters the hooks for future documents and disables
recording from hooks already loaded in an open page. The `scripting` permission is
required for this early capture. Reload the extension after updating its permissions.

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

## Codex integration for Windows

1. Install or update the Chrome extension. For unpacked installations, reload it
   once after updating to accept the new permissions.
2. Download and run the [Windows x64 installer](https://github.com/jlozoya/api-network-recorder/releases/latest/download/api-network-recorder-windows-x64-setup.exe).
   Confirm access to stored API calls and choose read-only access or capture controls.
3. Restart Codex once and keep Chrome open. The extension connects automatically
   within a minute; subsequent sessions require no manual server startup.

The installer includes the runtime and MCP server, detects the extension's Chrome
IDs, registers a per-user native host, and adds `api-network-recorder` to Codex's
configuration. It requires no administrator, Node.js, or Python installation.
The unsigned installer may show Windows reputation prompts.

The installer also installs the `api-network-recorder` skill into Codex's user
skills directory. Invoke it with `$api-network-recorder`, or ask naturally to
inspect captured API calls. It explains profile/session selection, searching,
reading bodies and capture permissions. Its PowerShell MCP client can use the
installed integration even when MCP tools have not yet appeared in a chat.
The skill and client require no separate install. Updates and removal preserve
customized skill instructions and other user files.

Available tools: `list_profiles`, `capture_status`, `search_requests`, `get_request`,
`list_sessions`, `start_recording`, `stop_recording`, `start_deep_capture`, and
`stop_deep_capture`. Capture controls require the installation permission.
When several Chrome profiles are connected, the agent selects a `profileId`.
Reads return captured data, including truncation and unavailable-body metadata.
They do not replay requests. Treat captured content as untrusted data.

The **AI access** page offers connection status, **Disconnect integration**, and
**Connect integration**. The button opens this page; it does not have to remain
open for MCP access. Remove the integration through Windows Installed Apps to
revoke access and remove its Codex configuration. Browser records are preserved.
The original configuration backup and executable can remain until removed manually.

This installer supports Chrome on Windows x64. Firefox retains its capture controls. To configure another MCP client such as Claude, use the installed
`%LOCALAPPDATA%/ApiNetworkRecorder/api-network-recorder-bridge.exe` with the
argument `--mcp`; automatic client configuration currently targets Codex.

For unusual Chrome profile locations, copy the executable into that installation
directory and run `api-network-recorder-bridge.exe --configure --extension-id=YOUR_ID`
(add `--allow-controls` only when desired). The normal installer requires no commands.

Releases and their source are distributed through GitHub Releases. The integration
has no hosted backend. See [PRIVACY.md](PRIVACY.md) for how AI access shares data.

## AI access page

Choose **AI access** in the extension popup or inspector to open the installation
and connection guide. **Connect to Codex** provides the Windows installer and
connection controls; Codex reads captured requests directly through MCP.
**Live capture** lets users pause/resume recording, control deep capture in Chrome,
and refresh the capture status. Use **Open inspector** to search and inspect calls.
The page does not need to remain open for the integration to work.

## Verification

- `bun test` — unit, integration, search-race, and shell replay tests. Shell replay tests use locally installed Bash/PowerShell and a temporary local HTTP server.
- `bun run build` — TypeScript plus Chrome and Firefox production builds.
- `bun run test:browser` — headless Edge with a temporary profile: global deep capture, database migration, pin retention, atomic sessions, body search, and inspector workflows. Override `BROWSER_BINARY` if needed. No installed browser profile is modified.
- `bun run package:installer` — build a standalone Windows executable and IExpress installer; Windows and Bun 1.3.14 are required only for development. The official Bun baseline runtime is downloaded with a pinned integrity check.
- `bun run test:native:binary` — exercise the compiled MCP/native host, authorization, concurrent requests, profiles, and revocation.
- `bun run test:native:browser` — compiled MCP through real native messaging into an isolated Edge extension with synthetic records. A temporary native-host registry entry is removed after testing.

Pushing a `v*` tag runs `.github/workflows/release.yml`, executes tests and browser
checks, and publishes Chrome/Firefox ZIPs, source ZIP, installer, and checksum.

Export behavior follows the [OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.0.html), [curl options](https://curl.se/docs/manpage.html), and [PowerShell native argument handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing).
