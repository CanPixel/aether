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

pub(crate) fn normalize_url(raw_url: &str, search_engine: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return search_engine_home(search_engine).to_string();
    }
    if Url::parse(trimmed).is_ok() {
        return strip_tracking_params(trimmed);
    }
    if trimmed.contains(char::is_whitespace) || !trimmed.contains(['.', ':']) {
        return format!(
            "{}{}",
            search_engine_prefix(search_engine),
            urlencoding(trimmed)
        );
    }
    if trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || trimmed.starts_with("[::1]")
    {
        return format!("http://{trimmed}");
    }
    format!("https://{trimmed}")
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

pub(crate) fn search_engine_home(id: &str) -> &'static str {
    match id {
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
