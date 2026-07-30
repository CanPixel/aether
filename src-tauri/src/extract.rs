//! Turning a live page into capturable text: a snapshot from the webview where one
//! exists, an HTTP fetch and `scraper` pass where it does not.

use super::*;

pub(crate) async fn extract_readable_active_page(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<CapturedPage> {
    #[cfg(desktop)]
    {
        if let Ok(page) = extract_readable_page_from_webview(state, active_tab).await {
            return Ok(page);
        }
    }

    #[cfg(target_os = "android")]
    {
        match extract_readable_page_from_android(active_tab) {
            Ok(page) => return Ok(page),
            Err(_) => {}
        }
    }

    extract_readable_page(&state.http_client(), &active_tab.url).await
}

// Android counterpart of extract_readable_page_from_webview: the Kotlin
// TabsPlugin's `snapshot` command reads the live DOM through
// evaluateJavascript's value callback, so logged-in and JS-rendered pages
// capture correctly instead of falling back to an anonymous HTTP re-fetch.
#[cfg(target_os = "android")]
pub(crate) fn extract_readable_page_from_android(active_tab: &ManagedTab) -> Cmd<CapturedPage> {
    let response: android_tabs::SnapshotResponse = android_tabs::run_for_global(
        "snapshot",
        android_tabs::TabPayload {
            tab_id: &active_tab.id,
        },
    )?;
    let payload = response.payload.trim();
    if payload.is_empty() || payload == "null" {
        return Err("Unable to read the active page.".to_string());
    }
    let snapshot = parse_page_snapshot(payload)?;
    snapshot_to_captured_page(snapshot, &active_tab.title)
}

#[cfg(desktop)]
pub(crate) async fn extract_readable_page_from_webview(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<CapturedPage> {
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
        .views
        .get(&active_tab.id)
        .cloned()
        .ok_or_else(|| "Active browser webview is not ready.".to_string())?;
    // Consent dialogs are first-party, visible DOM, so content blocking does not
    // touch them and innerText picks them up in full. "We use cookies to improve
    // your experience. Accept All. Reject." then gets embedded on every capture,
    // which is noise in every retrieval that follows.
    //
    // Named CMP containers only — no `[class*="cookie"]` guesswork. These five
    // cover the overwhelming majority of banners, and a wrong match here silently
    // deletes real content from a capture, which is far worse than a leftover
    // banner. Extend it with specific roots, never with substring heuristics.
    let script = r#"(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, iframe, form, nav, footer, svg').forEach((node) => node.remove());
      clone.querySelectorAll(
        '#onetrust-consent-sdk, #CybotCookiebotDialog, .fc-consent-root, #usercentrics-root, [id^="sp_message_container"]'
      ).forEach((node) => node.remove());
      return {
        html: '<!doctype html>' + clone.outerHTML,
        url: location.href,
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
        bodyText: document.body?.innerText || ''
      };
    })()"#;
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .eval_with_callback(script, {
            let sender = Arc::clone(&sender);
            move |payload| {
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(payload);
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let payload = tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "Timed out reading the active page.".to_string())?
        .map_err(|_| "Unable to read the active page.".to_string())?;
    let snapshot = parse_page_snapshot(&payload)?;
    snapshot_to_captured_page(snapshot, &active_tab.title)
}

pub(crate) fn parse_page_snapshot(payload: &str) -> Cmd<BrowserPageSnapshot> {
    parse_json_payload::<BrowserPageSnapshot>(payload)
}

pub(crate) fn parse_json_payload<T: DeserializeOwned>(payload: &str) -> Cmd<T> {
    let value =
        serde_json::from_str::<serde_json::Value>(payload).map_err(|error| error.to_string())?;
    if let Some(inner) = value.as_str() {
        serde_json::from_str::<T>(inner).map_err(|error| error.to_string())
    } else {
        serde_json::from_value::<T>(value).map_err(|error| error.to_string())
    }
}

pub(crate) fn snapshot_to_captured_page(
    snapshot: BrowserPageSnapshot,
    fallback_title: &str,
) -> Cmd<CapturedPage> {
    let url = snapshot
        .url
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "Unable to read the active page.".to_string())?;
    let parsed_document = snapshot
        .html
        .as_ref()
        .map(|html| Html::parse_document(html));
    let title = snapshot
        .title
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_first_text(document, "title"))
        })
        .unwrap_or_else(|| fallback_title.to_string());
    let description = snapshot.description.unwrap_or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_content(document, "description"))
            .unwrap_or_default()
    });
    // The cleaned clone wins over the raw `innerText`, and the order matters.
    //
    // The injected script strips nav, footer, script and friends from a *clone*
    // and sends that as `html`, but `body_text` is `document.body.innerText` from
    // the untouched live DOM. Preferring `body_text` — which is what this did —
    // meant the stripping never applied to the text that actually gets embedded,
    // and every capture carried the site's navigation and footer into the index.
    //
    // `innerText` remains the fallback because it is the better answer when the
    // clone is missing or unparseable, and because it respects `display: none`
    // where the clone's text does not.
    // Deliberately a "the clone yielded essentially nothing" threshold, not
    // MIN_CAPTURE_TEXT_LENGTH. Falling back at the capture threshold would mean a
    // page with a little genuine content gets topped up with its own navigation
    // until it passes — the capture should honestly fail instead.
    const CLONE_TEXT_FLOOR: usize = 32;

    let body_text = parsed_document
        .as_ref()
        .map(select_body_text)
        .filter(|text| text.len() >= CLONE_TEXT_FLOOR)
        .or(snapshot.body_text)
        .unwrap_or_default();
    let text = normalize_captured_text(&format!("{title}\n\n{description}\n\n{body_text}"));

    if text.len() < MIN_CAPTURE_TEXT_LENGTH {
        return Err("This page does not contain enough readable text to capture.".to_string());
    }

    Ok(CapturedPage { title, url, text })
}

