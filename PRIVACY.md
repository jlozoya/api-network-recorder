# Privacy Policy

Effective date: May 2026

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

The extension does not use captured data for advertising, analytics, profiling, creditworthiness, or any purpose unrelated to API/network debugging and documentation.

## Data Storage

Captured network records and settings are stored locally in the user’s browser using browser storage technologies such as IndexedDB and extension storage.

API Network Recorder does not upload captured network data to any external server.

The extension does not operate a backend service for collecting, storing, or analyzing user data.

## Data Sharing

API Network Recorder does not sell, rent, transfer, or share captured network data with third parties.

Captured data remains local to the user’s browser unless the user manually exports it and chooses to share it.

## Remote Code

API Network Recorder does not execute remotely hosted code.

The extension’s functionality is included in the extension package submitted to the browser extension store.

## Permissions

API Network Recorder requests browser permissions required for its functionality.

### `storage`

Used to store captured records and extension settings locally in the browser.

### `tabs`

Used to associate captured network traffic with the correct browser tab and open the inspector page.

### `activeTab`

Used to identify the active tab when the user interacts with the extension.

### `webRequest`

Used to observe network requests and responses so the extension can display request metadata, response metadata, headers, status codes, and timing information.

### `debugger`

Used only in Chrome when the user enables deep capture. Deep capture uses the Chrome Debugger Protocol to access response bodies that are not available through standard network APIs.

### Host permissions

Used because developers may need to debug API traffic on different websites, local development environments, staging environments, and production applications.

## User Control

Users can clear captured records from inside the extension.

Users can also remove all extension data by uninstalling the extension or clearing the extension’s browser storage.

The extension includes controls to pause and continue live updates in the inspector view.

## Children’s Privacy

API Network Recorder is a developer tool and is not intended for use by children.

The extension does not knowingly collect data from children.

## Changes to This Policy

This Privacy Policy may be updated when the extension changes.

Updates will be published in this repository.

## Contact

For questions about this Privacy Policy, contact:

fernandolv1995@gmail.com