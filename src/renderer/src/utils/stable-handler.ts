import { useCallback, useLayoutEffect, useRef } from 'react'

// Gives an event handler a permanent identity without pinning the values it closes
// over.
//
// App holds most of its handlers as plain `async function` declarations, so every
// render produces new function objects and every child receiving one re-renders
// with it. That is what made React.memo pointless on the four big panels: their
// props were never equal twice.
//
// The usual fix is useCallback with a dependency array, but these handlers read
// from across a component with dozens of state values, and a dependency list that
// is subtly short does not fail loudly — it silently serves stale state. This
// trades that risk away: the ref is refreshed on every commit, so the call always
// runs the newest closure while the identity handed to children never changes.
// It is the same shape as React's own useEffectEvent.
//
// Only for handlers invoked in response to something happening — an event, an
// effect, a timeout. A function called *during* render must not go through this:
// the ref is updated in a layout effect, so a render-phase caller can read the
// previous render's closure. Everything wrapped here is passed to a child as a
// callback and invoked later, which is exactly the supported case.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStableHandler<T extends (...args: any[]) => any>(handler: T): T {
  const ref = useRef(handler)

  // Layout, not passive: this must be current before any child effect can fire a
  // handler, and a passive effect runs too late to guarantee that.
  useLayoutEffect(() => {
    ref.current = handler
  })

  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, [])
}
