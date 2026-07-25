//! Every `#[tauri::command]` the renderer can invoke.
//!
//! Thin by design: each one validates its input, delegates to the domain function
//! below, and maps the result into `Cmd<T>`. Command names are the IPC contract
//! with src/renderer/src/tauri-aether.ts and are also listed in `generate_handler!`
//! in lib.rs — adding one means touching all three.

use super::*;

#[tauri::command]
pub(crate) fn aether_state(state: State<Backend>) -> Cmd<AetherState> {
    Ok(lock_tabs(&state)?.state())
}

#[tauri::command]
pub(crate) fn aether_apps_list(state: State<Backend>) -> Cmd<Vec<AppSummary>> {
    Ok(lock_tabs(&state)?.apps())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_apps_activate(
    app: AppHandle,
    state: State<Backend>,
    app_id: String,
) -> Cmd<()> {
    if app_id != "browser" {
        return Err(format!("Unknown app: {app_id}"));
    }
    {
        let mut tabs = lock_tabs(&state)?;
        tabs.dashboard_open = false;
    }
    let active_tab_id = lock_tabs(&state)?.active_tab_id.clone();
    ensure_native_webview(&app, &state, &active_tab_id)?;
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_apps_navigate(
    app: AppHandle,
    state: State<'_, Backend>,
    app_id: String,
    url: String,
) -> Cmd<()> {
    if app_id != "browser" {
        return Err(format!("Unknown app: {app_id}"));
    }
    navigate_active_tab(&app, &state, &url).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_apps_go_back(
    app: AppHandle,
    state: State<Backend>,
    app_id: String,
) -> Cmd<()> {
    if app_id != "browser" {
        return Err(format!("Unknown app: {app_id}"));
    }
    aether_tabs_go_back(app, state, String::new())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_apps_go_forward(
    app: AppHandle,
    state: State<Backend>,
    app_id: String,
) -> Cmd<()> {
    if app_id != "browser" {
        return Err(format!("Unknown app: {app_id}"));
    }
    aether_tabs_go_forward(app, state, String::new())
}

#[tauri::command]
pub(crate) fn aether_tabs_list(state: State<Backend>) -> Cmd<Vec<BrowserTabSummary>> {
    Ok(lock_tabs(&state)?.tabs())
}

#[tauri::command]
pub(crate) async fn aether_tabs_create(
    app: AppHandle,
    state: State<'_, Backend>,
    input: Option<CreateTabInput>,
) -> Cmd<BrowserTabSummary> {
    let settings = load_settings(&state.paths.settings_path).await?;
    // No URL → open a blank start-page tab (Portals + search) rather than a search engine.
    let requested_url = input.and_then(|input| input.url);
    let url = match requested_url {
        Some(raw_url) => normalize_url(&raw_url, &settings.browser.default_search_engine),
        None => START_PAGE_URL.to_string(),
    };
    let tab = ManagedTab::new("browser", &url);
    let tab_id = tab.id.clone();
    let summary = tab.summary(true);
    {
        let mut tabs = lock_tabs(&state)?;
        tabs.active_tab_id = tab.id.clone();
        tabs.active_app_id = tab.app_id.clone();
        tabs.dashboard_open = false;
        tabs.tabs.push(tab);
    }
    ensure_native_webview(&app, &state, &tab_id)?;
    emit_state(&app, &state)?;
    schedule_session_save(&app);
    Ok(summary)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_tabs_activate(
    app: AppHandle,
    state: State<Backend>,
    tab_id: String,
) -> Cmd<()> {
    {
        let mut tabs = lock_tabs(&state)?;
        if !tabs.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(format!("Unknown tab: {tab_id}"));
        }
        tabs.active_tab_id = tab_id.clone();
        tabs.active_app_id = "browser".to_string();
        tabs.dashboard_open = false;
    }
    ensure_native_webview(&app, &state, &tab_id)?;
    emit_state(&app, &state)?;
    schedule_session_save(&app);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_tabs_close(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
    let mut next_active_tab_id = None;
    {
        let mut tabs = lock_tabs(&state)?;
        if tabs.tabs.len() == 1 {
            return Ok(());
        }
        let was_active = tabs.active_tab_id == tab_id;
        tabs.tabs.retain(|tab| tab.id != tab_id);
        if was_active {
            if let Some(next_id) = tabs.tabs.last().map(|tab| tab.id.clone()) {
                tabs.active_tab_id = next_id.clone();
                next_active_tab_id = Some(next_id);
            }
        }
    }
    close_native_webview(&app, &state, &tab_id)?;
    if let Some(active_tab_id) = next_active_tab_id {
        ensure_native_webview(&app, &state, &active_tab_id)?;
    } else {
        sync_native_webview_visibility(&app, &state)?;
    }
    emit_state(&app, &state)?;
    schedule_session_save(&app);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_tabs_navigate(
    app: AppHandle,
    state: State<'_, Backend>,
    tab_id: String,
    url: String,
) -> Cmd<()> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let target_url = {
        let mut tabs = lock_tabs(&state)?;
        let tab = tabs
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("Unknown tab: {tab_id}"))?;
        tab.navigate(&url, &settings.browser.default_search_engine);
        let target_url = tab.url.clone();
        tabs.active_tab_id = tab.id.clone();
        tabs.dashboard_open = false;
        target_url
    };
    navigate_native_webview(&app, &state, &tab_id, &target_url)?;
    emit_state(&app, &state)?;
    schedule_session_save(&app);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_tabs_scroll_to_text(
    app: AppHandle,
    state: State<Backend>,
    tab_id: String,
    text: String,
) -> Cmd<()> {
    {
        let tabs = lock_tabs(&state)?;
        if !tabs.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(format!("Unknown tab: {tab_id}"));
        }
    }
    scroll_native_webview_to_text(&app, &state, &tab_id, &text)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_tabs_find(
    app: AppHandle,
    state: State<Backend>,
    tab_id: String,
    query: Option<String>,
    action: Option<String>,
) -> Cmd<()> {
    let target_tab_id = {
        let tabs = lock_tabs(&state)?;
        if tab_id.is_empty() {
            tabs.active_tab_id.clone()
        } else if tabs.tabs.iter().any(|tab| tab.id == tab_id) {
            tab_id
        } else {
            return Err(format!("Unknown tab: {tab_id}"));
        }
    };
    let action = action.as_deref().unwrap_or("find");
    find_native_webview_text(&app, &state, &target_tab_id, query.as_deref(), action)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_tabs_go_back(
    app: AppHandle,
    state: State<Backend>,
    tab_id: String,
) -> Cmd<()> {
    let mut restore_start_page = false;
    let target_tab_id = {
        let mut tabs = lock_tabs(&state)?;
        let tab = if tab_id.is_empty() {
            tabs.active_tab_mut()
                .ok_or_else(|| "No active browser tab.".to_string())?
        } else {
            tabs.tabs
                .iter_mut()
                .find(|tab| tab.id == tab_id)
                .ok_or_else(|| format!("Unknown tab: {tab_id}"))?
        };
        // The start page is a renderer overlay, not a native page, so the webview can't
        // navigate back to it. When the previous history entry is the start page, park
        // the tab back on it (its webview is kept hidden for a later forward).
        if tab.can_go_back()
            && tab.history.get(tab.history_index - 1).map(String::as_str) == Some(START_PAGE_URL)
        {
            tab.history_index -= 1;
            tab.url = START_PAGE_URL.to_string();
            tab.title = "New tab".to_string();
            tab.is_loading = false;
            restore_start_page = true;
        }
        tab.id.clone()
    };
    if restore_start_page {
        sync_native_webview_visibility(&app, &state)?;
    } else {
        navigate_native_webview_history(
            &app,
            &state,
            &target_tab_id,
            WebviewHistoryDirection::Back,
        )?;
    }
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_tabs_go_forward(
    app: AppHandle,
    state: State<Backend>,
    tab_id: String,
) -> Cmd<()> {
    let mut leave_start_page = false;
    let target_tab_id = {
        let mut tabs = lock_tabs(&state)?;
        let tab = if tab_id.is_empty() {
            tabs.active_tab_mut()
                .ok_or_else(|| "No active browser tab.".to_string())?
        } else {
            tabs.tabs
                .iter_mut()
                .find(|tab| tab.id == tab_id)
                .ok_or_else(|| format!("Unknown tab: {tab_id}"))?
        };
        // Forwarding off the start page: advance to the real page whose (hidden) webview
        // we kept, then reveal it instead of issuing a native history.forward().
        if tab.url == START_PAGE_URL && tab.can_go_forward() {
            tab.history_index += 1;
            tab.url = tab.history[tab.history_index].clone();
            tab.title = title_from_url(&tab.url);
            tab.is_loading = false;
            leave_start_page = true;
        }
        tab.id.clone()
    };
    if leave_start_page {
        ensure_native_webview(&app, &state, &target_tab_id)?;
    } else {
        navigate_native_webview_history(
            &app,
            &state,
            &target_tab_id,
            WebviewHistoryDirection::Forward,
        )?;
    }
    emit_state(&app, &state)
}

// Mobile-only feedback channel: the Kotlin TabsPlugin evaluates
// `window.__AETHER_TAB_EVENT__(...)` in the main webview and the renderer
// forwards the payload here, mirroring how desktop child-webview callbacks
// (on_navigation / on_page_load / on_document_title_changed) feed tab state.
#[tauri::command]
pub(crate) fn aether_tabs_report_native_event(
    app: AppHandle,
    state: State<Backend>,
    input: NativeTabEventInput,
) -> Cmd<()> {
    match input.kind.as_str() {
        "navigation" => {
            let parked_on_start_page = {
                let tabs = lock_tabs(&state)?;
                tabs.tabs
                    .iter()
                    .find(|tab| tab.id == input.tab_id)
                    .map(|tab| tab.url == START_PAGE_URL)
                    .unwrap_or(true)
            };
            // A tab parked on the start page keeps its (hidden) webview alive;
            // ignore its stray events so the start-page sentinel survives.
            if parked_on_start_page {
                return Ok(());
            }
            if let Some(url) = input.url.as_deref() {
                update_tab_navigation_state(
                    &state,
                    &input.tab_id,
                    url,
                    input.is_loading.unwrap_or(false),
                );
            }
            {
                let mut tabs = lock_tabs(&state)?;
                if let Some(tab) = tabs.tabs.iter_mut().find(|tab| tab.id == input.tab_id) {
                    tab.native_can_go_back = input.can_go_back;
                    tab.native_can_go_forward = input.can_go_forward;
                }
            }
            emit_state(&app, &state)
        }
        "title" => {
            if let Some(title) = input.title.as_deref() {
                update_tab_title(&state, &input.tab_id, title);
            }
            emit_state(&app, &state)
        }
        "find" => app
            .emit(
                AETHER_FIND_RESULT_EVENT,
                FindResultPayload {
                    tab_id: input.tab_id,
                    current: input.current.unwrap_or(0),
                    total: input.total.unwrap_or(0),
                },
            )
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

// Preview image (data-URI JPEG) for the mobile tab-grid switcher. Desktop
// renders live child webviews and never asks for one, so it returns None.
// Async on purpose: the Kotlin side resolves on the Android UI thread, so the
// blocking run_mobile_plugin call must sit on a tokio worker.
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_tabs_thumbnail(app: AppHandle, tab_id: String) -> Cmd<Option<String>> {
    #[cfg(target_os = "android")]
    {
        let response: android_tabs::ThumbnailResponse = app
            .state::<android_tabs::AndroidTabs>()
            .run_for("thumbnail", android_tabs::TabPayload { tab_id: &tab_id })?;
        return Ok(response.image);
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, tab_id);
        Ok(None)
    }
}

// System-bar/cutout insets (CSS px) for the edge-to-edge Android activity;
// zero on desktop, where the OS window frame handles this. Async for the same
// UI-thread reason as aether_tabs_thumbnail.
#[tauri::command]
pub(crate) async fn aether_layout_window_insets(app: AppHandle) -> Cmd<serde_json::Value> {
    #[cfg(target_os = "android")]
    {
        let response: android_tabs::InsetsResponse = app
            .state::<android_tabs::AndroidTabs>()
            .run_for("insets", serde_json::json!({}))?;
        return serde_json::to_value(response).map_err(|error| error.to_string());
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        serde_json::to_value(serde_json::json!({
            "top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0
        }))
        .map_err(|error| error.to_string())
    }
}

// The renderer measures where Android tab WebViews belong (MobileTabView's
// The renderer measures the slot where live web content belongs (a placeholder div's
// bounding rect, CSS px) and reports it here. Both shells position their native web
// views from this, so a chrome restyle or a panel resize moves the content with it
// instead of drifting away from hardcoded offsets.
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_layout_set_web_content_bounds(
    app: AppHandle,
    state: State<Backend>,
    top: f64,
    left: f64,
    width: f64,
    height: f64,
) -> Cmd<()> {
    let next = WebContentBounds {
        top,
        left,
        width,
        height,
    };
    {
        let mut stored = state
            .web_content_bounds
            .lock()
            .map_err(|_| "layout bounds are unavailable.".to_string())?;
        // A ResizeObserver fires on every layout pass; repositioning native webviews
        // for an unchanged rect causes visible flicker on desktop.
        if *stored == next {
            return Ok(());
        }
        *stored = next;
    }
    sync_native_webview_visibility(&app, &state)
}

#[tauri::command]
pub(crate) fn aether_dashboard_open(app: AppHandle, state: State<Backend>) -> Cmd<()> {
    {
        let mut tabs = lock_tabs(&state)?;
        tabs.dashboard_open = true;
    }
    sync_native_webview_visibility(&app, &state)?;
    emit_state(&app, &state)
}

#[tauri::command]
pub(crate) async fn aether_hub_list(state: State<'_, Backend>) -> Cmd<Vec<HubShortcutSummary>> {
    Ok(load_library(&state.paths.library_path).await?.shortcuts)
}

#[tauri::command]
pub(crate) async fn aether_hub_create(
    state: State<'_, Backend>,
    input: CreateShortcutInput,
) -> Cmd<HubShortcutSummary> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("Shortcut title is required.".to_string());
    }
    let url = normalize_url(&input.url, "google");
    let mut data = load_library(&state.paths.library_path).await?;
    let favicon = input
        .favicon
        .as_deref()
        .map(str::trim)
        .filter(|favicon| !favicon.is_empty())
        .map(str::to_string);
    let theme_color = input.theme_color.as_deref().and_then(normalize_theme_color);
    if let Some(existing) = data
        .shortcuts
        .iter_mut()
        .find(|shortcut| shortcut.url == url)
    {
        let mut changed = false;
        if existing.favicon.is_none() && favicon.is_some() {
            existing.favicon = favicon;
            changed = true;
        }
        if existing.theme_color.is_none() && theme_color.is_some() {
            existing.theme_color = theme_color;
            changed = true;
        }
        let shortcut = existing.clone();
        if changed {
            save_json(&state.paths.library_path, &data).await?;
        }
        return Ok(shortcut);
    }
    let shortcut = HubShortcutSummary {
        id: uuid(),
        title,
        host: get_tab_host(&url),
        url,
        created_at: now(),
        favicon,
        theme_color,
    };
    data.shortcuts.insert(0, shortcut.clone());
    save_json(&state.paths.library_path, &data).await?;
    Ok(shortcut)
}

#[tauri::command]
pub(crate) async fn aether_hub_reorder(
    state: State<'_, Backend>,
    ids: Vec<String>,
) -> Cmd<Vec<HubShortcutSummary>> {
    let mut data = load_library(&state.paths.library_path).await?;
    data.shortcuts = reorder(data.shortcuts, &ids, |shortcut| &shortcut.id);
    save_json(&state.paths.library_path, &data).await?;
    Ok(data.shortcuts)
}

#[tauri::command]
pub(crate) async fn aether_hub_delete(state: State<'_, Backend>, id: String) -> Cmd<()> {
    let mut data = load_library(&state.paths.library_path).await?;
    data.shortcuts.retain(|shortcut| shortcut.id != id);
    save_json(&state.paths.library_path, &data).await
}

#[tauri::command]
pub(crate) async fn aether_collections_list(
    state: State<'_, Backend>,
) -> Cmd<Vec<CollectionSummary>> {
    Ok(load_library(&state.paths.library_path).await?.collections)
}

#[tauri::command]
pub(crate) async fn aether_collections_create(
    state: State<'_, Backend>,
    input: CreateCollectionInput,
) -> Cmd<CollectionSummary> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Collection name is required.".to_string());
    }
    let mut data = load_library(&state.paths.library_path).await?;
    let now = now();
    let existing = data
        .collections
        .iter()
        .map(|collection| collection.id.clone())
        .collect::<Vec<_>>();
    let collection = CollectionSummary {
        id: unique_slug(&name, &existing),
        name,
        description: input.description.unwrap_or_default().trim().to_string(),
        icon: Some(input.icon.unwrap_or_else(|| "book".to_string()))
            .map(|icon| icon.trim().to_string())
            .filter(|icon| !icon.is_empty()),
        created_at: now.clone(),
        updated_at: now,
        capture_count: 0,
        chunk_count: 0,
    };
    data.collections.push(collection.clone());
    save_json(&state.paths.library_path, &data).await?;
    Ok(collection)
}

#[tauri::command]
pub(crate) async fn aether_collections_update(
    state: State<'_, Backend>,
    input: UpdateCollectionInput,
) -> Cmd<CollectionSummary> {
    let mut data = load_library(&state.paths.library_path).await?;
    let collection = data
        .collections
        .iter_mut()
        .find(|collection| collection.id == input.id)
        .ok_or_else(|| "Collection not found.".to_string())?;
    if let Some(name) = input.name {
        let name = name.trim();
        if name.is_empty() {
            return Err("Collection name is required.".to_string());
        }
        collection.name = name.to_string();
    }
    if let Some(description) = input.description {
        collection.description = description.trim().to_string();
    }
    if let Some(icon) = input.icon {
        collection.icon = Some(icon.trim().to_string()).filter(|icon| !icon.is_empty());
    }
    collection.updated_at = now();
    let updated = collection.clone();
    save_json(&state.paths.library_path, &data).await?;
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn aether_collections_reorder(
    state: State<'_, Backend>,
    ids: Vec<String>,
) -> Cmd<Vec<CollectionSummary>> {
    let mut data = load_library(&state.paths.library_path).await?;
    data.collections = reorder(data.collections, &ids, |collection| &collection.id);
    save_json(&state.paths.library_path, &data).await?;
    Ok(data.collections)
}

#[tauri::command]
pub(crate) async fn aether_collections_delete(state: State<'_, Backend>, id: String) -> Cmd<()> {
    let mut library = load_library(&state.paths.library_path).await?;
    library.collections.retain(|collection| collection.id != id);
    library
        .captures
        .retain(|capture| capture.collection_id != id);
    save_json(&state.paths.library_path, &library).await?;

    with_vectors_mut(&state, |vectors| {
        vectors.chunks.retain(|chunk| chunk.collection_id != id);
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_collections_captures(
    state: State<'_, Backend>,
    collection_id: String,
) -> Cmd<Vec<CaptureSummary>> {
    let mut captures = load_library(&state.paths.library_path)
        .await?
        .captures
        .into_iter()
        .filter(|capture| capture.collection_id == collection_id)
        .collect::<Vec<_>>();
    captures.sort_by(|left, right| right.captured_at.cmp(&left.captured_at));
    Ok(captures)
}

// Strict counterpart to normalize_url: capture must never silently turn a typo into
// a search-engine URL and then index the results page. Bare hosts are still
// accepted, since that is how people paste links.
pub(crate) fn capture_target_url(raw: &str) -> Cmd<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a web address to capture.".to_string());
    }
    let lowered = trimmed.to_ascii_lowercase();
    let candidate = if lowered.starts_with("http://") || lowered.starts_with("https://") {
        trimmed.to_string()
    } else if lowered.contains("://") {
        return Err("Only http and https pages can be captured.".to_string());
    } else if !trimmed.contains(char::is_whitespace) && trimmed.contains('.') {
        format!("https://{trimmed}")
    } else {
        return Err(format!("\"{trimmed}\" is not a web address."));
    };
    let parsed =
        Url::parse(&candidate).map_err(|_| format!("\"{trimmed}\" is not a web address."))?;
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err(format!("\"{trimmed}\" is not a web address."));
    }
    Ok(parsed.to_string())
}

#[tauri::command]
pub(crate) async fn aether_capture_current_page(
    app: AppHandle,
    state: State<'_, Backend>,
    input: CaptureCurrentPageInput,
) -> Cmd<CaptureResult> {
    emit_capture_progress(&app, "Reading current page", None, None);
    let active_tab = {
        let tabs = lock_tabs(&state)?;
        if tabs.dashboard_open {
            return Err("Open a website before capturing into a collection.".to_string());
        }
        tabs.active_tab()
            .cloned()
            .ok_or_else(|| "No active browser tab.".to_string())?
    };
    let app_id = active_tab.app_id.clone();
    let captured = extract_readable_active_page(&state, &active_tab).await?;
    capture_page_into_collection(&app, &state, &input.collection_id, captured, &app_id).await
}

// Captures a page ÆTHER never had to load. This is what lets sources arrive from a
// pasted link, a dropped link, or a batch of open tabs instead of only from the
// active tab, so the library can grow without the app being the default browser.
#[tauri::command]
pub(crate) async fn aether_capture_url(
    app: AppHandle,
    state: State<'_, Backend>,
    input: CaptureUrlInput,
) -> Cmd<CaptureResult> {
    let target = capture_target_url(&input.url)?;
    emit_capture_progress(&app, "Fetching page", None, None);
    let captured = extract_readable_page(&state.client, &target).await?;
    capture_page_into_collection(&app, &state, &input.collection_id, captured, "browser").await
}

// Bulk sibling of aether_capture_url. One bad link in a batch must not discard the
// pages that did work, so failures are reported per URL instead of aborting.
#[tauri::command]
pub(crate) async fn aether_capture_urls(
    app: AppHandle,
    state: State<'_, Backend>,
    input: CaptureUrlsInput,
) -> Cmd<BulkCaptureResult> {
    if input.urls.is_empty() {
        return Err("No links to capture.".to_string());
    }
    let collection = get_collection(&state.paths.library_path, &input.collection_id).await?;

    let total = input.urls.len();
    let mut captured = Vec::new();
    let mut failures = Vec::new();

    for (index, raw_url) in input.urls.iter().enumerate() {
        emit_capture_progress(
            &app,
            format!("Capturing link {} of {total}", index + 1),
            Some(index),
            Some(total),
        );
        let outcome = async {
            let target = capture_target_url(raw_url)?;
            let page = extract_readable_page(&state.client, &target).await?;
            capture_page_into_collection(&app, &state, &input.collection_id, page, "browser").await
        }
        .await;

        match outcome {
            Ok(result) => captured.push(result.capture),
            Err(reason) => failures.push(BulkCaptureFailure {
                url: raw_url.clone(),
                reason,
            }),
        }
    }

    emit_capture_progress(&app, "Finished capturing links", Some(total), Some(total));

    Ok(BulkCaptureResult {
        captured,
        collection_name: collection.name,
        failures,
    })
}

// Shared tail of every capture path: chunk, embed, store vectors, update the
// library manifest. Kept in one place so the fetch-based captures cannot drift
// from the active-tab capture.
pub(crate) async fn capture_page_into_collection(
    app: &AppHandle,
    state: &State<'_, Backend>,
    collection_id: &str,
    captured: CapturedPage,
    app_id: &str,
) -> Cmd<CaptureResult> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let mut library = load_library(&state.paths.library_path).await?;
    let collection = library
        .collections
        .iter()
        .find(|collection| collection.id == collection_id)
        .cloned()
        .ok_or_else(|| "Collection not found.".to_string())?;
    emit_capture_progress(app, "Chunking readable text", None, None);
    let captured_key = normalize_capture_url_key(&captured.url);
    if library.captures.iter().any(|capture| {
        capture.collection_id == collection.id
            && normalize_capture_url_key(&capture.url) == captured_key
    }) {
        return Err(format!("Page is already in {}.", collection.name));
    }

    let (chunk_size, chunk_overlap) = capture_chunk_settings(&state.paths, &settings);
    let chunks = split_text(&captured.text, chunk_size, chunk_overlap);
    if chunks.is_empty() {
        return Err("No readable text found on that page.".to_string());
    }
    emit_capture_progress(
        app,
        format!("Embedding {} chunks", chunks.len()),
        Some(0),
        Some(chunks.len()),
    );
    let embeddings = local_embed_with_progress(
        state,
        &settings,
        chunks.clone(),
        Some(EmbeddingProgress {
            app: app.clone(),
            message: "Embedding chunks".to_string(),
        }),
    )
    .await?;
    if embeddings.len() != chunks.len() {
        return Err(
            "Local embedding model returned an unexpected number of embeddings.".to_string(),
        );
    }
    emit_capture_progress(
        app,
        "Saving capture",
        Some(chunks.len()),
        Some(chunks.len()),
    );

    let capture_id = uuid();
    let captured_at = now();
    let records = chunks
        .into_iter()
        .enumerate()
        .map(|(index, text)| ChunkRecord {
            id: uuid(),
            vector: embeddings[index].clone(),
            // Assigned by push_chunks when the store accepts the record.
            vector_slot: 0,
            needs_reembed: false,
            text,
            collection_id: collection.id.clone(),
            capture_id: capture_id.clone(),
            title: captured.title.clone(),
            url: captured.url.clone(),
            app_id: app_id.to_string(),
            captured_at: captured_at.clone(),
            chunk_index: index,
        })
        .collect::<Vec<_>>();

    // push_chunks assigns the sidecar slots; never extend `chunks` directly.
    with_vectors_mut(state, |vectors| {
        vectors.push_chunks(records.iter().cloned());
    })
    .await?;

    let capture = CaptureSummary {
        id: capture_id,
        collection_id: collection.id.clone(),
        title: captured.title,
        url: captured.url,
        app_id: app_id.to_string(),
        captured_at,
        chunk_count: records.len(),
        metadata: None,
    };
    library.captures.push(capture.clone());
    if let Some(stored_collection) = library
        .collections
        .iter_mut()
        .find(|item| item.id == collection.id)
    {
        stored_collection.capture_count += 1;
        stored_collection.chunk_count += records.len();
        stored_collection.updated_at = capture.captured_at.clone();
    }
    save_json(&state.paths.library_path, &library).await?;

    Ok(CaptureResult {
        capture,
        collection_name: collection.name,
    })
}

#[tauri::command]
pub(crate) async fn aether_capture_move(
    state: State<'_, Backend>,
    input: MoveCaptureInput,
) -> Cmd<CaptureSummary> {
    let mut library = load_library(&state.paths.library_path).await?;
    let now = now();
    let target_exists = library
        .collections
        .iter()
        .any(|collection| collection.id == input.collection_id);
    if !target_exists {
        return Err("Target collection not found.".to_string());
    }
    let capture = library
        .captures
        .iter_mut()
        .find(|capture| capture.id == input.capture_id)
        .ok_or_else(|| "Capture not found.".to_string())?;
    if capture.collection_id == input.collection_id {
        return Ok(capture.clone());
    }
    let source_collection_id = capture.collection_id.clone();
    let chunk_count = capture.chunk_count;
    capture.collection_id = input.collection_id.clone();
    let moved = capture.clone();
    for collection in &mut library.collections {
        if collection.id == source_collection_id {
            collection.capture_count = collection.capture_count.saturating_sub(1);
            collection.chunk_count = collection.chunk_count.saturating_sub(chunk_count);
            collection.updated_at = now.clone();
        }
        if collection.id == input.collection_id {
            collection.capture_count += 1;
            collection.chunk_count += chunk_count;
            collection.updated_at = now.clone();
        }
    }
    save_json(&state.paths.library_path, &library).await?;

    with_vectors_mut(&state, |vectors| {
        for chunk in &mut vectors.chunks {
            if chunk.capture_id == input.capture_id {
                chunk.collection_id = input.collection_id.clone();
            }
        }
    })
    .await?;
    Ok(moved)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_capture_delete(
    state: State<'_, Backend>,
    capture_id: String,
) -> Cmd<()> {
    let mut library = load_library(&state.paths.library_path).await?;
    let deleted = library
        .captures
        .iter()
        .find(|capture| capture.id == capture_id)
        .cloned();
    library.captures.retain(|capture| capture.id != capture_id);
    if let Some(deleted) = deleted {
        if let Some(collection) = library
            .collections
            .iter_mut()
            .find(|collection| collection.id == deleted.collection_id)
        {
            collection.capture_count = collection.capture_count.saturating_sub(1);
            collection.chunk_count = collection.chunk_count.saturating_sub(deleted.chunk_count);
            collection.updated_at = now();
        }
    }
    save_json(&state.paths.library_path, &library).await?;
    with_vectors_mut(&state, |vectors| {
        vectors
            .chunks
            .retain(|chunk| chunk.capture_id != capture_id);
    })
    .await
}

#[tauri::command]
pub(crate) async fn aether_search_collection(
    state: State<'_, Backend>,
    input: SearchCollectionInput,
) -> Cmd<Vec<SearchResult>> {
    search_collection(&state, input).await
}

#[tauri::command]
pub(crate) async fn aether_semantic_trail_generate(
    state: State<'_, Backend>,
    input: Option<SemanticTrailInput>,
) -> Cmd<SemanticTrailResult> {
    semantic_trail_generate(
        &state,
        input.unwrap_or(SemanticTrailInput {
            query: None,
            limit: None,
        }),
    )
    .await
}

#[tauri::command]
pub(crate) async fn aether_flow_graph(
    state: State<'_, Backend>,
    input: Option<FlowGraphInput>,
) -> Cmd<FlowGraphResult> {
    flow_graph_generate(
        &state,
        input.unwrap_or(FlowGraphInput {
            query: None,
            source_limit: None,
        }),
    )
    .await
}

#[tauri::command]
pub(crate) async fn aether_air_prepare(
    state: State<'_, Backend>,
    input: AirDossierInput,
) -> Cmd<AirPreparedDossier> {
    air_prepare_dossier(&state, input, false).await
}

#[tauri::command]
pub(crate) async fn aether_air_render(
    state: State<'_, Backend>,
    input: AirDossierInput,
) -> Cmd<AirRenderResult> {
    let prepared = air_prepare_dossier(&state, input, true).await?;
    let output_dir = resolve_air_export_dir(&state.paths, true).await?;
    let filename = air_dossier_filename(&prepared.title, &prepared.generated_at);
    let path = output_dir.join(filename);
    tokio::fs::write(&path, prepared.markdown_preview.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    Ok(AirRenderResult {
        path: path.display().to_string(),
        filename: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("aether-dossier.md")
            .to_string(),
        title: prepared.title,
        source_count: prepared.sources.len(),
        rendered_at: prepared.generated_at,
    })
}

#[tauri::command]
pub(crate) async fn aether_air_list_recent(state: State<'_, Backend>) -> Cmd<Vec<AirRecentFile>> {
    air_list_recent(&state.paths).await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_air_open(app: AppHandle, path: String) -> Cmd<()> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("AiR file not found.".to_string());
    }
    app.opener()
        .open_path(path.display().to_string(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_air_reveal(app: AppHandle, path: String) -> Cmd<()> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("AiR file not found.".to_string());
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn aether_capture_suggest_hub(
    state: State<'_, Backend>,
) -> Cmd<Option<CaptureHubSuggestion>> {
    suggest_capture_hub(&state).await
}

#[tauri::command]
pub(crate) async fn aether_chat_ask(
    app: AppHandle,
    state: State<'_, Backend>,
    input: AskChatInput,
) -> Cmd<ChatResult> {
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Enter a question before asking Æther.".to_string());
    }
    state
        .generation_cancelled
        .store(false, AtomicOrdering::Relaxed);
    let stream = ChatStreamEmitter {
        app,
        request_id: input.request_id.clone().unwrap_or_else(uuid),
    };
    let settings = load_settings(&state.paths.settings_path).await?;
    let mut citations = if let Some(collection_id) = input.collection_id.clone() {
        stream.status("Searching your knowledge hub");
        search_collection(
            &state,
            SearchCollectionInput {
                collection_id,
                query: prompt.clone(),
                limit: Some(8),
            },
        )
        .await?
    } else {
        Vec::new()
    };

    if input.include_current_page.unwrap_or(false) {
        stream.status("Reading current page");
        if let Ok(active_url) = active_tab_url(&state) {
            let active_tab = {
                let tabs = lock_tabs(&state)?;
                tabs.active_tab().cloned()
            };
            let captured = if let Some(active_tab) = active_tab {
                extract_readable_active_page(&state, &active_tab).await.ok()
            } else {
                extract_readable_page(&state.client, &active_url).await.ok()
            };
            if let Some(captured) = captured {
                // Give the current page fewer slots when a hub is also in play so the
                // hub still contributes; let it use the full budget on its own.
                let page_limit = if input.collection_id.is_some() {
                    3
                } else {
                    chat_citation_limit()
                };
                let page_citations = current_page_citations(
                    &state,
                    &settings,
                    captured,
                    &prompt,
                    input.collection_id.as_deref(),
                    page_limit,
                )
                .await;
                // Prepend so the current page takes priority over hub matches.
                citations.splice(0..0, page_citations);
            }
        }
    }
    let citations = dedupe_citations(citations)
        .into_iter()
        .take(chat_citation_limit())
        .collect::<Vec<_>>();

    // Only the most recent turns are replayed; older ones stay on disk for reading but
    // would otherwise crowd the retrieved sources out of the context window.
    let thread = conversation_thread(&state.paths, input.collection_id.as_deref()).await;
    let history = thread
        .iter()
        .rev()
        .take(PROMPT_HISTORY_TURNS)
        .rev()
        .cloned()
        .collect::<Vec<_>>();

    let result = local_chat(
        &state,
        &settings,
        &prompt,
        citations,
        &history,
        Some(stream),
    )
    .await?;

    // A failed write must not discard the answer the user is already reading.
    if let Err(error) = append_conversation_turn(
        &state.paths,
        input.collection_id.as_deref(),
        ConversationTurn {
            id: uuid(),
            prompt: prompt.clone(),
            answer: result.answer.clone(),
            model: result.model.clone(),
            asked_at: now(),
            citations: result.citations.clone(),
            metrics: result.metrics.clone(),
        },
    )
    .await
    {
        diag_warn!("could not save conversation turn: {error}");
    }

    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_chat_history(
    state: State<'_, Backend>,
    collection_id: Option<String>,
) -> Cmd<Vec<ConversationTurn>> {
    Ok(conversation_thread(&state.paths, collection_id.as_deref()).await)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_chat_clear_history(
    state: State<'_, Backend>,
    collection_id: Option<String>,
) -> Cmd<()> {
    let key = conversation_thread_key(collection_id.as_deref());
    let mut data = load_conversations(&state.paths.conversations_path).await?;
    data.threads.remove(&key);
    save_json(&state.paths.conversations_path, &data).await
}

#[tauri::command]
pub(crate) async fn aether_crystallizer_generate(
    state: State<'_, Backend>,
    input: GenerateIcebergInput,
) -> Cmd<IcebergResult> {
    let topic = input.keyword.trim().to_string();
    if topic.is_empty() {
        return Err("Enter a topic before crystallizing.".to_string());
    }
    state
        .generation_cancelled
        .store(false, AtomicOrdering::Relaxed);
    let settings = load_settings(&state.paths.settings_path).await?;
    local_generate_iceberg(&state, &settings, &topic).await
}

#[tauri::command]
pub(crate) fn aether_chat_cancel(state: State<Backend>) -> Cmd<()> {
    state
        .generation_cancelled
        .store(true, AtomicOrdering::Relaxed);
    Ok(())
}

#[tauri::command]
pub(crate) async fn aether_crystallizer_list_saved(
    state: State<'_, Backend>,
) -> Cmd<Vec<SavedIcebergSummary>> {
    Ok(load_icebergs(&state.paths.icebergs_path)
        .await?
        .icebergs
        .iter()
        .map(saved_iceberg_summary)
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_crystallizer_get_saved(
    state: State<'_, Backend>,
    id: String,
) -> Cmd<SavedIceberg> {
    load_icebergs(&state.paths.icebergs_path)
        .await?
        .icebergs
        .into_iter()
        .find(|iceberg| iceberg.id == id)
        .ok_or_else(|| "Saved iceberg not found.".to_string())
}

#[tauri::command]
pub(crate) async fn aether_crystallizer_save(
    state: State<'_, Backend>,
    input: SaveIcebergInput,
) -> Cmd<SavedIceberg> {
    let title = input.title.trim().to_string();
    let keyword = input.keyword.trim().to_string();
    let model = input.model.trim().to_string();
    let generated_at = input.generated_at.trim().to_string();
    let items = normalize_saved_items(input.items);
    if title.is_empty() {
        return Err("Iceberg title is required.".to_string());
    }
    if keyword.is_empty() {
        return Err("Iceberg keyword is required.".to_string());
    }
    if model.is_empty() {
        return Err("Iceberg model is required.".to_string());
    }
    if generated_at.is_empty() {
        return Err("Iceberg generation time is required.".to_string());
    }
    if items.is_empty() {
        return Err("Iceberg has no usable items to save.".to_string());
    }
    let now = now();
    let iceberg = SavedIceberg {
        iceberg: IcebergResult {
            keyword,
            model,
            items,
            generated_at,
        },
        id: uuid(),
        title,
        icon: normalize_iceberg_icon(input.icon),
        saved_at: now.clone(),
        updated_at: now,
    };
    let mut data = load_icebergs(&state.paths.icebergs_path).await?;
    data.icebergs.insert(0, iceberg.clone());
    save_json(&state.paths.icebergs_path, &data).await?;
    Ok(iceberg)
}

#[tauri::command]
pub(crate) async fn aether_crystallizer_reorder_saved(
    state: State<'_, Backend>,
    ids: Vec<String>,
) -> Cmd<Vec<SavedIcebergSummary>> {
    let mut data = load_icebergs(&state.paths.icebergs_path).await?;
    data.icebergs = reorder(data.icebergs, &ids, |iceberg| &iceberg.id);
    let summaries = data.icebergs.iter().map(saved_iceberg_summary).collect();
    save_json(&state.paths.icebergs_path, &data).await?;
    Ok(summaries)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn aether_crystallizer_delete_saved(
    state: State<'_, Backend>,
    id: String,
) -> Cmd<()> {
    let mut data = load_icebergs(&state.paths.icebergs_path).await?;
    data.icebergs.retain(|iceberg| iceberg.id != id);
    save_json(&state.paths.icebergs_path, &data).await
}

#[tauri::command]
pub(crate) async fn aether_system_status(state: State<'_, Backend>) -> Cmd<SystemStatus> {
    system_status(&state).await
}

#[tauri::command]
pub(crate) async fn aether_system_settings(state: State<'_, Backend>) -> Cmd<AppSettings> {
    let settings = load_settings(&state.paths.settings_path).await?;
    Ok(AppSettings {
        browser: settings.browser,
        developer_mode: settings.developer_mode,
        updates: settings.updates,
        appearance: settings.appearance,
    })
}

#[tauri::command]
pub(crate) async fn aether_system_update_settings(
    state: State<'_, Backend>,
    input: UpdateSettingsInput,
) -> Cmd<AppSettings> {
    let mut settings = load_settings(&state.paths.settings_path).await?;
    if let Some(browser) = input.browser {
        if let Some(default_search_engine) = browser.default_search_engine {
            settings.browser.default_search_engine =
                normalize_search_engine_id(&default_search_engine);
        }
    }
    if let Some(developer_mode) = input.developer_mode {
        settings.developer_mode = developer_mode;
    }
    if let Some(updates) = input.updates {
        if let Some(auto_check) = updates.auto_check {
            settings.updates.auto_check = auto_check;
        }
    }
    if let Some(appearance) = input.appearance {
        settings.appearance = appearance;
    }
    save_json(&state.paths.settings_path, &settings).await?;
    Ok(AppSettings {
        browser: settings.browser,
        developer_mode: settings.developer_mode,
        updates: settings.updates,
        appearance: settings.appearance,
    })
}

#[tauri::command]
pub(crate) async fn aether_system_check_for_update(
    state: State<'_, Backend>,
) -> Cmd<UpdateCheckResult> {
    let checked_at = now();
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let request = state
        .client
        .get(AETHER_RELEASES_API_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "AETHER-update-checker");
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            persist_update_last_checked_at(&state.paths, &checked_at).await?;
            return Ok(UpdateCheckResult {
                current_version,
                checked_at,
                update_available: false,
                latest_version: None,
                latest_name: None,
                release_url: None,
                release_notes: None,
                published_at: None,
                error: Some(format!("Could not reach GitHub Releases: {error}")),
            });
        }
    };

    if response.status().as_u16() == 404 {
        persist_update_last_checked_at(&state.paths, &checked_at).await?;
        return Ok(UpdateCheckResult {
            current_version,
            checked_at,
            update_available: false,
            latest_version: None,
            latest_name: None,
            release_url: None,
            release_notes: None,
            published_at: None,
            error: Some("No published GitHub release found yet.".to_string()),
        });
    }

    if !response.status().is_success() {
        persist_update_last_checked_at(&state.paths, &checked_at).await?;
        return Ok(UpdateCheckResult {
            current_version,
            checked_at,
            update_available: false,
            latest_version: None,
            latest_name: None,
            release_url: None,
            release_notes: None,
            published_at: None,
            error: Some(format!(
                "GitHub Releases returned HTTP {}.",
                response.status().as_u16()
            )),
        });
    }

    let release = match response.json::<GithubRelease>().await {
        Ok(release) => release,
        Err(error) => {
            persist_update_last_checked_at(&state.paths, &checked_at).await?;
            return Ok(UpdateCheckResult {
                current_version,
                checked_at,
                update_available: false,
                latest_version: None,
                latest_name: None,
                release_url: None,
                release_notes: None,
                published_at: None,
                error: Some(format!("Could not read GitHub release metadata: {error}")),
            });
        }
    };
    let latest_version = release_version_from_tag(&release.tag_name);
    let update_available = version_is_newer(&latest_version, &current_version);
    persist_update_last_checked_at(&state.paths, &checked_at).await?;

    Ok(UpdateCheckResult {
        current_version,
        checked_at,
        update_available,
        latest_version: Some(latest_version),
        latest_name: release.name.or(Some(release.tag_name)),
        release_url: Some(release.html_url),
        release_notes: release
            .body
            .map(|body| body.trim().chars().take(1400).collect::<String>())
            .filter(|body| !body.is_empty()),
        published_at: release.published_at,
        error: None,
    })
}

// Empty unless a real minisign public key has been put in tauri.conf.json (see
// docs/SIGNING.md). Unsigned local builds keep working; they just report
// `unconfigured` instead of downloading something they could never verify.
#[cfg(desktop)]
pub(crate) fn updater_pubkey(app: &AppHandle) -> Option<String> {
    updater_pubkey_from_config(app.config().plugins.0.get("updater"))
}

// Split out so the placeholder-versus-real-key branch is testable without an
// AppHandle. Whitespace is trimmed because the key is pasted in by hand during
// signing setup, and a trailing newline is the obvious way to get a "configured"
// build that fails every signature check.
#[cfg(desktop)]
pub(crate) fn updater_pubkey_from_config(updater: Option<&serde_json::Value>) -> Option<String> {
    updater
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .map(str::trim)
        .filter(|pubkey| !pubkey.is_empty())
        .map(str::to_string)
}

// Replacing the app in place only works where the install is a self-contained
// bundle we own. A .deb or .rpm is owned by the system package manager, and
// overwriting its files from inside the running process would corrupt it — those
// installs update through apt/dnf or a fresh download.
#[cfg(desktop)]
pub(crate) fn updater_install_support(app: &AppHandle) -> Result<(), String> {
    let _ = app;
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_none() {
        return Err(
            "This Linux install is managed by your package manager. Update it with apt \
             (or download the latest .deb) rather than from inside ÆTHER."
                .to_string(),
        );
    }
    Ok(())
}

// Downloads, signature-verifies, and installs the newest release. Deliberately
// separate from aether_system_check_for_update: that one reads the GitHub API for
// human-readable release notes, this one reads the signed updater manifest. They
// can disagree — a release whose latest.json failed to upload is visible to the
// first and invisible to the second — and the UI needs to say so rather than
// silently do nothing.
#[tauri::command]
pub(crate) async fn aether_system_install_update(app: AppHandle) -> Cmd<UpdateInstallResult> {
    #[cfg(not(desktop))]
    {
        let _ = app;
        return Ok(UpdateInstallResult::new(
            UpdateInstallStatus::Unsupported,
            "Mobile builds update through the app store, not from inside ÆTHER.",
        ));
    }

    #[cfg(desktop)]
    aether_install_update_desktop(app).await
}

#[cfg(desktop)]
pub(crate) async fn aether_install_update_desktop(app: AppHandle) -> Cmd<UpdateInstallResult> {
    use tauri_plugin_updater::UpdaterExt;

    let Some(pubkey) = updater_pubkey(&app) else {
        return Ok(UpdateInstallResult::new(
            UpdateInstallStatus::Unconfigured,
            "This build has no update signing key, so ÆTHER cannot verify a download. \
             Install the new version from the releases page instead.",
        ));
    };

    if let Err(message) = updater_install_support(&app) {
        return Ok(UpdateInstallResult::new(
            UpdateInstallStatus::Unsupported,
            message,
        ));
    }

    let updater = app
        .updater_builder()
        .pubkey(pubkey)
        .build()
        .map_err(|error| format!("Could not start the updater: {error}"))?;

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return Ok(UpdateInstallResult::new(
                UpdateInstallStatus::Unavailable,
                "The update manifest has no newer signed build for this platform yet.",
            ))
        }
        // A release can exist while carrying no artifact for this os/arch — ÆTHER
        // publishes no ARM Linux AppImage, for one. That is a gap in the release,
        // not a failure the user can act on, so it reads as unavailable rather
        // than as an error about a manifest they have never heard of.
        Err(tauri_plugin_updater::Error::TargetNotFound(target)) => {
            return Ok(UpdateInstallResult::new(
                UpdateInstallStatus::Unavailable,
                format!("The latest release has no build for {target}."),
            ))
        }
        Err(tauri_plugin_updater::Error::TargetsNotFound(targets)) => {
            return Ok(UpdateInstallResult::new(
                UpdateInstallStatus::Unavailable,
                format!(
                    "The latest release has no build for this platform ({}).",
                    targets.join(" or ")
                ),
            ))
        }
        Err(error) => {
            return Err(format!("Could not read the update manifest: {error}"));
        }
    };

    let version = update.version.clone();
    let progress_app = app.clone();
    let mut downloaded_bytes: u64 = 0;

    update
        .download_and_install(
            move |chunk_length, total_bytes| {
                downloaded_bytes += chunk_length as u64;
                let _ = progress_app.emit(
                    AETHER_UPDATE_PROGRESS_EVENT,
                    UpdateInstallProgress {
                        downloaded_bytes,
                        total_bytes,
                        done: false,
                    },
                );
            },
            {
                let app = app.clone();
                move || {
                    let _ = app.emit(
                        AETHER_UPDATE_PROGRESS_EVENT,
                        UpdateInstallProgress {
                            downloaded_bytes: 0,
                            total_bytes: None,
                            done: true,
                        },
                    );
                }
            },
        )
        .await
        .map_err(|error| format!("Could not install ÆTHER {version}: {error}"))?;

    Ok(UpdateInstallResult {
        status: UpdateInstallStatus::Installed.as_str().to_string(),
        version: Some(version.clone()),
        needs_restart: true,
        message: format!("ÆTHER {version} is installed and starts on the next launch."),
    })
}

// Tauri's own AppHandle::restart() cannot be used here, on two counts.
//
// Commands run off the main thread, so restart() takes its threaded path: it asks
// the runtime to exit and waits for RunEvent::ExitRequested to carry out the
// relaunch. Our ExitRequested handler answers with force_exit(), so the process
// dies before the relaunch ever happens — the user clicks Restart and the app
// simply quits.
//
// Its fallback re-exec is no better: tauri::process::restart ends in
// std::process::exit, which runs the C++ static destructors that force_exit()
// exists specifically to avoid (see the comment there). That would spawn the new
// ÆTHER and then crash the old one on the way out.
//
// So spawn the replacement ourselves and leave the same way every other quit does.
#[cfg(desktop)]
pub(crate) fn relaunch_after_update(app: &AppHandle) -> ! {
    let env = app.env();
    let binary = tauri::process::current_binary(&env);

    // Relaunch the bundle, not the inner binary: `open` re-registers the freshly
    // written .app with Launch Services, which is what the Dock and Gatekeeper
    // know about. `-n` is required — without it, `open` sees the still-running old
    // process, activates that instead, and nothing restarts once it exits.
    #[cfg(target_os = "macos")]
    if let Ok(binary) = binary.as_ref() {
        let bundle = binary
            .parent()
            .and_then(|macos| macos.parent())
            .and_then(|contents| contents.parent());
        if let Some(bundle) = bundle.filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        {
            let _ = std::process::Command::new("/usr/bin/open")
                .arg("-n")
                .arg(bundle)
                .spawn();
            force_exit();
        }
    }

    if let Ok(binary) = binary {
        let _ = std::process::Command::new(binary)
            .args(env.args_os.iter().skip(1))
            .spawn();
    }
    force_exit();
}

// Split from the install so the user chooses when to lose their current window.
// Session state is already persisted per-action, but an update is not a good
// moment to surprise someone mid-read.
#[tauri::command]
pub(crate) async fn aether_system_relaunch(app: AppHandle) -> Cmd<()> {
    #[cfg(desktop)]
    {
        save_window_geometry_now(&app);
        relaunch_after_update(&app);
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Restarting from inside the app is only supported on desktop.".to_string())
    }
}

#[tauri::command]
pub(crate) async fn aether_system_update_models(
    state: State<'_, Backend>,
    input: UpdateModelsInput,
) -> Cmd<SystemStatus> {
    let mut settings = load_settings(&state.paths.settings_path).await?;
    if let Some(model) = input.embedding_model {
        settings.local_model.embedding_model =
            Some(model.trim().to_string()).filter(|item| !item.is_empty());
    }
    if let Some(model) = input.chat_model {
        settings.local_model.chat_model =
            Some(model.trim().to_string()).filter(|item| !item.is_empty());
    }
    save_json(&state.paths.settings_path, &settings).await?;
    system_status(&state).await
}

#[tauri::command]
pub(crate) async fn aether_system_download_models(
    app: AppHandle,
    state: State<'_, Backend>,
    input: DownloadModelsInput,
) -> Cmd<SystemStatus> {
    download_managed_models(&app, &state, input).await?;
    system_status(&state).await
}

/// Recent diagnostics, newest first, for the Settings panel. In-memory only — the
/// on-disk log is for export, not for rendering.
#[tauri::command]
pub(crate) async fn aether_system_diagnostics() -> Cmd<Vec<diagnostics::DiagnosticEntry>> {
    Ok(diagnostics::recent())
}

/// Copies the diagnostics log somewhere the user can attach it to a bug report, and
/// reveals it. Nothing leaves the machine until they do that themselves — which is
/// the whole reason this is an export rather than an upload.
#[tauri::command]
pub(crate) async fn aether_system_export_diagnostics(
    app: AppHandle,
    state: State<'_, Backend>,
) -> Cmd<DiagnosticsExportResult> {
    let source = diagnostics::diagnostics_log_path()
        .ok_or_else(|| "The diagnostics log has not been opened yet.".to_string())?;

    let exported_at = now();
    let filename = format!("aether-diagnostics-{}.log", exported_at.replace(':', "-"));
    let target = state.paths.exports_path.join(&filename);
    ensure_parent_dir(&target).await?;

    // Written from the file rather than the in-memory buffer so an export covers
    // earlier sessions too, which is usually where the interesting failure is.
    let contents = tokio::fs::read(&source).await.unwrap_or_default();
    let byte_size = contents.len() as u64;
    tokio::fs::write(&target, contents)
        .await
        .map_err(|error| format!("Could not write the diagnostics export: {error}"))?;

    if let Err(error) = app.opener().reveal_item_in_dir(&target) {
        diag_warn!("exported diagnostics but could not reveal them: {error}");
    }

    Ok(DiagnosticsExportResult {
        path: target.display().to_string(),
        filename,
        byte_size,
        exported_at,
    })
}

// ÆTHER keeps no cloud copy, so a user-owned export is the only real backup. This
// snapshots every store into one timestamped folder the user can copy anywhere.
#[tauri::command]
pub(crate) async fn aether_system_export_library(
    app: AppHandle,
    state: State<'_, Backend>,
) -> Cmd<LibraryExportResult> {
    let paths = &state.paths;
    let exported_at = now();
    let folder_name = format!("aether-export-{}", exported_at.replace(':', "-"));
    let target_dir = paths.exports_path.join(&folder_name);
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|error| error.to_string())?;

    // chunks.json holds only metadata; without the binary sidecar beside it the
    // export would restore a library whose sources cannot be searched.
    //
    // `chunks.v1.json` is deliberately not exported. It holds only vectors from a
    // superseded embedding model, and the text they belong to is already in
    // chunks.json — so a restore plus a re-index reproduces everything it contains,
    // for none of the ~5x size.
    let chunks_vec_path = vector_data_path(&paths.chunks_path);
    let sources: [(&PathBuf, &str); 7] = [
        (&paths.library_path, "library.json"),
        (&paths.chunks_path, "chunks.json"),
        (&chunks_vec_path, "chunks.vec"),
        (&paths.settings_path, "settings.json"),
        (&paths.icebergs_path, "icebergs.json"),
        (&paths.conversations_path, "conversations.json"),
        (&paths.session_path, "session.json"),
    ];

    let mut files = Vec::new();
    let mut byte_size = 0_u64;
    for (source, name) in sources {
        if !tokio::fs::try_exists(source).await.unwrap_or(false) {
            continue;
        }
        let copied = tokio::fs::copy(source, target_dir.join(name))
            .await
            .map_err(|error| format!("Could not export {name}: {error}"))?;
        byte_size += copied;
        files.push(name.to_string());
    }

    if files.is_empty() {
        // Leaving an empty folder behind would look like a successful export.
        let _ = tokio::fs::remove_dir(&target_dir).await;
        return Err("There is nothing to export yet.".to_string());
    }

    let library = load_library(&paths.library_path).await.unwrap_or_default();
    let capture_count = library.captures.len();
    let chunk_count = library
        .collections
        .iter()
        .map(|collection| collection.chunk_count)
        .sum::<usize>();

    let manifest = serde_json::json!({
        "app": "aether",
        "appVersion": app.package_info().version.to_string(),
        "exportedAt": exported_at,
        "files": files,
        "captureCount": capture_count,
        "chunkCount": chunk_count,
        "collectionCount": library.collections.len(),
    });
    let manifest_raw =
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    tokio::fs::write(
        target_dir.join("manifest.json"),
        format!("{manifest_raw}\n"),
    )
    .await
    .map_err(|error| error.to_string())?;
    files.push("manifest.json".to_string());

    // Opening the folder is the expected payoff of an explicit export click, but a
    // desktop without a file manager should not fail the export.
    if let Err(error) = app.opener().reveal_item_in_dir(&target_dir) {
        diag_warn!("exported but could not reveal folder: {error}");
    }

    Ok(LibraryExportResult {
        path: target_dir.display().to_string(),
        exported_at,
        files,
        capture_count,
        chunk_count,
        byte_size,
    })
}

// Deliberately a separate command rather than a field on SystemStatus: answering it
// forces the vector store to load, and SystemStatus runs at startup where that would
// add a full parse of the metadata plus the sidecar to launch. Settings asks for this
// only when opened, which is also the only place the re-index button lives.
#[tauri::command]
pub(crate) async fn aether_library_index_status(
    state: State<'_, Backend>,
) -> Cmd<LibraryIndexStatus> {
    with_vectors_read(&state, |vectors| LibraryIndexStatus {
        dim: vectors.dim,
        embedded: vectors.embedded_count() as usize,
        pending_reembed: vectors.pending_reembed_count(),
    })
    .await
}

// Re-embeds every retained chunk with the loaded embedding model. This is the only
// way out of a store whose vectors came from a different model: the widths cannot be
// compared, so those chunks are invisible to search until they are embedded again.
// Chunk text is kept in the store, so this is local compute — no page is refetched.
#[tauri::command]
pub(crate) async fn aether_library_reindex(
    app: AppHandle,
    state: State<'_, Backend>,
) -> Cmd<LibraryReindexResult> {
    let settings = load_settings(&state.paths.settings_path).await?;

    // Snapshot ids and text without holding the lock: embedding takes minutes on a
    // large library, and blocking every capture for its duration is not acceptable.
    let pending = with_vectors_read(&state, |vectors| {
        vectors
            .chunks
            .iter()
            .map(|chunk| (chunk.id.clone(), chunk.text.clone()))
            .collect::<Vec<_>>()
    })
    .await?;

    if pending.is_empty() {
        return Err("There is nothing to re-index yet.".to_string());
    }

    let total = pending.len();
    emit_capture_progress(&app, "Re-indexing library", Some(0), Some(total));

    let mut vectors_by_id: HashMap<String, Vec<f32>> = HashMap::with_capacity(total);
    // Batched so progress advances steadily and peak memory stays bounded, rather than
    // handing the runtime every chunk in the library at once.
    for (batch_index, batch) in pending.chunks(REINDEX_BATCH_SIZE).enumerate() {
        let inputs = batch
            .iter()
            .map(|(_, text)| text.clone())
            .collect::<Vec<_>>();
        let embeddings = local_embed_with_progress(
            &state,
            &settings,
            inputs,
            Some(EmbeddingProgress {
                app: app.clone(),
                message: "Re-indexing library".to_string(),
            }),
        )
        .await?;
        if embeddings.len() != batch.len() {
            return Err(
                "Local embedding model returned an unexpected number of embeddings.".to_string(),
            );
        }
        for ((id, _), vector) in batch.iter().zip(embeddings) {
            vectors_by_id.insert(id.clone(), vector);
        }
        emit_capture_progress(
            &app,
            "Re-indexing library",
            Some(((batch_index + 1) * REINDEX_BATCH_SIZE).min(total)),
            Some(total),
        );
    }

    let dim = vectors_by_id
        .values()
        .map(Vec::len)
        .max()
        .filter(|dim| *dim > 0)
        .ok_or_else(|| "The embedding model returned no usable vectors.".to_string())?;

    let mut guard = state.vectors.write().await;
    if guard.is_none() {
        *guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    let data = guard.as_mut().expect("vector store cache");

    // Rebuild rather than patch: the store's width is changing, so every slot has to
    // be reassigned against the new stride.
    data.dim = dim;
    data.next_slot = 0;
    let existing = std::mem::take(&mut data.chunks);
    // Matched by id, so chunks captured while the embedding ran keep their own vectors
    // instead of being matched to the wrong text by position.
    data.push_chunks(existing.into_iter().map(|mut chunk| {
        if let Some(vector) = vectors_by_id.remove(&chunk.id) {
            chunk.vector = vector;
        }
        chunk.needs_reembed = false;
        chunk
    }));

    let embedded = data.embedded_count() as usize;
    let still_pending = data.pending_reembed_count();
    write_vector_sidecar(&state.paths.chunks_path, data, 0).await?;
    save_vector_metadata(&state.paths.chunks_path, data).await?;
    drop(guard);

    emit_capture_progress(&app, "Re-index complete", Some(total), Some(total));
    Ok(LibraryReindexResult {
        embedded,
        still_pending,
        dim,
        reindexed_at: now(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_system_open_external_url(app: AppHandle, url: String) -> Cmd<()> {
    let parsed = Url::parse(url.trim()).map_err(|_| "Invalid release URL.".to_string())?;
    match parsed.scheme() {
        "https" | "http" => app
            .opener()
            .open_url(parsed.to_string(), None::<String>)
            .map_err(|error| error.to_string()),
        _ => Err("Only web URLs can be opened from Settings.".to_string()),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_layout_set_panel_collapsed(
    app: AppHandle,
    state: State<Backend>,
    collapsed: bool,
) -> Cmd<()> {
    {
        let mut tabs = lock_tabs(&state)?;
        tabs.panel_collapsed = collapsed;
    }
    sync_native_webview_visibility(&app, &state)?;
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn aether_layout_set_modal_overlay_open(
    app: AppHandle,
    state: State<Backend>,
    open: bool,
) -> Cmd<()> {
    {
        let mut tabs = lock_tabs(&state)?;
        tabs.modal_overlay_open = open;
    }
    sync_native_webview_visibility(&app, &state)
}

#[tauri::command]
pub(crate) fn aether_layout_show_status_toast(input: StatusToastInput) -> Cmd<()> {
    let _ = (input.message, input.tone, input.duration_ms);
    Ok(())
}
