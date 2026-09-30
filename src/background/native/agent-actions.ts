import { agentTools, isAgentTool } from "../../core/agent-tools.js"
import type { ListNetworkRecordsPayload } from "../../core/message-types.js"
import { getCaptureSettings, setCaptureSettings } from "../../storage/capture-settings.js"
import {
  getNetworkRecordsByIds,
  listNetworkRecordPreviews,
  listSavedSessions,
} from "../../storage/network-record-repository.js"
import {
  getCaptureTabStatuses,
  startDebuggerCaptureForAllAvailableTabs,
  stopDebuggerCaptureForAllTabs,
} from "../debugger/debugger-controller.js"

export const runAgentAction = async (
  name: unknown,
  args: unknown,
  allowControls: boolean,
): Promise<unknown> => {
  if (!isAgentTool(name)) throw new Error("Unknown agent tool")
  if (!agentTools[name].readOnly && !allowControls)
    throw new Error("Capture controls were not authorized during installation.")
  const input = agentTools[name].schema.parse(args)
  switch (name) {
    case "capture_status":
      return { settings: await getCaptureSettings(), tabs: await getCaptureTabStatuses() }
    case "list_sessions":
      return listSavedSessions()
    case "search_requests": {
      const {
        profileId: _,
        sessionId,
        offset,
        pageSize,
        ...filters
      } = agentTools.search_requests.schema.parse(input)
      const query = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value !== undefined),
      ) as ListNetworkRecordsPayload
      const records = await listNetworkRecordPreviews({ ...query, limit: 1000 }, sessionId)
      return {
        total: records.length,
        offset,
        pageSize,
        hasMore: offset + pageSize < records.length,
        records: records.slice(offset, offset + pageSize),
      }
    }
    case "get_request": {
      const { id, sessionId } = agentTools.get_request.schema.parse(input)
      const [record] = await getNetworkRecordsByIds([id], sessionId)
      return record
    }
    case "start_recording": {
      const settings = await getCaptureSettings()
      return settings.capturePaused
        ? setCaptureSettings({ capturePaused: false, captureActiveSince: new Date().toISOString() })
        : settings
    }
    case "stop_recording":
      return setCaptureSettings({ capturePaused: true, captureActiveSince: null })
    case "start_deep_capture":
      await startDebuggerCaptureForAllAvailableTabs()
      return { enabled: true }
    case "stop_deep_capture":
      await stopDebuggerCaptureForAllTabs()
      return { enabled: false }
  }
}
