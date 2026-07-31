//! Clearing what visited sites left behind.
//!
//! Separate from `content_blocking` because the two solve opposite halves of the
//! same problem: that module stops data being set, this one removes what already
//! was. No platform exposes this through Tauri or wry, so each reaches its
//! native API directly.
//!
//! | Platform | Mechanism |
//! |---|---|
//! | macOS | `WKWebsiteDataStore::removeDataOfTypes` |
//! | Linux | `webkit_website_data_manager_clear` |
//! | Windows | `ICoreWebView2Profile::ClearBrowsingDataAll` (runtime 1.0.1518.46+) |
//!
//! Scope everywhere is the **shared, default** store — the one every non-private
//! tab uses. Private and container tabs have their own stores and are untouched:
//! a private tab's store is discarded with its webview anyway, and silently
//! wiping a container the user set up deliberately would be a surprise.
//!
//! This touches nothing ÆTHER itself stores. Captures, collections,
//! conversations and the vector store are all unaffected; it is the browser's
//! cookie jar and caches, nothing else.

use super::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::clear;

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
mod gtk;
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
use gtk::clear;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::clear;

/// Clears cookies, caches, local storage and the rest of the webview's site data.
///
/// Returns once the removal has been *requested*. Every platform's API is
/// asynchronous and the work is quick, but a caller must not read a successful
/// return as "the disk is clean by the time this returns".
#[tauri::command]
pub(crate) async fn aether_browser_clear_data(app: AppHandle) -> Cmd<()> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();

    // Every one of these APIs is main-thread-only, and Tauri commands are not on
    // it: WKWebsiteDataStore wants the main thread, GTK wants its main loop
    // thread, and WebView2 is single-threaded-apartment bound.
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(clear(&handle));
    })
    .map_err(|error| format!("Could not reach the main thread: {error}"))?;

    receiver
        .await
        .map_err(|_| "Clearing browsing data did not report back.".to_string())?
}
