//! Small pure helpers: string normalisation, URL tidying, slugs, ids, clocks.

use super::*;

pub(crate) fn reorder<T, F>(items: Vec<T>, ids: &[String], id_of: F) -> Vec<T>
where
    T: Clone,
    F: Fn(&T) -> &String,
{
    let requested = ids.iter().filter(|id| !id.is_empty()).collect::<Vec<_>>();
    let requested_set = requested
        .iter()
        .map(|id| (*id).clone())
        .collect::<HashSet<_>>();
    let by_id = items
        .iter()
        .map(|item| (id_of(item).clone(), item.clone()))
        .collect::<HashMap<_, _>>();
    let mut ordered = requested
        .into_iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect::<Vec<_>>();
    ordered.extend(
        items
            .into_iter()
            .filter(|item| !requested_set.contains(id_of(item))),
    );
    ordered
}

pub(crate) fn normalize_captured_text(text: &str) -> String {
    text.replace('\r', "")
        .split('\n')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Click identifiers, matched exactly. Each one exists to join a visit to an ad
/// impression or a mail send; none is load-bearing for rendering the page.
const TRACKING_PARAMS: [&str; 22] = [
    "fbclid",
    "gclid",
    "gclsrc",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "twclid",
    "ttclid",
    "igshid",
    "yclid",
    "li_fat_id",
    "mkt_tok",
    "mc_cid",
    "mc_eid",
    "s_kwcid",
    "ef_id",
    "epik",
    "irclickid",
    "rb_clickid",
    "vero_id",
    "oly_enc_id",
];

/// Whole families of analytics parameters. Kept narrow on purpose: a prefix that
/// is too greedy silently breaks real navigation, which is a worse failure than
/// leaking a campaign id, because the user cannot see it happen.
const TRACKING_PARAM_PREFIXES: [&str; 5] = ["utm_", "pk_", "_hsenc", "_hsmi", "hsa_"];

fn is_tracking_param(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    TRACKING_PARAMS.contains(&lowered.as_str())
        || TRACKING_PARAM_PREFIXES
            .iter()
            .any(|prefix| lowered.starts_with(prefix))
}

/// Removes click identifiers from an http(s) URL, leaving everything else byte
/// for byte. Returns the input unchanged when nothing matched, so ordinary
/// navigation never pays a URL-reserialisation round trip.
///
/// This runs on navigation *and* on capture, which matters twice over: the site
/// never receives the identifier, and it never reaches the local index either —
/// otherwise a captured URL would keep the ad attribution forever.
pub(crate) fn strip_tracking_params(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        return url.to_string();
    };
    if !matches!(parsed.scheme(), "http" | "https") || parsed.query().is_none() {
        return url.to_string();
    }

    let kept = parsed
        .query_pairs()
        .filter(|(key, _)| !is_tracking_param(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if kept.len() == parsed.query_pairs().count() {
        return url.to_string();
    }

    let mut cleaned = parsed.clone();
    if kept.is_empty() {
        cleaned.set_query(None);
    } else {
        cleaned.query_pairs_mut().clear().extend_pairs(kept);
    }
    cleaned.to_string()
}

pub(crate) fn normalize_url(raw_url: &str, search: SearchPrefs<'_>) -> String {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return search_engine_home(search).to_string();
    }
    if Url::parse(trimmed).is_ok() {
        return strip_tracking_params(trimmed);
    }
    if trimmed.contains(char::is_whitespace) || !trimmed.contains(['.', ':']) {
        return search_url(trimmed, search);
    }
    if trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || trimmed.starts_with("[::1]")
    {
        return format!("http://{trimmed}");
    }
    format!("https://{trimmed}")
}

/// Which engine a typed query goes to, and whether to ask that engine for results
/// without AI-generated answers.
///
/// The two travel together because they are one decision — "how does a query
/// become a URL" — and separating them is how a search path ends up honouring the
/// engine but quietly dropping the AI-free request, or the reverse.
#[derive(Clone, Copy)]
pub(crate) struct SearchPrefs<'a> {
    pub(crate) engine: &'a str,
    pub(crate) ai_free: bool,
}

impl SearchPrefs<'_> {
    /// For the paths that have no settings in hand: a link a page opened in a new
    /// tab, or a shortcut whose input is already a URL. The engine is only ever a
    /// fallback there — it applies when the input turns out to be a bare search
    /// term, which for those callers is the rare case, not the normal one.
    pub(crate) fn fallback() -> SearchPrefs<'static> {
        SearchPrefs {
            engine: DEFAULT_SEARCH_ENGINE,
            ai_free: default_ai_free_search(),
        }
    }
}

