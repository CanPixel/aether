//! Proves that WebKit itself accepts resources/content-blocking-rules.json.
//!
//! The unit tests in src/content_blocking.rs check the *shape* of the rules
//! against what the documentation says WebKit wants. Only WebKit can say whether
//! it agrees, and when it does not it fails asynchronously at runtime and
//! blocking is silently off. This binary closes that gap:
//!
//!     cargo run --example verify_content_rules
//!
//! It needs a main thread and a run loop, which is why it is an example rather
//! than a `#[test]` — cargo runs tests on worker threads.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("content rule lists are a WebKit API; nothing to verify on this platform.");
}

#[cfg(target_os = "macos")]
fn main() {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSDate, NSError, NSRunLoop, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore};
    use std::cell::Cell;
    use std::rc::Rc;

    const RULES_JSON: &str = include_str!("../resources/content-blocking-rules.json");
    // Deliberately not the identifier the app uses: compiling under that name
    // would leave this harness's build cached in the real store.
    const IDENTIFIER: &str = "aether-content-rules-verification";

    let mtm = MainThreadMarker::new().expect("examples start on the main thread");
    let store = unsafe { WKContentRuleListStore::defaultStore(mtm) }.expect("default store");

    let rule_count = RULES_JSON.matches("\"trigger\"").count();
    println!("compiling {rule_count} rules through WKContentRuleListStore...");

    // Set by the completion handler; the run loop below spins until it is.
    let outcome: Rc<Cell<Option<bool>>> = Rc::new(Cell::new(None));
    let handler_outcome = outcome.clone();

    let handler = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
        if list.is_null() {
            let reason = unsafe { error.as_ref() }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "unknown error".to_string());
            eprintln!("REJECTED: {reason}");
            handler_outcome.set(Some(false));
        } else {
            // Retain and drop it, so this also exercises the path the app takes.
            let _list: Option<Retained<WKContentRuleList>> = unsafe { Retained::retain(list) };
            println!("ACCEPTED: WebKit compiled all {rule_count} rules.");
            handler_outcome.set(Some(true));
        }
    });

    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(IDENTIFIER)),
            Some(&NSString::from_str(RULES_JSON)),
            Some(&handler),
        )
    };

    let run_loop = NSRunLoop::currentRunLoop();
    for _ in 0..100 {
        if outcome.get().is_some() {
            break;
        }
        run_loop.runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.1));
    }

    // Leave nothing behind in the shared store.
    unsafe {
        store.removeContentRuleListForIdentifier_completionHandler(
            Some(&NSString::from_str(IDENTIFIER)),
            None,
        )
    };

    match outcome.get() {
        Some(true) => {}
        Some(false) => std::process::exit(1),
        None => {
            eprintln!("TIMED OUT: the compiler never called back.");
            std::process::exit(1);
        }
    }
}
