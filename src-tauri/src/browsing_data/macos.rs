//! `WKWebsiteDataStore`. See the parent module for scope.

use super::*;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_foundation::NSDate;
use objc2_web_kit::WKWebsiteDataStore;

pub(crate) fn clear(_app: &AppHandle) -> Result<(), String> {
    let Some(mtm) = MainThreadMarker::new() else {
        return Err("Clearing browsing data must run on the main thread.".to_string());
    };

    let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm) };
    let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
    // Epoch rather than "since app start": the point of the button is to remove
    // what is already there, which is mostly older than this session.
    let epoch = NSDate::dateWithTimeIntervalSince1970(0.0);

    let done = RcBlock::new(move || {
        diag_info!("browsing data cleared");
    });

    unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &epoch, &done) };
    Ok(())
}
