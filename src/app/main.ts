import {
  exportEndpointMarkdown,
  exportOpenApiDraft,
  groupRecordsByEndpoint,
  hasCapturedBody,
  isProbablyApiRecord,
} from "../core/endpoint-utils.js"
import { recordToCurl, type CurlShell } from "../core/export-curl.js"
import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { CapturedBody, NetworkRecord } from "../core/network-types.js"
import {
  getCaptureSettings,
  normalizeIgnoredDomain,
  setCaptureSettings,
} from "../storage/capture-settings.js"
import { resetDb } from "../storage/db.js"
import {
  clearNetworkRecords,
  deleteNetworkRecord,
  listNetworkRecordPreviews,
  getNetworkRecordsByIds,
  listSavedSessions,
  saveSession,
  deleteSavedSession,
  setNetworkRecordPinned,
} from "../storage/network-record-repository.js"
import type { NetworkRecordPreview, SavedSession } from "../core/record-preview.js"
import type { CaptureTabStatus } from "../core/capture-tab-status.js"
import { compareRecords } from "../core/compare-records.js"
import { createTooltips } from "./tooltips.js"

import "./app.css"

const AUTO_REFRESH_INTERVAL_MS = 2_000
const RECORD_LOAD_TIMEOUT_MS = 30_000

const app = document.querySelector<HTMLElement>("#app")

if (!app) {
  throw new Error("Missing #app")
}

const tooltips = createTooltips(app)

interface AppState {
  records: NetworkRecordPreview[]
  selectedRecordId: string | null
  selectedEndpointKey: string | null
  view: "requests" | "endpoints"
  search: string
  method: string
  statusGroup: "all" | "success" | "redirect" | "client-error" | "server-error" | "error"
  source: NetworkRecord["source"] | "all"
  host: string
  apiOnly: boolean
  loading: boolean
  error: string | null
  listeningPaused: boolean
  deepCaptureEnabled: boolean
  deepCaptureBusy: boolean
  ignoredDomains: string[]
  sessions: SavedSession[]
  sessionId: string
  sessionName: string
  curlShell: CurlShell
  notice: string | null
}

interface ListAnchorRow {
  key: string
  offset: number
}

interface ListAnchor {
  pinnedToTop: boolean
  rows: ListAnchorRow[]
  scrollTop: number
}

interface PanelScrollState {
  listAnchor: ListAnchor
  detailsScrollTop: number
}

interface RenderOptions {
  preservePanelScroll?: boolean
}

const state: AppState = {
  records: [],
  selectedRecordId: null,
  selectedEndpointKey: null,
  view: "requests",
  search: "",
  method: "ALL",
  statusGroup: "all",
  source: "all",
  host: "",
  apiOnly: true,
  loading: true,
  error: null,
  listeningPaused: false,
  deepCaptureEnabled: false,
  deepCaptureBusy: false,
  ignoredDomains: [],
  sessions: [],
  sessionId: "",
  sessionName: "",
  curlShell: "bash",
  notice: null,
}

let reloadGeneration = 0
let detailGeneration = 0
let searchTimer: number | undefined
let refreshInFlight = 0
let detailLoading = false
let detailError: string | null = null
let compareBaseline: NetworkRecord | null = null
let details = new Map<string, NetworkRecord>()
const selectedRecord = () =>
  state.selectedRecordId ? details.get(state.selectedRecordId) : undefined

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timeoutId: number | undefined

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (typeof timeoutId === "number") {
      window.clearTimeout(timeoutId)
    }
  }
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

const tooltipAttributes = (title: string, description?: string, kind?: "url"): string =>
  `data-tooltip="${escapeHtml(title)}"${description ? ` data-tooltip-description="${escapeHtml(description)}"` : ""}${kind ? ` data-tooltip-kind="${kind}"` : ""}`

const sendMessage = async <T>(message: ExtensionMessage): Promise<T> => {
  const response = (await chrome.runtime.sendMessage(message)) as ExtensionResponse<T>

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.data
}

type ToolbarIcon =
  | "pause"
  | "play"
  | "refresh"
  | "bolt"
  | "stop"
  | "download"
  | "braces"
  | "file"
  | "trash"
  | "pin"
  | "copy"

const icon = (name: ToolbarIcon): string => {
  const paths: Record<ToolbarIcon, string> = {
    pause: `<path d="M8 5v14"/><path d="M16 5v14"/>`,
    play: `<path d="m7 4 12 8-12 8z"/>`,
    refresh: `<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/>`,
    bolt: `<path d="m13 2-8 12h7l-1 8 8-12h-7z"/>`,
    stop: `<rect x="6" y="6" width="12" height="12" rx="2"/>`,
    download: `<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>`,
    braces: `<path d="M8 3H7a3 3 0 0 0-3 3v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a3 3 0 0 0 3 3h1"/><path d="M16 3h1a3 3 0 0 1 3 3v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a3 3 0 0 1-3 3h-1"/>`,
    file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>`,
    trash: `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>`,
    pin: `<path d="M16 9V3H8v6l-2 3v2h12v-2z"/><path d="M12 14v7"/>`,
    copy: `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  }

  return `<svg class="buttonIcon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`
}

const renderActionButton = (
  id: string,
  label: string,
  iconName: ToolbarIcon,
  options?: {
    className?: string
    active?: boolean
    disabled?: boolean
  },
): string => {
  const classes = ["actionButton", options?.className].filter(Boolean).join(" ")
  const descriptions: Record<string, string> = {
    toggleListening: state.listeningPaused ? "Resume recording new requests." : "Pause recording new requests.",
    refresh: "Reload the list of recorded requests.",
    toggleDeepCapture: state.deepCaptureEnabled ? "Stop capturing response bodies with deep capture." : "Capture response bodies with deep capture.",
    clear: state.sessionId ? "Switch to Live capture to clear unpinned requests." : "Delete unpinned requests from live capture. Pinned requests are kept.",
    exportJson: "Download recorded requests as JSON.",
    exportMarkdown: "Download a Markdown summary of observed endpoints.",
    exportOpenApi: "Download an OpenAPI draft from observed endpoints.",
  }

  return `
    <button
      id="${id}"
      class="${classes}"
      type="button"
      ${tooltipAttributes(label, descriptions[id])}
      ${options?.active ? `data-active="true"` : ""}
      ${options?.disabled ? "disabled" : ""}
    >
      ${icon(iconName)}
      <span class="buttonLabel">${escapeHtml(label)}</span>
    </button>
  `
}

const LIST_TOP_PIN_THRESHOLD_PX = 8

const getListItemKey = (item: HTMLElement): string | null => {
  return item.dataset.id ?? item.dataset.endpointKey ?? null
}

const findListItem = (list: HTMLElement, key: string): HTMLElement | null => {
  return (
    list.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"]`) ??
    list.querySelector<HTMLElement>(`[data-endpoint-key="${CSS.escape(key)}"]`)
  )
}

