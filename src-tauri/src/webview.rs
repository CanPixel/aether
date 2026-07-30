//! Native web content: one child webview per tab on desktop, one Android WebView
//! per tab on mobile, driven through the same `*_native_webview` functions.
//!
//! Each function is paired: a `#[cfg(desktop)]` implementation and a mobile one.
//! Also holds the two injected page scripts (find-in-page, scroll-to-text), which
//! are the only JavaScript ÆTHER runs inside a visited page.

use super::*;

#[cfg(desktop)]
pub(crate) fn ensure_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
) -> Cmd<()> {
    let tab = {
        let tabs = lock_tabs(state)?;
        tabs.tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .cloned()
            .ok_or_else(|| format!("Unknown tab: {tab_id}"))?
    };

    // A blank start-page tab has no remote page to load — just reconcile visibility so
    // any previously-active webview is hidden and the renderer's start page shows.
    if tab.url == START_PAGE_URL {
        return sync_native_webview_visibility(app, state);
    }

    let exists = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?
        .views
        .contains_key(tab_id);
    if !exists {
        let webview = create_native_webview(app, state, &tab)?;
        state
            .webviews
            .lock()
            .map_err(|_| "webviews are unavailable.".to_string())?
            .views
            .insert(tab.id.clone(), webview);
    }

    sync_native_webview_visibility(app, state)
}

