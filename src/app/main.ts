import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { NetworkRecord } from "../core/network-types.js"

import "./app.css"

const app = document.querySelector("#app")

if (!app) {
  throw new Error("Missing #app")
}

const sendMessage = async <T>(message: ExtensionMessage): Promise<T> => {
  const response = (await chrome.runtime.sendMessage(message)) as ExtensionResponse<T>

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.data
}

const formatBody = (body: NetworkRecord["responseBody"]): string => {
  if (!body) return ""

  if (body.kind === "unavailable") {
    return body.reason
  }

  if (body.kind === "json") {
    return JSON.stringify(body.value, null, 2)
  }

  if (body.kind === "form-data") {
    return JSON.stringify(body.value, null, 2)
  }

  return body.value
}

const render = async (): Promise<void> => {
  const records = await sendMessage<NetworkRecord[]>({
    type: "GET_RECORDS",
    payload: {
      limit: 500,
    },
  })

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>API Network Recorder</h1>
        <p>${records.length} records</p>
      </div>
      <button id="refresh">Refresh</button>
    </header>

    <section class="layout">
      <aside class="list">
        ${records
          .map(
            (record) => `
              <article class="record" data-id="${record.id}">
                <div class="recordMeta">
                  <strong>${record.method}</strong>
                  <span>${record.status ?? "ERR"}</span>
                  <span>${record.durationMs ?? "-"}ms</span>
                </div>
                <div class="url">${record.url}</div>
              </article>
            `,
          )
          .join("")}
      </aside>

      <section class="details">
        <p>Select a request.</p>
      </section>
    </section>
  `

  document.querySelector("#refresh")?.addEventListener("click", () => {
    void render()
  })

  for (const item of document.querySelectorAll<HTMLElement>(".record")) {
    item.addEventListener("click", () => {
      const record = records.find((entry) => entry.id === item.dataset.id)
      if (!record) return

      const details = document.querySelector(".details")
      if (!details) return

      details.innerHTML = `
        <h2>${record.method} ${record.status ?? ""}</h2>
        <p class="detailsUrl">${record.url}</p>

        <h3>Request Headers</h3>
        <pre>${escapeHtml(JSON.stringify(record.requestHeaders, null, 2))}</pre>

        <h3>Request Body</h3>
        <pre>${escapeHtml(formatBody(record.requestBody))}</pre>

        <h3>Response Headers</h3>
        <pre>${escapeHtml(JSON.stringify(record.responseHeaders, null, 2))}</pre>

        <h3>Response Body</h3>
        <pre>${escapeHtml(formatBody(record.responseBody))}</pre>
      `
    })
  }
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

void render()