// New records are prepended to the top of the list (newest first), so a raw
// scrollTop offset would silently show different records after every
// refresh. Instead we anchor to whichever record was at the top of the
// viewport, like a chat that only autoscrolls when you're already pinned to
// the newest messages.
const getListAnchor = (): ListAnchor => {
  const list = document.querySelector<HTMLElement>(".list")

  if (!list) {
    return { pinnedToTop: true, rows: [], scrollTop: 0 }
  }

  const pinnedToTop = list.scrollTop <= LIST_TOP_PIN_THRESHOLD_PX
  const bounds = list.getBoundingClientRect()
  const rows: ListAnchorRow[] = []

  // Remember every row on screen, topmost first. The rolling capture window
  // deletes the oldest records while they are still being read, so the top
  // anchor can be gone by the next refresh; the next row still on screen then
  // keeps the viewport on the records the user is actually looking at.
  for (const item of list.querySelectorAll<HTMLElement>("[data-id], [data-endpoint-key]")) {
    const itemRect = item.getBoundingClientRect()

    if (itemRect.bottom <= bounds.top) continue
    if (itemRect.top >= bounds.bottom) break

    const key = getListItemKey(item)

    if (key) rows.push({ key, offset: itemRect.top - bounds.top })
  }

  return { pinnedToTop, rows, scrollTop: list.scrollTop }
}

const restoreListAnchor = (anchor: ListAnchor): void => {
  const list = document.querySelector<HTMLElement>(".list")

  if (!list) {
    return
  }

  let target: HTMLElement | null = null
  let anchorOffset = 0

  for (const row of anchor.rows) {
    const candidate = findListItem(list, row.key)

    if (candidate) {
      target = candidate
      anchorOffset = row.offset
      break
    }
  }

  if (!target) {
    list.scrollTop = anchor.pinnedToTop ? 0 : anchor.scrollTop
    return
  }

  const containerTop = list.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top

  // Jump instantly to keep the previously-anchored record exactly where it
  // was (invisible to the user), then glide the rest of the way to reveal
  // any newly captured records above it — only when the user was already
  // pinned near the top, same as a chat autoscrolling to new messages.
  const offsetChange = targetTop - containerTop - anchorOffset
  // An unchanged list must not cancel a smooth scroll already in progress.
  if (Math.abs(offsetChange) < 0.5) return
  list.scrollTop += offsetChange

  if (anchor.pinnedToTop && list.scrollTop > 0) {
    list.scrollTo({ top: 0, behavior: "smooth" })
  }
}

const getPanelScrollState = (): PanelScrollState => {
  const details = document.querySelector<HTMLElement>(".details")

  return {
    listAnchor: getListAnchor(),
    detailsScrollTop: details?.scrollTop ?? 0,
  }
}

const restorePanelScrollState = (scrollState: PanelScrollState): void => {
  restoreListAnchor(scrollState.listAnchor)
  const panel = document.querySelector<HTMLElement>(".details")
  if (panel && panel.scrollTop !== scrollState.detailsScrollTop) {
    panel.scrollTop = scrollState.detailsScrollTop
  }
}

const formatBody = (body: CapturedBody | null): string => {
  if (!body) return ""

  if (body.kind === "unavailable") {
    return body.reason
  }

  if (body.kind === "json" || body.kind === "form-data") {
    return JSON.stringify(body.value, null, 2)
  }

  if (body.kind === "binary") {
    const preview = body.value.slice(0, 512)
    const lines = [
      `Binary body: ${body.sizeBytes} bytes${body.truncated ? " (truncated)" : ""}`,
      "Encoding: base64",
    ]

    if (preview) {
      lines.push("", body.value.length > preview.length ? `${preview}...` : preview)
    }

    return lines.join("\n")
  }

  return body.value
}

const formatRecordLabel = (record: NetworkRecord): string => {
  return `${formatStatus(record)} ${record.source} ${record.completedAt}`
}

const renderSection = (title: string, copyKey: string, content: string): string => {
  return `
    <div class="sectionHeader">
      <h3>${escapeHtml(title)}</h3>
      <button class="copySection" data-copy-key="${escapeHtml(copyKey)}" type="button" ${tooltipAttributes(`Copy ${title.toLowerCase()}`)}>Copy</button>
    </div>
    <pre>${escapeHtml(content)}</pre>
  `
}

const renderAvailableBodies = (
  records: NetworkRecord[],
  getBody: (record: NetworkRecord) => CapturedBody | null,
): string => {
  const recordsWithBodies = records.filter((record) => hasCapturedBody(getBody(record)))

  if (!recordsWithBodies.length) {
    const unavailable = records.find((record) => getBody(record)?.kind === "unavailable")
    const fallback = unavailable ?? records[0]
    return `<pre>${escapeHtml(formatBody(fallback ? getBody(fallback) : null))}</pre>`
  }

  return recordsWithBodies
    .slice(0, 10)
    .map(
      (record) => `
        <div class="bodySample">
          <div class="bodySampleMeta">${escapeHtml(formatRecordLabel(record))}</div>
          <pre>${escapeHtml(formatBody(getBody(record)))}</pre>
        </div>
      `,
    )
    .join("")
}

const formatStatus = (record: NetworkRecord): string => {
  if (record.error) {
    return "ERR"
  }

  return String(record.status ?? "ERR")
}

const getStatusClass = (record: NetworkRecord): string => {
  if (record.error || record.status === null) {
    return "statusError"
  }

  if (record.status >= 200 && record.status < 300) {
    return "statusSuccess"
  }

  if (record.status >= 300 && record.status < 400) {
    return "statusRedirect"
  }

  if (record.status >= 400) {
    return "statusError"
  }

  return ""
}

const getHost = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return "unknown"
  }
}

const getPath = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

const getUniqueHosts = (records: NetworkRecord[]): string[] => {
  return Array.from(new Set(records.map((record) => getHost(record.url)))).sort((a, b) =>
    a.localeCompare(b),
  )
}

const downloadText = (filename: string, content: string, type: string): void => {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")

  anchor.href = url
  anchor.download = filename
  anchor.click()

  URL.revokeObjectURL(url)
}

const copyText = async (value: string): Promise<void> => {
  await navigator.clipboard.writeText(value)
}

const COPY_FLASH_CLASS = "copyFlash"
const COPY_FLASH_DURATION_MS = 900

const flashCopied = (button: HTMLElement | null): void => {
  if (!button) {
    return
  }

  button.classList.remove(COPY_FLASH_CLASS)
  void button.offsetWidth // restart the animation if the button was clicked again mid-flash
  button.classList.add(COPY_FLASH_CLASS)

  window.setTimeout(() => {
    button.classList.remove(COPY_FLASH_CLASS)
  }, COPY_FLASH_DURATION_MS)
}

const getRecordFingerprint = (records: NetworkRecord[]): string => {
  return records
    .map(
      (record) =>
        `${record.id}:${record.completedAt}:${"pinned" in record ? record.pinned : false}`,
    )
    .join("|")
}

const isEditingFilters = (): boolean => {
  const activeElement = document.activeElement

  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLTextAreaElement
  )
}

const hasActiveSelection = (): boolean => {
  const selection = window.getSelection()

  return Boolean(
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    app.contains(selection.anchorNode),
  )
}

