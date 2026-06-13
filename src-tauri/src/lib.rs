mod embeddinggemma;

use chrono::Utc;
use encoding_rs::UTF_8;
use llama_cpp_2::{
    context::params::{LlamaContextParams, LlamaPoolingType},
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, AddBos, LlamaChatMessage, LlamaModel},
    sampling::LlamaSampler,
};
use reqwest::Client;
use scraper::{Html, Selector};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    env, fs,
    num::NonZeroU32,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    webview::{NewWindowResponse, PageLoadEvent},
    Webview, WebviewBuilder, WebviewUrl, Window,
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, State,
    WindowEvent,
};
use tokio::task;
use url::Url;

const CHUNKS_TABLE: &str = "chunks";
const SIDEBAR_WIDTH: f64 = 76.0;
const BROWSER_VIEW_TOP: f64 = 166.0;
const PANEL_WIDTH: f64 = 404.0;
const PANEL_COLLAPSED_WIDTH: f64 = 58.0;
const LOCAL_RUNTIME_NAME: &str = "llama.cpp";
const AETHER_FIND_MENU_ID: &str = "aether-find-in-page";
const AETHER_FIND_REQUESTED_EVENT: &str = "aether:find-requested";
const AETHER_FIND_RESULT_EVENT: &str = "aether:find-result";
const AETHER_CHAT_STREAM_EVENT: &str = "aether:chat-stream";
const AETHER_MODEL_DIR_ENV: &str = "AETHER_MODEL_DIR";
const AETHER_CHAT_MODEL_ENV: &str = "AETHER_CHAT_MODEL";
const AETHER_EMBEDDING_MODEL_ENV: &str = "AETHER_EMBEDDING_MODEL";
const AETHER_LLM_CONTEXT_ENV: &str = "AETHER_LLM_CTX";
const AETHER_LLM_BATCH_TOKENS_ENV: &str = "AETHER_LLM_BATCH_TOKENS";
const AETHER_LLM_GPU_ENV: &str = "AETHER_LLM_GPU";
const AETHER_EMBED_GPU_ENV: &str = "AETHER_EMBED_GPU";
const AETHER_EMBED_BATCH_ENV: &str = "AETHER_EMBED_BATCH";
const AETHER_EMBED_BATCH_TOKENS_ENV: &str = "AETHER_EMBED_BATCH_TOKENS";
const DEFAULT_CHAT_CONTEXT_TOKENS: u32 = 6144;
const DEFAULT_CHAT_BATCH_TOKENS: usize = 2048;
const DEFAULT_EMBEDDING_CONTEXT_TOKENS: u32 = 2048;
const DEFAULT_EMBEDDING_BATCH_SIZE: usize = 8;
const DEFAULT_EMBEDDING_BATCH_TOKENS: usize = 2048;
const DEFAULT_CAPTURE_CHUNK_SIZE: usize = 2200;
const DEFAULT_CAPTURE_CHUNK_OVERLAP: usize = 240;
const SAFETENSORS_CAPTURE_CHUNK_SIZE: usize = DEFAULT_CAPTURE_CHUNK_SIZE;
const SAFETENSORS_CAPTURE_CHUNK_OVERLAP: usize = DEFAULT_CAPTURE_CHUNK_OVERLAP;
const DEFAULT_GENERATION_TOKENS: usize = 900;
const DEFAULT_ICEBERG_GENERATION_TOKENS: usize = 2800;
const DEFAULT_TOP_K: i32 = 64;
const DEFAULT_TOP_P: f32 = 0.95;
const PREFERRED_CHAT_MODEL_HINTS: [&str; 8] = [
    "gemma4", "gemma-4", "gemma3", "gemma-3", "gemma-2b", "2b", "gemma", "qwen",
];
const MIN_CAPTURE_TEXT_LENGTH: usize = 120;
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
    native_runtime: Arc<Mutex<NativeModelRuntime>>,
    vectors: tokio::sync::RwLock<Option<VectorStoreData>>,
    generation_cancelled: Arc<AtomicBool>,
}

#[cfg(desktop)]
#[derive(Default)]
struct NativeBrowserViews {
    views: HashMap<String, Webview>,
}

#[derive(Default)]
struct NativeModelRuntime {
    backend: Option<LlamaBackend>,
    chat: Option<LoadedNativeModel>,
    embedding: Option<LoadedNativeModel>,
    safetensors_embedding: Option<LoadedSafetensorsEmbeddingModel>,
}

struct LoadedNativeModel {
    path: PathBuf,
    model: LlamaModel,
}

struct LoadedSafetensorsEmbeddingModel {
    path: PathBuf,
    model: embeddinggemma::EmbeddingGemma,
}

#[derive(Clone)]
struct EmbeddingProgress {
    app: AppHandle,
    message: String,
}

impl EmbeddingProgress {
    fn emit(&self, current: usize, total: usize) {
        emit_capture_progress(&self.app, &self.message, Some(current), Some(total));
    }

    fn emit_message(&self, message: impl Into<String>, current: usize, total: usize) {
        emit_capture_progress(&self.app, message, Some(current), Some(total));
    }
}

struct ChatPromptMessage {
    role: &'static str,
    content: String,
}

struct RenderedChatPrompt {
    prompt: String,
    add_bos: AddBos,
}

#[derive(Clone, Copy)]
enum NativeModelKind {
    Chat,
    Embedding,
}

enum WebviewHistoryDirection {
    Back,
    Forward,
}

struct ModelCatalog {
    models: Vec<PathBuf>,
    chat_model: Option<PathBuf>,
    embedding_model: Option<PathBuf>,
    error: Option<String>,
}

#[derive(Clone)]
struct DataPaths {
    db_path: PathBuf,
    library_path: PathBuf,
    settings_path: PathBuf,
    icebergs_path: PathBuf,
    chunks_path: PathBuf,
    models_path: PathBuf,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureProgress {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamPayload {
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    citations: Option<Vec<SearchResult>>,
}

#[derive(Clone)]
struct ChatStreamEmitter {
    app: AppHandle,
    request_id: String,
}

impl ChatStreamEmitter {
    fn emit(&self, payload: ChatStreamPayload) {
        let _ = self.app.emit(AETHER_CHAT_STREAM_EVENT, payload);
    }

    fn status(&self, status: &str) {
        self.emit(ChatStreamPayload {
            request_id: self.request_id.clone(),
            status: Some(status.to_string()),
            delta: None,
            citations: None,
        });
    }

    fn citations(&self, citations: &[SearchResult]) {
        self.emit(ChatStreamPayload {
            request_id: self.request_id.clone(),
            status: Some("Generating answer".to_string()),
            delta: None,
            citations: Some(citations.to_vec()),
        });
    }

    fn delta(&self, delta: &str) {
        self.emit(ChatStreamPayload {
            request_id: self.request_id.clone(),
            status: None,
            delta: Some(delta.to_string()),
            citations: None,
        });
    }
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
    runtime_ready: bool,
    runtime_name: String,
    embedding_model: Option<String>,
    chat_model: Option<String>,
    available_models: Vec<String>,
    chat_models: Vec<String>,
    embedding_models: Vec<String>,
    model_dir: String,
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
struct FindMatchSnapshot {
    current: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FindResultPayload {
    tab_id: String,
    current: usize,
    total: usize,
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
#[serde(rename_all = "camelCase")]
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
    request_id: Option<String>,
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
    #[serde(default = "default_settings_version")]
    version: u8,
    #[serde(default)]
    browser: BrowserSettings,
    #[serde(default, alias = "ollama")]
    local_model: LocalModelSettings,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalModelSettings {
    embedding_model: Option<String>,
    chat_model: Option<String>,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            default_search_engine: "google".to_string(),
        }
    }
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            version: default_settings_version(),
            browser: BrowserSettings::default(),
            local_model: LocalModelSettings::default(),
        }
    }
}

fn default_settings_version() -> u8 {
    1
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
                models_path: project_models_path(),
            },
            tabs: Mutex::new(TabState::new()),
            #[cfg(desktop)]
            webviews: Mutex::new(NativeBrowserViews::default()),
            client: Client::builder()
                .user_agent("Aether/1.0 Tauri")
                .build()
                .expect("reqwest client"),
            native_runtime: Arc::new(Mutex::new(NativeModelRuntime::default())),
            vectors: tokio::sync::RwLock::new(None),
            generation_cancelled: Arc::new(AtomicBool::new(false)),
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

