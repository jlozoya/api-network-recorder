import { isAgentTool } from "../src/core/agent-tools.js"
import { callExtension } from "./client.js"
import { listConnections, loadConfig } from "./config.js"
import { executeReplayTool, isReplayTool } from "./replay-tools.js"

// Shared by MCP and the bundled terminal client; authorization stays in the native host.
export const executeTool = async (name: string, input: unknown): Promise<unknown> => {
  if (name === "list_profiles") {
    const config = loadConfig()
    return {
      profiles: listConnections()
        .filter((item) => config.extensionIds.includes(item.extensionId))
        .map(({ profileId, extensionId }) => ({ profileId, extensionId })),
      captureControlsAllowed: config.allowControls,
      replayAllowed: config.allowReplay,
      replayOrigins: config.replayOrigins,
    }
  }
  if (isReplayTool(name)) return executeReplayTool(name, input)
  if (!isAgentTool(name)) throw new Error("Unknown agent tool")
  return callExtension(name, input)
}