// Records kept alive for the open inspection stay in capture order: dropping
// them at the end of the list would teleport the selected row to the bottom.
const mergeRetainedRecords = (
  loaded: NetworkRecordPreview[],
  retained: NetworkRecordPreview[],
): NetworkRecordPreview[] => {
  const loadedIds = new Set(loaded.map((record) => record.id))
  const missing = retained.filter((record) => !loadedIds.has(record.id))

  if (!missing.length) {
    return loaded
  }

  return [...loaded, ...missing].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

const refreshRecords = async (): Promise<NetworkRecordPreview[]> => {
  return await withTimeout(
    listNetworkRecordPreviews(
      {
        limit: 2000,
        search: state.search,
        method: state.method,
        statusGroup: state.statusGroup,
        source: state.source,
        host: state.host,
        apiOnly: state.apiOnly,
      },
      state.sessionId || undefined,
    ),
    RECORD_LOAD_TIMEOUT_MS,
    "Local record load",
  )
}

const renderLoading = (): void => {
  app.innerHTML = `
    <section class="loadingState">
      <h1>API Network Recorder</h1>
      <p>Loading local network records...</p>
    </section>
  `
}

const renderError = (message: string): void => {
  app.innerHTML = `
    <section class="fatal">
      <h1>Unable to load API Network Recorder</h1>
      <p>${escapeHtml(message)}</p>
      <div class="fatalActions">
        <button id="retryLoad" type="button">Retry</button>
        <button id="resetLocalDb" type="button" class="danger">Reset local DB</button>
      </div>
      <pre>${escapeHtml(message)}</pre>
    </section>
  `

  document.querySelector("#retryLoad")?.addEventListener("click", () => {
    void reload({ silent: false })
  })

  document.querySelector("#resetLocalDb")?.addEventListener("click", async () => {
    try {
      await resetDb()
      state.records = []
      state.selectedRecordId = null
      state.selectedEndpointKey = null
      state.error = null
      await reload({ silent: false })
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      render()
    }
  })
}

const renderFilters = (): string => {
  const hosts = getUniqueHosts(state.records)

  return `
    <section class="filters">
      <input
        id="search"
        type="search"
        placeholder="Search URL, body, status..."
        value="${escapeHtml(state.search)}"
      />

      <select id="method">
        ${["ALL", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
          .map(
            (method) =>
              `<option value="${method}" ${state.method === method ? "selected" : ""}>${method}</option>`,
          )
          .join("")}
      </select>

      <select id="statusGroup">
        ${[
          ["all", "All statuses"],
          ["success", "2xx"],
          ["redirect", "3xx"],
          ["client-error", "4xx"],
          ["server-error", "5xx"],
          ["error", "Errors"],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${state.statusGroup === value ? "selected" : ""}>${label}</option>`,
          )
          .join("")}
      </select>

      <select id="source">
        ${[
          ["all", "All sources"],
          ["web-request", "webRequest"],
          ["fetch", "fetch"],
          ["xhr", "xhr"],
          ["debugger", "debugger"],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${state.source === value ? "selected" : ""}>${label}</option>`,
          )
          .join("")}
      </select>

      <select id="host">
        <option value="">All hosts</option>
        ${hosts
          .map(
            (host) =>
              `<option value="${escapeHtml(host)}" ${
                state.host === host ? "selected" : ""
              }>${escapeHtml(host)}</option>`,
          )
          .join("")}
      </select>

      <label class="checkbox">
        <input id="apiOnly" type="checkbox" ${state.apiOnly ? "checked" : ""} />
        API only
      </label>
    </section>
  `
}

const renderToolbar = (): string => {
  const apiRecords = state.records.filter(isProbablyApiRecord)
  const endpointGroups = groupRecordsByEndpoint(state.records)
  const listenButtonLabel = state.listeningPaused ? "Continue listening" : "Pause listening"
  const listenStatusLabel = state.listeningPaused ? "Paused" : "Listening"
  const deepCaptureButtonLabel = state.deepCaptureBusy
    ? "Working..."
    : state.deepCaptureEnabled
      ? "Stop deep capture"
      : "Start deep capture"

  return `
    <header class="topbar">
      <div>
        <h1>API Network Recorder</h1>
        <p>${state.records.length} records · ${apiRecords.length} API-like · ${endpointGroups.length} endpoints · ${listenStatusLabel}</p>
      </div>

      <div class="topbarActions">
        <div class="actionRow controlActions ${__SUPPORTS_DEEP_CAPTURE__ ? "" : "noDeepCapture"}">
          ${renderActionButton(
            "toggleListening",
            listenButtonLabel,
            state.listeningPaused ? "play" : "pause",
            {
              active: state.listeningPaused,
            },
          )}
          ${renderActionButton("refresh", "Refresh", "refresh")}
          ${
            __SUPPORTS_DEEP_CAPTURE__
              ? renderActionButton(
                  "toggleDeepCapture",
                  deepCaptureButtonLabel,
                  state.deepCaptureEnabled ? "stop" : "bolt",
                  {
                    active: state.deepCaptureEnabled,
                    disabled: state.deepCaptureBusy,
                  },
                )
              : ""
          }
          ${renderActionButton("clear", "Clear unpinned", "trash", { className: "danger", disabled: Boolean(state.sessionId) })}
        </div>

        <div class="actionRow exportActions">
          ${renderActionButton("exportJson", "Export JSON", "braces")}
          ${renderActionButton("exportMarkdown", "Export Markdown", "file")}
          ${renderActionButton("exportOpenApi", "Export OpenAPI", "download")}
        </div>
      </div>
    </header>

    <section class="sessionBar" aria-label="Saved sessions">
      <label>Session <select id="sessionSelect"><option value="">Live capture</option>
        ${state.sessions.map((session) => `<option value="${escapeHtml(session.id)}" ${state.sessionId === session.id ? "selected" : ""}>${escapeHtml(session.name)} (${session.count})</option>`).join("")}
      </select></label>
      <input id="sessionName" aria-label="New session name" placeholder="Session name" maxlength="120" value="${escapeHtml(state.sessionName)}" />
      <button id="saveSession" type="button" ${tooltipAttributes("Save session", "Save the visible requests as a snapshot.")} ${state.records.length ? "" : "disabled"}>Save session visible requests</button>
      ${state.sessionId ? `<button id="deleteSession" class="danger" type="button" ${tooltipAttributes("Delete session", "Permanently delete this saved snapshot.")}>Delete session</button>` : ""}
      <button id="captureTabs" type="button" ${tooltipAttributes("Tab status", "See which tabs are being captured and any capture errors.")}>Tab status</button>
      <button id="openAgent" type="button" ${tooltipAttributes("AI access", "Open the settings for access through the local integration.")}>AI access</button>
    </section>
    ${state.notice ? `<div class="notice" role="status">${escapeHtml(state.notice)}<button id="dismissNotice" type="button">Dismiss</button></div>` : ""}
    <nav class="tabs">
      <button class="tab ${state.view === "requests" ? "active" : ""}" data-view="requests" type="button">
        Requests
      </button>
      <button class="tab ${state.view === "endpoints" ? "active" : ""}" data-view="endpoints" type="button">
        Endpoints
      </button>
    </nav>
  `
}

const renderRequestList = (): string => {
  if (!state.records.length) {
    return `<p class="empty">No records match the current filters.</p>`
  }

  return state.records
    .map(
      (record) => `
        <article class="record ${state.selectedRecordId === record.id ? "selected" : ""}" data-id="${escapeHtml(record.id)}">
          <div class="recordActions">
            <button class="recordAction recordCopyUrl" type="button" data-record-id="${escapeHtml(record.id)}" ${tooltipAttributes("Copy URL", "Copy the full request URL, including query parameters.")} aria-label="Copy URL">${icon("copy")}</button>
            ${!state.sessionId ? `<button class="recordAction recordPin" type="button" data-record-id="${escapeHtml(record.id)}" ${tooltipAttributes(record.pinned ? "Unpin" : "Pin", record.pinned ? "Allow this request to be removed by the capture limit or Clear unpinned." : "Keep this request when the capture limit is reached or unpinned requests are cleared.")} aria-label="${record.pinned ? "Unpin" : "Pin"}" aria-pressed="${record.pinned}">${icon("pin")}</button>` : ""}
            <button class="recordAction recordDelete" type="button" data-record-id="${escapeHtml(record.id)}" ${tooltipAttributes("Delete request", state.sessionId ? "Delete this request from the saved session." : "Delete this request from live capture, even if it is pinned.")} aria-label="Delete request">${icon("trash")}</button>
          </div>
          <div class="recordMeta">
            <strong>${escapeHtml(record.method)}</strong>
            <span class="${getStatusClass(record)}">${escapeHtml(formatStatus(record))}</span>
            <span>${escapeHtml(record.source)}</span>
            <span>${record.durationMs ?? "-"}ms</span>
          </div>
          <div class="host">${escapeHtml(getHost(record.url))}</div>
          <div class="url" ${tooltipAttributes("Request URL", record.url, "url")}>${escapeHtml(getPath(record.url))}</div>
          ${record.error ? `<div class="recordError">${escapeHtml(record.error)}</div>` : ""}
        </article>
      `,
    )
    .join("")
}

const renderEndpointList = (): string => {
  const groups = groupRecordsByEndpoint(state.records)

  if (!groups.length) {
    return `<p class="empty">No endpoint groups match the current filters.</p>`
  }

  return groups
    .map(
      (group) => `
        <article class="record ${
          state.selectedEndpointKey === group.key ? "selected" : ""
        }" data-endpoint-key="${escapeHtml(group.key)}">
          <div class="recordMeta">
            <strong>${escapeHtml(group.method)}</strong>
            <span>${group.count} calls</span>
            <span>${group.statuses.length ? group.statuses.join(", ") : "ERR"}</span>
            <span>${group.averageDurationMs ?? "-"}ms avg</span>
          </div>
          <div class="host">${escapeHtml(group.origin)}</div>
          <div class="url" ${tooltipAttributes("Endpoint URL", group.origin + group.normalizedPath, "url")}>${escapeHtml(group.normalizedPath)}</div>
        </article>
      `,
    )
    .join("")
}

const renderSelectedRequest = (): string => {
  const record = selectedRecord()

  if (!record) {
    if (detailLoading) {
      return `<div class="detailsLoading" role="status"><span class="detailsSpinner" aria-hidden="true"></span><span class="detailsLoadingLabel">Loading request details</span></div>`
    }
    return `<p class="empty">${escapeHtml(detailError ?? (state.selectedRecordId ? "Request no longer available. Refresh the list." : "Select a request."))}</p>`
  }

  const domain = normalizeIgnoredDomain(getHost(record.url))
  const domainIgnored = domain !== null && state.ignoredDomains.includes(domain)

  return `
    <section class="detailsHeader">
      <div>
        <h2>${escapeHtml(record.method)} ${escapeHtml(formatStatus(record))}</h2>
      </div>
      <div class="detailsActions">
        <button id="copyDomain" type="button" ${tooltipAttributes("Copy domain", "Copy only the hostname of this request.")}>Copy domain</button>
        <select id="curlShell" aria-label="cURL terminal" ${tooltipAttributes("cURL terminal", "Choose Bash or PowerShell formatting for the copied command.")}><option value="bash" ${state.curlShell === "bash" ? "selected" : ""}>Bash</option><option value="powershell" ${state.curlShell === "powershell" ? "selected" : ""}>PowerShell 7.3+</option></select>
        <button id="copyCurl" type="button" ${tooltipAttributes("Copy cURL", "Copy this request as a cURL command.")}>Copy cURL</button>
        <button id="setBaseline" type="button" ${tooltipAttributes("Use as comparison A", "Keep this request as the baseline for a comparison.")}>Use as comparison A</button>
        ${compareBaseline ? `<button id="compareRequest" type="button" ${tooltipAttributes("Compare requests", "Compare this request with comparison A.")}>Compare A → this request</button><button id="clearBaseline" type="button" ${tooltipAttributes("Clear comparison A", "Remove the current comparison baseline.")}>Clear A</button>` : ""}
        <button id="copyResponse" type="button" ${tooltipAttributes("Copy response", "Copy the captured response body.")}>Copy response</button>
        ${
          domain
            ? `
              <button
                id="toggleIgnoreDomain"
                type="button"
                data-domain="${escapeHtml(domain)}"
                ${tooltipAttributes(domainIgnored ? "Stop ignoring domain" : "Ignore domain", domainIgnored ? "Resume recording requests from this domain." : "Exclude new requests from this domain from capture.")}
                ${domainIgnored ? `data-active="true"` : ""}
              >
                ${domainIgnored ? "Stop ignoring domain" : "Ignore this domain"}
              </button>
            `
            : ""
        }
      </div>
      <p class="detailsUrl">${escapeHtml(record.url)}</p>
    </section>

    ${compareBaseline ? `<p class="comparisonLabel">Comparison A: ${escapeHtml(compareBaseline.method + " " + compareBaseline.url + " · " + compareBaseline.completedAt)}</p>` : ""}
    <section class="summaryGrid">
      <div><strong>Source</strong><span>${escapeHtml(record.source)}</span></div>
      <div><strong>Duration</strong><span>${record.durationMs ?? "-"}ms</span></div>
      <div><strong>MIME</strong><span>${escapeHtml(record.mimeType ?? "-")}</span></div>
      <div><strong>Page</strong><span>${escapeHtml(record.pageUrl ?? "-")}</span></div>
    </section>

    ${
      record.error
        ? `<section class="errorBox"><strong>Error</strong><p>${escapeHtml(record.error)}</p></section>`
        : ""
    }

    ${renderSection("Request Headers", "requestHeaders", JSON.stringify(record.requestHeaders, null, 2))}
    ${renderSection("Request Body", "requestBody", formatBody(record.requestBody))}
    ${renderSection("Response Headers", "responseHeaders", JSON.stringify(record.responseHeaders, null, 2))}
    ${renderSection("Response Body", "responseBody", formatBody(record.responseBody))}
  `
}

const renderSelectedEndpoint = (): string => {
  const group = groupRecordsByEndpoint(state.records).find(
    (entry) => entry.key === state.selectedEndpointKey,
  )

  if (!group) {
    return `<p class="empty">Select an endpoint group.</p>`
  }

  return `
    <section class="detailsHeader">
      <div>
        <h2>${escapeHtml(group.method)} ${escapeHtml(group.normalizedPath)}</h2>
      </div>
      <div class="detailsActions">
        <button id="copyEndpointMarkdown" type="button" ${tooltipAttributes("Copy Markdown", "Copy a Markdown summary of this endpoint.")}>Copy Markdown</button>
      </div>
      <p class="detailsUrl">${escapeHtml(group.origin)}</p>
    </section>

    <section class="summaryGrid">
      <div><strong>Observed calls</strong><span>${group.count}</span></div>
      <div><strong>Statuses</strong><span>${group.statuses.length ? group.statuses.join(", ") : "ERR"}</span></div>
      <div><strong>Average duration</strong><span>${group.averageDurationMs ?? "-"}ms</span></div>
      <div><strong>Last seen</strong><span>${escapeHtml(group.lastSeenAt)}</span></div>
    </section>

    <h3>Available Request Bodies</h3>
    ${
      detailLoading
        ? '<p class="empty">Loading samples…</p>'
        : detailError
          ? `<p class="empty">${escapeHtml(detailError)}</p>`
          : renderAvailableBodies(
              group.records.flatMap((record) => details.get(record.id) ?? []),
              (record) => record.requestBody,
            )
    }

    <h3>Available Response Bodies</h3>
    ${renderAvailableBodies(
      group.records.flatMap((record) => details.get(record.id) ?? []),
      (record) => record.responseBody,
    )}

    <h3>Observed Records</h3>
    <div class="miniList">
      ${group.records
        .slice(0, 25)
        .map(
          (record) => `
            <button class="miniRecord" data-id="${record.id}" type="button">
              <strong>${escapeHtml(formatStatus(record))}</strong>
              <span>${escapeHtml(record.source)}</span>
              <span>${escapeHtml(record.completedAt)}</span>
              <span>${record.durationMs ?? "-"}ms</span>
            </button>
          `,
        )
        .join("")}
    </div>
  `
}

// Reuse the scroll containers and rows so refreshes do not reset focus,
// text selection, or a native scroll animation already in progress.
const updateInspector = (html: string, layout: HTMLElement): void => {
  const template = document.createElement("template")
  template.innerHTML = html
  const nextLayout = template.content.querySelector<HTMLElement>(".layout")!
  const list = layout.querySelector<HTMLElement>(".list")!
  const nextList = nextLayout.querySelector<HTMLElement>(".list")!
  const existingRows = new Map(
    Array.from(list.querySelectorAll<HTMLElement>(".record"), (row) => [getListItemKey(row), row]),
  )
  const nextRows = Array.from(nextList.querySelectorAll<HTMLElement>(".record"))
  const nextKeys = new Set(nextRows.map(getListItemKey))
  for (const child of Array.from(list.children)) {
    if (!nextKeys.has(getListItemKey(child as HTMLElement))) child.remove()
  }
  let cursor = list.firstElementChild
  for (const nextRow of nextRows) {
    const key = getListItemKey(nextRow)
    const existing = existingRows.get(key)
    const row = existing ?? nextRow
    if (existing) {
      if (row.className !== nextRow.className) row.className = nextRow.className
      if (row.innerHTML !== nextRow.innerHTML) row.innerHTML = nextRow.innerHTML
    }
    if (row !== cursor) list.insertBefore(row, cursor)
    cursor = row.nextElementSibling
    if (!existing && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      row.animate(
        [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 240, easing: "ease-out" },
      )
    }
  }
  if (!nextRows.length && list.innerHTML !== nextList.innerHTML) {
    list.innerHTML = nextList.innerHTML
  }

  const panel = layout.querySelector<HTMLElement>(".details")!
  const nextPanel = nextLayout.querySelector<HTMLElement>(".details")!
  if (panel.innerHTML !== nextPanel.innerHTML) panel.innerHTML = nextPanel.innerHTML

  // The toolbar and filters are separate sections; changing a count must not
  // detach the list or the detail panel from the document.
  const nextSections = Array.from(template.content.children)
  const sectionClasses = new Set(nextSections.map((section) => section.className))
  for (const section of Array.from(app.children)) {
    if (!sectionClasses.has(section.className)) section.remove()
  }
  for (const nextSection of nextSections) {
    if (nextSection.className === "layout") continue
    const section = Array.from(app.children).find(
      (current) => current.className === nextSection.className,
    )
    if (!section) {
      const following = nextSections.slice(nextSections.indexOf(nextSection) + 1)
      const before = Array.from(app.children).find(
        (current) => following.some((next) => next.className === current.className),
      )
      app.insertBefore(nextSection, before ?? layout)
    } else if (section.innerHTML !== nextSection.innerHTML) {
      section.innerHTML = nextSection.innerHTML
    }
  }
}

const render = (options?: RenderOptions): void => {
  tooltips.beforeRender()
  const previousPanelScrollState = options?.preservePanelScroll ? getPanelScrollState() : null
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  const focusedId = focused?.id
  const selection =
    focused?.type === "search" ? ([focused.selectionStart, focused.selectionEnd] as const) : null

  if (state.error) {
    renderError(state.error)
    tooltips.refresh()
    return
  }

  if (state.loading) {
    renderLoading()
    tooltips.refresh()
    return
  }

  const html = `
    ${renderToolbar()}
    ${renderFilters()}

    <section class="layout">
      <aside class="list">
        ${state.view === "requests" ? renderRequestList() : renderEndpointList()}
      </aside>

      <section class="details">
        ${state.view === "requests" ? renderSelectedRequest() : renderSelectedEndpoint()}
      </section>
    </section>
  `

  const layout = document.querySelector<HTMLElement>(".layout")
  if (options?.preservePanelScroll && layout) updateInspector(html, layout)
  else app.innerHTML = html

  bindEvents()
  tooltips.refresh()
  if (focusedId) {
    const input = document.getElementById(focusedId) as HTMLInputElement | null
    if (input && input !== document.activeElement) input.focus({ preventScroll: true })
    if (input && selection) input.setSelectionRange(selection[0], selection[1])
  }

  if (previousPanelScrollState) {
    restorePanelScrollState(previousPanelScrollState)
  }
}

const reload = async (options?: { silent?: boolean; preserveSelection?: boolean }): Promise<void> => {
  const generation = ++reloadGeneration
  refreshInFlight++
  const recordsPromise = refreshRecords()
  try {
    const previousFingerprint = getRecordFingerprint(state.records)
    const previousSettings = JSON.stringify([
      state.listeningPaused,
      state.deepCaptureEnabled,
      state.ignoredDomains,
    ])

    if (!options?.silent) {
      state.loading = true
      state.error = null
      render()
    }

    const [settings, loadedRecords, sessions] = await Promise.all([
      getCaptureSettings(),
      recordsPromise,
      listSavedSessions(),
    ])
    if (generation !== reloadGeneration) return
    // Keep the current inspection available when live retention removes its records.
    // Explicit filter/session changes still use only the freshly queried records.
    const selectedRecords = options?.preserveSelection
      ? state.view === "requests"
        ? state.records.filter((record) => record.id === state.selectedRecordId)
        : groupRecordsByEndpoint(state.records).find(
            (group) => group.key === state.selectedEndpointKey,
          )?.records ?? []
      : []
    const selectedStillPresent = state.view === "requests"
      ? loadedRecords.some((record) => record.id === state.selectedRecordId)
      : groupRecordsByEndpoint(loadedRecords).some(
          (group) => group.key === state.selectedEndpointKey,
        )
    const nextRecords: NetworkRecordPreview[] = selectedStillPresent
      ? loadedRecords
      : mergeRetainedRecords(loadedRecords, selectedRecords as NetworkRecordPreview[])
    const sessionsChanged = JSON.stringify(state.sessions) !== JSON.stringify(sessions)
    state.sessions = sessions
    const nextFingerprint = getRecordFingerprint(nextRecords)
    state.listeningPaused = settings.capturePaused
    state.deepCaptureEnabled = settings.deepCaptureEnabled
    state.ignoredDomains = settings.ignoredDomains

    const settingsChanged =
      previousSettings !==
      JSON.stringify([state.listeningPaused, state.deepCaptureEnabled, state.ignoredDomains])
    if (
      options?.silent &&
      previousFingerprint === nextFingerprint &&
      !settingsChanged &&
      !sessionsChanged &&
      !state.loading &&
      !state.error
    ) {
      return
    }

    state.records = nextRecords
    for (const [id, record] of details) {
      if (!nextRecords.some((item) => item.id === id && item.completedAt === record.completedAt))
        details.delete(id)
    }

    if (
      state.selectedRecordId &&
      !state.records.some((record) => record.id === state.selectedRecordId)
    ) {
      state.selectedRecordId = null
    }

    if (
      state.selectedEndpointKey &&
      !groupRecordsByEndpoint(state.records).some(
        (group) => group.key === state.selectedEndpointKey,
      )
    ) {
      state.selectedEndpointKey = null
    }

    state.loading = false
    state.error = null
    render({
      preservePanelScroll: Boolean(options?.silent),
    })
    if (state.selectedRecordId || state.selectedEndpointKey)
      void loadSelectedDetails({ renderInitial: false })
  } catch (error) {
    if (generation !== reloadGeneration) return
    if (options?.silent) {
      console.warn("[API Network Recorder] Silent refresh failed.", error)
      return
    }

    state.loading = false
    state.error = error instanceof Error ? error.message : String(error)
    render()
  } finally {
    refreshInFlight--
  }
}

const scheduleAutoRefresh = (): void => {
  window.setInterval(() => {
    if (
      refreshInFlight > 0 ||
      Boolean(state.sessionId) ||
      state.listeningPaused ||
      document.hidden ||
      state.loading ||
      state.error ||
      isEditingFilters() ||
      hasActiveSelection()
    ) {
      return
    }

    void reload({ silent: true, preserveSelection: true })
  }, AUTO_REFRESH_INTERVAL_MS)
}

const boundControls = new WeakSet<Element>()
const unboundControls = {
  querySelector<T extends Element = Element>(selector: string): T | null {
    const element = document.querySelector<T>(selector)
    if (!element || boundControls.has(element)) return null
    boundControls.add(element)
    return element
  },
  querySelectorAll<T extends Element = Element>(selector: string): T[] {
    return Array.from(document.querySelectorAll<T>(selector)).filter((element) => {
      if (boundControls.has(element)) return false
      boundControls.add(element)
      return true
    })
  },
}

const bindEvents = (): void => {
  unboundControls.querySelector("#dismissNotice")?.addEventListener("click", () => {
    state.notice = null
    render({ preservePanelScroll: true })
  })
  unboundControls.querySelector("#sessionName")?.addEventListener("input", (event) => {
    state.sessionName = (event.target as HTMLInputElement).value
  })
  unboundControls.querySelector("#curlShell")?.addEventListener("change", (event) => {
    state.curlShell = (event.target as HTMLSelectElement).value as CurlShell
  })
  unboundControls.querySelector("#sessionSelect")?.addEventListener("change", (event) => {
    state.sessionId = (event.target as HTMLSelectElement).value
    state.selectedRecordId = null
    state.selectedEndpointKey = null
    details.clear()
    detailGeneration++
    void reload()
  })
  unboundControls.querySelector("#saveSession")?.addEventListener("click", (event) => {
    void runAction(event, async () => {
      const session = await saveSession(
        state.sessionName,
        state.records.map((record) => record.id),
        state.sessionId || undefined,
      )
      state.sessionName = ""
      state.notice = "Saved “" + session.name + "” with " + session.count + " requests."
      await reload()
    })
  })
  unboundControls.querySelector("#deleteSession")?.addEventListener("click", (event) => {
    const sessionId = state.sessionId
    if (!sessionId || !window.confirm("Delete this saved session? This cannot be undone.")) return
    void runAction(event, async () => {
      await deleteSavedSession(sessionId)
      state.sessionId = ""
      details.clear()
      detailGeneration++
      state.selectedRecordId = null
      state.selectedEndpointKey = null
      await reload()
    })
  })
  unboundControls.querySelectorAll<HTMLButtonElement>(".recordCopyUrl").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      const record = state.records.find((item) => item.id === button.dataset.recordId)
      if (record)
        void runAction(event, async () => {
          await copyText(record.url)
          flashCopied(button)
        })
    })
  })
  unboundControls.querySelectorAll<HTMLButtonElement>(".recordPin").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      if (state.sessionId) return
      const record = state.records.find((item) => item.id === button.dataset.recordId)
      if (record)
        void runAction(event, async () => {
          await setNetworkRecordPinned(record.id, !record.pinned)
          await reload({ silent: true })
        })
    })
  })
  unboundControls.querySelectorAll<HTMLButtonElement>(".recordDelete").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation()
      const id = button.dataset.recordId
      const sessionId = state.sessionId
      if (!id) return
      void runAction(event, async () => {
        await deleteNetworkRecord(id, sessionId || undefined)
        if (sessionId === state.sessionId) {
          // Discard pending reads that could restore the deleted record or its details.
          reloadGeneration++
          detailGeneration++
          state.records = state.records.filter((record) => record.id !== id)
          details.delete(id)
          if (state.selectedRecordId === id) state.selectedRecordId = null
          if (compareBaseline?.id === id) compareBaseline = null
          detailError = null
          detailLoading = false
          render({ preservePanelScroll: true })
          if (state.selectedRecordId) void loadSelectedDetails({ renderInitial: false })
        }
        await reload({ silent: true })
      })
    })
  })
  unboundControls.querySelector("#setBaseline")?.addEventListener("click", () => {
    compareBaseline = selectedRecord() ?? null
    render({ preservePanelScroll: true })
  })
  unboundControls.querySelector("#clearBaseline")?.addEventListener("click", () => {
    compareBaseline = null
    render({ preservePanelScroll: true })
  })
  unboundControls.querySelector("#compareRequest")?.addEventListener("click", () => {
    const record = selectedRecord()
    if (record && compareBaseline) showComparison(compareBaseline, record)
  })
  unboundControls.querySelector("#captureTabs")?.addEventListener("click", () => {
    void showCaptureTabs()
  })
  unboundControls.querySelector("#openAgent")?.addEventListener("click", () => {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL("agent.html") })
      .catch((error: unknown) => {
        state.notice = error instanceof Error ? error.message : String(error)
        render({ preservePanelScroll: true })
      })
  })

  unboundControls.querySelector("#toggleListening")?.addEventListener("click", () => {
    const nextPaused = !state.listeningPaused

    state.listeningPaused = nextPaused
    render({
      preservePanelScroll: true,
    })

    void setCaptureSettings({
      capturePaused: nextPaused,
      captureActiveSince: nextPaused ? null : new Date().toISOString(),
    })
      .then(() => {
        if (!nextPaused) {
          void reload({ silent: true })
        }
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error)
        render()
      })
  })

  unboundControls.querySelector("#refresh")?.addEventListener("click", () => {
    void reload({ silent: false })
  })

  unboundControls.querySelector("#toggleDeepCapture")?.addEventListener("click", () => {
    const nextEnabled = !state.deepCaptureEnabled

    state.deepCaptureBusy = true
    state.deepCaptureEnabled = nextEnabled
    state.notice = null
    render({
      preservePanelScroll: true,
    })

    void sendMessage<null>({
      type: nextEnabled ? "START_DEBUGGER_CAPTURE_ALL" : "STOP_DEBUGGER_CAPTURE",
    })
      .then(async () => {
        state.deepCaptureBusy = false
        render({ preservePanelScroll: true })
        await reload({ silent: true })
      })
      .catch((error: unknown) => {
        state.deepCaptureBusy = false
        state.deepCaptureEnabled = !nextEnabled
        const message = error instanceof Error ? error.message : String(error)
        state.notice = `Could not ${nextEnabled ? "start" : "stop"} deep capture: ${message} Check Tab status for details.`
        render({ preservePanelScroll: true })
      })
  })

  unboundControls.querySelector("#clear")?.addEventListener("click", (event) => {
    void runAction(event, async () => {
      // Drop the open inspection before touching the database: a refresh or a
      // detail load already in flight would otherwise carry the selected
      // record back into the list after it has been cleared.
      reloadGeneration++
      detailGeneration++
      state.selectedRecordId = null
      state.selectedEndpointKey = null
      state.records = []
      details.clear()
      compareBaseline = null
      detailError = null
      detailLoading = false

      await clearNetworkRecords()
      await reload({ silent: false })
    })
  })

  unboundControls.querySelector("#exportJson")?.addEventListener("click", (event) => {
    void runAction(event, async () =>
      downloadText(
        "api-network-records.json",
        JSON.stringify(await visibleRecords(), null, 2),
        "application/json",
      ),
    )
  })
  unboundControls.querySelector("#exportMarkdown")?.addEventListener("click", (event) => {
    void runAction(event, async () =>
      downloadText(
        "observed-api.md",
        exportEndpointMarkdown(groupRecordsByEndpoint(await visibleRecords())),
        "text/markdown",
      ),
    )
  })
  unboundControls.querySelector("#exportOpenApi")?.addEventListener("click", () => {
    const groups = groupRecordsByEndpoint(state.records)
    const origins = [...new Set(groups.map((group) => group.origin))]
    const sessionId = state.sessionId
    const dialog = showDialog(
      "Export OpenAPI",
      '<p>Download a separate document for each API origin. Exports include the current filters.</p><div class="dialogActions">' +
        origins
          .map(
            (origin, index) =>
              '<button type="button" data-origin="' +
              index +
              '">' +
              escapeHtml(origin) +
              "</button>",
          )
          .join("") +
        (origins.length ? "" : "<p>No requests to export.</p>") +
        "</div>",
    )
    dialog.querySelectorAll<HTMLButtonElement>("[data-origin]").forEach((button) =>
      button.addEventListener("click", (event) => {
        void runAction(event, async () => {
          const origin = origins[Number(button.dataset.origin)]!
          const ids = groups
            .filter((group) => group.origin === origin)
            .flatMap((group) => group.records.map((record) => record.id))
          const records = await getNetworkRecordsByIds(ids, sessionId || undefined)
          downloadText(
            "openapi-" + origin.replace(/[^a-z0-9.-]/gi, "_") + ".json",
            exportOpenApiDraft(groupRecordsByEndpoint(records)),
            "application/json",
          )
        })
      }),
    )
  })

  unboundControls.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view === "endpoints" ? "endpoints" : "requests"
      render()
      void loadSelectedDetails({ renderInitial: false })
    })
  })

  unboundControls.querySelector("#search")?.addEventListener("input", (event) => {
    state.search = event.target instanceof HTMLInputElement ? event.target.value : ""
    reloadGeneration++
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      void reload({ silent: true })
    }, 300)
  })

  unboundControls.querySelector("#method")?.addEventListener("change", (event) => {
    state.method = event.target instanceof HTMLSelectElement ? event.target.value : "ALL"
    void reload({ silent: true })
  })

  unboundControls.querySelector("#statusGroup")?.addEventListener("change", (event) => {
    state.statusGroup =
      event.target instanceof HTMLSelectElement
        ? (event.target.value as AppState["statusGroup"])
        : "all"
    void reload({ silent: true })
  })

  unboundControls.querySelector("#source")?.addEventListener("change", (event) => {
    state.source =
      event.target instanceof HTMLSelectElement ? (event.target.value as AppState["source"]) : "all"
    void reload({ silent: true })
  })

  unboundControls.querySelector("#host")?.addEventListener("change", (event) => {
    state.host = event.target instanceof HTMLSelectElement ? event.target.value : ""
    void reload({ silent: true })
  })

  unboundControls.querySelector("#apiOnly")?.addEventListener("change", (event) => {
    state.apiOnly = event.target instanceof HTMLInputElement ? event.target.checked : true
    void reload({ silent: true })
  })

  unboundControls.querySelectorAll<HTMLElement>(".record[data-id]").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedRecordId = item.dataset.id ?? null
      void loadSelectedDetails()
    })
  })

  unboundControls.querySelectorAll<HTMLElement>(".record[data-endpoint-key]").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedEndpointKey = item.dataset.endpointKey ?? null
      void loadSelectedDetails()
    })
  })

  unboundControls.querySelectorAll<HTMLButtonElement>(".miniRecord").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedRecordId = button.dataset.id ?? null
      state.view = "requests"
      void loadSelectedDetails()
    })
  })

  unboundControls
    .querySelector<HTMLButtonElement>("#toggleIgnoreDomain")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement
      const domain = button.dataset.domain

      if (!domain) {
        return
      }

      const ignoredDomains = state.ignoredDomains.includes(domain)
        ? state.ignoredDomains.filter((item) => item !== domain)
        : Array.from(new Set([...state.ignoredDomains, domain]))

      const settings = await setCaptureSettings({ ignoredDomains })

      state.ignoredDomains = settings.ignoredDomains
      render({ preservePanelScroll: true })
    })

  unboundControls
    .querySelector<HTMLButtonElement>("#copyDomain")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLElement
      const record = selectedRecord()

      if (record) {
        await copyText(getHost(record.url))
        flashCopied(button)
      }
    })

  unboundControls
    .querySelector<HTMLButtonElement>("#copyCurl")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLElement
      const record = selectedRecord()

      if (record) {
        await copyText(recordToCurl(record, state.curlShell))
        flashCopied(button)
      }
    })

  unboundControls
    .querySelector<HTMLButtonElement>("#copyResponse")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLElement
      const record = selectedRecord()

      if (record) {
        await copyText(formatBody(record.responseBody))
        flashCopied(button)
      }
    })

  unboundControls.querySelectorAll<HTMLButtonElement>(".copySection").forEach((button) => {
    button.addEventListener("click", async () => {
      const record = selectedRecord()

      if (!record) {
        return
      }

      const copyKey = button.dataset.copyKey
      const sectionTextByKey: Record<string, string> = {
        requestHeaders: JSON.stringify(record.requestHeaders, null, 2),
        requestBody: formatBody(record.requestBody),
        responseHeaders: JSON.stringify(record.responseHeaders, null, 2),
        responseBody: formatBody(record.responseBody),
      }
      const text = copyKey ? sectionTextByKey[copyKey] : undefined

      if (typeof text !== "string") {
        return
      }

      await copyText(text)
      flashCopied(button)
    })
  })

  unboundControls
    .querySelector<HTMLButtonElement>("#copyEndpointMarkdown")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLElement
      const group = groupRecordsByEndpoint(state.records).find(
        (entry) => entry.key === state.selectedEndpointKey,
      )

      if (group) {
        await copyText(
          exportEndpointMarkdown(
            groupRecordsByEndpoint(
              await getNetworkRecordsByIds(
                group.records.map((record) => record.id),
                state.sessionId || undefined,
              ),
            ),
          ),
        )
        flashCopied(button)
      }
    })
}