    #[cfg(not(desktop))]
    fn go_back(&mut self) {
        if self.can_go_back() {
            self.history_index -= 1;
            self.url = self.history[self.history_index].clone();
            self.title = title_from_url(&self.url);
        }
    }

    #[cfg(not(desktop))]
    fn go_forward(&mut self) {
        if self.can_go_forward() {
            self.history_index += 1;
            self.url = self.history[self.history_index].clone();
            self.title = title_from_url(&self.url);
        }
    }

    fn commit_history_url(&mut self, url: String) {
        if self.history.get(self.history_index) == Some(&url) {
            return;
        }

        if let Some(existing_index) = self
            .history
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, item)| (item == &url).then_some(index))
        {
            self.history_index = existing_index;
            return;
        }

        self.history.truncate(self.history_index + 1);
        self.history.push(url);
        self.history_index = self.history.len().saturating_sub(1);
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
fn navigate_native_webview_history(
    state: &State<Backend>,
    tab_id: &str,
    direction: WebviewHistoryDirection,
) -> Cmd<()> {
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
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
fn navigate_native_webview_history(
    _state: &State<Backend>,
    _tab_id: &str,
    _direction: WebviewHistoryDirection,
) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn scroll_native_webview_to_text(state: &State<Backend>, tab_id: &str, text: &str) -> Cmd<()> {
    let source_text = text.trim();
    if source_text.is_empty() {
        return Ok(());
    }
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
        .views
        .get(tab_id)
        .cloned()
        .ok_or_else(|| format!("Native webview not found for tab: {tab_id}"))?;
    let text_json = serde_json::to_string(source_text).map_err(|error| error.to_string())?;
    let script = scroll_to_text_script().replace("__AETHER_SOURCE_TEXT__", &text_json);
    webview.eval(script).map_err(|error| error.to_string())
}

#[cfg(not(desktop))]
fn scroll_native_webview_to_text(_state: &State<Backend>, _tab_id: &str, _text: &str) -> Cmd<()> {
    Ok(())
}

#[cfg(desktop)]
fn find_native_webview_text(
    app: &AppHandle,
    state: &State<Backend>,
    tab_id: &str,
    query: Option<&str>,
    action: &str,
) -> Cmd<()> {
    let webview = state
        .webviews
        .lock()
        .map_err(|_| "Æther webviews are unavailable.".to_string())?
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
fn find_native_webview_text(
    _app: &AppHandle,
    _state: &State<Backend>,
    _tab_id: &str,
    _query: Option<&str>,
    _action: &str,
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

fn find_in_page_script() -> &'static str {
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

fn scroll_to_text_script() -> &'static str {
    r#"
(() => {
  const sourceText = __AETHER_SOURCE_TEXT__;
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const source = normalize(sourceText);
  if (!source) return;

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

  const restorePreviousHighlights = () => {
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
            if !is_loading {
                tab.commit_history_url(url);
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

// macOS quit (`-[NSApplication terminate:]`) calls libc `exit()`, which runs
// C++ static destructors. llama.cpp's Metal backend frees its global device
// registry there and asserts that all residency sets were released first — but
// our loaded models (which hold those Metal buffers) are never dropped, because
// the Cocoa quit path skips Rust's normal teardown. That assert aborts the
// process ("Æther quit unexpectedly"). Terminate immediately via `_exit`, which
// bypasses the static destructors entirely; the OS reclaims Metal/host memory,
// and all app state is already persisted per-action (no exit-time flush).
#[cfg(desktop)]
fn force_exit() -> ! {
    extern "C" {
        fn _exit(code: i32) -> !;
    }
    unsafe { _exit(0) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            let find_item = MenuItem::with_id(
                app,
                AETHER_FIND_MENU_ID,
                "Find in Page",
                true,
                Some("CmdOrCtrl+F"),
            )?;
            let find_menu = Submenu::with_items(app, "Find", true, &[&find_item])?;
            menu.append(&find_menu)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == AETHER_FIND_MENU_ID {
                let _ = app.emit(AETHER_FIND_REQUESTED_EVENT, ());
            }
        });

    builder
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
                prewarm_local_models(&app_handle);
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
            aether_tabs_scroll_to_text,
            aether_tabs_find,
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
            aether_chat_cancel,
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
        .build(tauri::generate_context!())
        .expect("error while building Æther")
        .run(|_app_handle, event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::ExitRequested { .. } = event {
                force_exit();
            }
        });
}

#[cfg(desktop)]
fn prewarm_local_models(app: &AppHandle) {
    let state = app.state::<Backend>();
    let paths = state.paths.clone();
    let runtime = Arc::clone(&state.native_runtime);

    tauri::async_runtime::spawn(async move {
        let Ok(settings) = load_settings(&paths.settings_path).await else {
            return;
        };
        let catalog = model_catalog(&paths, &settings.local_model);
        let chat_model = catalog.chat_model;
        let embedding_model = catalog.embedding_model;
        if chat_model.is_none() && embedding_model.is_none() {
            return;
        }
        let result = task::spawn_blocking(move || {
            let mut runtime = runtime
                .lock()
                .map_err(|_| "Local model runtime is unavailable.".to_string())?;
            if let Some(model_path) = &chat_model {
                runtime
                    .ensure_model(NativeModelKind::Chat, model_path)
                    .map_err(|error| {
                        format!("chat model {} failed: {error}", model_label(model_path))
                    })?;
            }
            if let Some(model_path) = &embedding_model {
                runtime.warm_embedding_model(model_path).map_err(|error| {
                    format!(
                        "embedding model {} failed: {error}",
                        model_label(model_path)
                    )
                })?;
            }
            Ok::<(), String>(())
        })
        .await;

        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("Æther model prewarm failed: {error}"),
            Err(error) => eprintln!("Æther model prewarm task failed: {error}"),
        }
    });
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
fn aether_tabs_scroll_to_text(state: State<Backend>, tab_id: String, text: String) -> Cmd<()> {
    {
        let tabs = lock_tabs(&state)?;
        if !tabs.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(format!("Unknown tab: {tab_id}"));
        }
    }
    scroll_native_webview_to_text(&state, &tab_id, &text)
}

#[tauri::command(rename_all = "camelCase")]
fn aether_tabs_find(
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
fn aether_tabs_go_back(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
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
        let target_tab_id = tab.id.clone();
        #[cfg(not(desktop))]
        tab.go_back();
        target_tab_id
    };
    navigate_native_webview_history(&state, &target_tab_id, WebviewHistoryDirection::Back)?;
    emit_state(&app, &state)
}

#[tauri::command(rename_all = "camelCase")]
fn aether_tabs_go_forward(app: AppHandle, state: State<Backend>, tab_id: String) -> Cmd<()> {
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
        let target_tab_id = tab.id.clone();
        #[cfg(not(desktop))]
        tab.go_forward();
        target_tab_id
    };
    navigate_native_webview_history(&state, &target_tab_id, WebviewHistoryDirection::Forward)?;
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

    with_vectors_mut(&state, |vectors| {
        vectors.chunks.retain(|chunk| chunk.collection_id != id);
    })
    .await
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
    app: AppHandle,
    state: State<'_, Backend>,
    input: CaptureCurrentPageInput,
) -> Cmd<CaptureResult> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let mut library = load_library(&state.paths.library_path).await?;
    let collection = library
        .collections
        .iter()
        .find(|collection| collection.id == input.collection_id)
        .cloned()
        .ok_or_else(|| "Collection not found.".to_string())?;
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
    let captured = extract_readable_active_page(&state, &active_tab).await?;
    emit_capture_progress(&app, "Chunking readable text", None, None);
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
        return Err("No readable text found on the current page.".to_string());
    }
    emit_capture_progress(
        &app,
        &format!("Embedding {} chunks", chunks.len()),
        Some(0),
        Some(chunks.len()),
    );
    let embeddings = local_embed_with_progress(
        &state,
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
        &app,
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

    with_vectors_mut(&state, |vectors| {
        vectors.chunks.extend(records.iter().cloned());
    })
    .await?;

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
    with_vectors_mut(&state, |vectors| {
        vectors
            .chunks
            .retain(|chunk| chunk.capture_id != capture_id);
    })
    .await
}

#[tauri::command]
async fn aether_search_collection(
    state: State<'_, Backend>,
    input: SearchCollectionInput,
) -> Cmd<Vec<SearchResult>> {
    search_collection(&state, input).await
}

#[tauri::command]
async fn aether_chat_ask(
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
            if let Some(active_tab) = active_tab {
                if let Ok(captured) = extract_readable_active_page(&state, &active_tab).await {
                    citations.insert(
                        0,
                        current_page_citation(captured, &prompt, input.collection_id.as_deref()),
                    );
                }
            } else if let Ok(captured) = extract_readable_page(&state.client, &active_url).await {
                citations.insert(
                    0,
                    current_page_citation(captured, &prompt, input.collection_id.as_deref()),
                );
            }
        }
    }
    let citations = dedupe_citations(citations)
        .into_iter()
        .take(8)
        .collect::<Vec<_>>();
    local_chat(&state, &settings, &prompt, citations, Some(stream)).await
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
    state
        .generation_cancelled
        .store(false, AtomicOrdering::Relaxed);
    let settings = load_settings(&state.paths.settings_path).await?;
    local_generate_iceberg(&state, &settings, &topic).await
}

