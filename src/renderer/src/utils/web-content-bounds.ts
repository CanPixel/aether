import { useLayoutEffect, type RefObject } from 'react'

// Reports the measured position and size of the slot where live web content belongs.
// Rust positions its native web views from this rather than from hardcoded chrome
// offsets, so restyling the chrome or dragging the AiON panel moves the content with
// it instead of leaving it misaligned.
//
// Native webviews always paint above the DOM. Measure the bottom of the visible
// browser chrome as well as the slot, so an overflowing chrome row can never be
// covered by a live page.
export function useWebContentBounds(
  ref: RefObject<HTMLElement | null>,
  deps: unknown[] = [],
): void {
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return

    let last = ''
    const report = (): void => {
      const rect = host.getBoundingClientRect()
      const quickActions = document.querySelector<HTMLElement>('.quick-action-row')
      const browserChrome = document.querySelector<HTMLElement>('.browser-chrome')
      const chromeBottom =
        quickActions?.getBoundingClientRect().bottom ??
        browserChrome?.getBoundingClientRect().bottom
      const top = Math.max(rect.top, chromeBottom ?? rect.top)
      const height = Math.max(0, rect.bottom - top)
      // Skip identical rects: the observer fires on every layout pass, and each
      // report repositions native webviews, which flickers if done needlessly.
      const key = `${top}:${rect.left}:${rect.width}:${height}`
      if (key === last) return
      last = key

      void window.aether.layout
        .setWebContentBounds({
          top,
          left: rect.left,
          width: rect.width,
          height,
        })
        .catch(() => undefined)
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(host)
    const chrome = document.querySelector<HTMLElement>('.quick-action-row, .browser-chrome')
    if (chrome) observer.observe(chrome)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
    // `deps` is spread so callers can re-measure when their own layout state changes.
  }, [ref, ...deps])
}
