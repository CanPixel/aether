import { useEffect, useRef, type MouseEvent, type PointerEvent, type SyntheticEvent } from 'react'

type DismissableOverlay = {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onClick: (event: MouseEvent<HTMLDivElement>) => void
}

// Shared dismiss behaviour for the full-screen modals: click the backdrop or press
// Escape to close. Spread the returned handlers onto the backdrop element itself — the
// dismiss test is `target === currentTarget`, so every descendant is inert by
// construction and no modal has to enumerate the regions that must not close.
//
// `dismissable: false` (a running install, say) suppresses both routes, so a modal that
// must not be abandoned cannot be dismissed by an errant click or keypress.
export function useDismissableOverlay(
  onDismiss: () => void,
  dismissable = true,
): DismissableOverlay {
  // A click only counts when the gesture both started and ended on the backdrop.
  // Selecting text inside the card and releasing outside it fires a click whose target
  // is the backdrop; without this the modal would close mid-drag.
  const pressedBackdrop = useRef(false)
  // Callers pass inline closures, so keeping the callback in a ref stops the Escape
  // listener from being torn down and re-added on every parent render.
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    if (!dismissable) return undefined

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      dismissRef.current()
    }

    // Capture phase, so the modal wins over any Escape handling further down the tree.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [dismissable])

  function isBackdrop(event: SyntheticEvent<HTMLDivElement>): boolean {
    return event.target === event.currentTarget
  }

  return {
    onPointerDown: (event) => {
      pressedBackdrop.current = isBackdrop(event)
    },
    onClick: (event) => {
      const dismissed = pressedBackdrop.current && isBackdrop(event)
      pressedBackdrop.current = false
      if (dismissed && dismissable) onDismiss()
    },
  }
}