#[tauri::command]
fn aether_chat_cancel(state: State<Backend>) -> Cmd<()> {
    state
        .generation_cancelled
        .store(true, AtomicOrdering::Relaxed);
    Ok(())
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

fn emit_capture_progress(
    app: &AppHandle,
    message: impl Into<String>,
    current: Option<usize>,
    total: Option<usize>,
) {
    let _ = app.emit(
        "aether:capture-progress",
        CaptureProgress {
            message: message.into(),
            current,
            total,
        },
    );
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
    let query_vector = local_embed(state, &settings, vec![query])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "Local embedding model returned no embedding.".to_string())?;
    with_vectors_read(state, |vectors| {
        let mut scored = vectors
            .chunks
            .iter()
            .filter(|chunk| chunk.collection_id == input.collection_id)
            .map(|chunk| (cosine_distance(&query_vector, &chunk.vector), chunk))
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(Ordering::Equal));
        scored.truncate(input.limit.unwrap_or(8));
        scored
            .into_iter()
            .map(|(score, chunk)| SearchResult {
                score,
                id: chunk.id.clone(),
                collection_id: chunk.collection_id.clone(),
                capture_id: chunk.capture_id.clone(),
                app_id: chunk.app_id.clone(),
                title: chunk.title.clone(),
                url: chunk.url.clone(),
                captured_at: chunk.captured_at.clone(),
                chunk_index: chunk.chunk_index,
                text: chunk.text.clone(),
            })
            .collect::<Vec<_>>()
    })
    .await
}

fn capture_chunk_settings(paths: &DataPaths, settings: &UserSettings) -> (usize, usize) {
    let catalog = model_catalog(paths, &settings.local_model);
    if catalog
        .embedding_model
        .as_deref()
        .is_some_and(is_safetensors_embedding_model)
    {
        (
            SAFETENSORS_CAPTURE_CHUNK_SIZE,
            SAFETENSORS_CAPTURE_CHUNK_OVERLAP,
        )
    } else {
        (DEFAULT_CAPTURE_CHUNK_SIZE, DEFAULT_CAPTURE_CHUNK_OVERLAP)
    }
}

fn current_page_citation(
    captured: CapturedPage,
    prompt: &str,
    collection_id: Option<&str>,
) -> SearchResult {
    let chunks = split_text(&captured.text, 1600, 180);
    let (chunk_index, text) = chunks
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            lexical_relevance_score(left, prompt)
                .partial_cmp(&lexical_relevance_score(right, prompt))
                .unwrap_or(Ordering::Equal)
        })
        .map(|(index, text)| (index, text.clone()))
        .unwrap_or_else(|| (0, captured.text.chars().take(1800).collect()));

    SearchResult {
        id: format!("current-{}", uuid()),
        collection_id: collection_id
            .map(ToString::to_string)
            .unwrap_or_else(|| "current-page".to_string()),
        capture_id: "current-page".to_string(),
        app_id: "browser".to_string(),
        title: captured.title,
        url: captured.url,
        captured_at: now(),
        chunk_index,
        text,
        score: 0.0,
    }
}

fn lexical_relevance_score(text: &str, query: &str) -> f64 {
    let terms = query_terms(query);
    if terms.is_empty() {
        return 0.0;
    }
    let haystack = text.to_lowercase();
    terms
        .iter()
        .map(|term| lexical_term_score(&haystack, term))
        .sum()
}

fn lexical_term_score(haystack: &str, term: &str) -> f64 {
    if haystack.contains(term) {
        return 2.0 + (term.len() as f64 / 10.0);
    }
    let stem_len = term.len().min(6);
    if stem_len >= 5 && haystack.contains(&term[..stem_len]) {
        return 1.25 + (stem_len as f64 / 12.0);
    }
    if let Some(singular) = term.strip_suffix('s') {
        if singular.len() >= 5 && haystack.contains(singular) {
            return 1.5 + (singular.len() as f64 / 12.0);
        }
    }
    0.0
}

fn query_terms(query: &str) -> Vec<String> {
    let stopwords = [
        "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how",
        "i", "in", "is", "it", "me", "most", "of", "on", "or", "should", "the", "this", "to",
        "was", "were", "what", "when", "where", "which", "who", "why", "with",
    ];
    let stopwords = stopwords.into_iter().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    query
        .split(|character: char| !character.is_alphanumeric())
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|term| term.len() > 2 && !stopwords.contains(term.as_str()))
        .filter(|term| seen.insert(term.clone()))
        .collect()
}

