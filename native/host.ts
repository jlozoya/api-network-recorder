import { createServer, type Socket } from "node:net"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from "node:fs"
import { join } from "node:path"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { agentTools, isAgentTool } from "../src/core/agent-tools.js"
import {
  appDirectory,
  loadConfig,
  pipeForProfile,
  profileIdSchema,
  socketDirectory,
  connectionSchema,
} from "./config.js"
import { readFrames, writeFrame } from "./framing.js"

export const startNativeHost = (origin: string): void => {
  const config = loadConfig()
  const extensionId = config.extensionIds.find((id) => origin === `chrome-extension://${id}/`)
  if (!extensionId) throw new Error("This extension is not authorized by the installer")
  let registered = false
  let connectionFile: string | undefined
  let boundSocket: string | undefined
  const clients = new Set<Socket>()
  const pending = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>()
  const server = createServer((socket) => {
    if (clients.size >= 32) {
      socket.destroy()
      return
    }
    clients.add(socket)
    socket.setTimeout(35000, () => socket.destroy())
    socket.on("error", () => {})
    socket.on("close", () => {
      clients.delete(socket)
      for (const [id, call] of pending)
        if (call.socket === socket) {
          clearTimeout(call.timer)
          pending.delete(id)
        }
    })
    let called = false
    readFrames(
      socket,
      (message) => {
        if (called) {
          socket.destroy()
          return
        }
        called = true
        try {
          if (
            !message ||
            typeof message.token !== "string" ||
            message.token.length !== 64 ||
            !timingSafeEqual(Buffer.from(message.token), Buffer.from(config.token))
          )
            throw new Error("Unauthorized bridge client")
          // Uninstall/revocation must also stop already-running native host processes.
          const currentConfig = loadConfig()
          if (
            currentConfig.token !== config.token ||
            !currentConfig.extensionIds.includes(extensionId)
          )
            throw new Error("Bridge access has been revoked")
          const method: unknown = message.method
          if (!isAgentTool(method)) throw new Error("Unknown agent tool")
          if (
            !agentTools[method].readOnly &&
            (!config.allowControls || !currentConfig.allowControls)
          )
            throw new Error(
              "Capture-control permission is disabled. Re-run the installer to authorize it.",
            )
          const args = agentTools[method].schema.parse(message.args)
          const id = randomUUID()
          const timer = setTimeout(() => {
            pending.delete(id)
            writeFrame(socket, { error: "The extension did not respond within 30 seconds" })
            socket.end()
          }, 30000)
          pending.set(id, { socket, timer })
          writeFrame(process.stdout, { type: "call", id, method: message.method, args })
        } catch (error) {
          writeFrame(socket, { error: error instanceof Error ? error.message : String(error) })
          socket.end()
        }
      },
      () => socket.destroy(),
    )
  })
  const stop = () => {
    for (const call of pending.values()) clearTimeout(call.timer)
    for (const socket of clients) socket.destroy()
    server.close()
    if (boundSocket && process.platform !== "win32") {
      try {
        unlinkSync(boundSocket)
      } catch {
        /* Socket already closed. */
      }
    }
    if (connectionFile) {
      try {
        if (JSON.parse(readFileSync(connectionFile, "utf8")).pid === process.pid)
          unlinkSync(connectionFile)
      } catch {
        /* Already removed by uninstall, or replaced by another host. */
      }
    }
    process.exit(0)
  }
  server.on("error", (error) => {
    console.error(error.message)
    stop()
  })
  process.stdin.on("end", stop)
  process.stdin.on("error", stop)
  process.on("SIGTERM", stop)
  readFrames(
    process.stdin,
    (message) => {
      if (message?.type === "hello" && !registered) {
        const profileId = profileIdSchema.parse(message.profileId)
        if (message.extensionId !== extensionId) throw new Error("Extension identity mismatch")
        registered = true
        const pipe = pipeForProfile(profileId)
        if (process.platform !== "win32") {
          const socketDir = socketDirectory()
          mkdirSync(socketDir, { recursive: true, mode: 0o700 })
          const stat = lstatSync(socketDir)
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!())
            throw new Error("Unsafe native socket directory")
          chmodSync(socketDir, 0o700)
          if (existsSync(pipe)) {
            const previous = connectionSchema.parse(
              JSON.parse(
                readFileSync(join(appDirectory(), "connections", `${profileId}.json`), "utf8"),
              ),
            )
            if (previous.pipe !== pipe || previous.profileId !== profileId)
              throw new Error("Socket does not match the registered profile")
            try {
              process.kill(previous.pid, 0)
              throw new Error("This Chrome profile already has a connected native host")
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
            }
            if (!lstatSync(pipe).isSocket()) throw new Error("Invalid native socket file")
            unlinkSync(pipe)
          }
        }
        server.listen(pipe, () => {
          boundSocket = pipe
          if (process.platform !== "win32") chmodSync(pipe, 0o600)
          const directory = join(appDirectory(), "connections")
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          connectionFile = join(directory, `${profileId}.json`)
          writeFileSync(
            connectionFile,
            JSON.stringify({
              profileId,
              extensionId,
              pipe: pipeForProfile(profileId),
              pid: process.pid,
            }),
            { mode: 0o600 },
          )
          writeFrame(process.stdout, { type: "ready", allowControls: config.allowControls })
        })
        return
      }
      if (message?.type !== "result" || typeof message.id !== "string") return
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      clearTimeout(call.timer)
      writeFrame(
        call.socket,
        typeof message.error === "string" ? { error: message.error } : { result: message.result },
      )
      call.socket.end()
    },
    (error) => {
      console.error(error.message)
      stop()
    },
  )
}