#[cfg(not(desktop))]
pub(crate) fn ensure_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        let tab = {
            let tabs = lock_tabs(state)?;
            tabs.tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| format!("Unknown tab: {tab_id}"))?
        };
        // Like the desktop path: a start-page tab has nothing to load, only
        // visibility to reconcile so the renderer's start page shows.
        if tab.url != START_PAGE_URL {
            app.state::<android_tabs::AndroidTabs>().run(
                "ensure",
                android_tabs::TabUrlPayload {
                    tab_id: &tab.id,
                    url: &tab.url,
                },
            )?;
        }
        return sync_native_webview_visibility(app, state);
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state, tab_id);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn create_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab: &ManagedTab,
) -> Cmd<Webview> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is not ready.".to_string())?;
    let bounds = native_webview_bounds(&window, state)?;
    let label = native_webview_label(&tab.id);
    let tab_id_for_navigation = tab.id.clone();
    let tab_id_for_load = tab.id.clone();
    let tab_id_for_title = tab.id.clone();
    let app_for_navigation = app.clone();
    let app_for_load = app.clone();
    let app_for_title = app.clone();
    let app_for_new_window = app.clone();
    let app_for_download = app.clone();
    let url = Url::parse(&tab.url).map_err(|error| error.to_string())?;

    let builder = WebviewBuilder::new(label, WebviewUrl::External(url));

    // Container tabs get their own persistent store. wry's availability check is
    // at *runtime* (macOS 14+) and falls back to the default store below that, so
    // this costs nothing on older systems and needs no deployment-target bump —
    // but it does mean a container silently shares the default jar on macOS 13
    // and earlier, and on every other platform, where the option is unsupported.
    #[cfg(target_os = "macos")]
    let builder = match tab.container.as_deref() {
        Some(container) if !tab.private => {
            builder.data_store_identifier(container_data_store_id(container))
        }
        _ => builder,
    };

    // Routed through the proxy the app is currently configured for, if any.
    // Read from `Backend` rather than from settings.json because this is a sync
    // path and, more importantly, because it has to be the *same* value the HTTP
    // client is using — one source, so tabs and favicon fetches cannot diverge.
    //
    // macOS: safe here only because `proxy()` returns None below macOS 14. wry
    // sets `proxyConfigurations` through KVC with no version check, and that key
    // does not exist on 13, so an ungated call would raise rather than degrade.
    let builder = match state.proxy() {
        Some(proxy) => builder.proxy_url(proxy),
        None => builder,
    };

    // Document-start, every frame. Both halves matter: on load is too late to
    // stop a page reading the real timezone, and main-frame-only would leave any
    // embedded tracker iframe reading it anyway.
    let builder = if state.pin_timezone.load(std::sync::atomic::Ordering::Relaxed) {
        builder.initialization_script_for_all_frames(TIMEZONE_PIN_SCRIPT)
    } else {
        builder
    };

    let builder = builder
        .user_agent(BROWSER_USER_AGENT)
        // macOS/iOS: a nonPersistent WKWebsiteDataStore. Linux: an ephemeral
        // WebContext. Windows: needs WebView2 runtime 101+, and does nothing on
        // older ones — which is why the tab is also kept out of the session file
        // rather than relying on the engine alone. Reading a private tab —
        // capture, or AiON's current-page context — is deliberately not part of
        // that defence: both write locally and emit nothing, so they are the
        // user's call, not the engine's. See docs/SECURITY.md.
        .incognito(tab.private)
        .on_navigation(move |url| {
            let state = app_for_navigation.state::<Backend>();
            update_tab_navigation_state(&state, &tab_id_for_navigation, url.as_str(), true);
            let _ = emit_state(&app_for_navigation, &state);
            true
        })
        .on_page_load(move |webview, payload| {
            let state = app_for_load.state::<Backend>();
            let is_loading = payload.event() == PageLoadEvent::Started;
            update_tab_navigation_state(
                &state,
                &tab_id_for_load,
                payload.url().as_str(),
                is_loading,
            );
            let _ = emit_state(&app_for_load, &state);
            if payload.event() == PageLoadEvent::Finished {
                // Records the settled URL and title, which is what a restore needs.
                schedule_session_save(&app_for_load);
                let _ = webview.eval(NATIVE_WEBVIEW_SCROLLBAR_SCRIPT);
                read_native_webview_metadata(
                    &webview,
                    app_for_load.clone(),
                    tab_id_for_load.clone(),
                );
            }
        })
        .on_document_title_changed(move |_webview, title| {
            let state = app_for_title.state::<Backend>();
            update_tab_title(&state, &tab_id_for_title, &title);
            let _ = emit_state(&app_for_title, &state);
        })
        .on_new_window(move |url, _features| {
            let state = app_for_new_window.state::<Backend>();
            let _ = create_native_tab_from_url(&app_for_new_window, &state, url.as_str());
            NewWindowResponse::Deny
        })
        // Without this hook the webview silently drops downloads: clicking a PDF or
        // zip link did nothing at all, with no error and no file.
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                match resolve_download_destination(&app_for_download, &url) {
                    Some(target) => {
                        let filename = file_name_of(&target);
                        app_for_download
                            .state::<Backend>()
                            .pending_downloads
                            .lock()
                            .map(|mut pending| {
                                pending.insert(url.to_string(), target.clone());
                            })
                            .ok();
                        *destination = target;
                        emit_download_event(
                            &app_for_download,
                            "started",
                            &filename,
                            None,
                            url.as_str(),
                        );
                        true
                    }
                    None => {
                        diag_error!("no writable downloads directory; refusing download");
                        emit_download_event(
                            &app_for_download,
                            "failed",
                            &file_name_from_url(&url),
                            None,
                            url.as_str(),
                        );
                        false
                    }
                }
            }
            DownloadEvent::Finished { url, path, success } => {
                // macOS never reports the path here, so fall back to the destination
                // recorded at request time.
                let recorded = app_for_download
                    .state::<Backend>()
                    .pending_downloads
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&url.to_string()));
                let resolved = path.or(recorded);
                let filename = resolved
                    .as_deref()
                    .map(file_name_of)
                    .unwrap_or_else(|| file_name_from_url(&url));
                emit_download_event(
                    &app_for_download,
                    if success { "finished" } else { "failed" },
                    &filename,
                    resolved.as_deref(),
                    url.as_str(),
                );
                true
            }
            _ => true,
        });

    let webview = window
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|error| error.to_string())?;
    // Before the first paint, so no tracker request escapes an unblocked tab.
    content_blocking::apply_to_webview(&webview);
    webview.hide().map_err(|error| error.to_string())?;
    Ok(webview)
}

