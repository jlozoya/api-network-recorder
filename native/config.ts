import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, posix } from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { integrationPaths } from "./platform.js"

export const HOST_NAME = "com.api_network_recorder.bridge"
export const MCP_NAME = "api-network-recorder"
export const VERSION = "0.4.4"
export const extensionIdSchema = z.string().regex(/^[a-p]{32}$/)
export const profileIdSchema = z.string().uuid()
export const configSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    extensionIds: z.array(extensionIdSchema).min(1),
    allowControls: z.boolean(),
  })
  .strict()
export type BridgeConfig = z.infer<typeof configSchema>
export const appDirectory = (): string => integrationPaths().directory
export const loadConfig = (): BridgeConfig =>
  configSchema.parse(JSON.parse(readFileSync(join(appDirectory(), "bridge.json"), "utf8")))
export const socketDirectory = (): string => {
  const key = createHash("sha256").update(appDirectory()).digest("hex").slice(0, 20)
  // macOS has a 104-byte Unix socket path limit; app and OS temp paths can exceed it.
  return posix.join("/tmp", `api-recorder-${process.getuid!()}-${key}`)
}
export const pipeForProfile = (profileId: string): string => {
  profileIdSchema.parse(profileId)
  const key = createHash("sha256").update(appDirectory()).digest("hex").slice(0, 20)
  return process.platform === "win32"
    ? `\\\\.\\pipe\\api-recorder-${key}-${profileId}`
    : posix.join(socketDirectory(), `${profileId}.sock`)
}
export const connectionSchema = z
  .object({
    profileId: profileIdSchema,
    extensionId: extensionIdSchema,
    pid: z.number().int().positive(),
    pipe: z.string(),
  })
  .strict()
export type ConnectionInfo = z.infer<typeof connectionSchema>
export const listConnections = (): ConnectionInfo[] => {
  const directory = join(appDirectory(), "connections")
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => /^[0-9a-f-]+\.json$/.test(name))
    .flatMap((name) => {
      try {
        const connection = connectionSchema.parse(
          JSON.parse(readFileSync(join(directory, name), "utf8")),
        )
        if (connection.pipe !== pipeForProfile(connection.profileId)) return []
        process.kill(connection.pid, 0)
        return [connection]
      } catch {
        return []
      }
    })
}