async fn system_status(state: &State<'_, Backend>) -> Cmd<SystemStatus> {
    let settings = load_settings(&state.paths.settings_path).await?;
    let library = load_library(&state.paths.library_path).await?;
    let catalog = model_catalog(&state.paths, &settings.local_model);
    Ok(SystemStatus {
        runtime_ready: catalog.chat_model.is_some() || catalog.embedding_model.is_some(),
        runtime_name: LOCAL_RUNTIME_NAME.to_string(),
        embedding_model: catalog.embedding_model.as_ref().map(path_to_model_value),
        chat_model: catalog.chat_model.as_ref().map(path_to_model_value),
        available_models: catalog.models.iter().map(path_to_model_value).collect(),
        chat_models: catalog
            .models
            .iter()
            .filter(|path| is_chat_model(path))
            .map(path_to_model_value)
            .collect(),
        embedding_models: catalog
            .models
            .iter()
            .filter(|path| is_embedding_model(path))
            .map(path_to_model_value)
            .collect(),
        model_dir: state.paths.models_path.display().to_string(),
        db_path: state.paths.db_path.display().to_string(),
        library_path: state.paths.library_path.display().to_string(),
        collections: library.collections,
        error: catalog.error,
    })
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

async fn with_vectors_read<T>(
    state: &State<'_, Backend>,
    read: impl FnOnce(&VectorStoreData) -> T,
) -> Cmd<T> {
    {
        let guard = state.vectors.read().await;
        if let Some(vectors) = guard.as_ref() {
            return Ok(read(vectors));
        }
    }
    let mut guard = state.vectors.write().await;
    if guard.is_none() {
        *guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    Ok(read(guard.as_ref().expect("vector store cache")))
}

async fn with_vectors_mut<T>(
    state: &State<'_, Backend>,
    mutate: impl FnOnce(&mut VectorStoreData) -> T,
) -> Cmd<T> {
    let mut guard = state.vectors.write().await;
    if guard.is_none() {
        *guard = Some(load_vectors(&state.paths.chunks_path).await?);
    }
    let vectors = guard.as_mut().expect("vector store cache");
    let result = mutate(vectors);
    save_vectors(&state.paths.chunks_path, vectors).await?;
    Ok(result)
}

// Vector rows are large and machine-managed, so they are persisted as compact
// JSON instead of the pretty format used for small user-editable stores.
async fn save_vectors(path: &Path, data: &VectorStoreData) -> Cmd<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string(data).map_err(|error| error.to_string())?;
    tokio::fs::write(path, raw)
        .await
        .map_err(|error| error.to_string())
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

async fn local_embed(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    inputs: Vec<String>,
) -> Cmd<Vec<Vec<f32>>> {
    local_embed_with_progress(state, settings, inputs, None).await
}

async fn local_embed_with_progress(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    inputs: Vec<String>,
    progress: Option<EmbeddingProgress>,
) -> Cmd<Vec<Vec<f32>>> {
    let catalog = model_catalog(&state.paths, &settings.local_model);
    let model_path = catalog.embedding_model.ok_or_else(|| {
        format!(
            "No local embedding model found. Add an embedding GGUF or official EmbeddingGemma safetensors folder to {} or set {AETHER_EMBEDDING_MODEL_ENV}.",
            state.paths.models_path.display()
        )
    })?;
    let runtime = Arc::clone(&state.native_runtime);
    task::spawn_blocking(move || {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "Local model runtime is unavailable.".to_string())?;
        match progress {
            Some(progress) => runtime.embed_with_progress(&model_path, inputs, Some(progress)),
            None => runtime.embed(&model_path, inputs),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn local_chat(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    prompt: &str,
    citations: Vec<SearchResult>,
    stream: Option<ChatStreamEmitter>,
) -> Cmd<ChatResult> {
    let catalog = model_catalog(&state.paths, &settings.local_model);
    let model_path = catalog.chat_model.ok_or_else(|| {
        format!(
            "No local chat GGUF model found. Add Gemma or another chat model to {} or set {AETHER_CHAT_MODEL_ENV}.",
            state.paths.models_path.display()
        )
    })?;
    if let Some(stream) = &stream {
        stream.citations(&citations);
    }
    let messages = build_chat_messages(prompt, &citations);
    let runtime = Arc::clone(&state.native_runtime);
    let cancel = Arc::clone(&state.generation_cancelled);
    let model_label = model_label(&model_path);
    let answer = task::spawn_blocking(move || {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "Local model runtime is unavailable.".to_string())?;
        let on_token: Option<Box<dyn FnMut(&str) + Send>> = stream
            .map(|stream| Box::new(move |delta: &str| stream.delta(delta)) as Box<dyn FnMut(&str) + Send>);
        runtime.complete_chat(
            &model_path,
            messages,
            DEFAULT_GENERATION_TOKENS,
            0.2,
            &cancel,
            on_token,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let answer = normalize_answer_citations(&clean_model_output(&answer), citations.len());
    Ok(ChatResult {
        answer,
        model: model_label,
        citations,
    })
}

async fn local_generate_iceberg(
    state: &State<'_, Backend>,
    settings: &UserSettings,
    topic: &str,
) -> Cmd<IcebergResult> {
    let catalog = model_catalog(&state.paths, &settings.local_model);
    let model_path = catalog.chat_model.ok_or_else(|| {
        format!(
            "No local generative GGUF model found. Add Gemma or another chat model to {} or set {AETHER_CHAT_MODEL_ENV}.",
            state.paths.models_path.display()
        )
    })?;
    let messages = vec![ChatPromptMessage {
        role: "user",
        content: build_iceberg_prompt(topic),
    }];
    let runtime = Arc::clone(&state.native_runtime);
    let cancel = Arc::clone(&state.generation_cancelled);
    let model_label = model_label(&model_path);
    let generated = task::spawn_blocking(move || {
        let mut runtime = runtime
            .lock()
            .map_err(|_| "Local model runtime is unavailable.".to_string())?;
        runtime.complete_chat(
            &model_path,
            messages,
            DEFAULT_ICEBERG_GENERATION_TOKENS,
            0.35,
            &cancel,
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    if state.generation_cancelled.load(AtomicOrdering::Relaxed) {
        return Err("Crystallization stopped.".to_string());
    }
    let generated = clean_model_output(&generated);
    Ok(IcebergResult {
        keyword: topic.to_string(),
        model: model_label,
        items: normalize_iceberg_items(&generated)?,
        generated_at: now(),
    })
}

impl NativeModelRuntime {
    fn ensure_backend(&mut self) -> Cmd<()> {
        if self.backend.is_some() {
            return Ok(());
        }

        let mut backend = LlamaBackend::init().map_err(|error| error.to_string())?;
        backend.void_logs();
        self.backend = Some(backend);
        Ok(())
    }

    fn ensure_model(&mut self, kind: NativeModelKind, path: &Path) -> Cmd<()> {
        let path = canonical_model_path(path);
        let current_path = match kind {
            NativeModelKind::Chat => self.chat.as_ref().map(|loaded| loaded.path.as_path()),
            NativeModelKind::Embedding => {
                self.embedding.as_ref().map(|loaded| loaded.path.as_path())
            }
        };
        if current_path == Some(path.as_path()) {
            return Ok(());
        }

        self.ensure_backend()?;
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "Local model backend is not initialized.".to_string())?;
        let mut params = LlamaModelParams::default().with_use_mmap(backend.supports_mmap());
        let use_gpu = match kind {
            NativeModelKind::Chat => local_gpu_enabled(),
            NativeModelKind::Embedding => embedding_gpu_enabled(),
        };
        if use_gpu && backend.supports_gpu_offload() {
            params = params.with_n_gpu_layers(999);
        } else {
            params = params
                .with_n_gpu_layers(0)
                .with_devices(&[])
                .map_err(|error| format!("Failed to select CPU model backend: {error}"))?;
        }
        let model = LlamaModel::load_from_file(backend, &path, &params).map_err(|error| {
            format!("Failed to load local model {}: {error}", model_label(&path))
        })?;
        let loaded = LoadedNativeModel { path, model };
        match kind {
            NativeModelKind::Chat => self.chat = Some(loaded),
            NativeModelKind::Embedding => self.embedding = Some(loaded),
        }
        Ok(())
    }

    fn embed(&mut self, model_path: &Path, inputs: Vec<String>) -> Cmd<Vec<Vec<f32>>> {
        self.embed_with_progress(model_path, inputs, None)
    }

    fn embed_with_progress(
        &mut self,
        model_path: &Path,
        inputs: Vec<String>,
        progress: Option<EmbeddingProgress>,
    ) -> Cmd<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        if is_safetensors_embedding_model(model_path) {
            return self.embed_safetensors(model_path, inputs, progress);
        }

        self.ensure_model(NativeModelKind::Embedding, model_path)?;
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "Local model backend is not initialized.".to_string())?;
        let model = &self
            .embedding
            .as_ref()
            .ok_or_else(|| "Local embedding model is not loaded.".to_string())?
            .model;
        let threads = auto_thread_count();
        let total = inputs.len();
        let mut embeddings = Vec::with_capacity(total);
        let mut tokenized_inputs = Vec::with_capacity(total);

        if let Some(progress) = &progress {
            progress.emit_message("Tokenizing chunks", 0, total);
        }

        for input in inputs {
            let tokens = model
                .str_to_token(&input, AddBos::Always)
                .map_err(|error| error.to_string())?;
            if tokens.is_empty() {
                return Err("Local embedding input produced no tokens.".to_string());
            }
            tokenized_inputs.push(tokens);
        }

        let max_sequences = embedding_batch_size().min(16);
        let max_batch_tokens = embedding_batch_token_limit();
        let mut input_index = 0;
        let mut batches = Vec::new();

        while input_index < tokenized_inputs.len() {
            let mut batch_token_count = 0usize;
            let mut batch_end = input_index;

            while batch_end < tokenized_inputs.len()
                && batch_end - input_index < max_sequences
                && (batch_token_count == 0
                    || batch_token_count + tokenized_inputs[batch_end].len() <= max_batch_tokens)
            {
                batch_token_count += tokenized_inputs[batch_end].len();
                batch_end += 1;
            }

            batches.push((input_index, batch_end, batch_token_count));
            input_index = batch_end;
        }

        let max_batch_token_count = batches
            .iter()
            .map(|(_, _, batch_token_count)| *batch_token_count)
            .max()
            .unwrap_or_default();
        let max_batch_sequence_count = batches
            .iter()
            .map(|(batch_start, batch_end, _)| batch_end - batch_start)
            .max()
            .unwrap_or(1);
        let n_ctx = embedding_context_tokens(max_batch_token_count);
        if max_batch_token_count as u32 > n_ctx {
            return Err(format!(
                "Local embedding batch is too long for the embedding context: {} tokens exceeds {}.",
                max_batch_token_count, n_ctx
            ));
        }
        let n_batch = n_ctx.max(max_batch_token_count as u32).max(512);
        let offload_embedding_ops = embedding_gpu_enabled();
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_seq_max(max_batch_sequence_count as u32)
            .with_n_batch(n_batch)
            .with_n_ubatch(n_batch)
            .with_n_threads(threads)
            .with_n_threads_batch(threads)
            .with_embeddings(true)
            .with_offload_kqv(offload_embedding_ops)
            .with_op_offload(offload_embedding_ops)
            .with_pooling_type(LlamaPoolingType::Mean);
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|error| error.to_string())?;

        for (batch_start, batch_end, batch_token_count) in batches {
            let batch_sequence_count = batch_end - batch_start;
            if let Some(progress) = &progress {
                progress.emit_message(
                    format!(
                        "Embedding chunks {}-{batch_end} of {total}",
                        batch_start + 1
                    ),
                    batch_start,
                    total,
                );
            }

            ctx.clear_kv_cache();
            let mut batch = LlamaBatch::new(batch_token_count, batch_sequence_count as i32);
            for (sequence_index, tokens) in
                tokenized_inputs[batch_start..batch_end].iter().enumerate()
            {
                batch
                    .add_sequence(tokens, sequence_index as i32, false)
                    .map_err(|error| error.to_string())?;
            }
            ctx.encode(&mut batch).map_err(|error| error.to_string())?;

            for sequence_index in 0..batch_sequence_count {
                let embedding = ctx
                    .embeddings_seq_ith(sequence_index as i32)
                    .map_err(|error| error.to_string())?;
                embeddings.push(normalize_embedding(embedding));
            }
            if let Some(progress) = &progress {
                progress.emit(batch_end, total);
            }
        }

        Ok(embeddings)
    }

    fn has_safetensors_embedding(&self, model_path: &Path) -> bool {
        let path = canonical_model_path(model_path);
        self.safetensors_embedding
            .as_ref()
            .is_some_and(|loaded| loaded.path.as_path() == path.as_path())
    }

    fn ensure_safetensors_embedding(&mut self, model_path: &Path) -> Cmd<()> {
        if self.has_safetensors_embedding(model_path) {
            return Ok(());
        }
        let path = canonical_model_path(model_path);
        let model = embeddinggemma::EmbeddingGemma::load(&path)
            .map_err(|error| format!("Failed to load EmbeddingGemma safetensors: {error}"))?;
        self.safetensors_embedding = Some(LoadedSafetensorsEmbeddingModel { path, model });
        Ok(())
    }

    fn warm_embedding_model(&mut self, model_path: &Path) -> Cmd<()> {
        if is_safetensors_embedding_model(model_path) {
            self.ensure_safetensors_embedding(model_path)
        } else {
            self.ensure_model(NativeModelKind::Embedding, model_path)
        }
    }

    fn embed_safetensors(
        &mut self,
        model_path: &Path,
        inputs: Vec<String>,
        progress: Option<EmbeddingProgress>,
    ) -> Cmd<Vec<Vec<f32>>> {
        if !self.has_safetensors_embedding(model_path) {
            if let Some(progress) = &progress {
                progress.emit_message("Loading EmbeddingGemma", 0, inputs.len());
            }
        }
        self.ensure_safetensors_embedding(model_path)?;
        let model = self
            .safetensors_embedding
            .as_mut()
            .ok_or_else(|| "Official EmbeddingGemma model is not loaded.".to_string())?;
        let total = inputs.len();
        let mut embeddings = Vec::with_capacity(total);
        let batch_size = safetensors_embedding_batch_size(&inputs);
        for batch in inputs.chunks(batch_size) {
            if let Some(progress) = &progress {
                let start = embeddings.len() + 1;
                let end = (embeddings.len() + batch.len()).min(total);
                progress.emit_message(
                    format!("Embedding chunks {start}-{end} of {total}"),
                    embeddings.len(),
                    total,
                );
            }
            let batch = batch.to_vec();
            let batch_embeddings = model
                .model
                .embed_batch(&batch)
                .map_err(|error| error.to_string())?;
            embeddings.extend(batch_embeddings);
            if let Some(progress) = &progress {
                progress.emit(embeddings.len(), total);
            }
        }
        Ok(embeddings)
    }

    fn complete_chat(
        &mut self,
        model_path: &Path,
        messages: Vec<ChatPromptMessage>,
        max_tokens: usize,
        temperature: f32,
        cancel: &AtomicBool,
        on_token: Option<Box<dyn FnMut(&str) + Send>>,
    ) -> Cmd<String> {
        self.ensure_model(NativeModelKind::Chat, model_path)?;
        let rendered = {
            let model = &self
                .chat
                .as_ref()
                .ok_or_else(|| "Local chat model is not loaded.".to_string())?
                .model;
            render_model_chat_prompt(model, &messages)?
        };
        self.complete_loaded_prompt(
            &rendered.prompt,
            max_tokens,
            temperature,
            rendered.add_bos,
            cancel,
            on_token,
        )
    }

    fn complete_loaded_prompt(
        &mut self,
        prompt: &str,
        max_tokens: usize,
        temperature: f32,
        add_bos: AddBos,
        cancel: &AtomicBool,
        mut on_token: Option<Box<dyn FnMut(&str) + Send>>,
    ) -> Cmd<String> {
        let backend = self
            .backend
            .as_ref()
            .ok_or_else(|| "Local model backend is not initialized.".to_string())?;
        let model = &self
            .chat
            .as_ref()
            .ok_or_else(|| "Local chat model is not loaded.".to_string())?
            .model;
        let mut tokens = model
            .str_to_token(prompt, add_bos)
            .map_err(|error| error.to_string())?;
        if tokens.is_empty() {
            return Err("Local chat prompt produced no tokens.".to_string());
        }

        let n_ctx = chat_context_tokens();
        let max_prompt_tokens =
            n_ctx.saturating_sub((max_tokens as u32).min(1024)).max(512) as usize;
        if tokens.len() > max_prompt_tokens {
            tokens = tokens[tokens.len() - max_prompt_tokens..].to_vec();
        }
        let n_batch = (chat_batch_token_limit() as u32).min(n_ctx).max(512);
        let n_ubatch = n_batch.min(2048).max(512);
        let threads = auto_thread_count();
        let offload_ops = local_gpu_enabled();
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(n_batch)
            .with_n_ubatch(n_ubatch)
            .with_n_threads(threads)
            .with_n_threads_batch(threads)
            .with_offload_kqv(offload_ops)
            .with_op_offload(offload_ops);
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|error| error.to_string())?;

        let last_prompt_index = tokens.len().saturating_sub(1);
        let prompt_batch_limit = n_batch as usize;
        let mut prompt_cursor = 0usize;
        let mut sample_index = 0;
        while prompt_cursor < tokens.len() {
            if cancel.load(AtomicOrdering::Relaxed) {
                return Err("Generation stopped.".to_string());
            }
            let prompt_end = (prompt_cursor + prompt_batch_limit).min(tokens.len());
            let mut prompt_batch = LlamaBatch::new(prompt_end - prompt_cursor, 1);
            for (offset, token) in tokens[prompt_cursor..prompt_end].iter().enumerate() {
                let index = prompt_cursor + offset;
                prompt_batch
                    .add(*token, index as i32, &[0], index == last_prompt_index)
                    .map_err(|error| error.to_string())?;
            }
            ctx.decode(&mut prompt_batch)
                .map_err(|error| error.to_string())?;
            if prompt_end == tokens.len() {
                sample_index = prompt_batch.n_tokens() - 1;
            }
            prompt_cursor = prompt_end;
        }

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::top_k(DEFAULT_TOP_K),
            LlamaSampler::top_p(DEFAULT_TOP_P, 1),
            LlamaSampler::temp(temperature),
            LlamaSampler::dist(0xA371_2026),
        ]);
        let mut decoder = UTF_8.new_decoder();
        let mut output = String::new();
        let mut streamed_len = 0usize;
        let mut batch = LlamaBatch::new(1, 1);
        let mut position = tokens.len() as i32;

        for _ in 0..max_tokens {
            if cancel.load(AtomicOrdering::Relaxed) {
                break;
            }
            let token = sampler.sample(&ctx, sample_index);
            if model.is_eog_token(token) {
                break;
            }
            let piece = model
                .token_to_piece(token, &mut decoder, true, None)
                .map_err(|error| error.to_string())?;
            output.push_str(&piece);
            if contains_stop_marker(&output) {
                break;
            }
            if let Some(on_token) = on_token.as_mut() {
                let safe_end = stream_safe_len(&output);
                if safe_end > streamed_len {
                    on_token(&output[streamed_len..safe_end]);
                    streamed_len = safe_end;
                }
            }

            batch.clear();
            batch
                .add(token, position, &[0], true)
                .map_err(|error| error.to_string())?;
            ctx.decode(&mut batch).map_err(|error| error.to_string())?;
            sample_index = batch.n_tokens() - 1;
            position += 1;
        }

        if output.trim().is_empty() && cancel.load(AtomicOrdering::Relaxed) {
            return Err("Generation stopped.".to_string());
        }

        Ok(output)
    }
}

fn model_catalog(paths: &DataPaths, settings: &LocalModelSettings) -> ModelCatalog {
    let mut errors = Vec::new();
    let model_dirs = [
        paths.models_path.clone(),
        paths.models_path.join("chat"),
        paths.models_path.join("embeddings"),
    ];
    for dir in &model_dirs {
        if let Err(error) = fs::create_dir_all(dir) {
            errors.push(format!(
                "Could not create model directory {}: {error}",
                dir.display()
            ));
        }
    }

    let mut models = Vec::new();
    collect_gguf_models(&paths.models_path, &mut models);
    collect_safetensors_embedding_models(&paths.models_path.join("embeddings"), &mut models);
    if let Ok(dir) = env::var(AETHER_MODEL_DIR_ENV) {
        let dir = PathBuf::from(dir);
        collect_gguf_models(&dir, &mut models);
        collect_safetensors_embedding_models(&dir, &mut models);
    }
    for var in [AETHER_CHAT_MODEL_ENV, AETHER_EMBEDDING_MODEL_ENV] {
        match env_model_path(var) {
            Ok(Some(path)) => models.push(path),
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
    }

    models = dedupe_model_paths(models);
    let embedding_model = pick_embedding_model(&models, settings);
    let chat_model = pick_chat_model(&models, settings);
    if models.is_empty() {
        errors.push(format!(
            "No local models found. Add GGUF models or official EmbeddingGemma safetensors to {} or set {AETHER_MODEL_DIR_ENV}.",
            paths.models_path.display()
        ));
    } else {
        if embedding_model.is_none() {
            errors.push(format!(
                "No embedding model selected. Put official EmbeddingGemma safetensors, embeddinggemma GGUF, or nomic-embed-text GGUF in {} or set {AETHER_EMBEDDING_MODEL_ENV}.",
                paths.models_path.join("embeddings").display()
            ));
        }
        if chat_model.is_none() {
            errors.push(format!(
                "No chat GGUF selected. Put a Gemma chat model in {} or set {AETHER_CHAT_MODEL_ENV}.",
                paths.models_path.join("chat").display()
            ));
        }
    }

    ModelCatalog {
        models,
        chat_model,
        embedding_model,
        error: if errors.is_empty() {
            None
        } else {
            Some(errors.join(" "))
        },
    }
}

fn collect_gguf_models(root: &Path, models: &mut Vec<PathBuf>) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 4 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push((path, depth + 1));
            } else if is_gguf_model(&path) {
                models.push(path);
            }
        }
    }
}