#[cfg(desktop)]
pub(crate) fn create_native_tab_from_url(
    app: &AppHandle,
    state: &State<Backend>,
    raw_url: &str,
) -> Cmd<()> {
    // A page opened this (target=_blank, window.open), so it is already a URL.
    let url = normalize_url(raw_url, SearchPrefs::fallback());
    let tab = ManagedTab::new("browser", &url);
    let tab_id = tab.id.clone();
    {
        let mut tabs = lock_tabs(state)?;
        tabs.active_tab_id = tab_id.clone();
        tabs.active_app_id = tab.app_id.clone();
        tabs.dashboard_open = false;
        tabs.tabs.push(tab);
    }
    ensure_native_webview(app, state, &tab_id)?;
    emit_state(app, state)
}

#[cfg(desktop)]
pub(crate) fn navigate_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    url: &str,
) -> Cmd<()> {
    ensure_native_webview(app, state, tab_id)?;
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?
        .views
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("Native webview not found for tab: {tab_id}"))?;
    webview.navigate(parsed).map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
pub(crate) fn navigate_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    url: &str,
) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        app.state::<android_tabs::AndroidTabs>()
            .run("navigate", android_tabs::TabUrlPayload { tab_id, url })?;
        return sync_native_webview_visibility(app, state);
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state, tab_id, url);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn navigate_native_webview_history(
    _app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    direction: WebviewHistoryDirection,
) -> Cmd<()> {
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?
        .views
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("Native webview not found for tab: {tab_id}"))?;
    let script = match direction {
        WebviewHistoryDirection::Back => "history.back();",
        WebviewHistoryDirection::Forward => "history.forward();",
    };
    webview.eval(script).map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
pub(crate) fn navigate_native_webview_history(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    direction: WebviewHistoryDirection,
) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        let _ = state;
        let command = match direction {
            WebviewHistoryDirection::Back => "goBack",
            WebviewHistoryDirection::Forward => "goForward",
        };
        return app
            .state::<android_tabs::AndroidTabs>()
            .run(command, android_tabs::TabPayload { tab_id });
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state, tab_id, direction);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn scroll_native_webview_to_text(
    _app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    text: &str,
) -> Cmd<()> {
    let source_text = text.trim();
    if source_text.is_empty() {
        return Ok(());
    }
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?
        .views
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("Native webview not found for tab: {tab_id}"))?;
    let text_json = serde_json::to_string(source_text).map_err(|error| error.to_string())?;
    let script = scroll_to_text_script().replace("__AETHER_SOURCE_TEXT__", &text_json);
    webview.eval(script).map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
pub(crate) fn scroll_native_webview_to_text(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    text: &str,
) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        let _ = state;
        let source_text = text.trim();
        if source_text.is_empty() {
            return Ok(());
        }
        let text_json = serde_json::to_string(source_text).map_err(|error| error.to_string())?;
        let script = scroll_to_text_script().replace("__AETHER_SOURCE_TEXT__", &text_json);
        return app
            .state::<android_tabs::AndroidTabs>()
            .run("eval", android_tabs::EvalPayload { tab_id, script });
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state, tab_id, text);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn find_native_webview_text(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    query: Option<&str>,
    action: &str,
) -> Cmd<()> {
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?
        .views
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("Native webview not found for tab: {tab_id}"))?;
    let query_json = match query.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::to_string(value).map_err(|error| error.to_string())?,
        None => "null".to_string(),
    };
    let action_json = serde_json::to_string(action).map_err(|error| error.to_string())?;
    let script = find_in_page_script()
        .replace("__AETHER_FIND_QUERY__", &query_json)
        .replace("__AETHER_FIND_ACTION__", &action_json);
    let app = app.clone();
    let tab_id = tab_id.to_string();
    webview
        .eval_with_callback(script, move |payload| {
            let Ok(snapshot) = parse_json_payload::<FindMatchSnapshot>(&payload) else {
                return;
            };
            let _ = app.emit(
                AETHER_FIND_RESULT_EVENT,
                FindResultPayload {
                    tab_id: tab_id.clone(),
                    current: snapshot.current,
                    total: snapshot.total,
                },
            );
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
pub(crate) fn find_native_webview_text(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    query: Option<&str>,
    action: &str,
) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        let _ = state;
        // Android WebView has native find support (findAllAsync/findNext); the
        // match counts come back through the FindListener as a "find" event on
        // aether_tabs_report_native_event.
        return app.state::<android_tabs::AndroidTabs>().run(
            "find",
            android_tabs::FindPayload {
                tab_id,
                query: query.map(str::trim).filter(|value| !value.is_empty()),
                action,
            },
        );
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state, tab_id, query, action);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn close_native_webview(
    _app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
) -> Cmd<()> {
    if let Some(webview) = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?
        .views
        .remove(tab_id)
    {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(desktop))]
pub(crate) fn close_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        let _ = state;
        return app
            .state::<android_tabs::AndroidTabs>()
            .run("close", android_tabs::TabPayload { tab_id });
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state, tab_id);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn find_in_page_script() -> &'static str {
    r#"
