interface TooltipAnchor {
  left: number
  right: number
  top: number
  bottom: number
}

export const getTooltipPosition = (
  anchor: TooltipAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } => {
  const padding = 12
  const below = anchor.bottom + 8
  const top =
    below + size.height <= viewport.height - padding ? below : anchor.top - size.height - 8
  return {
    left: Math.max(
      padding,
      Math.min(
        (anchor.left + anchor.right - size.width) / 2,
        viewport.width - size.width - padding,
      ),
    ),
    top: Math.max(padding, Math.min(top, viewport.height - size.height - padding)),
  }
}

export const createTooltips = (root: HTMLElement): { beforeRender(): void; refresh(): void } => {
  const id = "recorder-tooltip"
  let target: HTMLElement | null = null
  let tooltip: HTMLDivElement | null = null
  let title: HTMLElement | null = null
  let description: HTMLElement | null = null
  let showTimer: number | undefined
  let hideTimer: number | undefined

  const cancelTimers = () => {
    window.clearTimeout(showTimer)
    window.clearTimeout(hideTimer)
  }
  const clearDescription = () => {
    if (target) {
      const ids = (target.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((value) => value && value !== id)
      if (ids.length) target.setAttribute("aria-describedby", ids.join(" "))
      else target.removeAttribute("aria-describedby")
    }
  }
  const hide = () => {
    cancelTimers()
    clearDescription()
    if (tooltip) tooltip.hidden = true
    target = null
  }
  const hideSoon = () => {
    window.clearTimeout(showTimer)
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(hide, 150)
  }
  const show = () => {
    if (!target?.isConnected) return hide()
    if (!tooltip) {
      tooltip = document.createElement("div")
      tooltip.id = id
      tooltip.className = "recorderTooltip"
      tooltip.setAttribute("role", "tooltip")
      title = document.createElement("strong")
      title.className = "tooltipTitle"
      description = document.createElement("div")
      description.className = "tooltipDescription"
      tooltip.append(title, description)
      tooltip.addEventListener("pointerenter", cancelTimers)
      tooltip.addEventListener("pointerleave", hideSoon)
      document.body.append(tooltip)
    }
    title!.textContent = target.dataset.tooltip ?? ""
    description!.textContent = target.dataset.tooltipDescription ?? ""
    description!.hidden = !description!.textContent
    tooltip.dataset.kind = target.dataset.tooltipKind ?? "action"
    const anchor = target.getBoundingClientRect()
    tooltip.style.maxWidth = `${Math.min(360, Math.max(0, window.innerWidth - 24))}px`
    tooltip.style.maxHeight = `${Math.min(
      240,
      Math.max(44, anchor.top - 20, window.innerHeight - anchor.bottom - 20),
    )}px`
    tooltip.hidden = false
    const size = tooltip.getBoundingClientRect()
    const position = getTooltipPosition(anchor, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    })
    tooltip.style.left = `${position.left}px`
    tooltip.style.top = `${position.top}px`
    const ids = new Set(
      (target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean),
    )
    ids.add(id)
    target.setAttribute("aria-describedby", [...ids].join(" "))
  }
  const findTarget = (event: Event) => {
    const element =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null
    return element && root.contains(element) ? element : null
  }
  root.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return
    const next = findTarget(event)
    if (!next) return
    if (next === target) return window.clearTimeout(hideTimer)
    hide()
    target = next
    showTimer = window.setTimeout(show, 250)
  })
  root.addEventListener("pointerout", (event) => {
    if (!target) return
    const next = event.relatedTarget
    if (next instanceof Node && (target.contains(next) || tooltip?.contains(next))) return
    hideSoon()
  })
  root.addEventListener("focusin", (event) => {
    const next = findTarget(event)
    if (!next?.matches(":focus-visible")) return
    hide()
    target = next
    show()
  })
  root.addEventListener("focusout", hide)
  root.addEventListener("pointerdown", hide)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide()
  })
  document.addEventListener(
    "scroll",
    (event) => {
      if (event.target instanceof Node && tooltip?.contains(event.target)) return
      hide()
    },
    true,
  )
  window.addEventListener("resize", hide)
  window.addEventListener("blur", hide)
  return {
    beforeRender: clearDescription,
    refresh() {
      if (target && (!target.isConnected || !target.dataset.tooltip)) hide()
      else if (tooltip && !tooltip.hidden) {
        if (!target?.matches(":hover, :focus-visible") && !tooltip.matches(":hover")) hide()
        else show()
      }
    },
  }
}
