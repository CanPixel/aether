use chrono::Utc;
use reqwest::Client;
use scraper::{Html, Selector};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
#[cfg(desktop)]
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Webview, WebviewBuilder, WebviewUrl, Window,
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State,
    WindowEvent,
};
use url::Url;

const CHUNKS_TABLE: &str = "chunks";
const SIDEBAR_WIDTH: f64 = 76.0;
const BROWSER_VIEW_TOP: f64 = 166.0;
const PANEL_WIDTH: f64 = 404.0;
const PANEL_COLLAPSED_WIDTH: f64 = 58.0;
const EMBEDDING_MODEL: &str = "nomic-embed-text";
const PREFERRED_CHAT_MODELS: [&str; 3] = ["llama3.1:8b", "gemma3:latest", "gemma3"];
const MIN_CAPTURE_TEXT_LENGTH: usize = 120;
const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const DESKTOP_BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ICEBERG_LEVEL_LANES: [f64; 5] = [13.0, 87.0, 28.0, 72.0, 42.0];

type Cmd<T> = Result<T, String>;

struct Backend {
    paths: DataPaths,
    tabs: Mutex<TabState>,
    #[cfg(desktop)]
    webviews: Mutex<NativeBrowserViews>,
    client: Client,
}

#[cfg(desktop)]
#[derive(Default)]
struct NativeBrowserViews {
    views: HashMap<String, Webview>,
}

#[derive(Clone)]
struct DataPaths {
    db_path: PathBuf,
    library_path: PathBuf,
    settings_path: PathBuf,
    icebergs_path: PathBuf,
    chunks_path: PathBuf,
}

#[derive(Clone)]
struct TabState {
    tabs: Vec<ManagedTab>,
    active_app_id: String,
    active_tab_id: String,
    dashboard_open: bool,
    modal_overlay_open: bool,
    panel_collapsed: bool,
}