(() => {
  const action = __AETHER_FIND_ACTION__;
  const rawQuery = __AETHER_FIND_QUERY__;
  const HL = 'aether-find';
  const HL_CUR = 'aether-find-current';
  const STYLE_ID = 'aether-find-style';
  const MAX = 5000;
  const supportsHighlight =
    typeof CSS !== 'undefined' &&
    CSS.highlights &&
    typeof Highlight !== 'undefined' &&
    typeof Range !== 'undefined';
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const state = (window.__aetherFind = window.__aetherFind || { query: '', index: 0, total: 0 });

  const clearHighlights = () => {
    if (supportsHighlight) {
      try { CSS.highlights.delete(HL); CSS.highlights.delete(HL_CUR); } catch (error) {}
    }
    document.querySelectorAll('mark[data-aether-find]').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '::highlight(aether-find){background-color:#bfe9f7;color:#0e364a;}' +
      '::highlight(aether-find-current){background-color:#247fa7;color:#f4fbff;}' +
      'mark[data-aether-find]{background-color:#bfe9f7;color:#0e364a;border-radius:2px;padding:0;}' +
      'mark[data-aether-find="current"]{background-color:#247fa7;color:#f4fbff;}';
    (document.head || document.documentElement).appendChild(style);
  };

  if (action === 'clear') {
    clearHighlights();
    state.query = ''; state.index = 0; state.total = 0;
    return { current: 0, total: 0 };
  }

  const query = normalize(rawQuery);
  clearHighlights();
  if (!query) {
    state.query = ''; state.index = 0; state.total = 0;
    return { current: 0, total: 0 };
  }

  const collectRanges = (needle) => {
    const lc = needle.toLowerCase();
    const len = lc.length;
    const root = document.body || document.documentElement;
    if (!root || !len) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let buffer = '';
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: buffer.length });
      buffer += node.nodeValue;
    }
    const haystack = buffer.toLowerCase();
    const nodeAt = (offset) => {
      let lo = 0, hi = nodes.length - 1, pick = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nodes[mid].start <= offset) { pick = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return pick;
    };
    const ranges = [];
    let from = 0, at;
    while ((at = haystack.indexOf(lc, from)) !== -1) {
      const end = at + len;
      const startNode = nodeAt(at);
      const endNode = nodeAt(end - 1);
      try {
        const range = document.createRange();
        range.setStart(nodes[startNode].node, at - nodes[startNode].start);
        range.setEnd(nodes[endNode].node, end - nodes[endNode].start);
        ranges.push(range);
      } catch (error) {}
      from = end;
      if (ranges.length >= MAX) break;
    }
    return ranges;
  };

  const ranges = collectRanges(query);
  const total = ranges.length;
  if (total === 0) {
    state.query = query; state.index = 0; state.total = 0;
    return { current: 0, total: 0 };
  }

  let index;
  if ((action === 'next' || action === 'prev') && state.query === query) {
    index = state.index + (action === 'next' ? 1 : -1);
  } else {
    index = 0;
  }
  index = ((index % total) + total) % total;
  state.query = query; state.index = index; state.total = total;

  ensureStyle();
  if (supportsHighlight) {
    try {
      const all = new Highlight();
      for (const range of ranges) all.add(range);
      CSS.highlights.set(HL, all);
      const current = new Highlight();
      current.add(ranges[index]);
      CSS.highlights.set(HL_CUR, current);
    } catch (error) {}
  } else {
    for (let i = ranges.length - 1; i >= 0; i--) {
      try {
        const mark = document.createElement('mark');
        mark.setAttribute('data-aether-find', i === index ? 'current' : 'all');
        ranges[i].surroundContents(mark);
      } catch (error) {}
    }
  }

  let scrollTarget = null;
  if (supportsHighlight) {
    const node = ranges[index].startContainer;
    scrollTarget = node.nodeType === 1 ? node : node.parentElement;
  } else {
    scrollTarget = document.querySelector('mark[data-aether-find="current"]');
  }
  try {
    if (scrollTarget && scrollTarget.scrollIntoView) {
      scrollTarget.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  } catch (error) {}

  return { current: index + 1, total };
})()
"#
}

