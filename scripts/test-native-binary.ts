import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { nativeBinary } from "./native-target.js"

const result = spawnSync(process.execPath, ["test", "tests/native-bridge.test.ts"], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, RECORDER_NATIVE_BINARY: resolve(nativeBinary()) },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