#[derive(Clone)]
struct ManagedTab {
    id: String,
    app_id: String,
    title: String,
    url: String,
    is_loading: bool,
    favicon: Option<String>,
    theme_color: Option<String>,
    history: Vec<String>,
    history_index: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSummary {
    id: String,
    name: String,
    category: String,
    home_url: String,
    current_url: String,
    title: String,
    is_active: bool,
    is_loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTabSummary {
    id: String,
    app_id: String,
    title: String,
    url: String,
    host: String,
    is_active: bool,
    is_loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    theme_color: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AetherState {
    apps: Vec<AppSummary>,
    tabs: Vec<BrowserTabSummary>,
    active_app_id: String,
    active_tab_id: String,
    dashboard_open: bool,
    panel_collapsed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubShortcutSummary {
    id: String,
    title: String,
    url: String,
    host: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    theme_color: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSettings {
    default_search_engine: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    browser: BrowserSettings,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionSummary {
    id: String,
    name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    created_at: String,
    updated_at: String,
    capture_count: usize,
    chunk_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSummary {
    id: String,
    collection_id: String,
    title: String,
    url: String,
    app_id: String,
    captured_at: String,
    chunk_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<CaptureMetadata>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureResult {
    #[serde(flatten)]
    capture: CaptureSummary,
    collection_name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    id: String,
    collection_id: String,
    capture_id: String,
    app_id: String,
    title: String,
    url: String,
    captured_at: String,
    chunk_index: usize,
    text: String,
    score: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatResult {
    answer: String,
    model: String,
    citations: Vec<SearchResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IcebergItem {
    id: String,
    name: String,
    description: String,
    level: u8,
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IcebergResult {
    keyword: String,
    model: String,
    items: Vec<IcebergItem>,
    generated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedIcebergSummary {
    id: String,
    title: String,
    keyword: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    generated_at: String,
    saved_at: String,
    updated_at: String,
    item_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedIceberg {
    #[serde(flatten)]
    iceberg: IcebergResult,
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    saved_at: String,
    updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemStatus {
    ollama_reachable: bool,
    embedding_model: String,
    chat_model: Option<String>,
    available_models: Vec<String>,
    db_path: String,
    library_path: String,
    collections: Vec<CollectionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTabInput {
    url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateShortcutInput {
    title: String,
    url: String,
    favicon: Option<String>,
    theme_color: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageMetadataSnapshot {
    theme_color: Option<String>,
    favicon: Option<String>,
}

#[derive(Deserialize)]
struct CreateCollectionInput {
    name: String,
    description: Option<String>,
    icon: Option<String>,
}

#[derive(Deserialize)]
struct UpdateCollectionInput {
    id: String,
    name: Option<String>,
    description: Option<String>,
    icon: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureCurrentPageInput {
    collection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveCaptureInput {
    capture_id: String,
    collection_id: String,
}

#[derive(Deserialize)]
struct SearchCollectionInput {
    collection_id: String,
    query: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskChatInput {
    collection_id: Option<String>,
    prompt: String,
    include_current_page: Option<bool>,
}

#[derive(Deserialize)]
struct GenerateIcebergInput {
    keyword: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveIcebergInput {
    title: String,
    keyword: String,
    model: String,
    icon: Option<String>,
    generated_at: String,
    items: Vec<IcebergItem>,
}

#[derive(Deserialize)]
struct UpdateSettingsInput {
    browser: Option<PartialBrowserSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialBrowserSettings {
    default_search_engine: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateModelsInput {
    embedding_model: Option<String>,
    chat_model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusToastInput {
    message: String,
    tone: String,
    duration_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryData {
    version: u8,
    collections: Vec<CollectionSummary>,
    captures: Vec<CaptureSummary>,
    shortcuts: Vec<HubShortcutSummary>,
    migrated_realm_tables: Vec<String>,
}

impl Default for LibraryData {
    fn default() -> Self {
        Self {
            version: 1,
            collections: Vec::new(),
            captures: Vec::new(),
            shortcuts: Vec::new(),
            migrated_realm_tables: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserSettings {
    version: u8,
    browser: BrowserSettings,
    ollama: OllamaSettings,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OllamaSettings {
    embedding_model: Option<String>,
    chat_model: Option<String>,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            version: 1,
            browser: BrowserSettings {
                default_search_engine: "google".to_string(),
            },
            ollama: OllamaSettings::default(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct IcebergData {
    version: u8,
    icebergs: Vec<SavedIceberg>,
}

impl Default for IcebergData {
    fn default() -> Self {
        Self {
            version: 1,
            icebergs: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkRecord {
    id: String,
    vector: Vec<f32>,
    text: String,
    collection_id: String,
    capture_id: String,
    title: String,
    url: String,
    app_id: String,
    captured_at: String,
    chunk_index: usize,
}

#[derive(Serialize, Deserialize)]
struct VectorStoreData {
    version: u8,
    chunks: Vec<ChunkRecord>,
}

impl Default for VectorStoreData {
    fn default() -> Self {
        Self {
            version: 1,
            chunks: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct OllamaModel {
    name: String,
}

#[derive(Deserialize)]
struct OllamaEmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    model: String,
    message: OllamaMessage,
}

#[derive(Deserialize)]
struct OllamaMessage {
    content: String,
}

#[derive(Deserialize)]
struct OllamaGenerateResponse {
    model: String,
    response: String,
}

struct CapturedPage {
    title: String,
    url: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageSnapshot {
    html: Option<String>,
    url: Option<String>,
    title: Option<String>,
    description: Option<String>,
    body_text: Option<String>,
}

impl Backend {
    fn new(app_data_dir: PathBuf) -> Self {
        let db_path = app_data_dir.join("aether-realms");
        Self {
            paths: DataPaths {
                chunks_path: db_path.join(format!("{CHUNKS_TABLE}.json")),
                db_path,
                library_path: app_data_dir.join("aether-library").join("library.json"),
                settings_path: app_data_dir.join("aether-settings").join("settings.json"),
                icebergs_path: app_data_dir.join("aether-icebergs").join("icebergs.json"),
            },
            tabs: Mutex::new(TabState::new()),
            #[cfg(desktop)]
            webviews: Mutex::new(NativeBrowserViews::default()),
            client: Client::builder()
                .user_agent("Aether/1.0 Tauri")
                .build()
                .expect("reqwest client"),
        }
    }
}

impl TabState {
    fn new() -> Self {
        let url = "https://www.google.com".to_string();
        let initial = ManagedTab::new("browser", &url);
        let active_tab_id = initial.id.clone();
        Self {
            tabs: vec![initial],
            active_app_id: "browser".to_string(),
            active_tab_id,
            dashboard_open: true,
            modal_overlay_open: false,
            panel_collapsed: true,
        }
    }

    fn state(&self) -> AetherState {
        AetherState {
            apps: self.apps(),
            tabs: self.tabs(),
            active_app_id: self.active_app_id.clone(),
            active_tab_id: self.active_tab_id.clone(),
            dashboard_open: self.dashboard_open,
            panel_collapsed: self.panel_collapsed,
        }
    }

    fn apps(&self) -> Vec<AppSummary> {
        let active = self.active_tab();
        vec![AppSummary {
            id: "browser".to_string(),
            name: "Browser".to_string(),
            category: "Web".to_string(),
            home_url: "https://www.google.com".to_string(),
            current_url: active
                .map(|tab| tab.url.clone())
                .unwrap_or_else(|| "https://www.google.com".to_string()),
            title: active
                .map(|tab| tab.title.clone())
                .unwrap_or_else(|| "Browser".to_string()),
            is_active: !self.dashboard_open,
            is_loading: active.map(|tab| tab.is_loading).unwrap_or(false),
            can_go_back: active.map(|tab| tab.can_go_back()).unwrap_or(false),
            can_go_forward: active.map(|tab| tab.can_go_forward()).unwrap_or(false),
        }]
    }

    fn tabs(&self) -> Vec<BrowserTabSummary> {
        self.tabs
            .iter()
            .map(|tab| tab.summary(tab.id == self.active_tab_id && !self.dashboard_open))
            .collect()
    }

    fn active_tab(&self) -> Option<&ManagedTab> {
        self.tabs.iter().find(|tab| tab.id == self.active_tab_id)
    }

    fn active_tab_mut(&mut self) -> Option<&mut ManagedTab> {
        let active_tab_id = self.active_tab_id.clone();
        self.tabs.iter_mut().find(|tab| tab.id == active_tab_id)
    }
}

impl ManagedTab {
    fn new(app_id: &str, raw_url: &str) -> Self {
        let url = normalize_url(raw_url, "google");
        Self {
            id: uuid(),
            app_id: app_id.to_string(),
            title: title_from_url(&url),
            url: url.clone(),
            is_loading: false,
            favicon: None,
            theme_color: None,
            history: vec![url],
            history_index: 0,
        }
    }

    fn navigate(&mut self, raw_url: &str, search_engine: &str) {
        let url = normalize_url(raw_url, search_engine);
        self.url = url.clone();
        self.title = title_from_url(&url);
        self.favicon = favicon_for_url(&url);
        self.theme_color = None;
        self.is_loading = false;
        self.history.truncate(self.history_index + 1);
        self.history.push(url);
        self.history_index = self.history.len().saturating_sub(1);
    }

    fn go_back(&mut self) {
        if self.can_go_back() {
            self.history_index -= 1;
            self.url = self.history[self.history_index].clone();
            self.title = title_from_url(&self.url);
        }
    }

    fn go_forward(&mut self) {
        if self.can_go_forward() {
            self.history_index += 1;
            self.url = self.history[self.history_index].clone();
            self.title = title_from_url(&self.url);
        }
    }

    fn can_go_back(&self) -> bool {
        self.history_index > 0
    }

    fn can_go_forward(&self) -> bool {
        self.history_index + 1 < self.history.len()
    }

    fn summary(&self, is_active: bool) -> BrowserTabSummary {
        BrowserTabSummary {
            id: self.id.clone(),
            app_id: self.app_id.clone(),
            title: self.title.clone(),
            url: self.url.clone(),
            host: get_tab_host(&self.url),
            is_active,
            is_loading: self.is_loading,
            can_go_back: self.can_go_back(),
            can_go_forward: self.can_go_forward(),
            favicon: self.favicon.clone(),
            theme_color: self.theme_color.clone(),
        }
    }
}

#[cfg(desktop)]
fn ensure_native_webview(app: &AppHandle, state: &State<Backend>, tab_id: &str) -> Cmd<()> {
    let tab = {
        let tabs = lock_tabs(state)?;
        tabs.tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .cloned()
            .ok_or_else(|| format!("Unknown tab: {tab_id}"))?
    };

    let exists = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
        .views
        .contains_key(tab_id);
    if !exists {
        let webview = create_native_webview(app, state, &tab)?;
        state
            .webviews
            .lock()
            .map_err(|_| "Æther webviews are unavailable.".to_string())?
            .views
            .insert(tab.id.clone(), webview);
    }

    sync_native_webview_visibility(app, state)
}

#[cfg(not(desktop))]
fn ensure_native_webview(_app: &AppHandle, _state: &State<Backend>, _tab_id: &str) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn create_native_webview(
    app: &AppHandle,
    state: &State<Backend>,
    tab: &ManagedTab,
) -> Cmd<Webview> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "Æther main window is not ready.".to_string())?;
    let bounds = native_webview_bounds(&window, state)?;
    let label = native_webview_label(&tab.id);
    let tab_id_for_navigation = tab.id.clone();
    let tab_id_for_load = tab.id.clone();
    let tab_id_for_title = tab.id.clone();
    let app_for_navigation = app.clone();
    let app_for_load = app.clone();
    let app_for_title = app.clone();
    let app_for_new_window = app.clone();
    let url = Url::parse(&tab.url).map_err(|error| error.to_string())?;

    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .user_agent(DESKTOP_BROWSER_USER_AGENT)
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
        });

    let webview = window
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|error| error.to_string())?;
    webview.hide().map_err(|error| error.to_string())?;
    Ok(webview)
}

#[cfg(desktop)]
fn create_native_tab_from_url(app: &AppHandle, state: &State<Backend>, raw_url: &str) -> Cmd<()> {
    let url = normalize_url(raw_url, "google");
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
fn navigate_native_webview(
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
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
        .views
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("Native webview not found for tab: {tab_id}"))?;
    webview.navigate(parsed).map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
fn navigate_native_webview(
    _app: &AppHandle,
    _state: &State<Backend>,
    _tab_id: &str,
    _url: &str,
) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn close_native_webview(state: &State<Backend>, tab_id: &str) -> Cmd<()> {
    if let Some(webview) = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
        .views
        .remove(tab_id)
    {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(desktop))]
fn close_native_webview(_state: &State<Backend>, _tab_id: &str) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn resize_native_webviews(app: &AppHandle, state: &State<Backend>) -> Cmd<()> {
    sync_native_webview_visibility(app, state)
}

#[cfg(not(desktop))]
fn resize_native_webviews(_app: &AppHandle, _state: &State<Backend>) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn sync_native_webview_visibility(app: &AppHandle, state: &State<Backend>) -> Cmd<()> {
    let (active_tab_id, show_active, panel_collapsed) = {
        let tabs = lock_tabs(state)?;
        (
            tabs.active_tab_id.clone(),
            !tabs.dashboard_open && !tabs.modal_overlay_open,
            tabs.panel_collapsed,
        )
    };
    let window = app
        .get_window("main")
        .ok_or_else(|| "Æther main window is not ready.".to_string())?;
    let bounds = native_webview_bounds_for_window(&window, panel_collapsed)?;
    let webviews = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?;

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
fn sync_native_webview_visibility(_app: &AppHandle, _state: &State<Backend>) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn native_webview_bounds(window: &Window, state: &State<Backend>) -> Cmd<Rect> {
    let panel_collapsed = lock_tabs(state)?.panel_collapsed;
    native_webview_bounds_for_window(window, panel_collapsed)
}

#[cfg(desktop)]
fn native_webview_bounds_for_window(window: &Window, panel_collapsed: bool) -> Cmd<Rect> {
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

#[cfg(desktop)]
fn native_webview_label(tab_id: &str) -> String {
    format!("aether-browser-tab-{tab_id}")
}

#[cfg(desktop)]
fn read_native_webview_metadata(webview: &Webview, app: AppHandle, tab_id: String) {
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

fn update_tab_navigation_state(state: &State<Backend>, tab_id: &str, url: &str, is_loading: bool) {
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
            if tab.history.get(tab.history_index) != Some(&url) {
                tab.history.truncate(tab.history_index + 1);
                tab.history.push(url);
                tab.history_index = tab.history.len().saturating_sub(1);
            }
        }
    }
}

fn should_accept_webview_url(current_url: &str, next_url: &str) -> bool {
    if next_url.is_empty() {
        return false;
    }
    if is_transient_webview_url(next_url) && !is_transient_webview_url(current_url) {
        return false;
    }
    true
}

fn is_transient_webview_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized == "about:blank"
        || normalized.starts_with("about:blank#")
        || normalized == "about:srcdoc"
}

fn update_tab_metadata(
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

fn update_tab_title(state: &State<Backend>, tab_id: &str, title: &str) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("app data dir");
            app.manage(Backend::new(app_data_dir));
            #[cfg(desktop)]
            if let Some(window) = app.get_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
                    ) {
                        let state = app_handle.state::<Backend>();
                        let _ = resize_native_webviews(&app_handle, &state);
                    }
                });
            }
            #[cfg(desktop)]
            {
                let app_handle = app.handle().clone();
                let state = app_handle.state::<Backend>();
                if let Ok(active_tab_id) = active_tab_id(&state) {
                    if let Err(error) = ensure_native_webview(&app_handle, &state, &active_tab_id) {
                        eprintln!("Æther browser webview prewarm failed: {error}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            aether_state,
            aether_apps_list,
            aether_apps_activate,
            aether_apps_navigate,
            aether_apps_go_back,
            aether_apps_go_forward,
            aether_tabs_list,
            aether_tabs_create,
            aether_tabs_activate,
            aether_tabs_close,
            aether_tabs_navigate,
            aether_tabs_go_back,
            aether_tabs_go_forward,
            aether_dashboard_open,
            aether_hub_list,
            aether_hub_create,
            aether_hub_reorder,
            aether_hub_delete,
            aether_collections_list,
            aether_collections_create,
            aether_collections_update,
            aether_collections_reorder,
            aether_collections_delete,
            aether_collections_captures,
            aether_capture_current_page,
            aether_capture_move,
            aether_capture_delete,
            aether_search_collection,
            aether_chat_ask,
            aether_crystallizer_generate,
            aether_crystallizer_list_saved,
            aether_crystallizer_get_saved,
            aether_crystallizer_save,
            aether_crystallizer_reorder_saved,
            aether_crystallizer_delete_saved,
            aether_system_status,
            aether_system_settings,
            aether_system_update_settings,
            aether_system_update_models,
            aether_layout_set_panel_collapsed,
            aether_layout_set_modal_overlay_open,
            aether_layout_show_status_toast
        ])
        .run(tauri::generate_context!())
        .expect("error while running Æther");
}

#[tauri::command]
fn aether_state(state: State<Backend>) -> Cmd<AetherState> {
    Ok(lock_tabs(&state)?.state())
}

#[tauri::command]
fn aether_apps_list(state: State<Backend>) -> Cmd<Vec<AppSummary>> {
    Ok(lock_tabs(&state)?.apps())
}

#[tauri::command(rename_all = "camelCase")]
fn aether_apps_activate(app: AppHandle, state: State<Backend>, app_id: String) -> Cmd<()> {
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
async fn aether_apps_navigate(
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
fn aether_apps_go_back(app: AppHandle, state: State<Backend>, app_id: String) -> Cmd<()> {
    if app_id != "browser" {
        return Err(format!("Unknown app: {app_id}"));
    }
    aether_tabs_go_back(app, state, String::new())
}

#[tauri::command(rename_all = "camelCase")]
fn aether_apps_go_forward(app: AppHandle, state: State<Backend>, app_id: String) -> Cmd<()> {
    if app_id != "browser" {
        return Err(format!("Unknown app: {app_id}"));
    }
    aether_tabs_go_forward(app, state, String::new())
}

#[tauri::command]
fn aether_tabs_list(state: State<Backend>) -> Cmd<Vec<BrowserTabSummary>> {
    Ok(lock_tabs(&state)?.tabs())
}

#[tauri::command]
async fn aether_tabs_create(
    app: AppHandle,
    state: State<'_, Backend>,
    input: Option<CreateTabInput>,
) -> Cmd<BrowserTabSummary> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let raw_url = input
        .and_then(|input| input.url)
        .unwrap_or_else(|| "https://www.google.com".to_string());
    let url = normalize_url(&raw_url, &settings.browser.default_search_engine);
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
    Ok(summary)
}

#[tauri::command(rename_all = "camelCase")]
fn aether_tabs_activate(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
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
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
fn aether_tabs_close(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
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
    close_native_webview(&state, &tab_id)?;
    if let Some(active_tab_id) = next_active_tab_id {
        ensure_native_webview(&app, &state, &active_tab_id)?;
    } else {
        sync_native_webview_visibility(&app, &state)?;
    }
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
async fn aether_tabs_navigate(
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
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
fn aether_tabs_go_back(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
    let (target_tab_id, target_url) = {
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
        tab.go_back();
        (tab.id.clone(), tab.url.clone())
    };
    navigate_native_webview(&app, &state, &target_tab_id, &target_url)?;
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
fn aether_tabs_go_forward(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
    let (target_tab_id, target_url) = {
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
        tab.go_forward();
        (tab.id.clone(), tab.url.clone())
    };
    navigate_native_webview(&app, &state, &target_tab_id, &target_url)?;
    emit_state(&app, &state)
}

#[tauri::command]
fn aether_dashboard_open(app: AppHandle, state: State<Backend>) -> Cmd<()> {
    {
        let mut tabs = lock_tabs(&state)?;
        tabs.dashboard_open = true;
    }
    sync_native_webview_visibility(&app, &state)?;
    emit_state(&app, &state)
}

#[tauri::command]
async fn aether_hub_list(state: State<'_, Backend>) -> Cmd<Vec<HubShortcutSummary>> {
    Ok(load_library(&state.paths.library_path).await?.shortcuts)
}

#[tauri::command]
async fn aether_hub_create(
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
async fn aether_hub_reorder(
    state: State<'_, Backend>,
    ids: Vec<String>,
) -> Cmd<Vec<HubShortcutSummary>> {
    let mut data = load_library(&state.paths.library_path).await?;
    data.shortcuts = reorder(data.shortcuts, &ids, |shortcut| &shortcut.id);
    save_json(&state.paths.library_path, &data).await?;
    Ok(data.shortcuts)
}

#[tauri::command]
async fn aether_hub_delete(state: State<'_, Backend>, id: String) -> Cmd<()> {
    let mut data = load_library(&state.paths.library_path).await?;
    data.shortcuts.retain(|shortcut| shortcut.id != id);
    save_json(&state.paths.library_path, &data).await
}

#[tauri::command]
async fn aether_collections_list(state: State<'_, Backend>) -> Cmd<Vec<CollectionSummary>> {
    Ok(load_library(&state.paths.library_path).await?.collections)
}

#[tauri::command]
async fn aether_collections_create(
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
async fn aether_collections_update(
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
async fn aether_collections_reorder(
    state: State<'_, Backend>,
    ids: Vec<String>,
) -> Cmd<Vec<CollectionSummary>> {
    let mut data = load_library(&state.paths.library_path).await?;
    data.collections = reorder(data.collections, &ids, |collection| &collection.id);
    save_json(&state.paths.library_path, &data).await?;
    Ok(data.collections)
}

#[tauri::command]
async fn aether_collections_delete(state: State<'_, Backend>, id: String) -> Cmd<()> {
    let mut library = load_library(&state.paths.library_path).await?;
    library.collections.retain(|collection| collection.id != id);
    library
        .captures
        .retain(|capture| capture.collection_id != id);
    save_json(&state.paths.library_path, &library).await?;

    let mut vectors = load_vectors(&state.paths.chunks_path).await?;
    vectors.chunks.retain(|chunk| chunk.collection_id != id);
    save_json(&state.paths.chunks_path, &vectors).await
}

#[tauri::command(rename_all = "camelCase")]
async fn aether_collections_captures(
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

#[tauri::command]
async fn aether_capture_current_page(
    state: State<'_, Backend>,
    input: CaptureCurrentPageInput,
) -> Cmd<CaptureResult> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let collection = get_collection(&state.paths.library_path, &input.collection_id).await?;
    let active_tab = {
        let tabs = lock_tabs(&state)?;
        if tabs.dashboard_open {
            return Err("Open a website before capturing into a collection.".to_string());
        }
        tabs.active_tab()
            .cloned()
            .ok_or_else(|| "No active browser tab.".to_string())?
    };
    let captured = extract_readable_active_page(&state, &active_tab).await?;
    let captured_key = normalize_capture_url_key(&captured.url);
    let mut library = load_library(&state.paths.library_path).await?;
    if library.captures.iter().any(|capture| {
        capture.collection_id == collection.id
            && normalize_capture_url_key(&capture.url) == captured_key
    }) {
        return Err(format!("Page is already in {}.", collection.name));
    }

    let chunks = split_text(&captured.text, 2200, 240);
    if chunks.is_empty() {
        return Err("No readable text found on the current page.".to_string());
    }
    let embeddings = ollama_embed(&state.client, &settings, chunks.clone()).await?;
    if embeddings.len() != chunks.len() {
        return Err("Ollama returned an unexpected number of embeddings.".to_string());
    }

    let capture_id = uuid();
    let captured_at = now();
    let records = chunks
        .into_iter()
        .enumerate()
        .map(|(index, text)| ChunkRecord {
            id: uuid(),
            vector: embeddings[index].clone(),
            text,
            collection_id: collection.id.clone(),
            capture_id: capture_id.clone(),
            title: captured.title.clone(),
            url: captured.url.clone(),
            app_id: active_tab.app_id.clone(),
            captured_at: captured_at.clone(),
            chunk_index: index,
        })
        .collect::<Vec<_>>();

    let mut vectors = load_vectors(&state.paths.chunks_path).await?;
    vectors.chunks.extend(records.iter().cloned());
    save_json(&state.paths.chunks_path, &vectors).await?;

    let capture = CaptureSummary {
        id: capture_id,
        collection_id: collection.id.clone(),
        title: captured.title,
        url: captured.url,
        app_id: active_tab.app_id,
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
async fn aether_capture_move(
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

    let mut vectors = load_vectors(&state.paths.chunks_path).await?;
    for chunk in &mut vectors.chunks {
        if chunk.capture_id == input.capture_id {
            chunk.collection_id = input.collection_id.clone();
        }
    }
    save_json(&state.paths.chunks_path, &vectors).await?;
    Ok(moved)
}

#[tauri::command(rename_all = "camelCase")]
async fn aether_capture_delete(state: State<'_, Backend>, capture_id: String) -> Cmd<()> {
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
    let mut vectors = load_vectors(&state.paths.chunks_path).await?;
    vectors
        .chunks
        .retain(|chunk| chunk.capture_id != capture_id);
    save_json(&state.paths.chunks_path, &vectors).await
}

#[tauri::command]
async fn aether_search_collection(
    state: State<'_, Backend>,
    input: SearchCollectionInput,
) -> Cmd<Vec<SearchResult>> {
    search_collection(&state, input).await
}

#[tauri::command]
async fn aether_chat_ask(state: State<'_, Backend>, input: AskChatInput) -> Cmd<ChatResult> {
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Enter a question before asking Æther.".to_string());
    }
    let settings = load_settings(&state.paths.settings_path).await?;
    let mut citations = if let Some(collection_id) = input.collection_id.clone() {
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
        if let Ok(active_url) = active_tab_url(&state) {
            let active_tab = {
                let tabs = lock_tabs(&state)?;
                tabs.active_tab().cloned()
            };
            if let Some(active_tab) = active_tab {
                if let Ok(captured) = extract_readable_active_page(&state, &active_tab).await {
                    citations.insert(
                        0,
                        SearchResult {
                            id: format!("current-{}", uuid()),
                            collection_id: input
                                .collection_id
                                .clone()
                                .unwrap_or_else(|| "current-page".to_string()),
                            capture_id: "current-page".to_string(),
                            app_id: "browser".to_string(),
                            title: captured.title,
                            url: captured.url,
                            captured_at: now(),
                            chunk_index: 0,
                            text: captured.text.chars().take(5000).collect(),
                            score: 0.0,
                        },
                    );
                }
            } else if let Ok(captured) = extract_readable_page(&state.client, &active_url).await {
                citations.insert(
                    0,
                    SearchResult {
                        id: format!("current-{}", uuid()),
                        collection_id: input
                            .collection_id
                            .clone()
                            .unwrap_or_else(|| "current-page".to_string()),
                        capture_id: "current-page".to_string(),
                        app_id: "browser".to_string(),
                        title: captured.title,
                        url: captured.url,
                        captured_at: now(),
                        chunk_index: 0,
                        text: captured.text.chars().take(5000).collect(),
                        score: 0.0,
                    },
                );
            }
        }
    }
    let citations = dedupe_citations(citations)
        .into_iter()
        .take(8)
        .collect::<Vec<_>>();
    ollama_chat(&state.client, &settings, &prompt, citations).await
}

#[tauri::command]
async fn aether_crystallizer_generate(
    state: State<'_, Backend>,
    input: GenerateIcebergInput,
) -> Cmd<IcebergResult> {
    let topic = input.keyword.trim().to_string();
    if topic.is_empty() {
        return Err("Enter a topic before crystallizing.".to_string());
    }
    let settings = load_settings(&state.paths.settings_path).await?;
    ollama_generate_iceberg(&state.client, &settings, &topic).await
}

#[tauri::command]
async fn aether_crystallizer_list_saved(
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
async fn aether_crystallizer_get_saved(state: State<'_, Backend>, id: String) -> Cmd<SavedIceberg> {
    load_icebergs(&state.paths.icebergs_path)
        .await?
        .icebergs
        .into_iter()
        .find(|iceberg| iceberg.id == id)
        .ok_or_else(|| "Saved iceberg not found.".to_string())
}

#[tauri::command]
async fn aether_crystallizer_save(
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
async fn aether_crystallizer_reorder_saved(
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
async fn aether_crystallizer_delete_saved(state: State<'_, Backend>, id: String) -> Cmd<()> {
    let mut data = load_icebergs(&state.paths.icebergs_path).await?;
    data.icebergs.retain(|iceberg| iceberg.id != id);
    save_json(&state.paths.icebergs_path, &data).await
}

#[tauri::command]
async fn aether_system_status(state: State<'_, Backend>) -> Cmd<SystemStatus> {
    system_status(&state).await
}

#[tauri::command]
async fn aether_system_settings(state: State<'_, Backend>) -> Cmd<AppSettings> {
    let settings = load_settings(&state.paths.settings_path).await?;
    Ok(AppSettings {
        browser: settings.browser,
    })
}

#[tauri::command]
async fn aether_system_update_settings(
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
    save_json(&state.paths.settings_path, &settings).await?;
    Ok(AppSettings {
        browser: settings.browser,
    })
}

#[tauri::command]
async fn aether_system_update_models(
    state: State<'_, Backend>,
    input: UpdateModelsInput,
) -> Cmd<SystemStatus> {
    let mut settings = load_settings(&state.paths.settings_path).await?;
    if let Some(model) = input.embedding_model {
        settings.ollama.embedding_model =
            Some(model.trim().to_string()).filter(|item| !item.is_empty());
    }
    if let Some(model) = input.chat_model {
        settings.ollama.chat_model = Some(model.trim().to_string()).filter(|item| !item.is_empty());
    }
    save_json(&state.paths.settings_path, &settings).await?;
    system_status(&state).await
}

#[tauri::command(rename_all = "camelCase")]
fn aether_layout_set_panel_collapsed(
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
fn aether_layout_set_modal_overlay_open(
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
fn aether_layout_show_status_toast(input: StatusToastInput) -> Cmd<()> {
    let _ = (input.message, input.tone, input.duration_ms);
    Ok(())
}

async fn navigate_active_tab(app: &AppHandle, state: &State<'_, Backend>, url: &str) -> Cmd<()> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let (tab_id, target_url) = {
        let mut tabs = lock_tabs(state)?;
        let tab = tabs
            .active_tab_mut()
            .ok_or_else(|| "No active browser tab.".to_string())?;
        tab.navigate(url, &settings.browser.default_search_engine);
        let result = (tab.id.clone(), tab.url.clone());
        tabs.dashboard_open = false;
        result
    };
    navigate_native_webview(app, state, &tab_id, &target_url)?;
    emit_state(app, state)
}

async fn search_collection(
    state: &State<'_, Backend>,
    input: SearchCollectionInput,
) -> Cmd<Vec<SearchResult>> {
    let query = input.query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    get_collection(&state.paths.library_path, &input.collection_id).await?;
    let settings = load_settings(&state.paths.settings_path).await?;
    let vectors = load_vectors(&state.paths.chunks_path).await?;
    let query_vector = ollama_embed(&state.client, &settings, vec![query])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "Ollama returned no embedding.".to_string())?;
    let mut results = vectors
        .chunks
        .into_iter()
        .filter(|chunk| chunk.collection_id == input.collection_id)
        .map(|chunk| SearchResult {
            score: cosine_distance(&query_vector, &chunk.vector),
            id: chunk.id,
            collection_id: chunk.collection_id,
            capture_id: chunk.capture_id,
            app_id: chunk.app_id,
            title: chunk.title,
            url: chunk.url,
            captured_at: chunk.captured_at,
            chunk_index: chunk.chunk_index,
            text: chunk.text,
        })
        .collect::<Vec<_>>();
    results.sort_by(|left, right| {
        left.score
            .partial_cmp(&right.score)
            .unwrap_or(Ordering::Equal)
    });
    results.truncate(input.limit.unwrap_or(8));
    Ok(results)
}

async fn system_status(state: &State<'_, Backend>) -> Cmd<SystemStatus> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let library = load_library(&state.paths.library_path).await?;
    match ollama_models(&state.client).await {
        Ok(models) => Ok(SystemStatus {
            ollama_reachable: true,
            embedding_model: pick_embedding_model(&models, &settings.ollama),
            chat_model: pick_chat_model(&models, &settings.ollama),
            available_models: models,
            db_path: state.paths.db_path.display().to_string(),
            library_path: state.paths.library_path.display().to_string(),
            collections: library.collections,
            error: None,
        }),
        Err(error) => Ok(SystemStatus {
            ollama_reachable: false,
            embedding_model: EMBEDDING_MODEL.to_string(),
            chat_model: None,
            available_models: Vec::new(),
            db_path: state.paths.db_path.display().to_string(),
            library_path: state.paths.library_path.display().to_string(),
            collections: library.collections,
            error: Some(error),
        }),
    }
}

async fn load_library(path: &Path) -> Cmd<LibraryData> {
    read_json_or_default(path).await
}

async fn load_settings(path: &Path) -> Cmd<UserSettings> {
    read_json_or_default(path).await
}

async fn load_icebergs(path: &Path) -> Cmd<IcebergData> {
    read_json_or_default(path).await
}

async fn load_vectors(path: &Path) -> Cmd<VectorStoreData> {
    read_json_or_default(path).await
}

async fn read_json_or_default<T>(path: &Path) -> Cmd<T>
where
    T: DeserializeOwned + Default + Serialize,
{
    match tokio::fs::read_to_string(path).await {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| error.to_string()),
        Err(_) => {
            let data = T::default();
            save_json(path, &data).await?;
            Ok(data)
        }
    }
}

async fn save_json<T: Serialize>(path: &Path, data: &T) -> Cmd<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
    tokio::fs::write(path, format!("{raw}\n"))
        .await
        .map_err(|error| error.to_string())
}

async fn get_collection(path: &Path, collection_id: &str) -> Cmd<CollectionSummary> {
    load_library(path)
        .await?
        .collections
        .into_iter()
        .find(|collection| collection.id == collection_id)
        .ok_or_else(|| "Collection not found.".to_string())
}

async fn ollama_models(client: &Client) -> Cmd<Vec<String>> {
    let response = client
        .get(format!("{OLLAMA_BASE_URL}/api/tags"))
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Ollama /api/tags failed: {}", response.status()));
    }
    let tags = response
        .json::<OllamaTagsResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(tags.models.into_iter().map(|model| model.name).collect())
}

async fn ollama_embed(
    client: &Client,
    settings: &UserSettings,
    inputs: Vec<String>,
) -> Cmd<Vec<Vec<f32>>> {
    let models = ollama_models(client).await?;
    let model = pick_embedding_model(&models, &settings.ollama);
    if !models.contains(&model) {
        return Err(format!(
            "Ollama embedding model \"{model}\" is not installed."
        ));
    }
    let mut embeddings = Vec::new();
    for batch in inputs.chunks(8) {
        let response = client
            .post(format!("{OLLAMA_BASE_URL}/api/embed"))
            .json(&json!({ "model": model, "input": batch }))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Ollama /api/embed failed: {}", response.status()));
        }
        let embed = response
            .json::<OllamaEmbedResponse>()
            .await
            .map_err(|error| error.to_string())?;
        embeddings.extend(embed.embeddings);
    }
    Ok(embeddings)
}

async fn ollama_chat(
    client: &Client,
    settings: &UserSettings,
    prompt: &str,
    citations: Vec<SearchResult>,
) -> Cmd<ChatResult> {
    let models = ollama_models(client).await?;
    let model = pick_chat_model(&models, &settings.ollama).ok_or_else(|| {
        "No local chat model found in Ollama. Install llama3.1:8b or gemma3.".to_string()
    })?;
    let context_block = citations
        .iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "[{}] {}\nURL: {}\nCollection: {}\n{}",
                index + 1,
                item.title,
                item.url,
                item.collection_id,
                item.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let response = client
        .post(format!("{OLLAMA_BASE_URL}/api/chat"))
        .json(&json!({
            "model": model,
            "stream": false,
            "messages": [
                {
                    "role": "system",
                    "content": "You are Æther, a private local research assistant. Answer only from the supplied local collection context. If the context is insufficient, say what is missing. Cite sources with bracket numbers."
                },
                {
                    "role": "user",
                    "content": format!("Local collection context:\n{}\n\nQuestion: {}", if context_block.is_empty() { "No stored context was retrieved." } else { &context_block }, prompt)
                }
            ],
            "options": { "temperature": 0.2 }
        }))
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Ollama /api/chat failed: {}", response.status()));
    }
    let answer = response
        .json::<OllamaChatResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(ChatResult {
        answer: answer.message.content,
        model: answer.model,
        citations,
    })
}

async fn ollama_generate_iceberg(
    client: &Client,
    settings: &UserSettings,
    topic: &str,
) -> Cmd<IcebergResult> {
    let models = ollama_models(client).await?;
    let model = pick_chat_model(&models, &settings.ollama).ok_or_else(|| {
        "No local generative model found in Ollama. Install llama3.1:8b or gemma3.".to_string()
    })?;
    let response = client
        .post(format!("{OLLAMA_BASE_URL}/api/generate"))
        .json(&json!({
            "model": model,
            "prompt": build_iceberg_prompt(topic),
            "stream": false,
            "format": "json",
            "options": { "temperature": 0.35, "num_predict": 5000 }
        }))
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Ollama /api/generate failed: {}",
            response.status()
        ));
    }
    let generated = response
        .json::<OllamaGenerateResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(IcebergResult {
        keyword: topic.to_string(),
        model: generated.model,
        items: normalize_iceberg_items(&generated.response)?,
        generated_at: now(),
    })
}

async fn extract_readable_active_page(
    state: &State<'_, Backend>,
    active_tab: &ManagedTab,
) -> Cmd<CapturedPage> {
    #[cfg(desktop)]
    {
        match extract_readable_page_from_webview(state, active_tab).await {
            Ok(page) => return Ok(page),
            Err(_) => {}
        }
    }

    extract_readable_page(&state.client, &active_tab.url).await
}

#[cfg(desktop)]
async fn extract_readable_page_from_webview(
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
    let script = r#"(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, iframe, form, nav, footer, svg').forEach((node) => node.remove());
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

fn parse_page_snapshot(payload: &str) -> Cmd<BrowserPageSnapshot> {
    parse_json_payload::<BrowserPageSnapshot>(payload)
}

fn parse_json_payload<T: DeserializeOwned>(payload: &str) -> Cmd<T> {
    let value =
        serde_json::from_str::<serde_json::Value>(payload).map_err(|error| error.to_string())?;
    if let Some(inner) = value.as_str() {
        serde_json::from_str::<T>(inner).map_err(|error| error.to_string())
    } else {
        serde_json::from_value::<T>(value).map_err(|error| error.to_string())
    }
}

fn snapshot_to_captured_page(
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
    let body_text = snapshot.body_text.unwrap_or_else(|| {
        parsed_document
            .as_ref()
            .map(select_body_text)
            .unwrap_or_default()
    });
    let text = normalize_captured_text(&format!("{title}\n\n{description}\n\n{body_text}"));

    if text.len() < MIN_CAPTURE_TEXT_LENGTH {
        return Err("This page does not contain enough readable text to capture.".to_string());
    }

    Ok(CapturedPage { title, url, text })
}

async fn extract_readable_page(client: &Client, url: &str) -> Cmd<CapturedPage> {
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

fn select_first_text(document: &Html, selector: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .next()
        .map(|node| node.text().collect::<Vec<_>>().join(" ").trim().to_string())
}

fn select_meta_content(document: &Html, name: &str) -> Option<String> {
    let selector = Selector::parse(&format!("meta[name=\"{name}\"]")).ok()?;
    document
        .select(&selector)
        .next()
        .and_then(|node| node.value().attr("content"))
        .map(|value| value.trim().to_string())
}

fn select_body_text(document: &Html) -> String {
    let selector = Selector::parse("body").expect("body selector");
    document
        .select(&selector)
        .flat_map(|node| node.text())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn pick_embedding_model(models: &[String], settings: &OllamaSettings) -> String {
    if let Some(model) = settings
        .embedding_model
        .as_deref()
        .and_then(|model| pick_model(models, &[model]))
    {
        return model;
    }
    pick_model(models, &[EMBEDDING_MODEL]).unwrap_or_else(|| EMBEDDING_MODEL.to_string())
}

fn pick_chat_model(models: &[String], settings: &OllamaSettings) -> Option<String> {
    if let Some(model) = settings
        .chat_model
        .as_deref()
        .and_then(|model| pick_model(models, &[model]))
    {
        return Some(model);
    }
    pick_model(models, &PREFERRED_CHAT_MODELS).or_else(|| models.first().cloned())
}

fn pick_model(models: &[String], preferred: &[&str]) -> Option<String> {
    for candidate in preferred {
        if let Some(model) = models.iter().find(|model| model.as_str() == *candidate) {
            return Some(model.clone());
        }

        let latest = format!("{candidate}:latest");
        if let Some(model) = models.iter().find(|model| **model == latest) {
            return Some(model.clone());
        }

        if let Some(stripped) = candidate.strip_suffix(":latest") {
            if let Some(model) = models.iter().find(|model| model.as_str() == stripped) {
                return Some(model.clone());
            }
        }
    }
    None
}

fn build_iceberg_prompt(keyword: &str) -> String {
    format!(
        r#"Create an iceberg chart for the topic "{keyword}".

Return JSON only with this exact shape:
{{
  "items": [
    {{ "name": "Visible phrase", "description": "One short explanation.", "level": 1 }},
    {{ "name": "Another phrase", "description": "One short explanation.", "level": 1 }}
  ]
}}

Rules:
- level must be an integer from 1 to 5.
- level 1 is broad, familiar, or introductory.
- level 5 is obscure, technical, hidden, or specialist knowledge.
- Return exactly 25 items total.
- Return exactly 5 items for each level.
- Use concise item names that fit on a node.
- Every item must include a non-empty description.
- Do not include markdown, prose, or comments."#
    )
}

fn normalize_iceberg_items(response: &str) -> Cmd<Vec<IcebergItem>> {
    let json_text = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed = match serde_json::from_str::<serde_json::Value>(json_text) {
        Ok(value) => value,
        Err(_) => {
            let start = json_text
                .find('[')
                .ok_or_else(|| "Ollama did not return valid iceberg JSON.".to_string())?;
            let end = json_text
                .rfind(']')
                .ok_or_else(|| "Ollama did not return valid iceberg JSON.".to_string())?;
            serde_json::from_str(&json_text[start..=end])
                .map_err(|_| "Ollama did not return valid iceberg JSON.".to_string())?
        }
    };
    let items_value = parsed.get("items").cloned().unwrap_or(parsed);
    let raw_items = items_value
        .as_array()
        .ok_or_else(|| "Ollama did not return valid iceberg JSON.".to_string())?;
    let mut by_level: HashMap<u8, Vec<IcebergItem>> = HashMap::new();
    for raw in raw_items {
        let name = raw
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        let description = raw
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        if name.is_empty() || description.is_empty() {
            continue;
        }
        let level = raw
            .get("level")
            .and_then(|value| value.as_u64())
            .unwrap_or(1)
            .clamp(1, 5) as u8;
        let level_items = by_level.entry(level).or_default();
        if level_items.len() >= 5 {
            continue;
        }
        let index = level_items.len();
        level_items.push(IcebergItem {
            id: unique_slug(&format!("{level}-{}-{name}", index + 1), &[]),
            name: name.to_string(),
            description: description.to_string(),
            level,
            x: ICEBERG_LEVEL_LANES[index % ICEBERG_LEVEL_LANES.len()],
            y: 120.0 + index as f64 * 44.0,
        });
    }
    let normalized = (1..=5)
        .flat_map(|level| by_level.remove(&level).unwrap_or_default())
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        Err("Ollama did not return any usable iceberg items.".to_string())
    } else {
        Ok(normalized)
    }
}

fn normalize_saved_items(items: Vec<IcebergItem>) -> Vec<IcebergItem> {
    items
        .into_iter()
        .filter(|item| !item.name.trim().is_empty() && !item.description.trim().is_empty())
        .map(|mut item| {
            item.name = item.name.trim().to_string();
            item.description = item.description.trim().to_string();
            item.level = item.level.clamp(1, 5);
            if item.id.trim().is_empty() {
                item.id = unique_slug(&format!("{}-{}", item.level, item.name), &[]);
            }
            item
        })
        .collect()
}

fn saved_iceberg_summary(iceberg: &SavedIceberg) -> SavedIcebergSummary {
    SavedIcebergSummary {
        id: iceberg.id.clone(),
        title: iceberg.title.clone(),
        keyword: iceberg.iceberg.keyword.clone(),
        model: iceberg.iceberg.model.clone(),
        icon: iceberg.icon.clone(),
        generated_at: iceberg.iceberg.generated_at.clone(),
        saved_at: iceberg.saved_at.clone(),
        updated_at: iceberg.updated_at.clone(),
        item_count: iceberg.iceberg.items.len(),
    }
}

fn dedupe_citations(citations: Vec<SearchResult>) -> Vec<SearchResult> {
    let mut unique: HashMap<String, SearchResult> = HashMap::new();
    for citation in citations {
        let key = normalize_citation_key(&citation.url);
        if let Some(existing) = unique.get_mut(&key) {
            if !existing.text.contains(&citation.text) {
                existing.text = format!(
                    "{}\n\nChunk {}:\n{}",
                    existing.text,
                    citation.chunk_index + 1,
                    citation.text
                )
                .chars()
                .take(9000)
                .collect();
            }
            existing.score = existing.score.min(citation.score);
        } else {
            unique.insert(key, citation);
        }
    }
    unique.into_values().collect()
}

fn split_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        let chunk = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    chunks
}

fn cosine_distance(left: &[f32], right: &[f32]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return f64::INFINITY;
    }
    let mut dot = 0.0_f64;
    let mut left_norm = 0.0_f64;
    let mut right_norm = 0.0_f64;
    for (left, right) in left.iter().zip(right.iter()) {
        let left = *left as f64;
        let right = *right as f64;
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        f64::INFINITY
    } else {
        1.0 - dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

fn lock_tabs<'a>(state: &'a State<'_, Backend>) -> Cmd<std::sync::MutexGuard<'a, TabState>> {
    state
        .tabs
        .lock()
        .map_err(|_| "Æther tab state is unavailable.".to_string())
}

fn emit_state(app: &AppHandle, state: &State<Backend>) -> Cmd<()> {
    let tabs = lock_tabs(state)?;
    app.emit("aether:state", tabs.state())
        .map_err(|error| error.to_string())
}

fn active_tab_url(state: &State<Backend>) -> Cmd<String> {
    let tabs = lock_tabs(state)?;
    tabs.active_tab()
        .map(|tab| tab.url.clone())
        .ok_or_else(|| "No active browser tab.".to_string())
}

fn active_tab_id(state: &State<Backend>) -> Cmd<String> {
    Ok(lock_tabs(state)?.active_tab_id.clone())
}

fn reorder<T, F>(items: Vec<T>, ids: &[String], id_of: F) -> Vec<T>
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

fn normalize_captured_text(text: &str) -> String {
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

fn normalize_url(raw_url: &str, search_engine: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return "https://www.google.com".to_string();
    }
    if Url::parse(trimmed).is_ok() {
        return trimmed.to_string();
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

fn search_engine_prefix(id: &str) -> &'static str {
    match id {
        "bing" => "https://www.bing.com/search?q=",
        "yahoo" => "https://search.yahoo.com/search?p=",
        "ecosia" => "https://www.ecosia.org/search?q=",
        "duckduckgo" => "https://duckduckgo.com/?q=",
        _ => "https://www.google.com/search?q=",
    }
}

fn normalize_search_engine_id(value: &str) -> String {
    match value {
        "google" | "bing" | "yahoo" | "ecosia" | "duckduckgo" => value.to_string(),
        _ => "google".to_string(),
    }
}

fn normalize_iceberg_icon(value: Option<String>) -> Option<String> {
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

fn normalize_theme_color(color: &str) -> Option<String> {
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

fn title_from_url(url: &str) -> String {
    let host = get_tab_host(url);
    if host.is_empty() {
        "New tab".to_string()
    } else {
        host
    }
}

fn favicon_for_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    Some(format!(
        "{}://{}/favicon.ico",
        parsed.scheme(),
        parsed.host_str()?
    ))
}

fn get_tab_host(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.trim_start_matches("www.").to_string())
        })
        .unwrap_or_default()
}

fn normalize_citation_key(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_fragment(None);
            parsed.to_string()
        }
        Err(_) => url.to_string(),
    }
}

fn normalize_capture_url_key(url: &str) -> String {
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

fn unique_slug(name: &str, existing: &[String]) -> String {
    let base = slugify(name);
    let mut candidate = base.clone();
    let mut suffix = 2;
    while existing.contains(&candidate) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn slugify(value: &str) -> String {
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

fn urlencoding(value: &str) -> String {
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

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