const visibleRecords = () =>
  getNetworkRecordsByIds(
    state.records.map((record) => record.id),
    state.sessionId || undefined,
  )

const runAction = async (event: Event, action: () => Promise<void>): Promise<void> => {
  const button = event.currentTarget as HTMLButtonElement | null
  if (button) button.disabled = true
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const dialog = button?.closest("dialog")
    if (dialog) {
      let notice = dialog.querySelector(".dialogError")
      if (!notice) {
        notice = document.createElement("p")
        notice.className = "dialogError"
        notice.setAttribute("role", "alert")
        dialog.append(notice)
      }
      notice.textContent = message
    } else {
      state.notice = message
      render({ preservePanelScroll: true })
    }
  } finally {
    if (button?.isConnected) button.disabled = false
  }
}

const showDialog = (title: string, content: string): HTMLDialogElement => {
  const dialog = document.createElement("dialog")
  dialog.className = "inspectorDialog"
  dialog.setAttribute("aria-label", title)
  dialog.innerHTML =
    '<div class="dialogHeader"><h2>' +
    escapeHtml(title) +
    '</h2><button type="button" class="closeDialog">Close</button></div>' +
    content
  document.body.append(dialog)
  dialog.querySelector(".closeDialog")?.addEventListener("click", () => dialog.close())
  dialog.addEventListener("close", () => dialog.remove(), { once: true })
  dialog.showModal()
  return dialog
}

