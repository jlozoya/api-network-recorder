import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { spawn } from "node:child_process"
import { recordToCurl } from "../src/core/export-curl.ts"
import type { NetworkRecord } from "../src/core/network-types.ts"

const shells = [
  {
    name: "bash" as const,
    binary: process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash"),
    args: ["-c"],
  },
  {
    name: "powershell" as const,
    binary: Bun.which("pwsh"),
    args: ["-NoProfile", "-NonInteractive", "-Command"],
  },
]
for (const shell of shells) {
  const available =
    Boolean(shell.binary && existsSync(shell.binary)) &&
    (shell.name !== "powershell" || process.platform === "win32")
  for (const multipart of [false, true]) {
    test.skipIf(!available)(
      "replays " + (multipart ? "multipart" : "JSON") + " through real " + shell.name,
      async () => {
        const value =
          'O\'Brien \u00B7 \u00E1 \u00B7 "quoted" \u00B7 $notExpanded \u00B7 @literal;type=text/plain'
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const data = multipart
              ? Object.fromEntries(await request.formData())
              : await request.json()
            return Response.json({ data, header: request.headers.get("x-literal") })
          },
        })
        const directory = await mkdtemp(join(tmpdir(), "recorder-curl-test-"))
        try {
          const record = {
            url: "http://127.0.0.1:" + server.port + "/api?x=one&y=two",
            method: "POST",
            requestHeaders: {
              "Content-Type": multipart ? "multipart/form-data; boundary=old" : "application/json",
              "X-Literal": 'O\'Brien "quote"',
            },
            requestBody: {
              kind: multipart ? "form-data" : "json",
              value: { name: value },
              sizeBytes: 100,
              truncated: false,
            },
          } as NetworkRecord
          const command = recordToCurl(record, shell.name)
          const scriptPath = join(directory, shell.name === "bash" ? "replay.sh" : "replay.ps1")
          await writeFile(scriptPath, command, "utf8")
          const scriptArg = shell.name === "bash" ? scriptPath.replaceAll("\\", "/") : scriptPath
          const argumentsList =
            shell.name === "bash"
              ? [scriptArg]
              : ["-NoProfile", "-NonInteractive", "-File", scriptArg]
          const response = await new Promise<string>((resolve, reject) => {
            const child = spawn(shell.binary!, argumentsList, {
              windowsHide: true,
              timeout: 15000,
              env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            })
            let stdout = "",
              stderr = ""
            child.stdout.on("data", (chunk) => {
              stdout += chunk
            })
            child.stderr.on("data", (chunk) => {
              stderr += chunk
            })
            child.on("error", reject)
            child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))))
          })
          const result = JSON.parse(response)
          expect(result.data).toEqual({ name: value })
          expect(result.header).toBe('O\'Brien "quote"')
        } finally {
          server.stop(true)
          if (
            resolve(dirname(directory)) === resolve(tmpdir()) &&
            directory.includes("recorder-curl-test-")
          )
            await rm(directory, { recursive: true, force: true })
        }
      },
      20000,
    )
  }
}
