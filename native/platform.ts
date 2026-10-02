import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export interface PlatformContext {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
}
export const platformContext = (): PlatformContext => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
})
const xdgHome = (value: string | undefined, fallback: string): string =>
  value && isAbsolute(value) ? value : fallback

export const integrationPaths = (context = platformContext()) => {
  const { platform, home, env } = context
  let data: string
  let chrome: string
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is missing")
    data = join(env.LOCALAPPDATA, "ApiNetworkRecorder")
    chrome = join(env.LOCALAPPDATA, "Google", "Chrome", "User Data")
  } else if (platform === "darwin") {
    data = join(home, "Library", "Application Support", "ApiNetworkRecorder")
    chrome = join(home, "Library", "Application Support", "Google", "Chrome")
  } else if (platform === "linux") {
    data = join(xdgHome(env.XDG_DATA_HOME, join(home, ".local", "share")), "api-network-recorder")
    chrome = join(xdgHome(env.XDG_CONFIG_HOME, join(home, ".config")), "google-chrome")
  } else throw new Error(`Unsupported integration platform: ${platform}`)
  const directory = env.API_RECORDER_HOME ? resolve(env.API_RECORDER_HOME) : data
  return {
    directory,
    chrome,
    executable: join(
      directory,
      platform === "win32" ? "api-network-recorder-bridge.exe" : "api-network-recorder-bridge",
    ),
    codex: resolve(env.CODEX_HOME || join(home, ".codex")),
  }
}
