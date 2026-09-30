import type { CaptureSettings } from "../storage/capture-settings.js"
import type { NetworkRecord } from "./network-types.js"

export interface ListNetworkRecordsPayload {
  limit?: number
  search?: string
  method?: string
  statusGroup?: "all" | "success" | "redirect" | "client-error" | "server-error" | "error"
  source?: NetworkRecord["source"] | "all"
  host?: string
  apiOnly?: boolean
}

export type ExtensionMessage =
  | { type: "GET_NATIVE_BRIDGE_STATUS" }
  | { type: "SET_NATIVE_BRIDGE_ENABLED"; payload: { enabled: boolean } }
  | { type: "GET_PAGE_CAPTURE_STATE" }
  | { type: "GET_CAPTURE_TABS_STATUS" }
  | { type: "GET_RECORD_SUMMARY" }
  | {
      type: "NETWORK_RECORD_CREATED"
      payload: Omit<NetworkRecord, "tabId">
    }
  | {
      type: "GET_RECORDS"
      payload?: ListNetworkRecordsPayload
    }
  | {
      type: "CLEAR_RECORDS"
    }
  | {
      type: "OPEN_APP"
    }
  | {
      type: "GET_CAPTURE_SETTINGS"
    }
  | {
      type: "SET_CAPTURE_SETTINGS"
      payload: Partial<CaptureSettings>
    }
  | {
      type: "START_DEBUGGER_CAPTURE"
      payload: {
        tabId: number
      }
    }
  | {
      type: "START_DEBUGGER_CAPTURE_ALL"
    }
  | {
      type: "STOP_DEBUGGER_CAPTURE"
      payload?: {
        tabId: number
      }
    }
  | {
      type: "GET_CAPTURE_STATUS"
      payload: {
        tabId?: number
      }
    }

export type ExtensionResponse<T = unknown> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: string
    }