impl BrowserSettings {
    pub(crate) fn search_prefs(&self) -> SearchPrefs<'_> {
        SearchPrefs {
            engine: &self.default_search_engine,
            ai_free: self.ai_free_search,
        }
    }
}

/// How an engine lets a user refuse AI-generated answers — if it lets them at all.
///
/// Every variant below was checked against the engine's own documentation rather
/// than inferred, because the mechanisms are unrelated to each other and two of
/// the five engines have none. See docs/SECURITY.md for the sources.
pub(crate) enum AiFreeSearch {
    /// No URL-level opt-out exists. Yahoo has no control of its own (it serves
    /// Bing's results), and Ecosia's is an account setting that is also gated by
    /// region — neither can be asked for from a URL, so nothing is claimed.
    Unavailable,
    /// A query operator appended to the search terms. Bing's `-ai` is a real,
    /// documented operator, added in June 2026.
    QueryOperator(&'static str),
    /// A parameter on the search URL. Google's `udm=14` selects the "Web" vertical,
    /// which returns plain links and no AI Overview.
    ///
    /// Deliberately *not* Google's `-ai`: that is a Bing operator, and on Google it
    /// is an ordinary negative keyword that drops every result containing "ai" —
    /// which would quietly gut a search for an iCE concept like "neural network".
    UrlParam(&'static str),
    /// A different host serving the same engine with AI features off, which is how
    /// DuckDuckGo ships its opt-out.
    AltHost { search: &'static str, home: &'static str },
}

/// What AI-free search does for the engine the user has actually selected.
///
/// Derived from `ai_free_search` rather than written out again, so a mechanism
/// added or lost below cannot leave the Settings screen describing the old one.
pub(crate) fn ai_free_search_status(browser: &BrowserSettings) -> AiFreeSearchStatus {
    let mechanism = match ai_free_search(&browser.default_search_engine) {
        AiFreeSearch::UrlParam(param) => format!("{param} Web filter"),
        AiFreeSearch::QueryOperator(operator) => format!("{operator} operator"),
        AiFreeSearch::AltHost { home, .. } => home.trim_start_matches("https://").to_string(),
        AiFreeSearch::Unavailable => String::new(),
    };

    AiFreeSearchStatus {
        enabled: browser.ai_free_search,
        available: !mechanism.is_empty(),
        mechanism,
    }
}

/// Parse a proxy endpoint, rejecting anything the transports cannot carry.
///
/// Deliberately strict, and the accepted set is not a judgement call: Tauri's
/// `parse_proxy_url` maps exactly `http` and `socks5` to a wry `ProxyConfig` and
/// returns `InvalidProxyUrl` for everything else. Accepting a scheme it will
/// refuse — `https`, `socks5h`, `socks4` — would push the failure to the moment
/// a tab is opened, long after the Settings screen said the address was fine.
///
/// A bare `127.0.0.1:9050` is refused for the same reason: `Url::parse` reads it
/// as scheme `127.0.0.1` with no host, so it would sail past a looser check and
/// end up proxying nothing.
pub(crate) fn parse_proxy_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("A proxy address is required while the proxy is on.".to_string());
    }

    let parsed = Url::parse(trimmed)
        .map_err(|_| format!("\"{trimmed}\" is not a valid proxy address."))?;

    if !matches!(parsed.scheme(), "socks5" | "http") {
        return Err(format!(
            "\"{}\" is not a supported proxy scheme — use socks5:// or http://.",
            parsed.scheme()
        ));
    }
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err(format!("\"{trimmed}\" is missing a host."));
    }
    // Neither transport has a default port worth guessing: Tor is 9050, a Tor
    // Browser bundle is 9150, and an HTTP proxy is whatever it was configured as.
    // Guessing wrong fails closed but confusingly, so require it.
    if parsed.port().is_none() {
        return Err(format!("\"{trimmed}\" is missing a port."));
    }

    Ok(parsed)
}

