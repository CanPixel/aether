import { AetherApi } from '../shared/aether'

declare global {
  interface Window {
    aether: AetherApi
  }
}
