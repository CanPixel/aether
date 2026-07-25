import { useRef } from 'react'
import { useWebContentBounds } from '../utils/web-content-bounds'

// Desktop counterpart to MobileTabView. Tauri child webviews are native and draw over
// the DOM, so this div is not the content — it is the measured hole the content is
// positioned into. Replacing the old SIDEBAR_WIDTH / BROWSER_VIEW_TOP / PANEL_WIDTH
// constants with a measurement means the chrome's real CSS geometry decides where web
// pages sit.
export function WebContentSlot({ panelWidth }: { panelWidth: number }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // Panel width is a dependency because dragging the panel moves this slot's right
  // edge, and a re-measure has to follow the committed layout.
  useWebContentBounds(hostRef, [panelWidth])

  return <div ref={hostRef} className="webview-underlay" aria-hidden="true" />
}
