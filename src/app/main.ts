import {
  exportEndpointMarkdown,
  exportOpenApiDraft,
  groupRecordsByEndpoint,
  hasCapturedBody,
  isProbablyApiRecord,
} from "../core/endpoint-utils.js"
import { recordToCurl } from "../core/export-curl.js"
import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { CapturedBody, NetworkRecord } from "../core/network-types.js"
import { getCaptureSettings, setCaptureSettings } from "../storage/capture-settings.js"
import { resetDb } from "../storage/db.js"
import { clearNetworkRecords, listNetworkRecords } from "../storage/network-record-repository.js"

import "./app.css"

const AUTO_REFRESH_INTERVAL_MS = 2_000
const RECORD_LOAD_TIMEOUT_MS = 30_000

const app = document.querySelector("#app")

if (!app) {
  throw new Error("Missing #app")
}

interface AppState {
  records: NetworkRecord[]
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
}

interface ListAnchor {
  pinnedToTop: boolean
  anchorKey: string | null
  anchorOffset: number
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
}

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

  return `
    <button
      id="${id}"
      class="${classes}"
      type="button"
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
    return { pinnedToTop: true, anchorKey: null, anchorOffset: 0 }
  }

  const pinnedToTop = list.scrollTop <= LIST_TOP_PIN_THRESHOLD_PX
  const containerTop = list.getBoundingClientRect().top

  for (const item of list.querySelectorAll<HTMLElement>("[data-id], [data-endpoint-key]")) {
    const itemTop = item.getBoundingClientRect().top

    if (itemTop >= containerTop) {
      return {
        pinnedToTop,
        anchorKey: getListItemKey(item),
        anchorOffset: itemTop - containerTop,
      }
    }
  }

  return { pinnedToTop, anchorKey: null, anchorOffset: 0 }
}

const restoreListAnchor = (anchor: ListAnchor): void => {
  const list = document.querySelector<HTMLElement>(".list")

  if (!list || !anchor.anchorKey) {
    return
  }

  const target = findListItem(list, anchor.anchorKey)

  if (!target) {
    return
  }

  const containerTop = list.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top

  // Jump instantly to keep the previously-anchored record exactly where it
  // was (invisible to the user), then glide the rest of the way to reveal
  // any newly captured records above it — only when the user was already
  // pinned near the top, same as a chat autoscrolling to new messages.
  list.scrollTop += targetTop - containerTop - anchor.anchorOffset

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
  window.requestAnimationFrame(() => {
    restoreListAnchor(scrollState.listAnchor)

    const details = document.querySelector<HTMLElement>(".details")

    if (details) {
      details.scrollTop = scrollState.detailsScrollTop
    }
  })
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
      <button class="copySection" data-copy-key="${escapeHtml(copyKey)}" type="button">Copy</button>
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
  return records.map((record) => `${record.id}:${record.completedAt}`).join("|")
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
    selection && !selection.isCollapsed && selection.anchorNode && app.contains(selection.anchorNode),
  )
}

const refreshRecords = async (): Promise<NetworkRecord[]> => {
  return await withTimeout(
    listNetworkRecords({
      limit: 2000,
      search: state.search,
      method: state.method,
      statusGroup: state.statusGroup,
      source: state.source,
      host: state.host,
      apiOnly: state.apiOnly,
    }),
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
          ${renderActionButton("clear", "Clear", "trash", { className: "danger" })}
        </div>

        <div class="actionRow exportActions">
          ${renderActionButton("exportJson", "Export JSON", "braces")}
          ${renderActionButton("exportMarkdown", "Export Markdown", "file")}
          ${renderActionButton("exportOpenApi", "Export OpenAPI", "download")}
        </div>
      </div>
    </header>

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
        <article class="record ${state.selectedRecordId === record.id ? "selected" : ""}" data-id="${record.id}">
          <div class="recordMeta">
            <strong>${escapeHtml(record.method)}</strong>
            <span class="${getStatusClass(record)}">${escapeHtml(formatStatus(record))}</span>
            <span>${escapeHtml(record.source)}</span>
            <span>${record.durationMs ?? "-"}ms</span>
          </div>
          <div class="host">${escapeHtml(getHost(record.url))}</div>
          <div class="url">${escapeHtml(getPath(record.url))}</div>
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
          <div class="url">${escapeHtml(group.normalizedPath)}</div>
        </article>
      `,
    )
    .join("")
}

