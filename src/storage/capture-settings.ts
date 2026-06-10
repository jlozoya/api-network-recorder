export type CaptureLimit = 50 | 100 | 150 | 250 | 500 | 1000

export interface CaptureSettings {
  captureLimit: CaptureLimit
  capturePaused: boolean
  captureActiveSince: string | null
  deepCaptureEnabled: boolean
  ignoredDomains: string[]
  ignoredTabIds: number[]
}

const STORAGE_KEY = "apiNetworkRecorderSettings"

const DEFAULT_SETTINGS: CaptureSettings = {
  captureLimit: 100,
  capturePaused: false,
  captureActiveSince: null,
  deepCaptureEnabled: false,
  ignoredDomains: [],
  ignoredTabIds: [],
}

const ALLOWED_CAPTURE_LIMITS = new Set<number>([50, 100, 150, 250, 500, 1000])

const normalizeCaptureLimit = (value: unknown): CaptureLimit => {
  if (typeof value === "number" && ALLOWED_CAPTURE_LIMITS.has(value)) {
    return value as CaptureLimit
  }

  return DEFAULT_SETTINGS.captureLimit
}

export const normalizeIgnoredDomain = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase()

  if (!trimmed) {
    return null
  }

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
    return parsed.hostname.replace(/^\.+|\.+$/g, "") || null
  } catch {
    const host =
      trimmed
        .replace(/^\w+:\/\//, "")
        .split("/")[0]
        ?.split(":")[0] ?? ""
    return host.replace(/^\.+|\.+$/g, "") || null
  }
}

const normalizeIgnoredDomains = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return DEFAULT_SETTINGS.ignoredDomains
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map(normalizeIgnoredDomain)
        .filter((item): item is string => Boolean(item)),
    ),
  ).sort((a, b) => a.localeCompare(b))
}

const normalizeIgnoredTabIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return DEFAULT_SETTINGS.ignoredTabIds
  }

  return Array.from(
    new Set(
      value.filter((item): item is number => {
        return Number.isInteger(item) && item >= 0
      }),
    ),
  ).sort((a, b) => a - b)
}

export const isUrlIgnoredByDomains = (
  url: string | null | undefined,
  domains: string[],
): boolean => {
  if (!url || !domains.length) {
    return false
  }

  let host = ""

  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }

  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export const getCaptureSettings = async (): Promise<CaptureSettings> => {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const rawSettings = result[STORAGE_KEY] as Partial<CaptureSettings> | undefined

  return {
    captureLimit: normalizeCaptureLimit(rawSettings?.captureLimit),
    capturePaused: rawSettings?.capturePaused === true,
    captureActiveSince:
      typeof rawSettings?.captureActiveSince === "string" ? rawSettings.captureActiveSince : null,
    deepCaptureEnabled: rawSettings?.deepCaptureEnabled === true,
    ignoredDomains: normalizeIgnoredDomains(rawSettings?.ignoredDomains),
    ignoredTabIds: normalizeIgnoredTabIds(rawSettings?.ignoredTabIds),
  }
}

export const setCaptureSettings = async (
  settings: Partial<CaptureSettings>,
): Promise<CaptureSettings> => {
  const currentSettings = await getCaptureSettings()

  const nextSettings: CaptureSettings = {
    ...currentSettings,
    captureLimit: normalizeCaptureLimit(settings.captureLimit ?? currentSettings.captureLimit),
    capturePaused: settings.capturePaused ?? currentSettings.capturePaused,
    captureActiveSince:
      settings.captureActiveSince === undefined
        ? currentSettings.captureActiveSince
        : settings.captureActiveSince,
    deepCaptureEnabled: settings.deepCaptureEnabled ?? currentSettings.deepCaptureEnabled,
    ignoredDomains: normalizeIgnoredDomains(
      settings.ignoredDomains ?? currentSettings.ignoredDomains,
    ),
    ignoredTabIds: normalizeIgnoredTabIds(settings.ignoredTabIds ?? currentSettings.ignoredTabIds),
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: nextSettings,
  })

  return nextSettings
}
