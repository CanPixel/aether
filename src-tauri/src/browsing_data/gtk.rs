//! `WebKitWebsiteDataManager`. See the parent module for scope.
//!
//! The safe `webkit2gtk` crate does not bind `clear()`, so this uses
//! `webkit2gtk_sys`. A timespan of zero means "everything, regardless of age",
//! matching the epoch cutoff the macOS path uses.

use super::*;

use std::ptr;
// Through webkit2gtk's re-exports, never as separate crates: see Cargo.toml.
use webkit2gtk::glib::translate::ToGlibPtr;
use webkit2gtk::{ffi as wk, WebViewExt};

pub(crate) fn clear(app: &AppHandle) -> Result<(), String> {
    // Every tab shares the default web context, so clearing through any live
    // webview clears the store all of them use. Private tabs have their own
    // ephemeral context and are deliberately untouched.
    let webviews = app.webviews();
    let Some(webview) = webviews.values().next() else {
        // Nothing has been opened yet, so there is nothing to clear.
        return Ok(());
    };

    webview
        .with_webview(|platform| {
            let Some(manager) = platform.inner().website_data_manager() else {
                diag_error!("clear browsing data: no website data manager");
                return;
            };
            // SAFETY: the manager is a live GObject owned by the web context and
            // we are on the GTK main thread. A null callback is allowed; the
            // clear still runs, we simply do not observe completion.
            unsafe {
                wk::webkit_website_data_manager_clear(
                    manager.to_glib_none().0,
                    wk::WEBKIT_WEBSITE_DATA_ALL,
                    0,
                    ptr::null_mut(),
                    None,
                    ptr::null_mut(),
                )
            };
            diag_info!("browsing data cleared");
        })
        .map_err(|error| format!("Could not reach the webview: {error}"))
}
