//! Turning a live page into capturable text: a snapshot from the webview where one
//! exists, an HTTP fetch and `scraper` pass where it does not.

use super::*;
use sha2::{Digest, Sha256};

const RECEIPT_VERSION: u8 = 1;
const EXTRACTOR_VERSION: &str = "aether-extract/2";

const PAGE_SNAPSHOT_SCRIPT: &str = r#"(() => {
  const schemaTypes = new Set(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report']);
  const schemaNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((node) => {
      try {
        return JSON.parse(node.textContent || 'null');
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
  const findArticleSchema = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findArticleSchema(item);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const types = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
    if (types.some((type) => schemaTypes.has(String(type).split(/[\/#]/).pop()))) return value;
    for (const child of Object.values(value)) {
      const found = findArticleSchema(child);
      if (found) return found;
    }
    return null;
  };
  const articleSchema = schemaNodes.map(findArticleSchema).find(Boolean) || {};
  const schemaName = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(schemaName).filter(Boolean).join(', ');
    return typeof value?.name === 'string' ? value.name : '';
  };
  const schemaUrl = (value) => {
    if (typeof value === 'string') return value;
    return typeof value?.['@id'] === 'string' ? value['@id'] : '';
  };
  const cssPath = (element) => {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 8) {
      if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(current.id)) {
        parts.unshift(`#${current.id}`);
        break;
      }
      let segment = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName)
        : [];
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(segment);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const readSelection = () => {
    const active = document.activeElement;
    if ((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
        typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number' &&
        active.selectionEnd > active.selectionStart) {
      return {
        text: active.value.slice(active.selectionStart, active.selectionEnd),
        selector: cssPath(active),
        before: active.value.slice(Math.max(0, active.selectionStart - 180), active.selectionStart),
        after: active.value.slice(active.selectionEnd, active.selectionEnd + 180)
      };
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return { text: '', selector: '', before: '', after: '' };
    }
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    let start = 0;
    if (root) {
      const prefix = range.cloneRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      start = prefix.toString().length;
    }
    const rootText = root?.textContent || '';
    const text = selection.toString();
    return {
      text,
      selector: cssPath(root),
      before: rootText.slice(Math.max(0, start - 180), start),
      after: rootText.slice(start + text.length, start + text.length + 180)
    };
  };
  const selection = readSelection();
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
    bodyText: document.body?.innerText || '',
    canonicalUrl: document.querySelector('link[rel~="canonical"]')?.href ||
      document.querySelector('meta[property="og:url"]')?.getAttribute('content') ||
      schemaUrl(articleSchema.mainEntityOfPage) || schemaUrl(articleSchema.url),
    author: document.querySelector('meta[name="author"]')?.getAttribute('content') ||
      document.querySelector('meta[property="article:author"]')?.getAttribute('content') ||
      schemaName(articleSchema.author),
    publishedAt: document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
      document.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') ||
      articleSchema.datePublished || articleSchema.dateCreated || '',
    siteName: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      schemaName(articleSchema.publisher) || schemaName(articleSchema.isPartOf),
    language: document.documentElement.lang || articleSchema.inLanguage || '',
    selectedText: selection.text,
    selectionSelector: selection.selector,
    selectionContextBefore: selection.before,
    selectionContextAfter: selection.after
  };
})()"#;

pub(crate) async fn extract_readable_active_page(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<CapturedPage> {
    #[cfg(desktop)]
    {
        match extract_readable_page_from_webview(state, active_tab).await {
            Ok(page) => return Ok(page),
            Err(_) => {
                let mut page = extract_readable_page(&state.http_client(), &active_tab.url).await?;
                page.provenance.fallback_reason = Some(
                    "Live page extraction was unavailable, so AETHER used an HTTP response."
                        .to_string(),
                );
                return Ok(page);
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        match extract_readable_page_from_android(active_tab) {
            Ok(page) => return Ok(page),
            Err(_) => {}
        }
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        return extract_readable_page(&state.http_client(), &active_tab.url).await;
    }

    #[allow(unreachable_code)]
    Err("Page extraction is unavailable on this platform.".to_string())
}

pub(crate) async fn extract_selected_active_page(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<CapturedPage> {
    #[cfg(desktop)]
    {
        let snapshot = read_page_snapshot_from_webview(state, active_tab).await?;
        return snapshot_to_selected_page(snapshot, &active_tab.title);
    }

    #[cfg(target_os = "android")]
    {
        let snapshot = read_page_snapshot_from_android(active_tab)?;
        return snapshot_to_selected_page(snapshot, &active_tab.title);
    }

    #[allow(unreachable_code)]
    Err("Selected-passage capture requires a live browser page.".to_string())
}

// Android counterpart of extract_readable_page_from_webview: the Kotlin
// TabsPlugin's `snapshot` command reads the live DOM through
// evaluateJavascript's value callback, so logged-in and JS-rendered pages
// capture correctly instead of falling back to an anonymous HTTP re-fetch.
#[cfg(target_os = "android")]
pub(crate) fn extract_readable_page_from_android(active_tab: &ManagedTab) -> Cmd<CapturedPage> {
    let snapshot = read_page_snapshot_from_android(active_tab)?;
    snapshot_to_captured_page(snapshot, &active_tab.title)
}

#[cfg(target_os = "android")]
fn read_page_snapshot_from_android(active_tab: &ManagedTab) -> Cmd<BrowserPageSnapshot> {
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
    parse_page_snapshot(payload)
}

#[cfg(desktop)]
pub(crate) async fn extract_readable_page_from_webview(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<CapturedPage> {
    let snapshot = read_page_snapshot_from_webview(state, active_tab).await?;
    snapshot_to_captured_page(snapshot, &active_tab.title)
}

#[cfg(desktop)]
async fn read_page_snapshot_from_webview(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<BrowserPageSnapshot> {
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
        .views
        .get(&active_tab.id)
        .cloned()
        .ok_or_else(|| "Active browser webview is not ready.".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .eval_with_callback(PAGE_SNAPSHOT_SCRIPT, {
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
    parse_page_snapshot(&payload)
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
    let url = strip_tracking_params(&url);
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
    let canonical_url = clean_metadata_value(snapshot.canonical_url)
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_link_href(document, "canonical"))
        })
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_meta_property(document, "og:url"))
        })
        .and_then(|value| normalize_provenance_url(&value, &url));
    let author = clean_metadata_value(snapshot.author)
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_meta_content(document, "author"))
        })
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_meta_property(document, "article:author"))
        });
    let published_at = clean_metadata_value(snapshot.published_at)
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_meta_property(document, "article:published_time"))
        })
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_meta_itemprop(document, "datePublished"))
        });
    let site_name = clean_metadata_value(snapshot.site_name).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_property(document, "og:site_name"))
    });
    let language = clean_metadata_value(snapshot.language).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(select_document_language)
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

    let (body_text, content_selector, fallback_reason) = parsed_document
        .as_ref()
        .map(select_readable_content)
        .filter(|content| content.text.len() >= CLONE_TEXT_FLOOR)
        .map(|content| {
            (
                content.text,
                content.selector,
                content.fallback_reason,
            )
        })
        .or_else(|| {
            snapshot
                .body_text
                .map(|text| {
                    (
                        text,
                        "body.innerText".to_string(),
                        Some(
                            "The cleaned DOM was unavailable, so AETHER used visible body text."
                                .to_string(),
                        ),
                    )
                })
        })
        .unwrap_or_else(|| {
            (
                String::new(),
                "none".to_string(),
                Some("No readable DOM content was available.".to_string()),
            )
        });
    let text = normalize_captured_text(&format!("{title}\n\n{description}\n\n{body_text}"));

    if text.len() < MIN_CAPTURE_TEXT_LENGTH {
        return Err("This page does not contain enough readable text to capture.".to_string());
    }

    let content_hash = hash_extracted_content(&text);
    let word_count = count_extracted_words(&text);
    Ok(CapturedPage {
        title,
        url: url.clone(),
        text,
        provenance: CaptureProvenance {
            receipt_version: RECEIPT_VERSION,
            extractor_version: EXTRACTOR_VERSION.to_string(),
            requested_url: Some(url.clone()),
            canonical_url,
            author,
            published_at,
            site_name,
            language,
            content_hash,
            extraction_method: ExtractionMethod::LiveDom,
            content_scope: CaptureScope::Page,
            content_selector,
            word_count,
            fallback_reason,
            selection_context_before: None,
            selection_context_after: None,
        },
    })
}

