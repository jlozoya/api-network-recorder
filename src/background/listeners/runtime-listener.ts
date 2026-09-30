import { getCaptureTabStatuses, isDebuggerAttached } from "../debugger/debugger-controller.js"
import { getNativeBridgeStatus, setNativeBridgeEnabled } from "../native/native-bridge.js"
import { isPageNetworkRecordMessage } from "../../core/record-validation.js"
import type { CaptureSettings } from "../../storage/capture-settings.js"
import {
  getCaptureSettings,
  setCaptureSettings,
  isUrlIgnoredByDomains,
} from "../../storage/capture-settings.js"
import type { ExtensionMessage, ExtensionResponse } from "../../core/message-types.js"
import type { NetworkRecord } from "../../core/network-types.js"
import {
  clearNetworkRecords,
  getNetworkRecordSummary,
  listNetworkRecords,
  saveNetworkRecord,
} from "../../storage/network-record-repository.js"
import {
  getFreshDebuggerCaptureStatus,
  startDebuggerCapture,
  startDebuggerCaptureForAllAvailableTabs,
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
  timeoutMs = 7000,
): void => {
  withTimeout(promise, timeoutMs, label)
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
    if (!message || typeof message !== "object") return false

    if (message.type === "GET_NATIVE_BRIDGE_STATUS" || message.type === "SET_NATIVE_BRIDGE_ENABLED") {
      if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return false
      respond(
        sendResponse,
        message.type === "SET_NATIVE_BRIDGE_ENABLED"
          ? setNativeBridgeEnabled(message.payload.enabled).then(getNativeBridgeStatus)
          : Promise.resolve(getNativeBridgeStatus()),
        message.type,
      )
      return true
    }

    if (message.type === "GET_PAGE_CAPTURE_STATE") {
      respond(
        sendResponse,
        getCaptureSettings().then((settings) => ({
          enabled:
            settings.deepCaptureEnabled &&
            !settings.capturePaused &&
            typeof sender.tab?.id === "number" &&
            !isDebuggerAttached(sender.tab.id) &&
            !settings.ignoredTabIds.includes(sender.tab.id) &&
            !isUrlIgnoredByDomains(sender.url, settings.ignoredDomains),
        })),
        message.type,
      )
      return true
    }

    if (message.type === "NETWORK_RECORD_CREATED") {
      if (
        !isPageNetworkRecordMessage(message) ||
        typeof sender.tab?.id !== "number" ||
        !sender.url
      ) {
        sendResponse({ ok: false, error: "Invalid page network record" })
        return false
      }
      const record: NetworkRecord = {
        ...message.payload,
        // Page data cannot choose a database key or impersonate a different frame.
        id: crypto.randomUUID(),
        tabId: sender.tab.id,
        frameId: sender.frameId ?? null,
        pageUrl: sender.url,
        origin: sender.origin ?? new URL(sender.url).origin,
      }

      respond(
        sendResponse,
        getCaptureSettings().then(async (settings) => {
          // Page hooks may outlive an unregister/stop; the background remains authoritative.
          if (settings.deepCaptureEnabled) await saveNetworkRecord(record)
          return null
        }),
        message.type,
      )
      return true
    }

    if (message.type === "GET_RECORD_SUMMARY") {
      respond(sendResponse, getNetworkRecordSummary(), message.type)
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
        30000,
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
        25000,
      )
      return true
    }

    if (message.type === "START_DEBUGGER_CAPTURE_ALL") {
      respond(
        sendResponse,
        startDebuggerCaptureForAllAvailableTabs().then(() => null),
        message.type,
        25000,
      )
      return true
    }

    if (message.type === "STOP_DEBUGGER_CAPTURE") {
      respond(
        sendResponse,
        stopDebuggerCaptureForAllTabs().then(() => null),
        message.type,
        25000,
      )
      return true
    }

    if (message.type === "GET_CAPTURE_TABS_STATUS") {
      respond(sendResponse, getCaptureTabStatuses(), message.type)
      return true
    }

    if (message.type === "GET_CAPTURE_STATUS") {
      respond(sendResponse, getFreshDebuggerCaptureStatus(message.payload.tabId), message.type)

      return true
    }

    return false
  },
)
