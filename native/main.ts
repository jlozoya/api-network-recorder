import { startMcp } from "./mcp.js"
import { startNativeHost } from "./host.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { installAgentSkill } from "./skill.js"
import { executeTool } from "./tools.js"
import { configureReplay } from "./replay-tools.js"
import {
  configureIntegration,
  installInteractive,
  installTerminal,
  uninstallIntegration,
  uninstallInteractive,
} from "./install.js"

const args = process.argv.slice(2)
try {
  if (args[0] === "--install") {
    if (process.platform === "win32") installInteractive()
    else await installTerminal(args.slice(1))
  } else if (args[0] === "--uninstall-ui") uninstallInteractive()
  else if (args[0] === "--mcp") await startMcp()
  else if (args[0] === "--call") {
    try {
      const input: unknown = JSON.parse(args[2] || "{}")
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Tool arguments must be a JSON object")
      console.log(JSON.stringify(await executeTool(args[1] || "", input)))
    } catch (error) {
      console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      process.exitCode = 1
    }
  } else if (args[0] === "--install-skill")
    installAgentSkill(process.env.CODEX_HOME || join(homedir(), ".codex"))
  else if (args[0] === "--configure") {
    configureIntegration(
      args.find((arg) => arg.startsWith("--extension-id="))?.slice(15) || undefined,
      args.includes("--allow-controls"),
    )
  } else if (args[0] === "--configure-replay") {
    configureReplay(
      args.includes("--allow-replay"),
      args.filter((arg) => arg.startsWith("--origin=")).map((arg) => arg.slice(9)),
    )
    console.log("Replay permission updated. Capture-control permissions are unchanged.")
  } else if (args[0] === "--uninstall") uninstallIntegration()
  else if (args[0]?.startsWith("chrome-extension://")) startNativeHost(args[0])
  else throw new Error("Use --mcp, or run the integration installer.")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
