//! `ICoreWebView2Profile::ClearBrowsingDataAll`. See the parent module for scope.
//!
//! Needs `ICoreWebView2_13`, which is WebView2 runtime 1.0.1518.46 or newer. On
//! an older runtime the cast fails and this reports that rather than silently
//! doing nothing — a "Clear" button that quietly no-ops is worse than one that
//! says it cannot.

use super::*;

use webview2_com::ClearBrowsingDataCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile2, ICoreWebView2_13};
use windows::core::Interface;

pub(crate) fn clear(app: &AppHandle) -> Result<(), String> {
    // Every non-private tab shares one profile, so clearing through any live
    // webview clears the store all of them use.
    let webviews = app.webviews();
    let Some(webview) = webviews.values().next() else {
        return Ok(());
    };

    let outcome: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let reported = Arc::clone(&outcome);

    webview
        .with_webview(move |platform| {
            let record = |message: &str| {
                if let Ok(mut slot) = reported.lock() {
                    *slot = Some(message.to_string());
                }
            };

            let controller = platform.controller();
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                record("No CoreWebView2 on this controller.");
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_13>() else {
                record("Clearing browsing data needs WebView2 runtime 1.0.1518.46 or newer.");
                return;
            };
            let Ok(profile) = (unsafe { core.Profile() }) else {
                record("Could not reach the WebView2 profile.");
                return;
            };
            // ClearBrowsingDataAll lives on Profile2, not Profile — a second
            // runtime-version gate on top of the ICoreWebView2_13 cast above.
            let Ok(profile) = profile.cast::<ICoreWebView2Profile2>() else {
                record("Clearing browsing data needs a newer WebView2 runtime.");
                return;
            };

            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |_result| {
                diag_info!("browsing data cleared");
                Ok(())
            }));
            if unsafe { profile.ClearBrowsingDataAll(&handler) }.is_err() {
                record("WebView2 refused the clear request.");
            }
        })
        .map_err(|error| format!("Could not reach the webview: {error}"))?;

    match outcome.lock().ok().and_then(|slot| slot.clone()) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}
