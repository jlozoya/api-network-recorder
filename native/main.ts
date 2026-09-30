import { startMcp } from "./mcp.js"
import { startNativeHost } from "./host.js"
import {
  configureIntegration,
  installInteractive,
  uninstallIntegration,
  uninstallInteractive,
} from "./install.js"

const args = process.argv.slice(2)
try {
  if (args[0] === "--install") installInteractive()
  else if (args[0] === "--uninstall-ui") uninstallInteractive()
  else if (args[0] === "--mcp") await startMcp()
  else if (args[0] === "--configure") {
    configureIntegration(
      args.find((arg) => arg.startsWith("--extension-id="))?.slice(15) || undefined,
      args.includes("--allow-controls"),
    )
  } else if (args[0] === "--uninstall") uninstallIntegration()
  else if (args[0]?.startsWith("chrome-extension://")) startNativeHost(args[0])
  else throw new Error("Use --mcp, or run the integration installer.")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
