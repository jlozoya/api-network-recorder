const MAX_INJECTION_ATTEMPTS = 50
const INJECTION_RETRY_DELAY_MS = 10

const getInjectionTarget = (): HTMLElement | null => {
  return document.documentElement || document.head || document.body
}

const injectScriptElement = (): boolean => {
  const target = getInjectionTarget()

  if (!target) {
    return false
  }

  const existingScript = document.querySelector<HTMLScriptElement>(
    'script[data-api-network-recorder="injected"]',
  )

  if (existingScript) {
    return true
  }

  const script = document.createElement("script")

  script.src = chrome.runtime.getURL("assets/injected.js")
  script.async = false
  script.dataset.apiNetworkRecorder = "injected"

  script.onload = () => {
    script.remove()
  }

  script.onerror = () => {
    script.remove()
    console.warn("[API Network Recorder] Failed to inject page script.")
  }

  target.prepend(script)

  return true
}

export const injectPageScript = (): void => {
  let attempts = 0

  const tryInject = (): void => {
    attempts += 1

    if (injectScriptElement()) {
      return
    }

    if (attempts >= MAX_INJECTION_ATTEMPTS) {
      console.warn("[API Network Recorder] Could not find a document node for script injection.")
      return
    }

    window.setTimeout(tryInject, INJECTION_RETRY_DELAY_MS)
  }

  tryInject()
}