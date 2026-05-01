import type { ExtensionMessage, ExtensionResponse } from "../core/message-types.js"
import type { NetworkRecord } from "../core/network-types.js"

const sendMessage = async <T>(message: ExtensionMessage): Promise<T> => {
  const response = (await chrome.runtime.sendMessage(message)) as ExtensionResponse<T>

  if (!response.ok) {
    throw new Error(response.error)
  }

  return response.data
}

const getActiveTabId = async (): Promise<number> => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  })

  if (typeof tab?.id !== "number") {
    throw new Error("No active tab found")
  }

  return tab.id
}

const refreshSummary = async (): Promise<void> => {
  const records = await sendMessage<NetworkRecord[]>({
    type: "GET_RECORDS",
    payload: {
      limit: 20,
    },
  })

  const summary = document.querySelector("#summary")
  if (!summary) return

  summary.textContent = `${records.length} recent records loaded.`
}

document.querySelector("#openApp")?.addEventListener("click", () => {
  void sendMessage<null>({
    type: "OPEN_APP",
  })
})

document.querySelector("#startDeep")?.addEventListener("click", async () => {
  const tabId = await getActiveTabId()

  await sendMessage<null>({
    type: "START_DEBUGGER_CAPTURE",
    payload: {
      tabId,
    },
  })

  await refreshSummary()
})

document.querySelector("#stopDeep")?.addEventListener("click", async () => {
  const tabId = await getActiveTabId()

  await sendMessage<null>({
    type: "STOP_DEBUGGER_CAPTURE",
    payload: {
      tabId,
    },
  })

  await refreshSummary()
})

document.querySelector("#clear")?.addEventListener("click", async () => {
  await sendMessage<null>({
    type: "CLEAR_RECORDS",
  })

  await refreshSummary()
})

void refreshSummary()