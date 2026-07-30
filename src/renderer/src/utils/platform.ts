// Tauri creates one hidden child webview per browser tab, but that API
// (`Window::add_child`) exists only on desktop. On Android, tabs are native
// android.webkit.WebViews managed by the Kotlin TabsPlugin; the renderer only
// marks where they belong (see MobileTabView) and forwards their events, and
// hardware-back is routed through the `app` plugin's `back-button` event
// instead of a window menu.
export const IS_ANDROID = /\bandroid\b/i.test(navigator.userAgent)

export const HAS_NATIVE_TAB_WEBVIEWS = !IS_ANDROID

export const IS_MACOS = !IS_ANDROID && /\bMacintosh\b/i.test(navigator.userAgent)

// Clearing browsing data is implemented on all three desktop platforms
// (src-tauri/src/browsing_data/), and the command itself is `#[cfg(desktop)]`, so
// Android is the only place the control would be a button that does nothing.
export const IS_DESKTOP = !IS_ANDROID
