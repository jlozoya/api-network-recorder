export interface CaptureTabStatus {
  tabId: number
  title: string
  url: string
  state: "attached" | "ignored" | "pending" | "failed" | "off" | "ineligible" | "unsupported"
  reason: string
}