const renderSelectedRequest = (): string => {
  const record = state.records.find((entry) => entry.id === state.selectedRecordId)

  if (!record) {
    return `<p class="empty">Select a request.</p>`
  }

  return `
    <section class="detailsHeader">
      <div>
        <h2>${escapeHtml(record.method)} ${escapeHtml(formatStatus(record))}</h2>
        <p class="detailsUrl">${escapeHtml(record.url)}</p>
      </div>
      <div class="detailsActions">
        <button id="copyDomain" type="button">Copy domain</button>
        <button id="copyCurl" type="button">Copy cURL</button>
        <button id="copyResponse" type="button">Copy response</button>
      </div>
    </section>

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
        <p class="detailsUrl">${escapeHtml(group.origin)}</p>
      </div>
      <div class="detailsActions">
        <button id="copyEndpointMarkdown" type="button">Copy Markdown</button>
      </div>
    </section>

    <section class="summaryGrid">
      <div><strong>Observed calls</strong><span>${group.count}</span></div>
      <div><strong>Statuses</strong><span>${group.statuses.length ? group.statuses.join(", ") : "ERR"}</span></div>
      <div><strong>Average duration</strong><span>${group.averageDurationMs ?? "-"}ms</span></div>
      <div><strong>Last seen</strong><span>${escapeHtml(group.lastSeenAt)}</span></div>
    </section>

    <h3>Available Request Bodies</h3>
    ${renderAvailableBodies(group.records, (record) => record.requestBody)}

    <h3>Available Response Bodies</h3>
    ${renderAvailableBodies(group.records, (record) => record.responseBody)}

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

const render = (options?: RenderOptions): void => {
  const previousPanelScrollState = options?.preservePanelScroll ? getPanelScrollState() : null

  if (state.error) {
    renderError(state.error)
    return
  }

  if (state.loading) {
    renderLoading()
    return
  }

  app.innerHTML = `
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

  bindEvents()

  if (previousPanelScrollState) {
    restorePanelScrollState(previousPanelScrollState)
  }
}

const reload = async (options?: { silent?: boolean }): Promise<void> => {
  try {
    const previousFingerprint = getRecordFingerprint(state.records)

    if (!options?.silent) {
      state.loading = true
      state.error = null
      render()
    }

    const settings = await getCaptureSettings()
    const nextRecords = await refreshRecords()
    const nextFingerprint = getRecordFingerprint(nextRecords)
    state.listeningPaused = settings.capturePaused
    state.deepCaptureEnabled = settings.deepCaptureEnabled

    if (options?.silent && previousFingerprint === nextFingerprint) {
      return
    }

    state.records = nextRecords

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
  } catch (error) {
    if (options?.silent) {
      console.warn("[API Network Recorder] Silent refresh failed.", error)
      return
    }

    state.loading = false
    state.error = error instanceof Error ? error.message : String(error)
    render()
  }
}

const scheduleAutoRefresh = (): void => {
  window.setInterval(() => {
    if (
      state.listeningPaused ||
      document.hidden ||
      state.loading ||
      state.error ||
      isEditingFilters() ||
      hasActiveSelection()
    ) {
      return
    }

    void reload({ silent: true })
  }, AUTO_REFRESH_INTERVAL_MS)
}

