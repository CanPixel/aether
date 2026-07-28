//! Tracker blocking.
//!
//! WebKit's content-rule engine runs *inside* the network path: a blocked
//! request is never made, rather than made and discarded. Neither Tauri nor wry
//! exposes it, so the platform modules reach the native APIs directly.
//!
//! | Platform | Mechanism | Third-party cookies |
//! |---|---|---|
//! | macOS | `WKContentRuleList` | yes, `block-cookies` rule |
//! | Linux | `WebKitUserContentFilterStore` (same JSON) | yes, same rule |
//! | Windows | `WebResourceRequested` host matching | no — see `windows.rs` |
//!
//! macOS and Linux share `resources/content-blocking-rules.json` verbatim,
//! because WebKitGTK consumes the same format. Windows has no rule-list concept
//! at all, so it re-derives a host list from the same file rather than carrying
//! a second copy of the domains.
//!
//! ## The two rule-file constraints
//!
//! Both are silent failures — one bad rule rejects the **entire** list at
//! runtime and blocking is simply off, with nothing visible to say so:
//!
//! 1. **`url-filter` does not support alternation.** `criteo\.(com|net)` fails
//!    with "Disjunctions are not supported yet". Split it into two rules. There
//!    is a unit test for this.
//! 2. **A rule object takes exactly `trigger` and `action`.** Any other key —
//!    including `_comment` — rejects the list, which is why the rules are
//!    documented here and not inline.
//!
//! After editing the rules, run the harness that compiles them through WebKit
//! itself, because the unit tests below only check them against what the
//! documentation *claims*:
//!
//! ```text
//! cargo run --example verify_content_rules
//! ```
//!
//! ## Lifecycle
//!
//! Compilation is asynchronous on every platform that has it, so there are two
//! paths and both are needed: (1) compile at startup, then apply to every
//! webview that already exists, and (2) apply to each webview as it is created.
//! (1) alone misses tabs opened later; (2) alone leaves the first launch
//! unprotected until a restart.

use super::*;

/// Identifier the compiled list is cached under. Changing it orphans the
/// previously compiled list in the store rather than replacing it, so it should
/// change only when the rules themselves change shape.
const RULE_LIST_IDENTIFIER: &str = "aether-tracker-blocking-v1";

/// Compiled into the binary; see resources/content-blocking-rules.json.
const RULES_JSON: &str = include_str!("../resources/content-blocking-rules.json");

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::{apply_to_webview, compile_on_startup};

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
mod gtk;
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
pub(crate) use gtk::{apply_to_webview, compile_on_startup};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::{apply_to_webview, compile_on_startup};

/// What this build actually blocks, for the renderer to state plainly.
///
/// Derived here rather than written into the UI because the three platforms do
/// genuinely different things, and a hardcoded string in the renderer would keep
/// claiming cookie blocking on Windows long after anyone remembered it was not
/// true. The gap is real and the honest place to say so is the screen the user
/// looks at, not a comment in windows.rs.
pub(crate) fn content_blocking_status() -> ContentBlockingStatus {
    // Counted from the same file every platform compiles, so the number cannot
    // describe a rule set the engine did not get.
    let blocked_host_count = rule_domain_count();

    #[cfg(target_os = "macos")]
    let (engine, blocks_third_party_cookies) = ("WebKit content rules", true);
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    let (engine, blocks_third_party_cookies) = ("WebKitGTK content filters", true);
    #[cfg(windows)]
    let (engine, blocks_third_party_cookies) = ("WebView2 request filtering", false);
    #[cfg(target_os = "android")]
    let (engine, blocks_third_party_cookies) = ("", false);

    ContentBlockingStatus {
        engine: engine.to_string(),
        blocked_host_count,
        blocks_third_party_cookies,
        // Android tabs are native android.webkit.WebViews with no filter wired up.
        available: !engine.is_empty(),
    }
}