pub(crate) fn scroll_to_text_script() -> &'static str {
    r#"
(() => {
  const sourceText = __AETHER_SOURCE_TEXT__;
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const source = normalize(sourceText);
  if (!source) return;
  const EXACT_HL = 'aether-source-exact';
  const STYLE_ID = 'aether-source-style';
  const supportsHighlight =
    typeof CSS !== 'undefined' &&
    CSS.highlights &&
    typeof Highlight !== 'undefined' &&
    typeof Range !== 'undefined';

  const words = source.split(' ').filter(Boolean).slice(0, 180);
  const snippets = [];
  const seen = new Set();
  const addSnippet = (start, length) => {
    const snippet = words.slice(start, start + length).join(' ');
    if (snippet.length >= 32 && !seen.has(snippet)) {
      seen.add(snippet);
      snippets.push(snippet);
    }
  };

  for (const length of [28, 22, 16, 12, 9, 7]) {
    const step = Math.max(3, Math.floor(length / 2));
    for (let start = 0; start < words.length; start += step) {
      addSnippet(start, length);
    }
  }
  snippets.sort((left, right) => right.length - left.length);

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '::highlight(aether-source-exact){background-color:rgba(255,224,102,0.72);color:inherit;}' +
      'mark[data-aether-source-range]{background-color:rgba(255,224,102,0.72);color:inherit;border-radius:2px;padding:0;}';
    (document.head || document.documentElement).appendChild(style);
  };

  const clearExactHighlights = () => {
    if (supportsHighlight) {
      try { CSS.highlights.delete(EXACT_HL); } catch (error) {}
    }
    document.querySelectorAll('mark[data-aether-source-range]').forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  };

  const restorePreviousHighlights = () => {
    clearExactHighlights();
    document.querySelectorAll('[data-aether-source-highlight="true"]').forEach((element) => {
      element.style.outline = element.dataset.aetherPreviousOutline || '';
      element.style.boxShadow = element.dataset.aetherPreviousBoxShadow || '';
      element.style.backgroundColor = element.dataset.aetherPreviousBackgroundColor || '';
      element.removeAttribute('data-aether-source-highlight');
      element.removeAttribute('data-aether-previous-outline');
      element.removeAttribute('data-aether-previous-box-shadow');
      element.removeAttribute('data-aether-previous-background-color');
    });
  };

  const textNodeAccepted = (node) => {
    if (!node.nodeValue) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    const tag = parent.tagName;
    return tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT' && tag !== 'TEXTAREA';
  };

  const collectTextIndex = () => {
    const root = document.body || document.documentElement;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return textNodeAccepted(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const map = [];
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || '';
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (/\s/.test(char)) {
          if (text && !text.endsWith(' ')) {
            text += ' ';
            map.push({ node, offset: index });
          }
        } else {
          text += char.toLowerCase();
          map.push({ node, offset: index });
        }
      }
    }
    while (text.endsWith(' ')) {
      text = text.slice(0, -1);
      map.pop();
    }
    return { text, map };
  };

  const rangeFromIndex = (index, length, map) => {
    const start = map[index];
    const end = map[index + length - 1];
    if (!start || !end) return null;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      return range;
    } catch (error) {
      return null;
    }
  };

  const findRangeMatch = () => {
    const index = collectTextIndex();
    if (!index) return null;
    for (const snippet of snippets) {
      const at = index.text.indexOf(snippet);
      if (at === -1) continue;
      const range = rangeFromIndex(at, snippet.length, index.map);
      if (range) return range;
    }
    return null;
  };

  const scrollRangeIntoView = (range) => {
    try {
      const rects = range.getClientRects();
      const rect = rects.length ? rects[0] : range.getBoundingClientRect();
      if (rect && Number.isFinite(rect.top)) {
        const top = rect.top + window.scrollY - window.innerHeight * 0.42;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        return;
      }
    } catch (error) {}
    const node = range.startContainer;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (element && element.scrollIntoView) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  };

  const highlightRange = (range) => {
    restorePreviousHighlights();
    ensureStyle();
    let highlighted = false;
    if (supportsHighlight) {
      try {
        const exact = new Highlight();
        exact.add(range);
        CSS.highlights.set(EXACT_HL, exact);
        highlighted = true;
      } catch (error) {}
    }
    if (!highlighted) {
      try {
        const mark = document.createElement('mark');
        mark.setAttribute('data-aether-source-range', 'true');
        range.surroundContents(mark);
        highlighted = true;
      } catch (error) {}
    }
    scrollRangeIntoView(range);
    window.setTimeout(clearExactHighlights, 12000);
    return highlighted;
  };

  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const scoreElement = (element) => {
    const tag = element.tagName.toLowerCase();
    if (['p', 'li', 'blockquote', 'td', 'th', 'figcaption', 'dd', 'dt'].includes(tag)) return 0;
    if (['article', 'section', 'main'].includes(tag)) return 2;
    return 1;
  };

  const highlight = (element) => {
    restorePreviousHighlights();
    element.dataset.aetherSourceHighlight = 'true';
    element.dataset.aetherPreviousOutline = element.style.outline || '';
    element.dataset.aetherPreviousBoxShadow = element.style.boxShadow || '';
    element.dataset.aetherPreviousBackgroundColor = element.style.backgroundColor || '';
    element.style.outline = '3px solid rgba(66, 153, 225, 0.72)';
    element.style.boxShadow = '0 0 0 8px rgba(66, 153, 225, 0.16)';
    element.style.backgroundColor = 'rgba(255, 246, 189, 0.42)';
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    window.setTimeout(() => {
      if (element.dataset.aetherSourceHighlight === 'true') restorePreviousHighlights();
    }, 12000);
  };

  const findMatch = () => {
    const elements = Array.from(
      document.querySelectorAll('p, li, blockquote, td, th, figcaption, dd, dt, article, section, main, div')
    )
      .filter(isVisible)
      .map((element) => ({ element, text: normalize(element.textContent) }))
      .filter((item) => item.text.length >= 32)
      .sort((left, right) => {
        const tagScore = scoreElement(left.element) - scoreElement(right.element);
        if (tagScore !== 0) return tagScore;
        return left.text.length - right.text.length;
      });

    for (const snippet of snippets) {
      const match = elements.find((item) => item.text.includes(snippet));
      if (match) return match.element;
    }

    return null;
  };

  let attempts = 0;
  const retry = () => {
    attempts += 1;
    const range = findRangeMatch();
    if (range && highlightRange(range)) return;
    const match = findMatch();
    if (match) {
      highlight(match);
      return;
    }
    if (attempts < 28) window.setTimeout(retry, 250);
  };

  retry();
})();
"#
}