/// Whether the running platform can route webview traffic through a proxy.
///
/// `Err` carries the reason, which the Settings screen shows verbatim.
///
/// The macOS gate is the load-bearing one. wry sets `proxyConfigurations` on the
/// data store through KVC *without* a version check of its own — unlike the
/// app-bound-domains call a few lines above it, which does test for 14. That key
/// only exists on macOS 14+, and `setValue:forKey:` against a missing key raises
/// NSUnknownKeyException, so on macOS 13 the choice is not "proxy or no proxy"
/// but "proxy or a crashed tab". ÆTHER supports back to 10.15, so this check
/// cannot be skipped.
pub(crate) fn proxy_platform_support() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if macos_major_version() < 14 {
            return Err(
                "Proxy support needs macOS 14 or later; this Mac browses directly.".to_string(),
            );
        }
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        Err("Proxy support is not available on Android; this device browses directly.".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "android")))]
    {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn macos_major_version() -> isize {
    objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
}

/// What the proxy is actually doing, as opposed to what the settings file says.
///
/// `active` folds together the three things that all have to hold — switched on,
/// supported here, and a parseable endpoint — so no caller has to remember the
/// conjunction and get it subtly wrong.
pub(crate) fn proxy_status(browser: &BrowserSettings) -> ProxyStatus {
    let support = proxy_platform_support();
    let available = support.is_ok();
    let usable = available && parse_proxy_url(&browser.proxy.url).is_ok();

    ProxyStatus {
        enabled: browser.proxy.enabled,
        url: browser.proxy.url.clone(),
        available,
        unsupported_reason: support.err(),
        active: browser.proxy.enabled && usable,
    }
}

/// Whether this shell can inject a document-start script into a visited page.
///
/// Desktop builds each tab with `WebviewBuilder`, which takes one. The Android
/// shell drives its WebViews through `android_tabs` and has no equivalent hook,
/// so the setting is inert there and says so rather than implying otherwise.
pub(crate) fn timezone_pin_platform_support() -> Result<(), String> {
    #[cfg(desktop)]
    {
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        Err("Timezone pinning is not available on this platform; pages see the device's own timezone.".to_string())
    }
}

pub(crate) fn timezone_pin_status(browser: &BrowserSettings) -> TimezonePinStatus {
    let support = timezone_pin_platform_support();
    let available = support.is_ok();

    TimezonePinStatus {
        enabled: browser.pin_timezone,
        available,
        unsupported_reason: support.err(),
        active: browser.pin_timezone && available,
    }
}

/// The endpoint to hand to the webview and HTTP client, or `None` to go direct.
///
/// Single source of truth for "is traffic proxied right now", so the tabs and the
/// favicon/capture client cannot disagree — a disagreement there is exactly the
/// leak this feature is meant to close.
pub(crate) fn active_proxy_url(browser: &BrowserSettings) -> Option<Url> {
    if !browser.proxy.enabled || proxy_platform_support().is_err() {
        return None;
    }
    parse_proxy_url(&browser.proxy.url).ok()
}

pub(crate) fn ai_free_search(id: &str) -> AiFreeSearch {
    match id {
        "google" => AiFreeSearch::UrlParam("udm=14"),
        "bing" => AiFreeSearch::QueryOperator("-ai"),
        "duckduckgo" => AiFreeSearch::AltHost {
            search: "https://noai.duckduckgo.com/?q=",
            home: "https://noai.duckduckgo.com",
        },
        // Yahoo and Ecosia, and anything unrecognised: nothing to append.
        _ => AiFreeSearch::Unavailable,
    }
}

/// Turns search terms into a URL for the chosen engine.
///
/// The AI-free step is applied here rather than at the call sites so that every
/// route to a search — the address bar, a bare query typed into it, and an iCE
/// concept sent to the web — cannot disagree about it.
pub(crate) fn search_url(terms: &str, search: SearchPrefs<'_>) -> String {
    if !search.ai_free {
        return format!(
            "{}{}",
            search_engine_prefix(search.engine),
            urlencoding(terms)
        );
    }

    match ai_free_search(search.engine) {
        // Appended before encoding, so the space before the operator survives as
        // `+` rather than being lost or double-escaped.
        AiFreeSearch::QueryOperator(operator) => format!(
            "{}{}",
            search_engine_prefix(search.engine),
            urlencoding(&format!("{terms} {operator}"))
        ),
        // The prefixes all end in `?q=` (or `?p=`), so the separator is `&`.
        AiFreeSearch::UrlParam(param) => format!(
            "{}{}&{param}",
            search_engine_prefix(search.engine),
            urlencoding(terms)
        ),
        AiFreeSearch::AltHost { search: prefix, .. } => {
            format!("{prefix}{}", urlencoding(terms))
        }
        AiFreeSearch::Unavailable => format!(
            "{}{}",
            search_engine_prefix(search.engine),
            urlencoding(terms)
        ),
    }
}

// DuckDuckGo is the fallback rather than Google in all three functions below.
// The default search engine is the single highest-traffic privacy decision the
// app makes — it sees every query typed into the address bar — so an unset or
// unrecognised value should land on the option that does not build a profile.
pub(crate) fn search_engine_prefix(id: &str) -> &'static str {
    match id {
        "google" => "https://www.google.com/search?q=",
        "bing" => "https://www.bing.com/search?q=",
        "yahoo" => "https://search.yahoo.com/search?p=",
        "ecosia" => "https://www.ecosia.org/search?q=",
        _ => "https://duckduckgo.com/?q=",
    }
}