fn collect_safetensors_embedding_models(root: &Path, models: &mut Vec<PathBuf>) {
    if is_safetensors_embedding_model(root) {
        models.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_safetensors_embedding_model(&path) {
            models.push(path);
        }
    }
}

fn project_models_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.join("aether-models"))
        .unwrap_or_else(|| PathBuf::from("aether-models"))
}

fn dedupe_model_paths(models: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for path in models {
        let path = canonical_model_path(&path);
        let key = path.display().to_string();
        if seen.insert(key) {
            deduped.push(path);
        }
    }
    deduped.sort_by_key(|path| model_label(path).to_lowercase());
    deduped
}

fn env_model_path(var: &str) -> Cmd<Option<PathBuf>> {
    let Ok(value) = env::var(var) else {
        return Ok(None);
    };
    let path = PathBuf::from(value.trim());
    let valid = match var {
        AETHER_CHAT_MODEL_ENV => is_chat_model(&path),
        AETHER_EMBEDDING_MODEL_ENV => is_embedding_model(&path),
        _ => is_gguf_model(&path) || is_safetensors_embedding_model(&path),
    };
    if valid {
        Ok(Some(path))
    } else {
        Err(format!(
            "{var} does not point to an existing local model: {}",
            path.display()
        ))
    }
}

