import { createConnection } from "node:net"
import { agentTools, isAgentTool } from "../src/core/agent-tools.js"
import { listConnections, loadConfig } from "./config.js"
import { readFrames, writeFrame } from "./framing.js"

export const callExtension = async (method: string, input: unknown): Promise<unknown> => {
  if (!isAgentTool(method)) throw new Error("Unknown agent tool")
  const args = agentTools[method].schema.parse(input)
  const config = loadConfig()
  const connections = listConnections().filter((connection) =>
    config.extensionIds.includes(connection.extensionId),
  )
  const profileId = args.profileId
  if (!profileId && connections.length > 1)
    throw new Error(
      "Multiple Chrome profiles are connected. Call list_profiles and specify profileId.",
    )
  const connection = profileId
    ? connections.find((item) => item.profileId === profileId)
    : connections[0]
  if (!connection)
    throw new Error(
      "No matching Chrome profile is connected. Install the extension, reload it after updating, and leave Chrome open. Automatic reconnection runs every minute.",
    )
  return new Promise((resolve, reject) => {
    const socket = createConnection(connection.pipe)
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error("Extension request timed out")), 35000)
    socket.on("connect", () => writeFrame(socket, { token: config.token, method, args }))
    socket.on("error", (error) => finish(error))
    socket.on("end", () => finish(new Error("Extension connection closed before responding")))
    readFrames(
      socket,
      (message) => {
        if (typeof message?.error === "string") finish(new Error(message.error))
        else if (message && Object.hasOwn(message, "result")) finish(undefined, message.result)
        else finish(new Error("Invalid extension response"))
      },
      (error) => finish(error),
    )
  })
}
