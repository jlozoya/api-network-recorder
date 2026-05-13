import type { NetworkRecord } from "../core/network-types.js"

const escapeShell = (value: string): string => {
  return value.replaceAll("'", "'\\''")
}

export const recordToCurl = (record: NetworkRecord): string => {
  const parts = [`curl '${escapeShell(record.url)}'`, `-X ${record.method}`]

  for (const [key, value] of Object.entries(record.requestHeaders)) {
    parts.push(`-H '${escapeShell(`${key}: ${value}`)}'`)
  }

  if (record.requestBody?.kind === "text") {
    parts.push(`--data-raw '${escapeShell(record.requestBody.value)}'`)
  }

  if (record.requestBody?.kind === "json") {
    parts.push(`--data-raw '${escapeShell(JSON.stringify(record.requestBody.value))}'`)
  }

  if (record.requestBody?.kind === "form-data") {
    parts.push(`--data-raw '${escapeShell(new URLSearchParams(record.requestBody.value).toString())}'`)
  }

  return parts.join(" \\\n  ")
}