fn pick_embedding_model(models: &[PathBuf], settings: &LocalModelSettings) -> Option<PathBuf> {
    if let Ok(Some(path)) = env_model_path(AETHER_EMBEDDING_MODEL_ENV) {
        return Some(canonical_model_path(&path));
    }
    if let Some(model) = settings
        .embedding_model
        .as_deref()
        .and_then(|value| pick_selected_model(models, value, true))
    {
        return Some(model);
    }
    models
        .iter()
        .filter(|path| is_embedding_model(path))
        .max_by_key(|path| embedding_model_score(path))
        .cloned()
}

fn pick_chat_model(models: &[PathBuf], settings: &LocalModelSettings) -> Option<PathBuf> {
    if let Ok(Some(path)) = env_model_path(AETHER_CHAT_MODEL_ENV) {
        return Some(canonical_model_path(&path));
    }
    if let Some(model) = settings
        .chat_model
        .as_deref()
        .and_then(|value| pick_selected_model(models, value, false))
    {
        return Some(model);
    }
    pick_model_by_hints(models, &PREFERRED_CHAT_MODEL_HINTS, false).or_else(|| {
        models
            .iter()
            .find(|path| !is_embedding_model_name(path))
            .cloned()
    })
}

fn pick_selected_model(models: &[PathBuf], value: &str, embedding: bool) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let direct = PathBuf::from(value);
    if selected_model_matches_kind(&direct, embedding) {
        return Some(canonical_model_path(&direct));
    }
    let normalized = value.to_lowercase();
    models
        .iter()
        .find(|path| {
            let label = model_label(path);
            path_to_model_value(path) == value
                || label == value
                || strip_gguf_extension(&label) == value
                || label.to_lowercase().contains(&normalized)
        })
        .filter(|path| selected_model_matches_kind(path, embedding))
        .cloned()
}

