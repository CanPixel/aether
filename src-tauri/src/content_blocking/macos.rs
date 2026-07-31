//! WKContentRuleList. See the parent module for the rules and their constraints.

use super::*;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKUserContentController};

/// Adds the compiled list to one webview's user-content controller.
///
/// `controller` is the `WKUserContentController` behind
/// `PlatformWebview::controller()`. It is retained for the duration of the
/// lookup: the callback is asynchronous, and a tab closed in that window would
/// otherwise leave a dangling pointer.
fn apply_to_controller(controller: *mut std::ffi::c_void) {
    let Some(mtm) = MainThreadMarker::new() else {
        diag_error!("content blocking: not on the main thread; skipping");
        return;
    };
    if controller.is_null() {
        return;
    }

    // SAFETY: wry hands back the WKUserContentController it built the webview
    // with, and we are on the main thread. retain() balances on drop.
    let controller: Retained<WKUserContentController> =
        match unsafe { Retained::retain(controller.cast()) } {
            Some(controller) => controller,
            None => return,
        };

    let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
        diag_error!("content blocking: no default rule list store");
        return;
    };
    let identifier = NSString::from_str(RULE_LIST_IDENTIFIER);

    let handler = RcBlock::new(move |list: *mut WKContentRuleList, _error: *mut NSError| {
        if list.is_null() {
            // Expected on a first run whose compile has not landed yet; the
            // startup path applies it when it does.
            return;
        }
        // SAFETY: WebKit hands the list to the block; retain it for the add.
        let Some(list) = (unsafe { Retained::retain(list) }) else {
            return;
        };
        unsafe { controller.addContentRuleList(&list) };
    });

    unsafe {
        store.lookUpContentRuleListForIdentifier_completionHandler(
            Some(&identifier),
            Some(&handler),
        )
    };
}

pub(crate) fn apply_to_webview(webview: &Webview) {
    let result = webview.with_webview(|platform| {
        apply_to_controller(platform.controller());
    });
    if let Err(error) = result {
        diag_error!("content blocking: could not reach the webview: {error}");
    }
}

pub(crate) fn compile_on_startup(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        diag_error!("content blocking: startup compile is not on the main thread");
        return;
    };

    let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
        diag_error!("content blocking: no default rule list store");
        return;
    };
    let identifier = NSString::from_str(RULE_LIST_IDENTIFIER);
    let rules = NSString::from_str(RULES_JSON);
    let app = app.clone();

    let handler = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
        if list.is_null() {
            // A malformed rule fails the whole list, so this is the line that
            // says why blocking is silently off.
            let reason = unsafe { error.as_ref() }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "unknown error".to_string());
            diag_error!("content blocking: rule list failed to compile: {reason}");
            return;
        }
        diag_info!("content blocking: rule list compiled");

        // Tabs restored from the previous session already exist by now.
        for webview in app.webviews().values() {
            apply_to_webview(webview);
        }
    });

    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&identifier),
            Some(&rules),
            Some(&handler),
        )
    };
}
