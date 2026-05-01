import type { ExtensionMessage, ExtensionResponse } from "../../core/message-types.js"
import type { NetworkRecord } from "../../core/network-types.js"
import {
  clearNetworkRecords,
  listNetworkRecords,
  saveNetworkRecord,
} from "../../storage/network-record-repository.js"
import { startDebuggerCapture, stopDebuggerCapture } from "../debugger/debugger-controller.js"

const respond = <T>(
  sendResponse: (response: ExtensionResponse<T>) => void,
  promise: Promise<T>,
): void => {
  promise
    .then((data) => {
      sendResponse({ ok: true, data })
    })
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender,
    sendResponse: (response: ExtensionResponse) => void,
  ): boolean => {
    if (message.type === "NETWORK_RECORD_CREATED") {
      const record: NetworkRecord = {
        ...message.payload,
        tabId: sender.tab?.id ?? null,
      }

      respond(sendResponse, saveNetworkRecord(record).then(() => null))
      return true
    }

    if (message.type === "GET_RECORDS") {
      respond(sendResponse, listNetworkRecords(message.payload))
      return true
    }

    if (message.type === "CLEAR_RECORDS") {
      respond(sendResponse, clearNetworkRecords().then(() => null))
      return true
    }

    if (message.type === "OPEN_APP") {
      respond(
        sendResponse,
        chrome.tabs
          .create({
            url: chrome.runtime.getURL("app.html"),
          })
          .then(() => null),
      )

      return true
    }

    if (message.type === "START_DEBUGGER_CAPTURE") {
      respond(sendResponse, startDebuggerCapture(message.payload.tabId).then(() => null))
      return true
    }

    if (message.type === "STOP_DEBUGGER_CAPTURE") {
      respond(sendResponse, stopDebuggerCapture(message.payload.tabId).then(() => null))
      return true
    }

    return false
  },
)