fn pick_model_by_hints(models: &[PathBuf], hints: &[&str], embedding: bool) -> Option<PathBuf> {
    for hint in hints {
        let hint = hint.to_lowercase();
        if let Some(model) = models.iter().find(|path| {
            let label = model_label(path).to_lowercase();
            label.contains(&hint)
                && if embedding {
                    is_embedding_model(path)
                } else {
                    is_chat_model(path)
                }
        }) {
            return Some(model.clone());
        }
    }
    None
}

fn embedding_model_score(path: &Path) -> i32 {
    let label = model_label(path).to_lowercase();
    let mut score = 0;
    if is_gguf_model(path) {
        score += 1_000;
    }
    if label.contains("embeddinggemma") || label.contains("embedding-gemma") {
        score += 500;
    }
    if label.contains("bf16") {
        score += 400;
    } else if label.contains("f16") {
        score += 300;
    } else if label.contains("q8") {
        score += 150;
    }
    if label.contains("nomic") {
        score += 250;
    }
    if is_safetensors_embedding_model(path) {
        score -= 500;
    }
    score
}

fn is_gguf_model(path: &Path) -> bool {
    path.is_file()
        && !is_mmproj_model(path)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
}

fn is_chat_model(path: &Path) -> bool {
    is_gguf_model(path) && !is_embedding_model_name(path)
}

fn selected_model_matches_kind(path: &Path, embedding: bool) -> bool {
    if embedding {
        is_embedding_model(path)
    } else {
        is_chat_model(path)
    }
}

fn is_embedding_model(path: &Path) -> bool {
    is_safetensors_embedding_model(path) || (is_gguf_model(path) && is_embedding_model_name(path))
}

fn is_embedding_model_name(path: &Path) -> bool {
    if is_safetensors_embedding_model(path) {
        return true;
    }
    let label = model_label(path).to_lowercase();
    label.contains("embed") || label.contains("embedding") || label.contains("nomic")
}

fn is_mmproj_model(path: &Path) -> bool {
    model_label(path).to_lowercase().contains("mmproj")
}

fn is_safetensors_embedding_model(path: &Path) -> bool {
    path.is_dir()
        && path.join("config.json").is_file()
        && path.join("tokenizer.json").is_file()
        && path.join("model.safetensors").is_file()
        && path.join("2_Dense").join("config.json").is_file()
        && path.join("2_Dense").join("model.safetensors").is_file()
        && path.join("3_Dense").join("config.json").is_file()
        && path.join("3_Dense").join("model.safetensors").is_file()
}

fn canonical_model_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_to_model_value(path: &PathBuf) -> String {
    path.display().to_string()
}

fn model_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(strip_gguf_extension)
        .unwrap_or_else(|| path.display().to_string())
}

fn strip_gguf_extension(value: &str) -> String {
    value
        .strip_suffix(".gguf")
        .or_else(|| value.strip_suffix(".GGUF"))
        .unwrap_or(value)
        .to_string()
}

fn chat_context_tokens() -> u32 {
    env::var(AETHER_LLM_CONTEXT_ENV)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(DEFAULT_CHAT_CONTEXT_TOKENS)
        .clamp(1024, 65_536)
}

fn chat_batch_token_limit() -> usize {
    env::var(AETHER_LLM_BATCH_TOKENS_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_CHAT_BATCH_TOKENS)
        .clamp(512, 8192)
}

fn local_gpu_enabled() -> bool {
    env_flag_enabled(AETHER_LLM_GPU_ENV, cfg!(target_os = "macos"))
}

fn embedding_gpu_enabled() -> bool {
    env_flag_enabled(AETHER_EMBED_GPU_ENV, false)
}

fn env_flag_enabled(name: &str, default: bool) -> bool {
    env::var(name).ok().map_or(default, |value| {
        matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on")
    })
}

fn embedding_batch_size() -> usize {
    env::var(AETHER_EMBED_BATCH_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_EMBEDDING_BATCH_SIZE)
        .clamp(1, 24)
}

fn embedding_batch_token_limit() -> usize {
    env::var(AETHER_EMBED_BATCH_TOKENS_ENV)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_EMBEDDING_BATCH_TOKENS)
        .clamp(512, 8192)
}

fn safetensors_embedding_batch_size(inputs: &[String]) -> usize {
    let configured = embedding_batch_size();
    let longest = inputs
        .iter()
        .map(|input| input.chars().count())
        .max()
        .unwrap_or_default();

    if longest >= 1_600 {
        configured.min(2)
    } else if longest >= 900 {
        configured.min(4)
    } else {
        configured.min(8)
    }
}

fn embedding_context_tokens(input_tokens: usize) -> u32 {
    let needed = input_tokens.saturating_add(16).min(u32::MAX as usize) as u32;
    DEFAULT_EMBEDDING_CONTEXT_TOKENS.max(needed).min(8192)
}

fn auto_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|threads| threads.get().saturating_sub(2).clamp(2, 12) as i32)
        .unwrap_or(6)
}

fn normalize_embedding(values: &[f32]) -> Vec<f32> {
    let norm = values
        .iter()
        .map(|value| (*value as f64) * (*value as f64))
        .sum::<f64>()
        .sqrt();
    if norm <= f64::EPSILON {
        return values.to_vec();
    }
    values
        .iter()
        .map(|value| (*value as f64 / norm) as f32)
        .collect()
}

