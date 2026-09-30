# Privacy Policy

Effective date: September 30, 2026

## API Network Recorder

API Network Recorder is a browser extension for developers. It helps users capture, inspect, filter, and export API/network traffic from browser pages for debugging, documentation, and API analysis.

This Privacy Policy explains what data the extension may process, how that data is used, and how it is stored.

## Data Collected or Processed

API Network Recorder may capture network request and response data from web pages where the user uses the extension.

Captured data may include:

- Request URLs
- HTTP methods
- HTTP status codes
- Request headers
- Request bodies
- Response headers
- Response bodies, when available
- Page URLs
- Timing metadata
- Browser tab identifiers
- API hostnames and endpoint paths

Depending on the website or API being inspected, this captured network data may include sensitive information such as authentication tokens, cookies, email addresses, user identifiers, personal information, or other data included in request or response payloads.

## How Data Is Used

Captured data is used only for the extension’s core functionality:

- Displaying captured network records
- Filtering and searching records
- Inspecting request and response details
- Grouping traffic by endpoint
- Exporting records as JSON
- Exporting API documentation as Markdown
- Exporting an OpenAPI draft
- Storing local capture settings
- Answering requests from an AI client through an optional, authorized local integration

The extension does not use captured data for advertising, analytics, profiling, creditworthiness, or any purpose unrelated to API/network debugging and documentation.

## Data Storage

Captured network records and settings are stored locally in the user’s browser using browser storage technologies such as IndexedDB and extension storage.

API Network Recorder does not upload captured network data to any external server.

The extension does not operate a backend service for collecting, storing, or analyzing user data.

## Data Sharing

API Network Recorder does not sell or rent captured network data.

Captured data remains in the browser unless the user exports it or permits an AI
client to access it. The optional Windows integration grants Codex access to
captured URLs, headers, and bodies through a local MCP process. The installer
asks whether the agent may also start and stop recording and deep capture;
users can choose read-only access. The integration does not send data directly
to a remote server. The AI client may send requested data to its AI provider
under that client's settings and privacy policy.

The integration stores its executable, permission settings, a local authentication
secret, and connection metadata under `%LOCALAPPDATA%/ApiNetworkRecorder`.
It does not persist captured API records outside the browser. The installer adds
its MCP entry to Codex's configuration and preserves unrelated settings, with
a backup of the existing configuration. Communication uses native messaging,
MCP standard input/output, and authenticated local named pipes.

## Remote Code

API Network Recorder does not execute remotely hosted code.

The extension’s functionality is included in the extension package submitted to the browser extension store.

## Permissions

API Network Recorder requests browser permissions required for its functionality.

### `storage`

Used to store captured records and extension settings locally in the browser.

### `tabs`

Used to associate captured network traffic with the correct browser tab and open the inspector page.

### `webRequest`

Used to observe network requests and responses so the extension can display request metadata, response metadata, headers, status codes, and timing information.

### `debugger`

Used only in Chrome when the user enables deep capture. Deep capture uses the Chrome Debugger Protocol to access response bodies that are not available through standard network APIs.

### `scripting`

Used in Chrome to register the extension's bundled fetch/XHR hooks at the start of
page loading while deep capture is enabled. This preserves API responses that
finish before the debugger connects in new or reloaded tabs. The hooks are
unregistered when deep capture stops; hooks in already open pages stop recording.

### Host permissions

Used because developers may need to debug API traffic on different websites, local development environments, staging environments, and production applications.

### `nativeMessaging` (Chrome)

Used to communicate with the optional local AI integration installed by the user.
The native host accepts only extension IDs authorized during installation.

### `alarms` (Chrome)

Used to reconnect to the installed local integration automatically.

## User Control

Users can clear captured records from inside the extension.

Users can also remove all extension data by uninstalling the extension or clearing the extension’s browser storage.

The extension includes controls to pause and continue live updates in the inspector view.

Users can disconnect AI access from the AI access page, or remove the integration
from Windows Installed Apps. Uninstalling revokes local access and removes its
Codex entry without deleting captured browser records. The configuration backup
and executable may remain until existing processes close and users remove them.

## Children’s Privacy

API Network Recorder is a developer tool and is not intended for use by children.

The extension does not knowingly collect data from children.

## Changes to This Policy

This Privacy Policy may be updated when the extension changes.

Updates will be published in this repository.

## Contact

For questions about this Privacy Policy, contact:

fernandolv1995@gmail.com