const bindEvents = (): void => {
  document.querySelector("#toggleListening")?.addEventListener("click", () => {
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

  document.querySelector("#refresh")?.addEventListener("click", () => {
    void reload({ silent: false })
  })

  document.querySelector("#toggleDeepCapture")?.addEventListener("click", () => {
    const nextEnabled = !state.deepCaptureEnabled

    state.deepCaptureBusy = true
    state.deepCaptureEnabled = nextEnabled
    render({
      preservePanelScroll: true,
    })

    void sendMessage<null>({
      type: nextEnabled ? "START_DEBUGGER_CAPTURE_ALL" : "STOP_DEBUGGER_CAPTURE",
    })
      .then(async () => {
        state.deepCaptureBusy = false
        await reload({ silent: true })
      })
      .catch((error: unknown) => {
        state.deepCaptureBusy = false
        state.deepCaptureEnabled = !nextEnabled
        state.error = error instanceof Error ? error.message : String(error)
        render()
      })
  })

  document.querySelector("#clear")?.addEventListener("click", async () => {
    await clearNetworkRecords()

    state.selectedRecordId = null
    state.selectedEndpointKey = null
    await reload({ silent: false })
  })

  document.querySelector("#exportJson")?.addEventListener("click", () => {
    downloadText(
      "api-network-records.json",
      JSON.stringify(state.records, null, 2),
      "application/json",
    )
  })

  document.querySelector("#exportMarkdown")?.addEventListener("click", () => {
    downloadText(
      "observed-api.md",
      exportEndpointMarkdown(groupRecordsByEndpoint(state.records)),
      "text/markdown",
    )
  })

  document.querySelector("#exportOpenApi")?.addEventListener("click", () => {
    downloadText(
      "openapi-draft.json",
      exportOpenApiDraft(groupRecordsByEndpoint(state.records)),
      "application/json",
    )
  })

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view === "endpoints" ? "endpoints" : "requests"
      render()
    })
  })

  document.querySelector("#search")?.addEventListener("input", (event) => {
    state.search = event.target instanceof HTMLInputElement ? event.target.value : ""
    void reload({ silent: true })
  })

  document.querySelector("#method")?.addEventListener("change", (event) => {
    state.method = event.target instanceof HTMLSelectElement ? event.target.value : "ALL"
    void reload({ silent: true })
  })

  document.querySelector("#statusGroup")?.addEventListener("change", (event) => {
    state.statusGroup =
      event.target instanceof HTMLSelectElement
        ? (event.target.value as AppState["statusGroup"])
        : "all"
    void reload({ silent: true })
  })

  document.querySelector("#source")?.addEventListener("change", (event) => {
    state.source =
      event.target instanceof HTMLSelectElement ? (event.target.value as AppState["source"]) : "all"
    void reload({ silent: true })
  })

  document.querySelector("#host")?.addEventListener("change", (event) => {
    state.host = event.target instanceof HTMLSelectElement ? event.target.value : ""
    void reload({ silent: true })
  })

  document.querySelector("#apiOnly")?.addEventListener("change", (event) => {
    state.apiOnly = event.target instanceof HTMLInputElement ? event.target.checked : true
    void reload({ silent: true })
  })

  document.querySelectorAll<HTMLElement>(".record[data-id]").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedRecordId = item.dataset.id ?? null
      render()
    })
  })

  document.querySelectorAll<HTMLElement>(".record[data-endpoint-key]").forEach((item) => {
    item.addEventListener("click", () => {
      state.selectedEndpointKey = item.dataset.endpointKey ?? null
      render()
    })
  })

  document.querySelectorAll<HTMLButtonElement>(".miniRecord").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedRecordId = button.dataset.id ?? null
      state.view = "requests"
      render()
    })
  })

  document.querySelector<HTMLButtonElement>("#copyDomain")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLElement
    const record = state.records.find((entry) => entry.id === state.selectedRecordId)

    if (record) {
      await copyText(getHost(record.url))
      flashCopied(button)
    }
  })

  document.querySelector<HTMLButtonElement>("#copyCurl")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLElement
    const record = state.records.find((entry) => entry.id === state.selectedRecordId)

    if (record) {
      await copyText(recordToCurl(record))
      flashCopied(button)
    }
  })

  document.querySelector<HTMLButtonElement>("#copyResponse")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLElement
    const record = state.records.find((entry) => entry.id === state.selectedRecordId)

    if (record) {
      await copyText(formatBody(record.responseBody))
      flashCopied(button)
    }
  })

  document.querySelectorAll<HTMLButtonElement>(".copySection").forEach((button) => {
    button.addEventListener("click", async () => {
      const record = state.records.find((entry) => entry.id === state.selectedRecordId)

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

  document
    .querySelector<HTMLButtonElement>("#copyEndpointMarkdown")
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLElement
      const group = groupRecordsByEndpoint(state.records).find(
        (entry) => entry.key === state.selectedEndpointKey,
      )

      if (group) {
        await copyText(exportEndpointMarkdown([group]))
        flashCopied(button)
      }
    })
}

void reload({ silent: false }).then(() => {
  scheduleAutoRefresh()
})
