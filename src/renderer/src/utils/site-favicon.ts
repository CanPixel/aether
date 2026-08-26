import { useEffect, useState } from 'react'
import { AetherApi } from '../../../shared/aether'

// Tab and shortcut records still carry `https://<host>/favicon.ico` as their
// favicon field, because that value is persisted in the session and the hub. It
// is a key here, never an <img src>: rendering it directly is what made the
// privileged window call out to every visited host. The bytes come from Rust.

// Keyed by that URL, which is already one entry per host. Rust caches too, but
// without this every re-render of every tab chip costs an IPC round trip.
const resolved = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

function resolveFavicon(api: AetherApi, iconUrl: string): Promise<string | null> {
  const existing = inFlight.get(iconUrl)
  if (existing) return existing

  const request = api.tabs
    .favicon(iconUrl)
    .catch(() => null)
    .then((dataUri) => {
      resolved.set(iconUrl, dataUri)
      inFlight.delete(iconUrl)
      return dataUri
    })

  inFlight.set(iconUrl, request)
  return request
}

/**
 * Turns a site's favicon URL into a `data:` URI, or undefined while it is being
 * fetched and null-equivalent (undefined) when the host has no usable icon.
 * Callers fall back to their own globe glyph.
 */
export function useSiteFavicon(iconUrl?: string): string | undefined {
  const [dataUri, setDataUri] = useState<string | undefined>(() =>
    iconUrl ? (resolved.get(iconUrl) ?? undefined) : undefined,
  )

  useEffect(() => {
    if (!iconUrl) {
      setDataUri(undefined)
      return
    }
    if (resolved.has(iconUrl)) {
      setDataUri(resolved.get(iconUrl) ?? undefined)
      return
    }

    let active = true
    void resolveFavicon(window.aether, iconUrl).then((value) => {
      if (active) setDataUri(value ?? undefined)
    })
    return () => {
      active = false
    }
  }, [iconUrl])

  return dataUri
}
