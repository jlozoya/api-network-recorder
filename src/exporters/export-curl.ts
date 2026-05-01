import type { NetworkRecord } from "../core/network-types.js"

export const recordToCurl = (record: NetworkRecord): string => {
  const parts = [`curl '${record.url}'`, `-X ${record.method}`]

  for (const [key, value] of Object.entries(record.requestHeaders)) {
    parts.push(`-H '${key}: ${value.replaceAll("'", "'\\''")}'`)
  }

  if (record.requestBody?.kind === "text") {
    parts.push(`--data-raw '${record.requestBody.value.replaceAll("'", "'\\''")}'`)
  }

  if (record.requestBody?.kind === "json") {
    parts.push(`--data-raw '${JSON.stringify(record.requestBody.value).replaceAll("'", "'\\''")}'`)
  }

  return parts.join(" \\\n  ")
}