pub(crate) fn snapshot_to_selected_page(
    snapshot: BrowserPageSnapshot,
    fallback_title: &str,
) -> Cmd<CapturedPage> {
    const MIN_SELECTED_TEXT_LENGTH: usize = 20;

    let selected_text = snapshot
        .selected_text
        .as_ref()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            "Select a passage on the page before capturing the selection.".to_string()
        })?;
    if selected_text.chars().count() < MIN_SELECTED_TEXT_LENGTH {
        return Err("Select a passage of at least 20 characters.".to_string());
    }

    let raw_url = snapshot
        .url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "Unable to read the active page.".to_string())?;
    let url = strip_tracking_params(raw_url);
    let parsed_document = snapshot
        .html
        .as_ref()
        .map(|html| Html::parse_document(html));
    let title = snapshot
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_first_text(document, "title"))
        })
        .unwrap_or_else(|| fallback_title.to_string());
    let canonical_url = clean_metadata_value(snapshot.canonical_url.clone())
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_link_href(document, "canonical"))
        })
        .or_else(|| {
            parsed_document
                .as_ref()
                .and_then(|document| select_meta_property(document, "og:url"))
        })
        .and_then(|value| normalize_provenance_url(&value, &url));
    let author = clean_metadata_value(snapshot.author.clone()).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_content(document, "author"))
    }).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_property(document, "article:author"))
    });
    let published_at = clean_metadata_value(snapshot.published_at.clone()).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_property(document, "article:published_time"))
    }).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_itemprop(document, "datePublished"))
    });
    let site_name = clean_metadata_value(snapshot.site_name.clone()).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(|document| select_meta_property(document, "og:site_name"))
    });
    let language = clean_metadata_value(snapshot.language.clone()).or_else(|| {
        parsed_document
            .as_ref()
            .and_then(select_document_language)
    });
    let content_selector = clean_metadata_value(snapshot.selection_selector.clone())
        .unwrap_or_else(|| "user-selection".to_string());
    let text = normalize_captured_text(&format!(
        "{}\n\nSelected passage\n\n{}",
        title, selected_text
    ));
    let word_count = count_extracted_words(&selected_text);

    Ok(CapturedPage {
        title,
        url: url.clone(),
        provenance: CaptureProvenance {
            receipt_version: RECEIPT_VERSION,
            extractor_version: EXTRACTOR_VERSION.to_string(),
            requested_url: Some(url),
            canonical_url,
            author,
            published_at,
            site_name,
            language,
            content_hash: hash_extracted_content(&text),
            extraction_method: ExtractionMethod::LiveDom,
            content_scope: CaptureScope::Selection,
            content_selector,
            word_count,
            fallback_reason: None,
            selection_context_before: clean_metadata_value(snapshot.selection_context_before),
            selection_context_after: clean_metadata_value(snapshot.selection_context_after),
        },
        text,
    })
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
    let final_url = response.url().clone();
    let html = response.text().await.map_err(|error| error.to_string())?;
    let document = Html::parse_document(&html);
    let structured = select_json_ld_metadata(&document);
    let title = select_first_text(&document, "title")
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| title_from_url(final_url.as_str()));
    let description = select_meta_content(&document, "description").unwrap_or_default();
    let readable = select_readable_content(&document);
    let body_text = readable.text;
    let text = normalize_captured_text(&format!("{title}\n\n{description}\n\n{body_text}"));
    if text.len() < MIN_CAPTURE_TEXT_LENGTH {
        return Err("This page does not contain enough readable text to capture.".to_string());
    }
    let canonical_url = select_link_href(&document, "canonical")
        .or_else(|| select_meta_property(&document, "og:url"))
        .or(structured.canonical_url)
        .and_then(|value| normalize_provenance_url(&value, final_url.as_str()));
    let author = select_meta_content(&document, "author")
        .or_else(|| select_meta_property(&document, "article:author"))
        .or(structured.author);
    let published_at = select_meta_property(&document, "article:published_time")
        .or_else(|| select_meta_itemprop(&document, "datePublished"))
        .or(structured.published_at);
    let site_name = select_meta_property(&document, "og:site_name").or(structured.site_name);
    let language = select_document_language(&document).or(structured.language);
    let content_hash = hash_extracted_content(&text);
    let word_count = count_extracted_words(&text);
    Ok(CapturedPage {
        title,
        url: strip_tracking_params(final_url.as_str()),
        text,
        provenance: CaptureProvenance {
            receipt_version: RECEIPT_VERSION,
            extractor_version: EXTRACTOR_VERSION.to_string(),
            requested_url: Some(strip_tracking_params(url)),
            canonical_url,
            author,
            published_at,
            site_name,
            language,
            content_hash,
            extraction_method: ExtractionMethod::HttpFetch,
            content_scope: CaptureScope::Page,
            content_selector: readable.selector,
            word_count,
            fallback_reason: readable.fallback_reason,
            selection_context_before: None,
            selection_context_after: None,
        },
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
        .map(str::to_string)
        .and_then(|value| clean_metadata_value(Some(value)))
}

pub(crate) fn select_meta_property(document: &Html, property: &str) -> Option<String> {
    select_element_attribute(
        document,
        &format!("meta[property=\"{property}\"]"),
        "content",
    )
}

pub(crate) fn select_meta_itemprop(document: &Html, itemprop: &str) -> Option<String> {
    select_element_attribute(
        document,
        &format!("meta[itemprop=\"{itemprop}\"]"),
        "content",
    )
}

pub(crate) fn select_link_href(document: &Html, rel: &str) -> Option<String> {
    select_element_attribute(document, &format!("link[rel~=\"{rel}\"]"), "href")
}

fn select_element_attribute(document: &Html, selector: &str, attribute: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .next()
        .and_then(|node| node.value().attr(attribute))
        .map(str::to_string)
        .and_then(|value| clean_metadata_value(Some(value)))
}

pub(crate) fn select_document_language(document: &Html) -> Option<String> {
    select_element_attribute(document, "html[lang]", "lang")
}

fn clean_metadata_value(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        // Web metadata is untrusted input. Keep a pathological meta tag from
        // turning one lightweight capture into a multi-megabyte library record.
        .map(|value| value.chars().take(2_048).collect())
}

fn normalize_provenance_url(value: &str, base_url: &str) -> Option<String> {
    let mut parsed = Url::parse(value)
        .or_else(|_| Url::parse(base_url).and_then(|base| base.join(value)))
        .ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.set_fragment(None);
    Some(strip_tracking_params(parsed.as_str()))
}

pub(crate) fn hash_extracted_content(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) fn count_extracted_words(text: &str) -> usize {
    text.split_whitespace().count()
}

pub(crate) struct ReadableContent {
    pub(crate) text: String,
    pub(crate) selector: String,
    pub(crate) fallback_reason: Option<String>,
}

pub(crate) fn select_readable_content(document: &Html) -> ReadableContent {
    const CONTENT_TEXT_FLOOR: usize = 120;
    const CANDIDATES: [(&str, f64); 8] = [
        ("[itemprop=\"articleBody\"]", 1_000.0),
        ("article", 900.0),
        ("main article", 850.0),
        (".article-body", 800.0),
        (".article-content", 800.0),
        (".entry-content", 800.0),
        (".post-content", 800.0),
        ("main, [role=\"main\"]", 450.0),
    ];

    let paragraph_selector = Selector::parse("p").expect("paragraph selector");
    let heading_selector = Selector::parse("h1, h2, h3").expect("heading selector");
    let link_selector = Selector::parse("a").expect("link selector");
    let mut best: Option<(f64, usize, String, String)> = None;

    for (selector_name, semantic_bonus) in CANDIDATES {
        let Ok(selector) = Selector::parse(selector_name) else {
            continue;
        };
        for (index, root) in document.select(&selector).enumerate() {
            let text = extract_content_text(root);
            let char_count = text.chars().count();
            if char_count < CONTENT_TEXT_FLOOR {
                continue;
            }

            let paragraph_count = root.select(&paragraph_selector).count() as f64;
            let heading_count = root.select(&heading_selector).count() as f64;
            let link_chars = root
                .select(&link_selector)
                .flat_map(|link| link.text())
                .map(str::trim)
                .map(str::len)
                .sum::<usize>() as f64;
            let link_ratio = (link_chars / char_count.max(1) as f64).min(1.0);
            let identity = format!(
                "{} {}",
                root.value().attr("id").unwrap_or_default(),
                root.value().attr("class").unwrap_or_default()
            )
            .to_ascii_lowercase();
            let boilerplate_penalty = [
                "comment", "footer", "header", "menu", "nav", "related", "share", "sidebar",
            ]
            .iter()
            .filter(|token| identity.contains(**token))
            .count() as f64
                * 900.0;
            let score = char_count as f64
                + paragraph_count * 180.0
                + heading_count * 55.0
                + semantic_bonus
                - link_ratio * char_count as f64 * 2.4
                - boilerplate_penalty;
            let replace = best
                .as_ref()
                .map_or(true, |(best_score, best_chars, _, _)| {
                    score > *best_score || (score == *best_score && char_count > *best_chars)
                });
            if replace {
                let resolved_selector = if index == 0 {
                    selector_name.to_string()
                } else {
                    format!("{selector_name} [candidate {}]", index + 1)
                };
                best = Some((score, char_count, text, resolved_selector));
            }
        }
    }

    if let Some((_, _, text, selector)) = best {
        return ReadableContent {
            text,
            selector,
            fallback_reason: None,
        };
    }

    ReadableContent {
        text: select_body_text(document),
        selector: "body".to_string(),
        fallback_reason: Some(
            "No article-like content root met the extraction quality threshold.".to_string(),
        ),
    }
}

fn extract_content_text(root: ElementRef<'_>) -> String {
    let mut out = Vec::new();
    collect_content_text(root, &mut out);
    out.join(" ")
}

#[derive(Default)]
pub(crate) struct StructuredPageMetadata {
    pub(crate) canonical_url: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) published_at: Option<String>,
    pub(crate) site_name: Option<String>,
    pub(crate) language: Option<String>,
}

