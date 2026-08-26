import { useLayoutEffect, useRef } from 'react'

// Android has no native child webviews (Tauri's `Window::add_child` is
// desktop-only), so tab content lives in per-tab android.webkit.WebViews that
// the Kotlin TabsPlugin layers above the app UI. This component is the
// placeholder that marks where those WebViews belong: it renders in the same
// spot the desktop child webview occupies and reports its bounding rect (CSS
// px) to Rust, which forwards it to Kotlin on every visibility sync.
export function MobileTabView(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const report = (): void => {
      const rect = host.getBoundingClientRect()
      void window.aether.layout
        .setWebContentBounds({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
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
  }, [])

  return <div ref={hostRef} className="mobile-tab-view" aria-hidden="true" />
}
