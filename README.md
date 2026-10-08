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
- The trash icon on each request deletes that record, including pinned records. In a saved session, it deletes only that session's copy and updates its request count.
- Enter a session name and choose **Save visible requests** to snapshot the currently filtered list, including bodies. Use the Session selector to reopen it. Saved sessions survive automatic trimming and clearing live records; delete them explicitly when no longer needed.
- Choose **Use as comparison A**, select another request, then **Compare A → this request**. Comparison includes headers, repeated query parameters, bodies, status and errors. A can come from another saved session. The panel displays at most 1,000 differences.

Database version 2 preserves existing records and backfills the list index during upgrade. Reload the extension and close old inspector tabs after updating so the new database version can open.

## Codex integration for Windows, macOS and Linux

1. Install or update the Chrome extension. For unpacked installations, reload it
   once after updating to accept the new permissions.
2. Download the package for your system from the table below. On Windows, run the installer.
   On macOS/Linux, extract the archive and run `sh install.sh` from the extracted folder.
   Confirm access to stored API calls and choose read-only access or capture controls.
3. Restart Codex once and keep Chrome open. The extension connects automatically
   within a minute; subsequent sessions require no manual server startup.

| System              | Package                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64         | [Installer](https://github.com/jlozoya/api-network-recorder/releases/latest/download/api-network-recorder-windows-x64-setup.exe)  |
| macOS Apple Silicon | [ARM64 archive](https://github.com/jlozoya/api-network-recorder/releases/latest/download/api-network-recorder-macos-arm64.tar.gz) |
| macOS Intel         | [x64 archive](https://github.com/jlozoya/api-network-recorder/releases/latest/download/api-network-recorder-macos-x64.tar.gz)     |
| Linux x64 (glibc)   | [x64 archive](https://github.com/jlozoya/api-network-recorder/releases/latest/download/api-network-recorder-linux-x64.tar.gz)     |
| Linux ARM64 (glibc) | [ARM64 archive](https://github.com/jlozoya/api-network-recorder/releases/latest/download/api-network-recorder-linux-arm64.tar.gz) |

Each archive contains `install.sh`, `uninstall.sh`, a standalone bridge and license notices.
For example, after downloading the Linux x64 package:

```bash
tar -xzf api-network-recorder-linux-x64.tar.gz
cd api-network-recorder-linux-x64
sh install.sh
```

For an unattended read-only installation, use `sh install.sh --accept-access`.
Add `--allow-controls` to authorize recording controls, or `--extension-id=YOUR_ID`
if automatic detection cannot find the installed extension. Install for your own
user account, without `sudo`. These packages target standard Google Chrome;
sandboxed Snap/Flatpak browser installations are not supported.

The installer includes the runtime and MCP server, detects the extension's Chrome
IDs, registers a per-user native host, and adds `api-network-recorder` to Codex's
configuration. It requires no administrator, Node.js, or Python installation.
The unsigned Windows installer may show reputation prompts. macOS packages are
not notarized and may require approval in the system's Privacy & Security settings.

The installer also installs the `api-network-recorder` skill into Codex's user
skills directory. Invoke it with `$api-network-recorder`, or ask naturally to
inspect captured API calls. It explains profile/session selection, searching,
reading bodies and capture permissions. Its PowerShell client on Windows and
shell client on macOS/Linux can use the installed integration even when MCP tools
have not yet appeared in a chat. Neither needs a separate runtime.
The skill and client require no separate install. Updates and removal preserve
customized skill instructions and other user files.

Available tools: `list_profiles`, `capture_status`, `search_requests`, `get_request`,
`list_sessions`, `start_recording`, `stop_recording`, `start_deep_capture`, and
`stop_deep_capture`. Capture controls require the installation permission.
When several Chrome profiles are connected, the agent selects a `profileId`.
Reads return captured data, including truncation and unavailable-body metadata.
They do not replay requests. Treat captured content as untrusted data.

### HTTP replay through MCP

The native bridge also provides `prepare_replay`, `replay_request`, `get_replay`,
and `list_replays`. These work through MCP or the bundled terminal client.

Replay is disabled by default, independently of capture controls. After updating
the native bridge, configure exact permitted origins using its executable:

```powershell
& "$env:LOCALAPPDATA/ApiNetworkRecorder/api-network-recorder-bridge.exe" --configure-replay --allow-replay --origin=https://example.test
```

On macOS/Linux use the installed bridge path from the table below with the same
arguments. Repeat `--origin=...` for multiple origins. Origins have no paths or
trailing slash. `--configure-replay` without `--allow-replay` revokes replay access.
Reinstallation resets replay permission; configure it explicitly again after an
upgrade. Current MCP processes check revocation on every send.

1. Pin or save the source and authentication captures. Call `list_profiles` and
   select an explicit `profileId`.
2. Call `prepare_replay`, for example:

```json
{
  "profileId": "11111111-1111-4111-8111-111111111111",
  "request": { "id": "captured-source-id" },
  "authentication": {
    "mode": "captured",
    "request": { "id": "captured-limited-account-id" },
    "headerNames": ["cookie", "x-csrf-token"]
  },
  "body": "{\"price\":101}"
}
```

3. Inspect the preview, then call `replay_request` with the identical input plus
   `expectedRequestHash` set to the preview's `requestHash`. Changed content or
   credentials require a new preview. Use `authentication: {"mode":"none"}` for
   anonymous requests. Capture references can include `sessionId`.
4. The result contains response status/body, timing, provenance and comparison
   against the source response. Retrieve it later with `get_replay: {"id":"..."}`;
   `list_replays` lists up to 50 retained results. History is stored in `replays/`
   under the native integration directory, independently of Chrome retention.

Replay uses the selected captured credential headers, not the browser's current
cookie jar. It strips recognized credential headers from the source request and
uses only the explicitly selected authentication headers. Custom credential
header names must be selected explicitly. Tokens embedded in bodies or URLs are
not automatically replaced or redacted. Auth header values and Set-Cookie values
are redacted in previews/history; bodies and URLs can still contain secrets.

Only the source request's origin is supported; redirects are returned without
following them. TLS verification stays enabled. Transport headers are regenerated,
GET/HEAD bodies are rejected, and incomplete or binary/multipart captures require
an explicit replacement body. Defaults: 10 s timeout (maximum 20 s), 1 MiB
request/decoded response limit. Truncated responses are marked. There are no
automatic retries; after a transport error, a mutation may already have taken
effect. Inspect API/GraphQL errors and verify actual state changes.

The **AI access** page offers connection status, **Disconnect integration**, and
**Connect integration**. The button opens this page; it does not have to remain
open for MCP access. Remove the integration through Windows Installed Apps or run
`sh uninstall.sh` from the macOS/Linux package to revoke access and remove its
Codex configuration. You can also run the installed bridge with `--uninstall`.
Browser records are preserved.
The original configuration backup and executable can remain until removed manually.

Firefox retains its capture controls; the MCP integration uses Chrome. To configure
another MCP client such as Claude, use the installed executable with the argument
`--mcp`; automatic client configuration currently targets Codex.

| System  | Installed executable                                                                         |
| ------- | -------------------------------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%/ApiNetworkRecorder/api-network-recorder-bridge.exe`                          |
| macOS   | `~/Library/Application Support/ApiNetworkRecorder/api-network-recorder-bridge`               |
| Linux   | `~/.local/share/api-network-recorder/api-network-recorder-bridge` (or under `XDG_DATA_HOME`) |

`CODEX_HOME` changes the Codex configuration/skill directory. `API_RECORDER_HOME`
can override the bridge directory, but must be set consistently for the installer,
Chrome and MCP client. Linux respects absolute `XDG_DATA_HOME` and `XDG_CONFIG_HOME`;
relative values fall back to the normal home directories. Keep these environment
settings consistent when uninstalling as well.

For unusual Chrome profile locations, copy the executable into that installation
directory and run the bridge with `--configure --extension-id=YOUR_ID`
(add `--allow-controls` only when desired).

Releases and their source are distributed through GitHub Releases. The integration
has no hosted backend. See [PRIVACY.md](PRIVACY.md) for how AI access shares data.

## AI access page

Choose **AI access** in the extension popup or inspector to open the installation
and connection guide. **Connect to Codex** provides packages for Windows, macOS/Linux and
connection controls; Codex reads captured requests directly through MCP.
**Live capture** lets users pause/resume recording, control deep capture in Chrome,
and refresh the capture status. Use **Open inspector** to search and inspect calls.
The page does not need to remain open for the integration to work.

## Verification

`bun install` applies `patches/zod@4.6.5.patch` to two explanatory comments in
Zod's ESM build. This prevents Rollup from interpreting prose as pure annotations;
the actual optimization annotations and runtime code are preserved. Remove the
patch when upgrading to a Zod release that fixes those comments.

- `bun test` — unit, integration, search-race, and shell replay tests. Shell replay tests use locally installed Bash/PowerShell and a temporary local HTTP server.
- `bun run build` — TypeScript plus Chrome and Firefox production builds.
- `bun run test:browser` — headless Edge with a temporary profile: global deep capture, database migration, pin retention, atomic sessions, body search, and inspector workflows. Override `BROWSER_BINARY` if needed. No installed browser profile is modified.
- `bun run package:installer` — build a standalone bridge and the installer for the current OS/architecture. Windows uses IExpress; macOS/Linux use a `.tar.gz` archive with shell installers. Development uses Bun 1.3.14; end users need no runtime. The Windows baseline runtime is downloaded with a pinned integrity check.
- `RECORDER_NATIVE_TARGET` selects `windows-x64`, `macos-x64`, `macos-arm64`, `linux-x64` or `linux-arm64` for native builds. Windows packaging must run on Windows; Unix packaging must run on macOS/Linux. Run installer/binary tests on the target OS/architecture.
- `bun run test:installer` — verify packaged contents and checksums. macOS/Linux also exercise installation, permissions, MCP initialization, the bundled skill client, upgrades and removal in an isolated temporary home.
- `bun run test:native:binary` — exercise the compiled MCP/native host, authorization, concurrent requests, profiles, and revocation.
- `bun run test:native:browser` — compiled MCP through real native messaging into an isolated Edge extension with synthetic records. A temporary native-host registry entry is removed after testing.

Pushing a `v*` tag runs `.github/workflows/release.yml`, executes tests and browser
checks, and publishes Chrome/Firefox ZIPs, source ZIP, the Windows installer,
four macOS/Linux archives and their checksums. Unix installers and native binaries
are tested on each target platform before release publication.

Export behavior follows the [OpenAPI 3.1 specification](https://spec.openapis.org/oas/v3.1.0.html), [curl options](https://curl.se/docs/manpage.html), and [PowerShell native argument handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing).