#[cfg(desktop)]
pub(crate) fn resize_native_webviews(app: &AppHandle, state: &State<Backend>) -> Cmd<()> {
    sync_native_webview_visibility(app, state)
}

#[cfg(desktop)]
pub(crate) fn sync_native_webview_visibility(app: &AppHandle, state: &State<Backend>) -> Cmd<()> {
    let (active_tab_id, show_active, panel_collapsed) = {
        let tabs = lock_tabs(state)?;
        // A tab parked on the start page must keep its (possibly still-alive) webview
        // hidden so the renderer's start page overlay stays visible.
        let active_is_start = tabs
            .active_tab()
            .map(|tab| tab.url == START_PAGE_URL)
            .unwrap_or(false);
        (
            tabs.active_tab_id.clone(),
            !tabs.dashboard_open && !tabs.modal_overlay_open && !active_is_start,
            tabs.panel_collapsed,
        )
    };
    // Prefer the renderer-measured slot; fall back to the layout constants until the
    // first report arrives.
    let bounds = match reported_webview_bounds(state) {
        Some(bounds) => bounds,
        None => {
            let window = app
                .get_window("main")
                .ok_or_else(|| "main window is not ready.".to_string())?;
            native_webview_bounds_for_window(&window, panel_collapsed)?
        }
    };
    let webviews = state
        .webviews
        .lock()
        .map_err(|_| "webviews are unavailable.".to_string())?;

    for (tab_id, webview) in &webviews.views {
        if show_active && tab_id == &active_tab_id {
            webview
                .set_bounds(bounds)
                .map_err(|error| error.to_string())?;
            webview.show().map_err(|error| error.to_string())?;
        } else {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(not(desktop))]
pub(crate) fn sync_native_webview_visibility(app: &AppHandle, state: &State<Backend>) -> Cmd<()> {
    #[cfg(target_os = "android")]
    {
        let (active_tab_id, show_active) = {
            let tabs = lock_tabs(state)?;
            // Same rules as desktop: keep webviews hidden behind the dashboard,
            // modal overlays, and the renderer's start-page overlay.
            let active_is_start = tabs
                .active_tab()
                .map(|tab| tab.url == START_PAGE_URL)
                .unwrap_or(false);
            (
                tabs.active_tab_id.clone(),
                !tabs.dashboard_open && !tabs.modal_overlay_open && !active_is_start,
            )
        };
        let bounds = *state
            .web_content_bounds
            .lock()
            .map_err(|_| "layout bounds are unavailable.".to_string())?;
        return app.state::<android_tabs::AndroidTabs>().run(
            "sync",
            android_tabs::SyncPayload {
                active_tab_id: show_active.then_some(active_tab_id.as_str()),
                top: bounds.top,
                left: bounds.left,
                width: bounds.width,
                height: bounds.height,
            },
        );
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, state);
        Ok(())
    }
}

#[cfg(desktop)]
pub(crate) fn native_webview_bounds(window: &Window, state: &State<Backend>) -> Cmd<Rect> {
    if let Some(bounds) = reported_webview_bounds(state) {
        return Ok(bounds);
    }
    let panel_collapsed = lock_tabs(state)?.panel_collapsed;
    native_webview_bounds_for_window(window, panel_collapsed)
}

#[cfg(desktop)]
pub(crate) fn native_webview_bounds_for_window(
    window: &Window,
    panel_collapsed: bool,
) -> Cmd<Rect> {
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|error| error.to_string())?);
    let right_width = if panel_collapsed {
        PANEL_COLLAPSED_WIDTH
    } else {
        PANEL_WIDTH
    };
    let width = (size.width - SIDEBAR_WIDTH - right_width).max(280.0);
    let height = (size.height - BROWSER_VIEW_TOP).max(200.0);

    Ok(Rect {
        position: Position::Logical(LogicalPosition::new(SIDEBAR_WIDTH, BROWSER_VIEW_TOP)),
        size: Size::Logical(LogicalSize::new(width, height)),
    })
}

