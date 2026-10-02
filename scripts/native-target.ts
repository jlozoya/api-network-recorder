import { join } from "node:path"

export const nativeTargets = {
  "windows-x64": "bun-windows-x64-baseline",
  "macos-x64": "bun-darwin-x64",
  "macos-arm64": "bun-darwin-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
} as const
export type NativeTarget = keyof typeof nativeTargets
export const nativeTarget = (): NativeTarget => {
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform
  const target = process.env.RECORDER_NATIVE_TARGET || `${platform}-${process.arch}`
  if (!Object.hasOwn(nativeTargets, target)) throw new Error(`Unsupported native target: ${target}`)
  return target as NativeTarget
}
export const nativeBinary = (target = nativeTarget()): string =>
  target === "windows-x64"
    ? join("dist", "native", "api-network-recorder-bridge.exe")
    : join("dist", "native", target, "api-network-recorder-bridge")
