export type CaptureLimit = 50 | 100 | 150 | 250 | 500 | 1000

export interface CaptureSettings {
  captureLimit: CaptureLimit
}

const STORAGE_KEY = "apiNetworkRecorderSettings"

const DEFAULT_SETTINGS: CaptureSettings = {
  captureLimit: 100,
}

const ALLOWED_CAPTURE_LIMITS = new Set<number>([50, 100, 150, 250, 500, 1000])

const normalizeCaptureLimit = (value: unknown): CaptureLimit => {
  if (typeof value === "number" && ALLOWED_CAPTURE_LIMITS.has(value)) {
    return value as CaptureLimit
  }

  return DEFAULT_SETTINGS.captureLimit
}

export const getCaptureSettings = async (): Promise<CaptureSettings> => {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const rawSettings = result[STORAGE_KEY] as Partial<CaptureSettings> | undefined

  return {
    captureLimit: normalizeCaptureLimit(rawSettings?.captureLimit),
  }
}

export const setCaptureSettings = async (
  settings: Partial<CaptureSettings>,
): Promise<CaptureSettings> => {
  const currentSettings = await getCaptureSettings()

  const nextSettings: CaptureSettings = {
    ...currentSettings,
    captureLimit: normalizeCaptureLimit(settings.captureLimit ?? currentSettings.captureLimit),
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: nextSettings,
  })

  return nextSettings
}