/// <reference types="vite/client" />

import { AetherApi, NativeTabEvent } from '../../shared/aether'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    aether: AetherApi
    // Android only: called by the Kotlin TabsPlugin via evaluateJavascript.
    __AETHER_TAB_EVENT__?: (event: NativeTabEvent) => void
  }
}
