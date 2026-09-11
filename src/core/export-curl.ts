import type { NetworkRecord } from "./network-types.js"
export type CurlShell = "bash" | "powershell"
const quoteBash = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const quotePowerShell = (value: string) =>
  "'" + value.replace(/['\u2018\u2019]/g, (char) => char + char) + "'"

export const recordToCurl = (record: NetworkRecord, shell: CurlShell = "bash"): string => {
  const quote = shell === "powershell" ? quotePowerShell : quoteBash
  const options: Array<[string, string]> = [
    ["url", record.url],
    ["request", record.method],
  ]
  const body = record.requestBody
  const contentType =
    Object.entries(record.requestHeaders).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1] ?? ""
  const multipart =
    body?.kind === "form-data" &&
    !contentType.toLowerCase().includes("application/x-www-form-urlencoded")
  for (const [key, value] of Object.entries(record.requestHeaders)) {
    if (
      key.startsWith(":") ||
      ["content-length", "host"].includes(key.toLowerCase()) ||
      (multipart && key.toLowerCase() === "content-type")
    )
      continue
    options.push(["header", key + ": " + value])
  }
  if (body?.kind === "text") options.push(["data-raw", body.value])
  if (body?.kind === "json") options.push(["data-raw", JSON.stringify(body.value)])
  if (body?.kind === "form-data") {
    if (multipart) {
      for (const [key, value] of Object.entries(body.value))
        options.push(["form-string", key + "=" + value])
    } else options.push(["data-raw", new URLSearchParams(body.value).toString()])
  }
  const notes: string[] = []
  if (body?.kind === "binary" || body?.kind === "unavailable")
    notes.push("# Request body unavailable for replay; add the original body before running.")
  if (body && body.kind !== "unavailable" && body.truncated)
    notes.push("# Captured request body is truncated; replace it before replay.")
  if (
    body?.kind === "form-data" &&
    Object.values(body.value).some((value) => /\[File:/i.test(value))
  )
    notes.push("# File fields contain captured names only; replace them with --form 'field=@path'.")
  const parts = options.map(([key, value]) => "--" + key + " " + quote(value))
  parts[0] = (shell === "powershell" ? "curl.exe " : "curl ") + parts[0]
  let command = parts.join(" " + String.fromCharCode(shell === "powershell" ? 96 : 92) + "\n  ")
  // Reading UTF-8 through stdin also avoids ANSI argv conversion in Git for Windows curl.
  if (shell === "bash" && options.some(([, value]) => /[^\x00-\x7f]/.test(value))) {
    const escapeConfig = (value: string) =>
      value
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"')
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t")
        .replaceAll("\v", "\\v")
    const config = options
      .map(([key, value]) => key + ' = "' + escapeConfig(value) + '"')
      .join("\n")
    command = "curl --config - <<'API_RECORDER_CURL'\n" + config + "\nAPI_RECORDER_CURL"
  }
  // Local scope leaves the user's preference unchanged; 7.3+ preserves embedded JSON quotes.
  return [
    ...notes,
    shell === "powershell"
      ? "# Requires PowerShell 7.3+\n& {\n  if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Use PowerShell 7.3 or later.' }\n  $PSNativeCommandArgumentPassing = 'Standard'\n  " +
        command +
        "\n}"
      : command,
  ].join("\n")
}
