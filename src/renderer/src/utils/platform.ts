// Tauri creates one hidden child webview per browser tab, but that API
// (`Window::add_child`) exists only on desktop. On Android, tabs are native
// android.webkit.WebViews managed by the Kotlin TabsPlugin; the renderer only
// marks where they belong (see MobileTabView) and forwards their events, and
// hardware-back is routed through the `app` plugin's `back-button` event
// instead of a window menu.
export const IS_ANDROID = /\bandroid\b/i.test(navigator.userAgent)

export const HAS_NATIVE_TAB_WEBVIEWS = !IS_ANDROID

// WKWebsiteDataStore has no equivalent wired up on the other platforms yet, so
// the Clear Browsing Data control would be a button that does nothing there.
export const IS_MACOS = !IS_ANDROID && /\bMacintosh\b/i.test(navigator.userAgent)