/// How many distinct domains the block rules name.
///
/// Shares `blocked_hosts()`'s parsing on Windows; elsewhere it counts blocking
/// rules directly, because the WebKit engine consumes the filters as written and
/// never needs them unescaped.
fn rule_domain_count() -> usize {
    let Ok(rules) = serde_json::from_str::<serde_json::Value>(RULES_JSON) else {
        return 0;
    };
    rules
        .as_array()
        .map(|rules| {
            rules
                .iter()
                .filter(|rule| rule["action"]["type"] == "block")
                .count()
        })
        .unwrap_or(0)
}

/// Every host the rules block, derived from the rule file at startup.
///
/// Only Windows needs this: WebView2 has no rule-list concept, so it matches
/// hosts per request instead. Parsing the same file keeps one source of truth —
/// a Windows-only domain list would drift from the WebKit one silently.
///
/// The filters are anchored regexes of a known shape
/// (`^https?://([^/]+\.)?example\.com`), so this unescapes that shape rather
/// than implementing a regex engine. A filter that does not match the shape is
/// skipped, which is why `blocklist_hosts_covers_every_blocking_rule` exists.
#[cfg(any(windows, test))]
pub(crate) fn blocked_hosts() -> Vec<String> {
    const PREFIX: &str = "^https?://([^/]+\\.)?";

    let Ok(rules) = serde_json::from_str::<serde_json::Value>(RULES_JSON) else {
        return Vec::new();
    };
    let Some(rules) = rules.as_array() else {
        return Vec::new();
    };

    rules
        .iter()
        .filter(|rule| rule["action"]["type"] == "block")
        .filter_map(|rule| rule["trigger"]["url-filter"].as_str())
        .filter_map(|filter| {
            let bare = filter
                .strip_prefix(PREFIX)
                .or_else(|| filter.strip_prefix("^https?://"))?;
            let host = bare.replace("\\.", ".");
            // A trailing dot comes from a deliberately open filter such as
            // `adservice\.google\.`, which covers every ccTLD.
            (!host.is_empty() && !host.contains(['(', ')', '[', ']', '|', '?', '*']))
                .then(|| host.trim_end_matches('.').to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A malformed list fails to compile at runtime and disables blocking
    // silently, which is exactly the failure this catches at build time instead.
    #[test]
    fn rules_are_valid_json_in_the_shape_webkit_expects() {
        let rules: serde_json::Value =
            serde_json::from_str(RULES_JSON).expect("rules must be valid JSON");
        let rules = rules.as_array().expect("rules must be a JSON array");
        assert!(!rules.is_empty());

        for rule in rules {
            let trigger = rule
                .get("trigger")
                .unwrap_or_else(|| panic!("rule without a trigger: {rule}"));
            assert!(
                trigger.get("url-filter").and_then(|f| f.as_str()).is_some(),
                "trigger without a url-filter: {rule}"
            );
            let action_type = rule
                .get("action")
                .and_then(|action| action.get("type"))
                .and_then(|value| value.as_str())
                .unwrap_or_else(|| panic!("rule without an action type: {rule}"));
            assert!(
                matches!(
                    action_type,
                    "block" | "block-cookies" | "css-display-none" | "ignore-previous-rules"
                ),
                "unsupported action type {action_type} in {rule}"
            );
            // WebKit rejects the whole list on an unknown key, which is why the
            // documentation for these rules lives in the module comment and not
            // in "_comment" fields inside the JSON.
            for key in rule.as_object().expect("rule must be an object").keys() {
                assert!(
                    matches!(key.as_str(), "trigger" | "action"),
                    "unexpected key {key} in {rule}"
                );
            }
        }
    }

    // The cookie rule is the only defence against third-party cookies on macOS
    // and Linux, so its loss would be silent and total.
    #[test]
    fn third_party_cookies_are_blocked_globally() {
        let rules: serde_json::Value = serde_json::from_str(RULES_JSON).unwrap();
        let cookie_rule = rules
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["action"]["type"] == "block-cookies")
            .expect("a block-cookies rule must exist");
        assert_eq!(cookie_rule["trigger"]["url-filter"], ".*");
        assert_eq!(cookie_rule["trigger"]["load-type"][0], "third-party");
    }

    // WebKit's url-filter engine rejects alternation outright ("Disjunctions are
    // not supported yet"), and one bad filter fails the *entire* list, so a
    // single `(com|net)` silently turns off all blocking at runtime.
    #[test]
    fn url_filters_avoid_unsupported_regex_alternation() {
        let rules: serde_json::Value = serde_json::from_str(RULES_JSON).unwrap();
        for rule in rules.as_array().unwrap() {
            let filter = rule["trigger"]["url-filter"].as_str().unwrap();
            assert!(
                !filter.contains('|'),
                "url-filter uses alternation, which WebKit rejects: {filter}"
            );
        }
    }

    // Blocking a first-party load would break the site the user asked for.
    #[test]
    fn every_blocking_rule_is_scoped_to_third_party_loads() {
        let rules: serde_json::Value = serde_json::from_str(RULES_JSON).unwrap();
        for rule in rules.as_array().unwrap() {
            assert_eq!(
                rule["trigger"]["load-type"][0], "third-party",
                "rule is not third-party scoped: {rule}"
            );
        }
    }

    // Windows blocks by host rather than by rule, so a filter this parser cannot
    // read is a domain that is blocked on macOS and Linux but not on Windows —
    // a silent per-platform divergence.
    #[test]
    fn blocklist_hosts_covers_every_blocking_rule() {
        let rules: serde_json::Value = serde_json::from_str(RULES_JSON).unwrap();
        let expected = rules
            .as_array()
            .unwrap()
            .iter()
            .filter(|rule| rule["action"]["type"] == "block")
            .count();
        assert_eq!(
            blocked_hosts().len(),
            expected,
            "some url-filters could not be reduced to a host"
        );
    }

    // The reported count is what the Settings screen says out loud, so it has to
    // come from the rules the engine was actually given rather than a number
    // someone typed once.
    #[test]
    fn reported_domain_count_matches_the_rule_file() {
        let status = content_blocking_status();
        assert_eq!(status.blocked_host_count, blocked_hosts().len());
        assert!(status.blocked_host_count > 0);
    }

    // This is the assertion that keeps the UI honest. The cookie claim is the one
    // real behavioural difference between the platforms, and the failure mode it
    // guards is silent: a build that stops blocking cookies while still telling
    // the user it does is worse than one that never claimed to.
    #[test]
    fn cookie_blocking_is_reported_per_platform() {
        let status = content_blocking_status();

        #[cfg(any(
            target_os = "macos",
            all(unix, not(target_os = "macos"), not(target_os = "android"))
        ))]
        {
            assert!(status.available);
            assert!(
                status.blocks_third_party_cookies,
                "WebKit evaluates the block-cookies rule on this platform"
            );
        }

        #[cfg(windows)]
        {
            assert!(status.available);
            assert!(
                !status.blocks_third_party_cookies,
                "WebView2 has no block-cookies equivalent; claiming otherwise misleads"
            );
        }

        #[cfg(target_os = "android")]
        assert!(!status.available);

        assert_eq!(status.engine.is_empty(), !status.available);
    }

    #[test]
    fn blocked_hosts_are_bare_domains() {
        let hosts = blocked_hosts();
        assert!(hosts.contains(&"doubleclick.net".to_string()));
        assert!(hosts.contains(&"criteo.com".to_string()));
        assert!(hosts.contains(&"criteo.net".to_string()));
        // From `^https?://connect\.facebook\.com`, which has no optional prefix.
        assert!(hosts.contains(&"connect.facebook.com".to_string()));
        // From the deliberately open `adservice\.google\.`.
        assert!(hosts.contains(&"adservice.google".to_string()));
        for host in hosts {
            assert!(!host.contains('\\'), "{host} still carries regex escapes");
        }
    }
}