// Preferred over the constants above: the renderer measures the actual content slot,
// so the chrome's real height and the panel's real width define the web view instead
// of numbers that silently drift whenever the CSS changes. The constants remain the
// fallback for the first frames, before the renderer has reported anything.
#[cfg(desktop)]
pub(crate) fn reported_webview_bounds(state: &State<Backend>) -> Option<Rect> {
    let bounds = *state.web_content_bounds.lock().ok()?;
    // A zero-size rect means the content slot is not laid out (dashboard open, or the
    // very first frame); positioning a webview to it would collapse the view.
    if bounds.width < 1.0 || bounds.height < 1.0 {
        return None;
    }
    Some(Rect {
        position: Position::Logical(LogicalPosition::new(bounds.left, bounds.top)),
        size: Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
    })
}

#[cfg(desktop)]
pub(crate) fn native_webview_label(tab_id: &str) -> String {
    format!("aether-browser-tab-{tab_id}")
}

#[cfg(desktop)]
pub(crate) fn read_native_webview_metadata(webview: &Webview, app: AppHandle, tab_id: String) {
    let script = r#"(() => {
      const theme = document.querySelector('meta[name="theme-color"], meta[name="msapplication-TileColor"]');
      const icons = Array.from(document.querySelectorAll('link[rel]'))
        .map((link) => {
          const rel = link.getAttribute('rel') || '';
          if (!/\b(icon|apple-touch-icon|shortcut icon)\b/i.test(rel)) return null;
          const href = link.href || '';
          const sizes = link.getAttribute('sizes') || '';
          const size = sizes
            .split(/\s+/)
            .map((item) => Number.parseInt(item, 10) || 0)
            .reduce((largest, value) => Math.max(largest, value), 0);
          return { href, rel, size };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (right.size !== left.size) return right.size - left.size;
          return Number(/apple-touch-icon/i.test(right.rel)) - Number(/apple-touch-icon/i.test(left.rel));
        });
      return {
        themeColor: theme?.getAttribute('content') || '',
        favicon: icons[0]?.href || ''
      };
    })()"#;

    let _ = webview.eval_with_callback(script, move |payload| {
        let metadata = match parse_json_payload::<PageMetadataSnapshot>(&payload) {
            Ok(metadata) => metadata,
            Err(_) => return,
        };
        let favicon = metadata
            .favicon
            .map(|favicon| favicon.trim().to_string())
            .filter(|favicon| !favicon.is_empty());
        let theme_color = metadata
            .theme_color
            .as_deref()
            .and_then(normalize_theme_color);
        let state = app.state::<Backend>();
        if update_tab_metadata(&state, &tab_id, theme_color, favicon) {
            let _ = emit_state(&app, &state);
        }
    });
}