fn build_chat_messages(prompt: &str, citations: &[SearchResult]) -> Vec<ChatPromptMessage> {
    let context_block = citations
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let source_text = strip_numeric_bracket_markers(&item.text);
            format!(
                "[{}] {}\nURL: {}\nCollection: {}\n{}",
                index + 1,
                item.title,
                item.url,
                item.collection_id,
                source_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let context = if context_block.is_empty() {
        "No stored context was retrieved."
    } else {
        &context_block
    };
    vec![
        ChatPromptMessage {
            role: "system",
            content: format!(
                "You are Æther, a private local research assistant. Answer only from the supplied local collection context. If the context is insufficient, say what is missing. Cite sources only with Æther source numbers [1] through [{}]. Do not copy bracketed reference numbers from webpage text.",
                citations.len().max(1)
            ),
        },
        ChatPromptMessage {
            role: "user",
            content: format!("Local collection context:\n{context}\n\nQuestion: {prompt}"),
        },
    ]
}

fn render_model_chat_prompt(
    model: &LlamaModel,
    messages: &[ChatPromptMessage],
) -> Cmd<RenderedChatPrompt> {
    let template = match model.chat_template(None) {
        Ok(template) => template,
        Err(_) => {
            return Ok(RenderedChatPrompt {
                prompt: fallback_chat_prompt(messages),
                add_bos: AddBos::Never,
            })
        }
    };
    let chat = messages
        .iter()
        .map(|message| LlamaChatMessage::new(message.role.to_string(), message.content.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    match model.apply_chat_template(&template, &chat, true) {
        Ok(prompt) => Ok(RenderedChatPrompt {
            prompt,
            add_bos: AddBos::Never,
        }),
        Err(_) => Ok(RenderedChatPrompt {
            prompt: fallback_chat_prompt(messages),
            add_bos: AddBos::Never,
        }),
    }
}

fn fallback_chat_prompt(messages: &[ChatPromptMessage]) -> String {
    let mut prompt = String::from("<bos>");
    let mut system_messages = Vec::new();

    for message in messages {
        match message.role {
            "system" | "developer" => {
                system_messages.push(message.content.trim().to_string());
            }
            "assistant" => {
                prompt.push_str("<|turn>model\n");
                prompt.push_str(message.content.trim());
                prompt.push_str("<turn|>\n");
            }
            "user" => {
                if !system_messages.is_empty() {
                    prompt.push_str("<|turn>system\n");
                    prompt.push_str(&system_messages.join("\n\n"));
                    prompt.push_str("<turn|>\n");
                    system_messages.clear();
                }
                prompt.push_str("<|turn>user\n");
                prompt.push_str(message.content.trim());
                prompt.push_str("<turn|>\n");
            }
            role => {
                prompt.push_str("<|turn>");
                prompt.push_str(role);
                prompt.push('\n');
                prompt.push_str(message.content.trim());
                prompt.push_str("<turn|>\n");
            }
        }
    }

    if !system_messages.is_empty() {
        prompt.push_str("<|turn>system\n");
        prompt.push_str(&system_messages.join("\n\n"));
        prompt.push_str("<turn|>\n");
    }

    prompt.push_str("<|turn>model\n");
    prompt
}

// Streaming deltas hold back a short tail starting at the most recent '<' so a
// stop marker arriving across several tokens is never shown to the user.
fn stream_safe_len(output: &str) -> usize {
    let tail_start = output.len().saturating_sub(18);
    let Some((boundary, _)) = output.char_indices().find(|(index, _)| *index >= tail_start) else {
        return output.len();
    };
    match output[boundary..].rfind('<') {
        Some(position) => boundary + position,
        None => output.len(),
    }
}

fn contains_stop_marker(output: &str) -> bool {
    output.contains("<end_of_turn>")
        || output.contains("<start_of_turn>")
        || output.contains("<turn|>")
        || output.contains("<|turn>")
        || output.contains("<|eot_id|>")
        || output.contains("<|end|>")
}

fn clean_model_output(output: &str) -> String {
    let mut cleaned = output.to_string();
    for marker in [
        "<end_of_turn>",
        "<start_of_turn>model",
        "<start_of_turn>assistant",
        "<start_of_turn>",
        "<turn|>",
        "<|turn>model",
        "<|turn>assistant",
        "<|turn>user",
        "<|turn>system",
        "<|turn>",
        "<|eot_id|>",
        "<|end|>",
    ] {
        cleaned = cleaned.replace(marker, "");
    }
    cleaned.trim().to_string()
}

fn normalize_answer_citations(answer: &str, citation_count: usize) -> String {
    tidy_citation_spacing(&rewrite_numeric_bracket_markers(
        answer,
        citation_count,
        true,
    ))
}

fn strip_numeric_bracket_markers(text: &str) -> String {
    rewrite_numeric_bracket_markers(text, 0, false)
}

fn rewrite_numeric_bracket_markers(text: &str, citation_count: usize, keep_valid: bool) -> String {
    let mut rewritten = String::with_capacity(text.len());
    let mut cursor = 0usize;

    while let Some(relative_start) = text[cursor..].find('[') {
        let start = cursor + relative_start;
        let Some(relative_end) = text[start + 1..].find(']') else {
            break;
        };
        let end = start + 1 + relative_end;
        let inner = &text[start + 1..end];
        let Some(numbers) = parse_numeric_citation_marker(inner) else {
            rewritten.push_str(&text[cursor..=start]);
            cursor = start + 1;
            continue;
        };

        rewritten.push_str(&text[cursor..start]);
        if keep_valid {
            let valid = numbers
                .into_iter()
                .filter(|number| *number > 0 && *number <= citation_count)
                .map(|number| number.to_string())
                .collect::<Vec<_>>();
            if !valid.is_empty() {
                rewritten.push('[');
                rewritten.push_str(&valid.join(", "));
                rewritten.push(']');
            }
        }
        cursor = end + 1;
    }

    rewritten.push_str(&text[cursor..]);
    rewritten
}

fn parse_numeric_citation_marker(value: &str) -> Option<Vec<usize>> {
    if value.trim().is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_digit() || character == ',' || character.is_whitespace()
        })
    {
        return None;
    }

    let mut numbers = Vec::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        let number = part.parse::<usize>().ok()?;
        numbers.push(number);
    }
    (!numbers.is_empty()).then_some(numbers)
}

fn tidy_citation_spacing(value: &str) -> String {
    let mut tidied = value.trim().to_string();
    for (from, to) in [
        (" .", "."),
        (" ,", ","),
        (" ;", ";"),
        (" :", ":"),
        (" !", "!"),
        (" ?", "?"),
        (" )", ")"),
        ("( ", "("),
    ] {
        tidied = tidied.replace(from, to);
    }
    while tidied.contains("  ") {
        tidied = tidied.replace("  ", " ");
    }
    tidied
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
                .ok_or_else(|| "Local model did not return valid iceberg JSON.".to_string())?;
            let end = json_text
                .rfind(']')
                .ok_or_else(|| "Local model did not return valid iceberg JSON.".to_string())?;
            serde_json::from_str(&json_text[start..=end])
                .map_err(|_| "Local model did not return valid iceberg JSON.".to_string())?
        }
    };
    let items_value = parsed.get("items").cloned().unwrap_or(parsed);
    let raw_items = items_value
        .as_array()
        .ok_or_else(|| "Local model did not return valid iceberg JSON.".to_string())?;
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
        Err("Local model did not return any usable iceberg items.".to_string())
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
    let mut unique = Vec::<SearchResult>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for citation in citations {
        let key = normalize_citation_key(&citation.url);
        if let Some(existing_index) = indexes.get(&key).copied() {
            let existing = &mut unique[existing_index];
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
            indexes.insert(key, unique.len());
            unique.push(citation);
        }
    }
    unique
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_citation_normalizer_removes_out_of_range_markers() {
        let answer = r#"The pelt was called "fitchet" [15]. It has another name [1, 16]."#;

        assert_eq!(
            normalize_answer_citations(answer, 2),
            r#"The pelt was called "fitchet". It has another name [1]."#
        );
    }

    #[test]
    fn source_context_sanitizer_removes_page_native_numeric_markers() {
        assert_eq!(
            strip_numeric_bracket_markers(
                "Rodents are mostly herbivorous.[1][2] Some vary [note]."
            ),
            "Rodents are mostly herbivorous. Some vary [note]."
        );
    }

    #[test]
    fn stream_safe_len_holds_back_potential_stop_marker() {
        assert_eq!(stream_safe_len("Plain prose with no markers"), 27);
        assert_eq!(stream_safe_len("Answer text <end_of"), 12);
        assert_eq!(stream_safe_len("Tail <"), 5);
        assert_eq!(stream_safe_len(""), 0);
    }

    #[test]
    fn stream_safe_len_releases_old_angle_brackets() {
        let text = "a < b is true, and much more prose follows here";
        assert_eq!(stream_safe_len(text), text.len());
    }

    #[test]
    fn stream_safe_len_respects_multibyte_boundaries() {
        let text = "Æther çalışması — özet <eö";
        let safe = stream_safe_len(text);
        assert!(text.is_char_boundary(safe));
        assert_eq!(&text[safe..], "<eö");
    }
}