/// The engine's own landing page, which an empty address bar opens.
///
/// Only DuckDuckGo differs when AI-free is on: its opt-out is a whole host, so
/// landing there keeps later searches typed into *that page* AI-free too. Google's
/// `udm=14` needs a query to apply to, so its home page is unchanged.
pub(crate) fn search_engine_home(search: SearchPrefs<'_>) -> &'static str {
    if search.ai_free {
        if let AiFreeSearch::AltHost { home, .. } = ai_free_search(search.engine) {
            return home;
        }
    }
    match search.engine {
        "google" => "https://www.google.com",
        "bing" => "https://www.bing.com",
        "yahoo" => "https://search.yahoo.com",
        "ecosia" => "https://www.ecosia.org",
        _ => "https://duckduckgo.com",
    }
}

pub(crate) fn normalize_search_engine_id(value: &str) -> String {
    match value {
        "google" | "bing" | "yahoo" | "ecosia" | "duckduckgo" => value.to_string(),
        _ => "duckduckgo".to_string(),
    }
}

pub(crate) fn normalize_iceberg_icon(value: Option<String>) -> Option<String> {
    let allowed = [
        "atom",
        "book",
        "brain",
        "briefcase",
        "code",
        "cpu",
        "dna",
        "film",
        "flask",
        "gamepad",
        "globe",
        "heart",
        "landmark",
        "microscope",
        "music",
        "palette",
        "shield",
        "snowflake",
        "sprout",
        "telescope",
    ];
    value
        .map(|icon| icon.trim().to_lowercase())
        .filter(|icon| allowed.contains(&icon.as_str()))
}

pub(crate) fn normalize_theme_color(color: &str) -> Option<String> {
    let value = color.trim().chars().take(64).collect::<String>();
    if value.is_empty() {
        return None;
    }

    if let Some(hex) = value.strip_prefix('#') {
        if (3..=8).contains(&hex.len())
            && hex.chars().all(|character| character.is_ascii_hexdigit())
        {
            return Some(value);
        }
    }

    let lower = value.to_ascii_lowercase();
    let supported_function = lower.starts_with("rgb(")
        || lower.starts_with("rgba(")
        || lower.starts_with("hsl(")
        || lower.starts_with("hsla(");
    if supported_function && value.ends_with(')') {
        return Some(value);
    }

    None
}

pub(crate) fn title_from_url(url: &str) -> String {
    let host = get_tab_host(url);
    if host.is_empty() {
        "New tab".to_string()
    } else {
        host
    }
}

/// Stable 16-byte data-store identifier for a container name.
///
/// macOS-only because `data_store_identifier` is: Windows, Linux and Android
/// have no equivalent, so a container tab there shares the default store and the
/// isolation is nominal. See docs/SECURITY.md.
///
/// UUIDv5 because it is a *deterministic* hash of the name: the same container
/// must resolve to the same WKWebsiteDataStore on every launch, or its cookies
/// are orphaned on disk and the user is silently logged out each restart.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn container_data_store_id(container: &str) -> [u8; 16] {
    const NAMESPACE: uuid::Uuid = uuid::Uuid::from_bytes([
        0x41, 0x45, 0x54, 0x48, 0x45, 0x52, 0x43, 0x54, 0x52, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01,
    ]);
    *uuid::Uuid::new_v5(&NAMESPACE, container.trim().to_lowercase().as_bytes()).as_bytes()
}

pub(crate) fn favicon_for_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    Some(format!(
        "{}://{}/favicon.ico",
        parsed.scheme(),
        parsed.host_str()?
    ))
}

pub(crate) fn get_tab_host(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.trim_start_matches("www.").to_string())
        })
        .unwrap_or_default()
}

pub(crate) fn normalize_citation_key(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => url.to_string(),
    }
}

pub(crate) fn normalize_capture_url_key(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            if parsed.path() == "/" {
                parsed.set_path("");
            }
            parsed.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => url.trim().trim_end_matches('/').to_string(),
    }
}

pub(crate) fn unique_slug(name: &str, existing: &[String]) -> String {
    let base = slugify(name);
    let mut candidate = base.clone();
    let mut suffix = 2;
    while existing.contains(&candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

pub(crate) fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for char in value.trim().to_lowercase().chars() {
        if char.is_ascii_alphanumeric() || char == '_' {
            slug.push(char);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "collection".to_string()
    } else {
        slug
    }
}

pub(crate) fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

pub(crate) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
