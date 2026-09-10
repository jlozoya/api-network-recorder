import type { NetworkRecord } from "./network-types.js"

export interface NetworkRecordSummary {
  total: number
  api: number
  deep: number
  errors: number
  hosts: number
}

export const createNetworkRecordSummary = () => {
  const summary: NetworkRecordSummary = { total: 0, api: 0, deep: 0, errors: 0, hosts: 0 }
  const hosts = new Set<string>()
  return {
    summary,
    add(record: NetworkRecord): void {
      summary.total += 1
      const resourceType = record.resourceType?.toLowerCase() ?? ""
      const mimeType = record.mimeType?.toLowerCase() ?? ""
      if (["xmlhttprequest", "fetch", "xhr"].includes(resourceType) || mimeType.includes("json"))
        summary.api += 1
      if (record.source === "debugger") summary.deep += 1
      if (record.error || record.status === null) summary.errors += 1
      try {
        hosts.add(new URL(record.url).host)
      } catch {
        /* Ignore invalid hosts. */
      }
      summary.hosts = hosts.size
    },
  }
}
