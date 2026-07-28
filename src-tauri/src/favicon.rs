//! Favicon fetching, moved out of the privileged window.
//!
//! Tab favicons used to be `<img src="https://host/favicon.ico">` inside the
//! window that holds the IPC bridge. That is the reason `img-src` in
//! tauri.conf.json had to allow `https:` and `http:` — and it meant the
//! privileged window made a direct outbound request to every host the user
//! visited, carrying whatever ambient state that context had.
//!
//! Here the fetch happens in Rust on the shared reqwest client, and the renderer
//! receives a `data:` URI. The privileged window now makes no outbound requests
//! at all, so `img-src` is down to `'self' data: blob:`.
//!
//! The cache is deliberately in memory only. A favicon cache on disk is a list of
//! visited hosts by another name, and one request per host per session is a small
//! price for not writing that file.

use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};

/// Above this, it is not a favicon and we are being fed something else.
const MAX_FAVICON_BYTES: usize = 256 * 1024;
/// Crude bound on the session cache. Favicons are small, but a long session with
/// many hosts should not grow this without limit.
const MAX_CACHED_FAVICONS: usize = 512;

/// `https://host:port` for an http(s) URL. This is the cache key, so it must not
/// carry the path: every page on a host shares one favicon.
pub(crate) fn favicon_origin(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    match parsed.port() {
        Some(port) => Some(format!("{}://{}:{}", parsed.scheme(), host, port)),
        None => Some(format!("{}://{}", parsed.scheme(), host)),
    }
}

/// Content-type is advisory here — plenty of servers label an ICO as
/// `text/plain` — so sniff the magic bytes first and only fall back to the
/// header. Anything unrecognised is rejected rather than guessed at, so the
/// renderer never gets a `data:` URI for a non-image.
fn image_mime(bytes: &[u8], declared: Option<&str>) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"\x00\x00\x01\x00") {
        return Some("image/x-icon");
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // SVG has no magic number; look for a root element in the opening bytes.
    let head_len = bytes.len().min(512);
    let head = String::from_utf8_lossy(&bytes[..head_len]);
    let head = head.trim_start();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
        return Some("image/svg+xml");
    }

    match declared.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) if value.starts_with("image/svg") => Some("image/svg+xml"),
        Some(value) if value.starts_with("image/png") => Some("image/png"),
        Some(value) if value.starts_with("image/jpeg") => Some("image/jpeg"),
        Some(value) if value.starts_with("image/gif") => Some("image/gif"),
        Some(value) if value.starts_with("image/webp") => Some("image/webp"),
        Some(value)
            if value.starts_with("image/x-icon") || value.starts_with("image/vnd.microsoft.icon") =>
        {
            Some("image/x-icon")
        }
        _ => None,
    }
}

async fn fetch_favicon(client: &Client, origin: &str) -> Option<String> {
    let response = client
        .get(format!("{origin}/favicon.ico"))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    // Checked before reading the body so an oversized response costs nothing.
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_FAVICON_BYTES)
    {
        return None;
    }

    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_FAVICON_BYTES {
        return None;
    }

    let mime = image_mime(&bytes, declared.as_deref())?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// Resolves a page URL to a `data:` URI for its site icon, or `None` when the
/// host has no usable favicon.
///
/// Failures are cached alongside successes: without that, every tab on a host
/// with no favicon would retry the same 404 on every render.
#[tauri::command]
pub(crate) async fn aether_browser_favicon(
    state: State<'_, Backend>,
    url: String,
) -> Cmd<Option<String>> {
    let Some(origin) = favicon_origin(&url) else {
        return Ok(None);
    };

    if let Ok(cache) = state.favicon_cache.lock() {
        if let Some(cached) = cache.get(&origin) {
            return Ok(cached.clone());
        }
    }

    let resolved = fetch_favicon(&state.client, &origin).await;

    if let Ok(mut cache) = state.favicon_cache.lock() {
        if cache.len() >= MAX_CACHED_FAVICONS {
            cache.clear();
        }
        cache.insert(origin, resolved.clone());
    }

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_drops_the_path_so_one_host_shares_one_icon() {
        assert_eq!(
            favicon_origin("https://example.com/a/b?c=d#e"),
            Some("https://example.com".to_string())
        );
    }

    #[test]
    fn origin_keeps_a_non_default_port() {
        assert_eq!(
            favicon_origin("http://localhost:3000/x"),
            Some("http://localhost:3000".to_string())
        );
    }

    #[test]
    fn origin_rejects_non_http_schemes() {
        assert_eq!(favicon_origin("aether://start"), None);
        assert_eq!(favicon_origin("file:///etc/passwd"), None);
        assert_eq!(favicon_origin("not a url"), None);
    }

    #[test]
    fn mime_sniffing_beats_a_wrong_content_type() {
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";
        assert_eq!(image_mime(png, Some("text/plain")), Some("image/png"));
    }

    #[test]
    fn mime_falls_back_to_the_header_when_bytes_are_unrecognised() {
        assert_eq!(image_mime(b"\x01\x02\x03\x04", None), None);
        assert_eq!(
            image_mime(b"\x01\x02\x03\x04", Some("image/png")),
            Some("image/png")
        );
    }

    #[test]
    fn mime_detects_an_ico_and_an_svg() {
        assert_eq!(image_mime(b"\x00\x00\x01\x00\x01\x00", None), Some("image/x-icon"));
        assert_eq!(
            image_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>", None),
            Some("image/svg+xml")
        );
    }

    #[test]
    fn html_error_pages_are_not_treated_as_icons() {
        assert_eq!(image_mime(b"<!doctype html><html>404", Some("text/html")), None);
    }

    // Ignored because it needs the network, so it stays out of CI and offline
    // builds. Run it by hand after touching the fetch path — the sniffing tests
    // above prove the branches, not that a real server's response survives them:
    //     cargo test --lib favicon -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn fetches_a_real_favicon_end_to_end() {
        let client = Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .build()
            .expect("client");
        let origin = favicon_origin("https://duckduckgo.com/?q=test").expect("origin");
        let data_uri = fetch_favicon(&client, &origin).await.expect("favicon");
        assert!(data_uri.starts_with("data:image/"), "got {data_uri:.40}");
        assert!(data_uri.contains(";base64,"));
        println!("{} bytes of data URI", data_uri.len());
    }
}
