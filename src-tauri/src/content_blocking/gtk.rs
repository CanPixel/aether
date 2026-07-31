//! WebKitGTK's content filters.
//!
//! WebKitGTK consumes **the same JSON rule format** as WKContentRuleList — same
//! `trigger`/`action` shape, same regex limitations — so the rules file is shared
//! with macOS verbatim rather than being a second list to keep in sync.
//!
//! The safe `webkit2gtk` crate does not bind `WebKitUserContentFilterStore`
//! (only its error enum), so this goes through `webkit2gtk_sys` directly. The
//! save is asynchronous in the GLib sense: `..._save` takes a
//! `GAsyncReadyCallback`, and the compiled filter is collected in that callback
//! with `..._save_finish`.
//!
//! Everything here runs on the GTK main thread, which is where webview creation
//! and the GLib main loop both live. That is what makes the thread-local below
//! sound: it is only ever touched from that one thread.

use super::*;

use std::cell::RefCell;
use std::ffi::{c_char, CString};
use std::ptr;
// Through webkit2gtk's re-exports, never as separate crates: see Cargo.toml.
use webkit2gtk::glib::translate::ToGlibPtr;
use webkit2gtk::{ffi as wk, gio, glib, WebViewExt};

thread_local! {
    /// The compiled filter, once the async save has produced it. Raw because
    /// `WebKitUserContentFilter` has no safe binding; it is reference-counted by
    /// GLib and this holds one reference for the process lifetime.
    static COMPILED_FILTER: RefCell<Option<*mut wk::WebKitUserContentFilter>> =
        const { RefCell::new(None) };
}

/// Passed through the GLib callback as `user_data` so the completion can apply
/// the filter to webviews that already exist.
struct SaveContext {
    app: AppHandle,
}

/// Collects the compiled filter and applies it to every open webview.
///
/// # Safety
/// Called by GLib as a `GAsyncReadyCallback`. `user_data` is the leaked
/// `Box<SaveContext>` from `compile_on_startup`, reclaimed exactly once here.
unsafe extern "C" fn on_filter_saved(
    store: *mut glib::gobject_ffi::GObject,
    result: *mut gio::ffi::GAsyncResult,
    user_data: glib::ffi::gpointer,
) {
    let context = unsafe { Box::from_raw(user_data as *mut SaveContext) };
    let mut error: *mut glib::ffi::GError = ptr::null_mut();
    let filter = unsafe {
        wk::webkit_user_content_filter_store_save_finish(
            store as *mut wk::WebKitUserContentFilterStore,
            result,
            &mut error,
        )
    };

    if filter.is_null() {
        let reason = if error.is_null() {
            "unknown error".to_string()
        } else {
            let message = unsafe { std::ffi::CStr::from_ptr((*error).message) }
                .to_string_lossy()
                .into_owned();
            unsafe { glib::ffi::g_error_free(error) };
            message
        };
        // One malformed rule rejects the whole list, exactly as on macOS.
        diag_error!("content blocking: filter failed to compile: {reason}");
        return;
    }

    COMPILED_FILTER.with(|slot| *slot.borrow_mut() = Some(filter));
    diag_info!("content blocking: filter compiled");

    for webview in context.app.webviews().values() {
        apply_to_webview(webview);
    }
}

pub(crate) fn apply_to_webview(webview: &Webview) {
    let result = webview.with_webview(|platform| {
        let Some(filter) = COMPILED_FILTER.with(|slot| *slot.borrow()) else {
            // The startup save has not finished yet; it applies to open webviews
            // when it does, so this is not an error.
            return;
        };
        let Some(manager) = platform.inner().user_content_manager() else {
            diag_error!("content blocking: webview has no user content manager");
            return;
        };
        // SAFETY: both pointers are live GObjects owned elsewhere, and we are on
        // the GTK main thread. add_filter takes its own reference.
        unsafe {
            wk::webkit_user_content_manager_add_filter(
                manager.to_glib_none().0,
                filter,
            )
        };
    });
    if let Err(error) = result {
        diag_error!("content blocking: could not reach the webview: {error}");
    }
}

pub(crate) fn compile_on_startup(app: &AppHandle) {
    // The store is a directory of compiled filters. Keeping it beside the app's
    // other data means an uninstall takes it with everything else.
    let Ok(store_dir) = app.path().app_data_dir() else {
        diag_error!("content blocking: no app data dir for the filter store");
        return;
    };
    let store_dir = store_dir.join("content-filters");
    if let Err(error) = std::fs::create_dir_all(&store_dir) {
        diag_error!("content blocking: could not create the filter store: {error}");
        return;
    }

    let Ok(store_path) = CString::new(store_dir.to_string_lossy().as_bytes()) else {
        diag_error!("content blocking: filter store path is not representable");
        return;
    };
    let Ok(identifier) = CString::new(RULE_LIST_IDENTIFIER) else {
        return;
    };
    let source = glib::Bytes::from_static(RULES_JSON.as_bytes());
    let context = Box::into_raw(Box::new(SaveContext { app: app.clone() }));

    // SAFETY: the store is created here and owned by GLib; `source` outlives the
    // call because save() takes a reference to the GBytes. `context` is
    // reclaimed in on_filter_saved, which GLib guarantees runs exactly once.
    unsafe {
        let store = wk::webkit_user_content_filter_store_new(
            store_path.as_ptr() as *const c_char,
        );
        if store.is_null() {
            drop(Box::from_raw(context));
            diag_error!("content blocking: could not open the filter store");
            return;
        }
        wk::webkit_user_content_filter_store_save(
            store,
            identifier.as_ptr() as *const c_char,
            source.to_glib_none().0,
            ptr::null_mut(),
            Some(on_filter_saved),
            context as glib::ffi::gpointer,
        );
    }
}