const showComparison = (before: NetworkRecord, after: NetworkRecord): void => {
  const result = compareRecords(before, after)
  const format = (value: unknown) =>
    value === undefined
      ? "(absent)"
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2)
  showDialog(
    "Compare requests",
    '<p class="detailsUrl">A: ' +
      escapeHtml(before.method + " " + before.url + " \u00B7 " + before.completedAt) +
      '</p><p class="detailsUrl">B: ' +
      escapeHtml(after.method + " " + after.url + " \u00B7 " + after.completedAt) +
      "</p>" +
      (result.differences.length
        ? '<table class="diffTable"><thead><tr><th>Field / change</th><th>A</th><th>B</th></tr></thead><tbody>' +
          result.differences
            .map(
              (item) =>
                '<tr class="diff-' +
                item.kind +
                '"><th scope="row">' +
                escapeHtml(item.path) +
                "<small>" +
                item.kind +
                "</small></th><td><pre>" +
                escapeHtml(format(item.before)) +
                "</pre></td><td><pre>" +
                escapeHtml(format(item.after)) +
                "</pre></td></tr>",
            )
            .join("") +
          "</tbody></table>"
        : '<p class="empty">No differences in request or response data.</p>') +
      (result.truncated ? "<p>Showing the first 1,000 differences.</p>" : ""),
  )
}

