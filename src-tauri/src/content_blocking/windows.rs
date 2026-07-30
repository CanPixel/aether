//! WebView2 request filtering.
//!
//! **This is the odd one out.** macOS and Linux both take a declarative rule
//! list that the engine evaluates inside its own network path. WebView2 has no
//! such concept, so blocking here is a per-request callback: every request is
//! surfaced to `WebResourceRequested`, and this decides.
//!
//! Consequences worth knowing before treating the three platforms as equivalent:
//!
//! - **Every request crosses the COM boundary**, where on WebKit a blocked
//!   request never reaches us at all. It is a hot path, so matching is kept to a
//!   lowercase suffix comparison and nothing more. The scan is linear over
//!   `blocked_hosts()`, which the shared rule file keeps to a few dozen entries —
//!   small enough that a set would cost more in hashing than it saves. If that
//!   list ever grows by an order of magnitude, this is the line to revisit.
//! - **Third-party cookies are not blocked here.** The `block-cookies` rule has
//!   no WebView2 equivalent; a request either happens or does not. Only the
//!   blocklisted hosts are stopped, so a tracker not on the list still sets
//!   third-party cookies on Windows. This is the largest per-platform gap.
//! - **"Third-party" is inferred**, by comparing the request's host against the
//!   top-level document's. WebKit knows the real load type; we approximate it.
//!
//! There is no `verify_content_rules` equivalent to run here: correctness is
//! `blocked_hosts()` (shared, and unit-tested in the parent module) plus the
//! matching below.

use super::*;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
};
use webview2_com::WebResourceRequestedEventHandler;
// Leading `::` is load-bearing: this module is itself named `windows`, and the
// `use super::*` above brings that name into scope from the parent, so a bare
// `windows::` is ambiguous between this module and the crate (E0659).
use ::windows::core::{HSTRING, PCWSTR, PWSTR};
use ::windows::Win32::System::Com::CoTaskMemFree;

/// Reads a WebView2 string out-parameter and frees it.
///
/// `Uri()` and `Source()` do not *return* the string — they take a `*mut PWSTR`
/// and hand back COM-allocated memory that the caller owns. Reading it without
/// `CoTaskMemFree` leaks a little on every single request, and this runs on every
/// request the browser makes.
///
/// # Safety
/// `value` must be a PWSTR that WebView2 allocated and handed to us.
unsafe fn take_pwstr(value: PWSTR) -> String {
    if value.is_null() {
        return String::new();
    }
    let text = unsafe { value.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(value.0 as *const std::ffi::c_void)) };
    text
}

/// Registrable-domain comparison without a public suffix list: the last two
/// labels. Wrong for `co.uk`-style suffixes, which makes it *over*-report
/// third-partyness there — the safe direction, since the host still has to be on
/// the blocklist before anything is blocked.
fn same_site(a: &str, b: &str) -> bool {
    fn registrable(host: &str) -> String {
        let labels = host.rsplit('.').take(2).collect::<Vec<_>>();
        labels.join(".")
    }
    !a.is_empty() && !b.is_empty() && registrable(a) == registrable(b)
}

fn host_of(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()?
        .host_str()
        .map(|host| host.to_ascii_lowercase())
}

/// True when `host` is the blocked domain or a subdomain of it, mirroring the
/// `([^/]+\.)?` prefix the WebKit filters use.
fn is_blocked_host(host: &str, blocklist: &[String]) -> bool {
    blocklist.iter().any(|blocked| {
        host == blocked
            || (host.len() > blocked.len()
                && host.ends_with(blocked.as_str())
                && host.as_bytes()[host.len() - blocked.len() - 1] == b'.')
    })
}

pub(crate) fn apply_to_webview(webview: &Webview) {
    let blocklist = blocked_hosts();
    let result = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            diag_error!("content blocking: no CoreWebView2 on this controller");
            return;
        };

        // Ask to see every request. Without the filter the event never fires.
        if let Err(error) = unsafe {
            core.AddWebResourceRequestedFilter(
                PCWSTR(HSTRING::from("*").as_ptr()),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            )
        } {
            diag_error!("content blocking: could not add a request filter: {error}");
            return;
        }

        let environment = platform.environment();
        let mut token = 0;
        let handler = WebResourceRequestedEventHandler::create(Box::new(
            move |sender: Option<ICoreWebView2>, args| {
                let (Some(sender), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                let request = unsafe { args.Request() }?;
                let mut raw_uri = PWSTR::null();
                unsafe { request.Uri(&mut raw_uri) }?;
                let uri = unsafe { take_pwstr(raw_uri) };
                let Some(host) = host_of(&uri) else {
                    return Ok(());
                };
                if !is_blocked_host(&host, &blocklist) {
                    return Ok(());
                }

                // Mirrors `load-type: third-party` on the WebKit rules: never
                // block the document the user actually asked for.
                let mut raw_source = PWSTR::null();
                let top_level = if unsafe { sender.Source(&mut raw_source) }.is_ok() {
                    host_of(&unsafe { take_pwstr(raw_source) }).unwrap_or_default()
                } else {
                    String::new()
                };
                if same_site(&host, &top_level) {
                    return Ok(());
                }

                // An empty 403 rather than a failed request: a hard network
                // failure makes some pages retry in a loop.
                let response = unsafe {
                    environment.CreateWebResourceResponse(
                        None,
                        403,
                        PCWSTR(HSTRING::from("Blocked").as_ptr()),
                        PCWSTR(HSTRING::from("").as_ptr()),
                    )
                }?;
                unsafe { args.SetResponse(&response) }?;
                Ok(())
            },
        ));

        if let Err(error) = unsafe { core.add_WebResourceRequested(&handler, &mut token) } {
            diag_error!("content blocking: could not attach the request handler: {error}");
        }
    });
    if let Err(error) = result {
        diag_error!("content blocking: could not reach the webview: {error}");
    }
}

/// Nothing to compile: the host list is derived from the rule file on demand.
/// Kept so the call site in lib.rs stays platform-agnostic.
pub(crate) fn compile_on_startup(_app: &AppHandle) {
    diag_info!(
        "content blocking: WebView2 filters per request; {} hosts blocked",
        blocked_hosts().len()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdomains_of_a_blocked_host_are_blocked() {
        let blocklist = vec!["doubleclick.net".to_string()];
        assert!(is_blocked_host("doubleclick.net", &blocklist));
        assert!(is_blocked_host("stats.g.doubleclick.net", &blocklist));
    }

    // The dangerous false positive: a different registrable domain that merely
    // ends with the same text.
    #[test]
    fn lookalike_hosts_are_not_blocked() {
        let blocklist = vec!["doubleclick.net".to_string()];
        assert!(!is_blocked_host("notdoubleclick.net", &blocklist));
        assert!(!is_blocked_host("doubleclick.net.evil.com", &blocklist));
        assert!(!is_blocked_host("example.com", &blocklist));
    }

    #[test]
    fn same_site_ignores_subdomains_but_separates_real_sites() {
        assert!(same_site("cdn.example.com", "www.example.com"));
        assert!(!same_site("tracker.net", "example.com"));
        assert!(!same_site("", "example.com"));
    }
}
