/// <reference types="vite/client" />

import { AetherApi } from '../../shared/aether'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    aether: AetherApi
  }
}
