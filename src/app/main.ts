import {
  exportEndpointMarkdown,
  exportOpenApiDraft,
  groupRecordsByEndpoint,
  hasCapturedBody,
  isProbablyApiRecord,
} from "../core/endpoint-utils.js"
import { recordToCurl } from "../core/export-curl.js"
import type { CapturedBody, NetworkRecord } from "../core/network-types.js"
import { resetDb } from "../storage/db.js"
import { clearNetworkRecords, listNetworkRecords } from "../storage/network-record-repository.js"

import "./app.css"

const AUTO_REFRESH_INTERVAL_MS = 2_000

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
}

interface PanelScrollState {
  listScrollTop: number
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
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
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

const getPanelScrollState = (): PanelScrollState => {
  const list = document.querySelector<HTMLElement>(".list")
  const details = document.querySelector<HTMLElement>(".details")

  return {
    listScrollTop: list?.scrollTop ?? 0,
    detailsScrollTop: details?.scrollTop ?? 0,
  }
}

const restorePanelScrollState = (scrollState: PanelScrollState): void => {
  window.requestAnimationFrame(() => {
    const list = document.querySelector<HTMLElement>(".list")
    const details = document.querySelector<HTMLElement>(".details")

    if (list) {
      list.scrollTop = scrollState.listScrollTop
    }

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
    return `[Binary body: ${body.sizeBytes} bytes base64]`
  }

  return body.value
}

const formatRecordLabel = (record: NetworkRecord): string => {
  return `${formatStatus(record)} ${record.source} ${record.completedAt}`
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
    7000,
    "IndexedDB read",
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

  return `
    <header class="topbar">
      <div>
        <h1>API Network Recorder</h1>
        <p>${state.records.length} records · ${apiRecords.length} API-like · ${endpointGroups.length} endpoints · ${listenStatusLabel}</p>
      </div>

      <div class="topbarActions">
        <button id="toggleListening" type="button">${listenButtonLabel}</button>
        <button id="refresh" type="button">Refresh</button>
        <button id="exportJson" type="button">Export JSON</button>
        <button id="exportMarkdown" type="button">Export Markdown</button>
        <button id="exportOpenApi" type="button">Export OpenAPI</button>
        <button id="clear" type="button" class="danger">Clear</button>
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

    <h3>Request Headers</h3>
    <pre>${escapeHtml(JSON.stringify(record.requestHeaders, null, 2))}</pre>

    <h3>Request Body</h3>
    <pre>${escapeHtml(formatBody(record.requestBody))}</pre>

    <h3>Response Headers</h3>
    <pre>${escapeHtml(JSON.stringify(record.responseHeaders, null, 2))}</pre>

    <h3>Response Body</h3>
    <pre>${escapeHtml(formatBody(record.responseBody))}</pre>
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

    const nextRecords = await refreshRecords()
    const nextFingerprint = getRecordFingerprint(nextRecords)

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
      isEditingFilters()
    ) {
      return
    }

    void reload({ silent: true })
  }, AUTO_REFRESH_INTERVAL_MS)
}

const bindEvents = (): void => {
  document.querySelector("#toggleListening")?.addEventListener("click", () => {
    state.listeningPaused = !state.listeningPaused

    if (state.listeningPaused) {
      render({
        preservePanelScroll: true,
      })
      return
    }

    void reload({ silent: true })
  })

  document.querySelector("#refresh")?.addEventListener("click", () => {
    void reload({ silent: false })
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

  document.querySelector("#copyCurl")?.addEventListener("click", async () => {
    const record = state.records.find((entry) => entry.id === state.selectedRecordId)

    if (record) {
      await copyText(recordToCurl(record))
    }
  })

  document.querySelector("#copyResponse")?.addEventListener("click", async () => {
    const record = state.records.find((entry) => entry.id === state.selectedRecordId)

    if (record) {
      await copyText(formatBody(record.responseBody))
    }
  })

  document.querySelector("#copyEndpointMarkdown")?.addEventListener("click", async () => {
    const group = groupRecordsByEndpoint(state.records).find(
      (entry) => entry.key === state.selectedEndpointKey,
    )

    if (group) {
      await copyText(exportEndpointMarkdown([group]))
    }
  })
}

void reload({ silent: false }).then(() => {
  scheduleAutoRefresh()
})