const showCaptureTabs = async (): Promise<void> => {
  const dialog = showDialog(
    "Deep capture by tab",
    '<p>Global capture applies to eligible tabs and respects exclusions.</p><button class="refreshTabs" type="button">Refresh status</button><div class="tabStatusList" aria-live="polite">Loading\u2026</div>',
  )
  const content = dialog.querySelector(".tabStatusList")!
  let busy = false
  const update = async () => {
    if (busy || !dialog.open) return
    busy = true
    try {
      const tabs = await withTimeout(
        sendMessage<CaptureTabStatus[]>({ type: "GET_CAPTURE_TABS_STATUS" }),
        8000,
        "Tab status",
      )
      if (!dialog.open) return
      content.innerHTML =
        tabs
          .map(
            (tab) =>
              '<article class="tabStatus"><strong>' +
              escapeHtml(tab.title) +
              '</strong><span class="captureState state-' +
              tab.state +
              '">' +
              escapeHtml(tab.state) +
              "</span><p>" +
              escapeHtml(tab.url) +
              "</p><p>" +
              escapeHtml(tab.reason) +
              "</p></article>",
          )
          .join("") || "<p>No tabs.</p>"
    } catch (error) {
      if (dialog.open) content.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      busy = false
    }
  }
  dialog.querySelector(".refreshTabs")?.addEventListener("click", () => {
    void update()
  })
  const timer = window.setInterval(() => {
    void update()
  }, 2000)
  dialog.addEventListener("close", () => window.clearInterval(timer), { once: true })
  await update()
}