pub(crate) async fn extract_readable_page(client: &Client, url: &str) -> Cmd<CapturedPage> {
    let parsed = Url::parse(url).map_err(|_| "Unable to read the active page URL.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https pages can be captured in the Tauri build.".to_string());
    }
    let response = client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Unable to fetch page: {}", response.status()));
    }
    let html = response.text().await.map_err(|error| error.to_string())?;
    let document = Html::parse_document(&html);
    let title = select_first_text(&document, "title")
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| title_from_url(url));
    let description = select_meta_content(&document, "description").unwrap_or_default();
    let body_text = select_body_text(&document);
    let text = normalize_captured_text(&format!("{title}\n\n{description}\n\n{body_text}"));
    if text.len() < MIN_CAPTURE_TEXT_LENGTH {
        return Err("This page does not contain enough readable text to capture.".to_string());
    }
    Ok(CapturedPage {
        title,
        url: url.to_string(),
        text,
    })
}

pub(crate) fn select_first_text(document: &Html, selector: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .next()
        .map(|node| node.text().collect::<Vec<_>>().join(" ").trim().to_string())
}

pub(crate) fn select_meta_content(document: &Html, name: &str) -> Option<String> {
    let selector = Selector::parse(&format!("meta[name=\"{name}\"]")).ok()?;
    document
        .select(&selector)
        .next()
        .and_then(|node| node.value().attr("content"))
        .map(|value| value.trim().to_string())
}

/// Elements whose text is never page content. Deliberately the same list the
/// injected snapshot script removes, so the webview path and the HTTP fallback
/// path agree on what a page says — otherwise the same URL yields different
/// embeddings depending on which path captured it.
///
/// `script` is the one that actually bit: `scraper`'s `.text()` walks every
/// descendant text node, and a `<script>` body *is* a text node, so inline
/// JavaScript source was being embedded and indexed as prose.
const NON_CONTENT_ELEMENTS: [&str; 8] = [
    "script", "style", "noscript", "iframe", "form", "nav", "footer", "svg",
];

fn collect_content_text(element: ElementRef, out: &mut Vec<String>) {
    for child in element.children() {
        if let Some(text) = child.value().as_text() {
            let text = text.trim();
            if !text.is_empty() {
                out.push(text.to_string());
            }
        } else if let Some(child) = ElementRef::wrap(child) {
            // Skipping the whole subtree, not just this node's own text.
            if NON_CONTENT_ELEMENTS.contains(&child.value().name()) {
                continue;
            }
            collect_content_text(child, out);
        }
    }
}

pub(crate) fn select_body_text(document: &Html) -> String {
    let selector = Selector::parse("body").expect("body selector");
    let mut out = Vec::new();
    for body in document.select(&selector) {
        collect_content_text(body, &mut out);
    }
    out.join(" ")
}