pub(crate) fn update_tab_navigation_state(
    state: &State<Backend>,
    tab_id: &str,
    url: &str,
    is_loading: bool,
) {
    if let Ok(mut tabs) = lock_tabs(state) {
        if let Some(tab) = tabs.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.is_loading = is_loading;
            let url = url.trim();
            if !should_accept_webview_url(&tab.url, url) {
                return;
            }

            let url = url.to_string();
            let url_changed = tab.url != url;
            tab.url = url.clone();
            tab.favicon = favicon_for_url(&url);
            if url_changed {
                tab.theme_color = None;
            }
            if tab.title == "New tab" || tab.title.is_empty() || tab.title == get_tab_host(&tab.url)
            {
                tab.title = title_from_url(&url);
            }
            if !is_loading {
                tab.commit_history_url(url);
            }
        }
    }
}

pub(crate) fn should_accept_webview_url(current_url: &str, next_url: &str) -> bool {
    if next_url.is_empty() {
        return false;
    }
    // While a tab is parked on the start page, ignore stray events from its hidden
    // webview so they don't overwrite the start-page sentinel.
    if current_url == START_PAGE_URL {
        return false;
    }
    if is_transient_webview_url(next_url) && !is_transient_webview_url(current_url) {
        return false;
    }
    true
}

pub(crate) fn is_transient_webview_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized == "about:blank"
        || normalized.starts_with("about:blank#")
        || normalized == "about:srcdoc"
}

#[cfg(desktop)]
pub(crate) fn update_tab_metadata(
    state: &State<Backend>,
    tab_id: &str,
    theme_color: Option<String>,
    favicon: Option<String>,
) -> bool {
    if let Ok(mut tabs) = lock_tabs(state) {
        if let Some(tab) = tabs.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            let favicon = favicon.or_else(|| tab.favicon.clone());
            if tab.theme_color == theme_color && tab.favicon == favicon {
                return false;
            }
            tab.theme_color = theme_color;
            tab.favicon = favicon;
            return true;
        }
    }
    false
}

pub(crate) fn update_tab_title(state: &State<Backend>, tab_id: &str, title: &str) {
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    if let Ok(mut tabs) = lock_tabs(state) {
        if let Some(tab) = tabs.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.title = title.to_string();
        }
    }
}