pub(crate) fn select_json_ld_metadata(document: &Html) -> StructuredPageMetadata {
    let mut metadata = StructuredPageMetadata::default();
    let selector = Selector::parse("script[type=\"application/ld+json\"]")
        .expect("valid JSON-LD selector");

    for script in document.select(&selector) {
        let source = script.text().collect::<Vec<_>>().join("");
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&source) else {
            continue;
        };
        let Some(article) = find_article_schema(&value) else {
            continue;
        };

        metadata.canonical_url = article
            .get("mainEntityOfPage")
            .and_then(json_ld_url)
            .or_else(|| article.get("url").and_then(json_ld_url));
        metadata.author = article.get("author").and_then(json_ld_name);
        metadata.published_at = article
            .get("datePublished")
            .or_else(|| article.get("dateCreated"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .and_then(|value| clean_metadata_value(Some(value)));
        metadata.site_name = article
            .get("publisher")
            .and_then(json_ld_name)
            .or_else(|| article.get("isPartOf").and_then(json_ld_name));
        metadata.language = article
            .get("inLanguage")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .and_then(|value| clean_metadata_value(Some(value)));
        break;
    }

    metadata
}

fn find_article_schema(
    value: &serde_json::Value,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    match value {
        serde_json::Value::Array(items) => items.iter().find_map(find_article_schema),
        serde_json::Value::Object(object) => {
            if object.get("@type").is_some_and(json_ld_is_article_type) {
                return Some(object);
            }
            object.values().find_map(find_article_schema)
        }
        _ => None,
    }
}

fn json_ld_is_article_type(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(types) => types.iter().any(json_ld_is_article_type),
        serde_json::Value::String(value) => matches!(
            value.rsplit(['/', '#']).next().unwrap_or(value),
            "Article" | "NewsArticle" | "BlogPosting" | "TechArticle" | "Report"
        ),
        _ => false,
    }
}

fn json_ld_name(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => clean_metadata_value(Some(value.clone())),
        serde_json::Value::Object(object) => object.get("name").and_then(json_ld_name),
        serde_json::Value::Array(items) => {
            let names = items.iter().filter_map(json_ld_name).collect::<Vec<_>>();
            (!names.is_empty()).then(|| names.join(", "))
        }
        _ => None,
    }
}

fn json_ld_url(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) => clean_metadata_value(Some(value.clone())),
        serde_json::Value::Object(object) => object
            .get("@id")
            .or_else(|| object.get("url"))
            .and_then(json_ld_url),
        _ => None,
    }
}

/// Elements whose text is never page content. Deliberately the same list the
/// injected snapshot script removes, so the webview path and the HTTP fallback
/// path agree on what a page says — otherwise the same URL yields different
/// embeddings depending on which path captured it.
///
/// `script` is the one that actually bit: `scraper`'s `.text()` walks every
/// descendant text node, and a `<script>` body *is* a text node, so inline
/// JavaScript source was being embedded and indexed as prose.
const NON_CONTENT_ELEMENTS: [&str; 10] = [
    "script", "style", "noscript", "iframe", "form", "nav", "footer", "header", "aside", "svg",
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