const loadSelectedDetails = async (options?: { renderInitial?: boolean }): Promise<void> => {
  const generation = ++detailGeneration
  const sessionId = state.sessionId
  const group =
    state.view === "endpoints"
      ? groupRecordsByEndpoint(state.records).find((item) => item.key === state.selectedEndpointKey)
      : undefined
  const candidates = group
    ? [
        ...group.records
          .filter((item) => (item as NetworkRecordPreview).hasRequestBody)
          .slice(0, 10),
        ...group.records
          .filter((item) => (item as NetworkRecordPreview).hasResponseBody)
          .slice(0, 10),
        ...group.records.slice(0, 1),
      ]
    : state.records.filter((item) => item.id === state.selectedRecordId)
  const ids = [...new Set(candidates.map((record) => record.id))]
  const missing = ids.filter((id) => !details.has(id))
  details = new Map([...details].filter(([id]) => ids.includes(id)))
  detailLoading = missing.length > 0
  detailError = null
  if (options?.renderInitial !== false) render({ preservePanelScroll: true })
  if (!missing.length) return
  try {
    const records = await withTimeout(
      getNetworkRecordsByIds(missing, sessionId || undefined),
      RECORD_LOAD_TIMEOUT_MS,
      "Request details",
    )
    if (generation !== detailGeneration || sessionId !== state.sessionId) return
    for (const record of records) details.set(record.id, record)
  } catch (error) {
    if (generation !== detailGeneration) return
    detailError = error instanceof Error ? error.message : String(error)
  } finally {
    if (generation === detailGeneration) {
      detailLoading = false
      render({ preservePanelScroll: true })
    }
  }
}

void reload({ silent: false }).then(() => {
  scheduleAutoRefresh()
})
