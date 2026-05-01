import type { NetworkRecord } from "./network-types.js"

export type ExtensionMessage =
  | {
      type: "NETWORK_RECORD_CREATED"
      payload: Omit<NetworkRecord, "tabId">
    }
  | {
      type: "GET_RECORDS"
      payload?: {
        limit?: number
        search?: string
      }
    }
  | {
      type: "CLEAR_RECORDS"
    }
  | {
      type: "OPEN_APP"
    }
  | {
      type: "START_DEBUGGER_CAPTURE"
      payload: {
        tabId: number
      }
    }
  | {
      type: "STOP_DEBUGGER_CAPTURE"
      payload: {
        tabId: number
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