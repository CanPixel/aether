import { useLayoutEffect, type RefObject } from 'react'

// Reports the measured position and size of the slot where live web content belongs.
// Rust positions its native web views from this rather than from hardcoded chrome
// offsets, so restyling the chrome or dragging the AiON panel moves the content with
// it instead of leaving it misaligned.
//
// A ResizeObserver only fires when the observed box changes size, so window resizes
// and any layout change that shifts the slot without resizing it are covered by the
// extra resize listener and by callers re-running this on their own layout state.
export function useWebContentBounds(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): void {
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return

    let last = ''
    const report = (): void => {
      const rect = host.getBoundingClientRect()
      // Skip identical rects: the observer fires on every layout pass, and each
      // report repositions native webviews, which flickers if done needlessly.
      const key = `${rect.top}:${rect.left}:${rect.width}:${rect.height}`
      if (key === last) return
      last = key

      void window.aether.layout
        .setWebContentBounds({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height
        })
        .catch(() => undefined)
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(host)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
    // `deps` is spread so callers can re-measure when their own layout state changes.
  }, [ref, ...deps])
}
