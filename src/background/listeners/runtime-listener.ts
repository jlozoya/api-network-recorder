import type { CaptureSettings } from "../../storage/capture-settings.js"
import { getCaptureSettings, setCaptureSettings } from "../../storage/capture-settings.js"
import type { ExtensionMessage, ExtensionResponse } from "../../core/message-types.js"
import type { NetworkRecord } from "../../core/network-types.js"
import {
  clearNetworkRecords,
  listNetworkRecords,
  saveNetworkRecord,
} from "../../storage/network-record-repository.js"
import {
  getFreshDebuggerCaptureStatus,
  startDebuggerCapture,
  stopDebuggerCaptureForAllTabs,
} from "../debugger/debugger-controller.js"

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

const respond = <T>(
  sendResponse: (response: ExtensionResponse<T>) => void,
  promise: Promise<T>,
  label: string,
): void => {
  withTimeout(promise, 7000, label)
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

      respond(
        sendResponse,
        saveNetworkRecord(record).then(() => null),
        message.type,
      )
      return true
    }

    if (message.type === "GET_RECORDS") {
      respond(sendResponse, listNetworkRecords(message.payload), message.type)
      return true
    }

    if (message.type === "CLEAR_RECORDS") {
      respond(
        sendResponse,
        clearNetworkRecords().then(() => null),
        message.type,
      )
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
        message.type,
      )

      return true
    }

    if (message.type === "GET_CAPTURE_SETTINGS") {
      respond<CaptureSettings>(sendResponse, getCaptureSettings(), message.type)
      return true
    }

    if (message.type === "SET_CAPTURE_SETTINGS") {
      respond<CaptureSettings>(sendResponse, setCaptureSettings(message.payload), message.type)
      return true
    }

    if (message.type === "START_DEBUGGER_CAPTURE") {
      respond(
        sendResponse,
        startDebuggerCapture(message.payload.tabId).then(() => null),
        message.type,
      )
      return true
    }

    if (message.type === "STOP_DEBUGGER_CAPTURE") {
      respond(
        sendResponse,
        stopDebuggerCaptureForAllTabs().then(() => null),
        message.type,
      )
      return true
    }

    if (message.type === "GET_CAPTURE_STATUS") {
      respond(sendResponse, getFreshDebuggerCaptureStatus(message.payload.tabId), message.type)

      return true
    }

    return false
  },
)
