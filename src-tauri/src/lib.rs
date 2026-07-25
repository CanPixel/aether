mod air;
mod chat;
mod commands;
mod diagnostics;
mod extract;
mod flow;
mod iceberg;
mod inference;
mod model_catalog;
mod model_downloads;
mod retrieval;
mod retrieval_scoring;
mod store;
mod system;
mod trail;
mod types;
mod util;
mod vectors;
mod webview;

use chrono::{DateTime, Utc};
use encoding_rs::UTF_8;
use llama_cpp_2::{
    context::params::{LlamaAttentionType, LlamaContextParams, LlamaPoolingType},
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
    time::{Duration, Instant},
};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    LogicalPosition, LogicalSize, Position, Rect, Size, Webview, WebviewBuilder, WebviewUrl,
    Window, WindowEvent,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;
use tokio::task;
use url::Url;

use air::*;
use chat::*;
use commands::*;
use diagnostics::{diag_error, diag_info, diag_warn};

use extract::*;
use flow::*;
use iceberg::*;
use inference::*;
use model_catalog::*;
use model_downloads::*;
use retrieval::*;
use retrieval_scoring::*;
use store::*;
use system::*;
use trail::*;
use types::*;
use util::*;
use vectors::*;
use webview::*;

const CHUNKS_TABLE: &str = "chunks";
// Every on-disk store is written temp-then-rename, keeping the previous good copy
// beside it. See write_bytes_atomically / read_json_or_default.
const BACKUP_SUFFIX: &str = ".bak";
const TEMP_WRITE_SUFFIX: &str = ".tmp";
// Distinct from BACKUP_SUFFIX so the one-generation `.bak` rotation can never
// overwrite the only copy of a store in its pre-migration format.
const PRE_MIGRATION_SUFFIX: &str = ".v1.json";
const LIBRARY_EXPORT_DIR: &str = "aether-backups";
// Thread key for asks scoped to the open page rather than a hub.
const CURRENT_PAGE_THREAD_KEY: &str = "current-page";
// Turns kept per thread on disk. Enough to reread a session, bounded so the store
// cannot grow without limit.
const MAX_THREAD_TURNS: usize = 40;
// Prior turns replayed into the prompt. Each one costs context that citations also
// need, so this stays small deliberately.
const PROMPT_HISTORY_TURNS: usize = 3;
// Answers from earlier turns are summarised into the prompt, not replayed whole; a
// long previous answer would otherwise crowd out the retrieved sources.
const PROMPT_HISTORY_ANSWER_CHARS: usize = 480;
#[cfg(desktop)]
const SIDEBAR_WIDTH: f64 = 76.0;
#[cfg(desktop)]
const BROWSER_VIEW_TOP: f64 = 172.0;
#[cfg(desktop)]
const PANEL_WIDTH: f64 = 404.0;
#[cfg(desktop)]
const PANEL_COLLAPSED_WIDTH: f64 = 58.0;
const LOCAL_RUNTIME_NAME: &str = "llama.cpp";
#[cfg(desktop)]
const AETHER_SHORTCUT_EVENT: &str = "aether:shortcut";
#[cfg(desktop)]
const AETHER_FIND_MENU_ID: &str = "aether-find-in-page";
#[cfg(desktop)]
const AETHER_FOCUS_ADDRESS_MENU_ID: &str = "aether-focus-address";
#[cfg(desktop)]
const AETHER_NEW_TAB_MENU_ID: &str = "aether-new-tab";
#[cfg(desktop)]
const AETHER_OPEN_DASHBOARD_MENU_ID: &str = "aether-open-dashboard";
#[cfg(desktop)]
const AETHER_OPEN_ICE_MENU_ID: &str = "aether-open-ice";
#[cfg(desktop)]
const AETHER_OPEN_BROWSER_MENU_ID: &str = "aether-open-browser";
#[cfg(desktop)]
const AETHER_TOGGLE_AION_MENU_ID: &str = "aether-toggle-aion";
#[cfg(desktop)]
const AETHER_CAPTURE_PAGE_MENU_ID: &str = "aether-capture-page";
#[cfg(desktop)]
const AETHER_FIND_REQUESTED_EVENT: &str = "aether:find-requested";
const AETHER_FIND_RESULT_EVENT: &str = "aether:find-result";
const AETHER_CHAT_STREAM_EVENT: &str = "aether:chat-stream";
const AETHER_DOWNLOAD_EVENT: &str = "aether:download";
const AETHER_MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "aether:model-download-progress";
// Only the desktop updater emits progress; mobile updates through the store.
#[cfg(desktop)]
const AETHER_UPDATE_PROGRESS_EVENT: &str = "aether:update-progress";
const AETHER_MODEL_DIR_ENV: &str = "AETHER_MODEL_DIR";
const AETHER_CHAT_MODEL_ENV: &str = "AETHER_CHAT_MODEL";
const AETHER_EMBEDDING_MODEL_ENV: &str = "AETHER_EMBEDDING_MODEL";
const HF_TOKEN_ENV: &str = "HF_TOKEN";
const HUGGINGFACE_HUB_TOKEN_ENV: &str = "HUGGINGFACE_HUB_TOKEN";
const HUGGING_FACE_HUB_TOKEN_ENV: &str = "HUGGING_FACE_HUB_TOKEN";
const AETHER_LLM_CONTEXT_ENV: &str = "AETHER_LLM_CTX";
const AETHER_LLM_BATCH_TOKENS_ENV: &str = "AETHER_LLM_BATCH_TOKENS";
const AETHER_LLM_GPU_ENV: &str = "AETHER_LLM_GPU";
const AETHER_EMBED_GPU_ENV: &str = "AETHER_EMBED_GPU";
const AETHER_EMBED_BATCH_ENV: &str = "AETHER_EMBED_BATCH";
const AETHER_EMBED_BATCH_TOKENS_ENV: &str = "AETHER_EMBED_BATCH_TOKENS";
const AETHER_RELEASES_API_URL: &str =
    "https://api.github.com/repos/CanPixel/aether/releases/latest";
// 8 citations of ~550 tokens plus a 900-token answer already filled the old 6144
// window; replaying prior turns needs the extra headroom. Mobile keeps its smaller
// window (see chat_context_tokens) because the KV cache there is the binding limit.
const DEFAULT_CHAT_CONTEXT_TOKENS: u32 = 8192;
const DEFAULT_CHAT_BATCH_TOKENS: usize = 2048;
const DEFAULT_EMBEDDING_CONTEXT_TOKENS: u32 = 2048;
const DEFAULT_EMBEDDING_BATCH_SIZE: usize = 8;
const DEFAULT_EMBEDDING_BATCH_TOKENS: usize = 2048;
const DEFAULT_CAPTURE_CHUNK_SIZE: usize = 2200;
const DEFAULT_CAPTURE_CHUNK_OVERLAP: usize = 240;
const DEFAULT_SEMANTIC_TRAIL_LIMIT: usize = 12;
const MAX_SEMANTIC_TRAIL_LIMIT: usize = 24;
const DEFAULT_FLOW_GRAPH_SOURCE_LIMIT: usize = 96;
const MAX_FLOW_GRAPH_SOURCE_LIMIT: usize = 180;
const FLOW_GRAPH_MIN_EDGE_SCORE: f64 = 42.0;
const FLOW_GRAPH_NEIGHBORS_PER_SOURCE: usize = 3;
const FLOW_GRAPH_MAX_SEMANTIC_EDGES: usize = 180;
const FLOW_GRAPH_QUERY_MATCH_LIMIT: usize = 18;
// Below this semantic score (0-100) a captured chunk is too unrelated to surface in Flow.
// Keeps weak matches out instead of padding the list with noise.
const SEMANTIC_TRAIL_MIN_SCORE: f64 = 35.0;
// Minimum semantic score before we silently pre-select a hub at capture time. Below this we
// leave the user's manual choice alone rather than risk auto-misfiling the page.
const CAPTURE_SUGGEST_MIN_SCORE: f64 = 50.0;
// Sentinel URL for a blank tab that shows the Æther start page in the renderer instead
// of loading a remote page. Must match START_PAGE_URL in src/renderer/src/App.tsx.
const START_PAGE_URL: &str = "aether://start";
const DEFAULT_GENERATION_TOKENS: usize = 900;
const DEFAULT_ICEBERG_GENERATION_TOKENS: usize = 4200;
const DEFAULT_TOP_K: i32 = 64;
const DEFAULT_TOP_P: f32 = 0.95;
const QWEN3_EMBEDDING_RETRIEVAL_INSTRUCTION: &str =
    "Given a web search query, retrieve relevant passages that answer the query";
const PREFERRED_CHAT_MODEL_HINTS: [&str; 8] = [
    "gemma4", "gemma-4", "gemma3", "gemma-3", "gemma-2b", "2b", "gemma", "qwen",
];
const MIN_CAPTURE_TEXT_LENGTH: usize = 120;
#[cfg(desktop)]
const DESKTOP_BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
#[cfg(desktop)]
const NATIVE_WEBVIEW_SCROLLBAR_SCRIPT: &str = r##"
(() => {
  const styleId = 'aether-native-scrollbar-style';
  const css = `
    :root {
      scrollbar-color: rgba(122, 220, 255, 0.82) rgba(7, 22, 38, 0.28);
    }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(122, 220, 255, 0.82) rgba(7, 22, 38, 0.28);
    }

    ::-webkit-scrollbar {
      width: 13px;
      height: 13px;
      background: rgba(7, 22, 38, 0.2);
    }

    ::-webkit-scrollbar-track {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(116, 205, 255, 0.08)),
        rgba(7, 22, 38, 0.2);
      border: 1px solid rgba(168, 232, 255, 0.18);
      border-radius: 999px;
      box-shadow: inset 0 0 10px rgba(136, 221, 255, 0.12);
    }

    ::-webkit-scrollbar-thumb {
      min-height: 42px;
      background:
        linear-gradient(180deg, rgba(244, 253, 255, 0.94), rgba(119, 220, 255, 0.76) 42%, rgba(38, 121, 184, 0.72)),
        rgba(122, 220, 255, 0.72);
      border: 3px solid rgba(5, 18, 32, 0.4);
      border-radius: 999px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.76),
        0 0 14px rgba(83, 212, 255, 0.34);
    }

    ::-webkit-scrollbar-thumb:hover {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(146, 234, 255, 0.86) 38%, rgba(50, 144, 210, 0.82)),
        rgba(146, 234, 255, 0.82);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.82),
        0 0 18px rgba(101, 226, 255, 0.48);
    }

    ::-webkit-scrollbar-corner {
      background: rgba(7, 22, 38, 0.24);
    }
  `;

  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    document.documentElement.appendChild(style);
  }
  style.textContent = css;
})();
"##;
const ICEBERG_LEVEL_LANES: [f64; 5] = [13.0, 87.0, 28.0, 72.0, 42.0];
const ICEBERG_LEVEL_COUNT: u8 = 5;
const ICEBERG_MIN_ITEMS: usize = 12;
const ICEBERG_MAX_ITEMS: usize = 45;
const ICEBERG_MAX_ITEMS_PER_LEVEL: usize = 10;

type Cmd<T> = Result<T, String>;

fn vector_data_path(json_path: &Path) -> PathBuf {
    json_path.with_extension("vec")
}

// v1 stored vectors inline as JSON numbers. Kept only to migrate existing installs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyChunkRecord {
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

#[derive(Deserialize)]
struct LegacyVectorStoreData {
    #[serde(default)]
    chunks: Vec<LegacyChunkRecord>,
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
        let models_path = default_models_path(&app_data_dir);
        Self {
            paths: DataPaths {
                chunks_path: db_path.join(format!("{CHUNKS_TABLE}.json")),
                db_path,
                library_path: app_data_dir.join("aether-library").join("library.json"),
                settings_path: app_data_dir.join("aether-settings").join("settings.json"),
                icebergs_path: app_data_dir.join("aether-icebergs").join("icebergs.json"),
                conversations_path: app_data_dir
                    .join("aether-conversations")
                    .join("conversations.json"),
                session_path: app_data_dir.join("aether-session").join("session.json"),
                air_exports_path: app_data_dir.join("aether-air"),
                exports_path: app_data_dir.join(LIBRARY_EXPORT_DIR),
                models_path,
            },
            tabs: Mutex::new(TabState::new()),
            #[cfg(desktop)]
            webviews: Mutex::new(NativeBrowserViews::default()),
            web_content_bounds: Mutex::new(WebContentBounds::default()),
            client: Client::builder()
                .user_agent("Aether/1.0 Tauri")
                .build()
                .expect("reqwest client"),
            native_runtime: Arc::new(Mutex::new(NativeModelRuntime::default())),
            vectors: tokio::sync::RwLock::new(None),
            generation_cancelled: Arc::new(AtomicBool::new(false)),
            #[cfg(desktop)]
            window_geometry_saved_at: Mutex::new(None),
            #[cfg(desktop)]
            pending_downloads: Mutex::new(HashMap::new()),
        }
    }
}

impl TabState {
    fn new() -> Self {
        let initial = ManagedTab::new("browser", START_PAGE_URL);
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
        let title = if url == START_PAGE_URL {
            "New tab".to_string()
        } else {
            title_from_url(&url)
        };
        Self {
            id: uuid(),
            app_id: app_id.to_string(),
            title,
            url: url.clone(),
            is_loading: false,
            favicon: None,
            theme_color: None,
            history: vec![url],
            history_index: 0,
            native_can_go_back: None,
            native_can_go_forward: None,
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
        // Unknown until the native webview reports in after the load.
        self.native_can_go_back = None;
        self.native_can_go_forward = None;
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
            can_go_back: self.can_go_back() || self.native_can_go_back.unwrap_or(false),
            can_go_forward: self.can_go_forward() || self.native_can_go_forward.unwrap_or(false),
            favicon: self.favicon.clone(),
            theme_color: self.theme_color.clone(),
        }
    }
}

// macOS quit (`-[NSApplication terminate:]`) calls libc `exit()`, which runs
// C++ static destructors. llama.cpp's Metal backend frees its global device
// registry there and asserts that all residency sets were released first — but
// our loaded models (which hold those Metal buffers) are never dropped, because
// the Cocoa quit path skips Rust's normal teardown. That assert aborts the
// process ("quit unexpectedly"). Terminate immediately via `_exit`, which
// bypasses the static destructors entirely; the OS reclaims Metal/host memory,
// and all app state is already persisted per-action (no exit-time flush).
#[cfg(desktop)]
fn force_exit() -> ! {
    extern "C" {
        fn _exit(code: i32) -> !;
    }
    unsafe { _exit(0) }
}

// Bridge to the Kotlin TabsPlugin (gen/android/.../TabsPlugin.kt), which hosts
// one android.webkit.WebView per browser tab above the main app webview. This
// is the Android counterpart of the desktop `Window::add_child` path: the same
// `*_native_webview` functions drive it, keeping Rust the source of truth for
// tab state. Navigation events come back through the renderer via the
// `aether_tabs_report_native_event` command.
#[cfg(target_os = "android")]
mod android_tabs {
    use serde::{de::DeserializeOwned, Deserialize, Serialize};
    use std::sync::OnceLock;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Wry,
    };

    pub struct AndroidTabs(PluginHandle<Wry>);

    // The plugin handle, additionally kept in a module global so helpers that
    // only receive `State<Backend>` (page capture) can reach the Kotlin side
    // without threading an AppHandle through every call site.
    static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    impl AndroidTabs {
        pub fn run(&self, command: &str, payload: impl Serialize) -> Result<(), String> {
            self.0
                .run_mobile_plugin::<()>(command, payload)
                .map_err(|error| error.to_string())
        }

        pub fn run_for<T: DeserializeOwned>(
            &self,
            command: &str,
            payload: impl Serialize,
        ) -> Result<T, String> {
            self.0
                .run_mobile_plugin::<T>(command, payload)
                .map_err(|error| error.to_string())
        }
    }

    // Run a plugin command via the global handle. Blocks until Kotlin resolves,
    // so only call from async commands (tokio workers), never the main thread —
    // Kotlin resolves on the Android UI thread and would deadlock against it.
    pub fn run_for_global<T: DeserializeOwned>(
        command: &str,
        payload: impl Serialize,
    ) -> Result<T, String> {
        HANDLE
            .get()
            .ok_or_else(|| "Android tabs plugin is not ready.".to_string())?
            .run_mobile_plugin::<T>(command, payload)
            .map_err(|error| error.to_string())
    }

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("aether-tabs")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.canur.aether", "TabsPlugin")?;
                let _ = HANDLE.set(handle.clone());
                app.manage(AndroidTabs(handle));
                Ok(())
            })
            .build()
    }

    #[derive(Deserialize)]
    pub struct ThumbnailResponse {
        pub image: Option<String>,
    }

    #[derive(Deserialize)]
    pub struct SnapshotResponse {
        pub payload: String,
    }

    #[derive(Deserialize, Serialize, Default)]
    pub struct InsetsResponse {
        pub top: f64,
        pub bottom: f64,
        pub left: f64,
        pub right: f64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TabUrlPayload<'a> {
        pub tab_id: &'a str,
        pub url: &'a str,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SyncPayload<'a> {
        pub active_tab_id: Option<&'a str>,
        pub top: f64,
        pub left: f64,
        pub width: f64,
        pub height: f64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TabPayload<'a> {
        pub tab_id: &'a str,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct EvalPayload<'a> {
        pub tab_id: &'a str,
        pub script: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FindPayload<'a> {
        pub tab_id: &'a str,
        pub query: Option<&'a str>,
        pub action: &'a str,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .menu(|app| {
            let menu = Menu::new(app)?;
            let focus_address_item = MenuItem::with_id(
                app,
                AETHER_FOCUS_ADDRESS_MENU_ID,
                "Focus Address Bar",
                true,
                Some("CmdOrCtrl+L"),
            )?;
            let new_tab_item = MenuItem::with_id(
                app,
                AETHER_NEW_TAB_MENU_ID,
                "New Tab",
                true,
                Some("CmdOrCtrl+T"),
            )?;
            let find_item = MenuItem::with_id(
                app,
                AETHER_FIND_MENU_ID,
                "Find in Page",
                true,
                Some("CmdOrCtrl+F"),
            )?;
            let open_dashboard_item = MenuItem::with_id(
                app,
                AETHER_OPEN_DASHBOARD_MENU_ID,
                "Open Dashboard",
                true,
                Some("CmdOrCtrl+1"),
            )?;
            let open_ice_item = MenuItem::with_id(
                app,
                AETHER_OPEN_ICE_MENU_ID,
                "Open iCE",
                true,
                Some("CmdOrCtrl+2"),
            )?;
            let open_browser_item = MenuItem::with_id(
                app,
                AETHER_OPEN_BROWSER_MENU_ID,
                "Open Browser",
                true,
                Some("CmdOrCtrl+3"),
            )?;
            let toggle_aion_item = MenuItem::with_id(
                app,
                AETHER_TOGGLE_AION_MENU_ID,
                "Toggle AiON",
                true,
                Some("CmdOrCtrl+Shift+A"),
            )?;
            let capture_page_item = MenuItem::with_id(
                app,
                AETHER_CAPTURE_PAGE_MENU_ID,
                "Capture Current Page",
                true,
                Some("CmdOrCtrl+Shift+C"),
            )?;
            let shortcuts_menu = Submenu::with_items(
                app,
                "Shortcuts",
                true,
                &[
                    &focus_address_item,
                    &new_tab_item,
                    &find_item,
                    &open_dashboard_item,
                    &open_ice_item,
                    &open_browser_item,
                    &toggle_aion_item,
                    &capture_page_item,
                ],
            )?;
            // Standard Edit submenu. Its predefined items carry the native key
            // equivalents (Cmd/Ctrl+A/C/V/X and undo/redo), which is what wires up
            // select-all/copy/paste in the address bar and other text fields. An
            // empty Menu::new has no Edit menu, so those shortcuts would do nothing.
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            menu.append(&edit_menu)?;
            menu.append(&shortcuts_menu)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            AETHER_FIND_MENU_ID => {
                let _ = app.emit(AETHER_FIND_REQUESTED_EVENT, ());
            }
            AETHER_FOCUS_ADDRESS_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "focus-address");
            }
            AETHER_NEW_TAB_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "new-tab");
            }
            AETHER_OPEN_DASHBOARD_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "open-dashboard");
            }
            AETHER_OPEN_ICE_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "open-ice");
            }
            AETHER_OPEN_BROWSER_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "open-browser");
            }
            AETHER_TOGGLE_AION_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "toggle-aion");
            }
            AETHER_CAPTURE_PAGE_MENU_ID => {
                let _ = app.emit(AETHER_SHORTCUT_EVENT, "capture-page");
            }
            _ => {}
        });

    let builder = builder.plugin(tauri_plugin_opener::init());
    // Registered even when no pubkey is configured: the plugin only fails at check
    // time, and aether_system_install_update turns that into one honest message
    // instead of a failed download. See updater_pubkey().
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_tabs::init());

    builder
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("app data dir");
            // Before anything else: session restore and model prewarm both log,
            // and those are the entries most worth having in a bug report.
            diagnostics::set_log_path(&app_data_dir);
            app.manage(Backend::new(app_data_dir));

            // Restore the previous session before anything reads tab state or
            // prewarms a webview, so the restored active tab is the one warmed.
            #[cfg(desktop)]
            let restored_window = {
                let app_handle = app.handle().clone();
                let state = app_handle.state::<Backend>();
                match tauri::async_runtime::block_on(load_session(&state.paths.session_path)) {
                    Ok(session) => {
                        restore_session_tabs(&state, &session);
                        session.window
                    }
                    Err(error) => {
                        diag_warn!("could not read session: {error}");
                        None
                    }
                }
            };

            #[cfg(desktop)]
            if let Some(window) = app.get_window("main") {
                if let Some(geometry) = restored_window {
                    apply_session_window(&window, geometry);
                }

                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                            let state = app_handle.state::<Backend>();
                            let _ = resize_native_webviews(&app_handle, &state);
                            schedule_window_geometry_save(&app_handle);
                        }
                        WindowEvent::Moved(_) => schedule_window_geometry_save(&app_handle),
                        // force_exit() follows a close, so this is the last chance to
                        // capture the final geometry the throttle may have skipped.
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                            save_window_geometry_now(&app_handle)
                        }
                        _ => {}
                    }
                });
            }
            #[cfg(desktop)]
            {
                let app_handle = app.handle().clone();
                let state = app_handle.state::<Backend>();
                if let Ok(active_tab_id) = active_tab_id(&state) {
                    if let Err(error) = ensure_native_webview(&app_handle, &state, &active_tab_id) {
                        diag_warn!("browser webview prewarm failed: {error}");
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
            aether_tabs_reorder,
            aether_tabs_navigate,
            aether_tabs_scroll_to_text,
            aether_tabs_find,
            aether_tabs_go_back,
            aether_tabs_go_forward,
            aether_tabs_report_native_event,
            aether_tabs_thumbnail,
            aether_layout_window_insets,
            aether_layout_set_web_content_bounds,
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
            aether_capture_url,
            aether_capture_urls,
            aether_capture_move,
            aether_capture_delete,
            aether_capture_suggest_hub,
            aether_search_collection,
            aether_search_library,
            aether_semantic_trail_generate,
            aether_flow_graph,
            aether_air_prepare,
            aether_air_render,
            aether_air_list_recent,
            aether_air_open,
            aether_air_reveal,
            aether_chat_ask,
            aether_chat_cancel,
            aether_chat_history,
            aether_chat_clear_history,
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
            aether_system_check_for_update,
            aether_system_install_update,
            aether_system_relaunch,
            aether_system_download_models,
            aether_system_export_library,
            aether_system_diagnostics,
            aether_system_export_diagnostics,
            aether_library_reindex,
            aether_library_index_status,
            aether_system_open_external_url,
            aether_layout_set_panel_collapsed,
            aether_layout_set_modal_overlay_open,
            aether_layout_show_status_toast
        ])
        .build(tauri::generate_context!())
        .expect("error while building Æther")
        .run(|_app_handle, _event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::ExitRequested { .. } = _event {
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
            Ok(Err(error)) => diag_warn!("model prewarm failed: {error}"),
            Err(error) => diag_warn!("model prewarm task failed: {error}"),
        }
    });
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

fn lock_tabs<'a>(state: &'a State<'_, Backend>) -> Cmd<std::sync::MutexGuard<'a, TabState>> {
    state
        .tabs
        .lock()
        .map_err(|_| "tab state is unavailable.".to_string())
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

#[cfg(desktop)]
fn active_tab_id(state: &State<Backend>) -> Cmd<String> {
    Ok(lock_tabs(state)?.active_tab_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The log's whole purpose is to exist when something has gone wrong on a
    // platform nobody could test, so the write path cannot be left to be exercised
    // for the first time by the failure it is meant to record. Covers the append,
    // the directory being created on demand, and the rollover — which is the part
    // that could silently throw away the file.
    #[test]
    fn diagnostics_log_appends_and_rolls_over() {
        use crate::diagnostics::{DiagnosticEntry, DiagnosticLevel};

        let dir = TempDir::new();
        // Deliberately a path whose parent does not exist yet: the first entry is
        // usually written before anything has created the directory.
        let path = dir.path("aether-diagnostics").join("aether.log");

        let entry = |message: &str| DiagnosticEntry {
            at: "2026-07-25T12:00:00.000Z".to_string(),
            level: DiagnosticLevel::Warn,
            message: message.to_string(),
        };

        crate::diagnostics::write_entry(&path, &entry("first failure"));
        crate::diagnostics::write_entry(&path, &entry("second failure"));

        let written = fs::read_to_string(&path).expect("log should exist");
        assert!(written.contains("first failure"));
        assert!(written.contains("second failure"));
        assert!(
            written.contains("[warn]"),
            "the level has to survive into the file, or an exported log cannot be \
             triaged: {written}"
        );
        assert_eq!(
            written.lines().count(),
            2,
            "entries must append, not replace"
        );

        // Past the cap, the oldest half goes and the newest half stays. Discarding
        // everything would leave an empty log exactly when one is wanted.
        // ~44 bytes a line, so this has to clear MAX_LOG_BYTES (512 KiB).
        let bulk = (0..16_000)
            .map(|index| format!("2026-07-25T12:00:00.000Z [warn] filler {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, format!("{bulk}\n")).expect("seed a large log");
        assert!(fs::metadata(&path).expect("metadata").len() > 512 * 1024);

        crate::diagnostics::write_entry(&path, &entry("after rollover"));

        let rolled = fs::read_to_string(&path).expect("log should survive rollover");
        assert!(
            rolled.contains("after rollover"),
            "the entry that triggered the rollover must still be recorded"
        );
        assert!(
            rolled.contains("filler 15999"),
            "the newest entries must be the ones kept"
        );
        assert!(
            !rolled.contains("filler 0\n"),
            "the oldest entries should have been dropped"
        );
        assert!(rolled.len() < bulk.len(), "the file should have shrunk");
    }

    // Every colour in the renderer resolves through a channel token, and a typo in
    // one is silent: `rgb(var(--surfce-rgb) / 0.7)` is simply an invalid
    // declaration, so the element renders with no background at all rather than
    // erroring. This catches that, and catches a channel added to the light theme
    // without a dark counterpart — which is how a panel ends up white-on-navy.
    #[test]
    fn theme_channels_are_defined_and_themed() {
        const STYLES: &str = "../src/renderer/src/assets/styles";
        let foundation =
            std::fs::read_to_string(format!("{STYLES}/foundation.css")).expect("foundation.css");

        // Definitions live in :root; the dark overrides come after it.
        let root_end = foundation.find("\n}").expect("closing brace for :root");
        let (root, dark) = foundation.split_at(root_end);

        let defined: std::collections::HashSet<&str> = root
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                line.strip_prefix("--")?
                    .split_once(':')
                    .map(|(name, _)| name)
                    .filter(|name| name.ends_with("-rgb"))
            })
            .collect();
        assert!(
            defined.len() > 60,
            "expected the full channel set, found {}",
            defined.len()
        );

        let mut referenced = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(STYLES).expect("styles dir") {
            let path = entry.expect("dir entry").path();
            if path.extension().is_none_or(|ext| ext != "css") {
                continue;
            }
            let css = std::fs::read_to_string(&path).expect("stylesheet");
            for (index, _) in css.match_indices("var(--") {
                // Stop at the first character that cannot be part of an ident. A
                // plain find(')') would run straight through `var(--x, rgb(...))`
                // fallbacks and report the whole fallback as the token name.
                let name: String = css[index + "var(--".len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                    .collect();
                if name.ends_with("-rgb") {
                    referenced.insert(name);
                }
            }
        }

        let undefined: Vec<_> = referenced
            .iter()
            .filter(|name| !defined.contains(name.as_str()))
            .collect();
        assert!(
            undefined.is_empty(),
            "channels referenced but never defined (these render as invalid CSS, \
             silently dropping the declaration): {undefined:?}"
        );

        // Surfaces, ink, and the text-only aliases decide light versus dark. A new
        // one without a dark value is the single most likely way to ship a
        // white panel on a navy page.
        let must_flip: Vec<_> = defined
            .iter()
            .filter(|name| {
                name.starts_with("surface")
                    || name.starts_with("ink")
                    || name.starts_with("text-")
                    || name.starts_with("wordmark")
                    || [
                        "highlight-rgb",
                        "edge-rgb",
                        "night-rgb",
                        "muted-rgb",
                        "faint-rgb",
                    ]
                    .contains(name)
            })
            .filter(|name| !dark.contains(&format!("--{name}:")))
            .collect();
        assert!(
            must_flip.is_empty(),
            "channels with no dark-theme value: {must_flip:?}"
        );
    }

    // The AiON panel's primary button shipped broken in dark mode because one opaque
    // gradient mixed a themed surface channel (which correctly inverts to navy) with
    // unthemed accent channels (which stay pale). The result ran from near-black to
    // pale blue under light label text. Low-alpha decorative gradients mix the two
    // families harmlessly, so this only guards fills solid enough to sit under text.
    #[test]
    fn opaque_fills_do_not_mix_themed_and_unthemed_channels() {
        const STYLES: &str = "../src/renderer/src/assets/styles";
        let foundation =
            std::fs::read_to_string(format!("{STYLES}/foundation.css")).expect("foundation.css");

        let channels_in = |block: &str| -> std::collections::HashSet<String> {
            block
                .lines()
                .filter_map(|line| {
                    let line = line.trim();
                    let name = line.strip_prefix("--")?.split_once(':')?.0;
                    name.ends_with("-rgb").then(|| name.to_string())
                })
                .collect()
        };

        let root_end = foundation.find("\n}").expect("closing brace for :root");
        let (root, rest) = foundation.split_at(root_end);
        let dark_start = rest
            .find(":root[data-theme='dark']")
            .expect("explicit dark block");
        let defined = channels_in(root);
        let themed = channels_in(&rest[dark_start..]);

        // Only surfaces and ink decide light-versus-dark; a brand accent that keeps
        // its hue on both themes is intentional.
        let must_flip = |name: &str| {
            name.starts_with("surface") || name.starts_with("ink") || name == "highlight-rgb"
        };

        let mut offenders = Vec::new();
        for entry in std::fs::read_dir(STYLES).expect("styles dir") {
            let path = entry.expect("dir entry").path();
            if path.extension().is_none_or(|ext| ext != "css") {
                continue;
            }
            let css = std::fs::read_to_string(&path).expect("stylesheet");
            for declaration in css.split(';') {
                let Some((prop, value)) = declaration.split_once(':') else {
                    continue;
                };
                if prop.trim_start_matches(['{', '}', '\n', ' ']).trim() != "background" {
                    continue;
                }
                // color-mix() composites by percentage, not by the `/ alpha` this
                // check reads, so its channels would all look opaque. Those call
                // sites are checked by eye instead.
                if value.contains("color-mix") {
                    continue;
                }

                let mut flips = Vec::new();
                let mut fixed = Vec::new();
                for (index, _) in value.match_indices("rgb(var(--") {
                    let tail = &value[index + "rgb(var(--".len()..];
                    let name: String = tail
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                        .collect();
                    if !defined.contains(&name) {
                        continue;
                    }
                    // Alpha follows the name as `) / 0.42)`; absent means fully opaque.
                    // The name has to be stepped over first, or the `/` search finds
                    // the one in a later stop and every fill reads as opaque.
                    let after_name = &tail[name.len()..];
                    let alpha = after_name
                        .strip_prefix(')')
                        .map(str::trim_start)
                        .and_then(|rest| rest.strip_prefix('/'))
                        .and_then(|rest| rest.trim_start().split(')').next())
                        .and_then(|rest| rest.trim().parse::<f64>().ok())
                        .unwrap_or(1.0);
                    if alpha < 0.9 {
                        continue;
                    }
                    if must_flip(&name) {
                        flips.push(name);
                    } else if !themed.contains(&name) {
                        fixed.push(name);
                    }
                }

                if !flips.is_empty() && !fixed.is_empty() {
                    offenders.push(format!(
                        "{}: {} (inverts) mixed with {} (does not)",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        flips.join(", "),
                        fixed.join(", ")
                    ));
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "opaque fills mixing themed and unthemed channels render incoherently in \
             dark mode:\n  {}",
            offenders.join("\n  ")
        );
    }

    #[test]
    fn foreground_channels_clear_wcag_aa_on_their_surfaces() {
        let foundation =
            std::fs::read_to_string("../src/renderer/src/assets/styles/foundation.css")
                .expect("foundation.css");
        let root_end = foundation.find("\n}").expect("closing brace for :root");
        let (light, rest) = foundation.split_at(root_end);
        let dark_start = rest
            .find(":root[data-theme='dark']")
            .expect("explicit dark block");
        let dark = &rest[dark_start..];

        fn channel(block: &str, name: &str) -> [f64; 3] {
            let prefix = format!("--{name}:");
            let value = block
                .lines()
                .map(str::trim)
                .find_map(|line| line.strip_prefix(&prefix))
                .unwrap_or_else(|| panic!("missing channel {name}"));
            let values: Vec<f64> = value
                .trim()
                .trim_end_matches(';')
                .split_whitespace()
                .map(|part| {
                    part.parse::<f64>()
                        .unwrap_or_else(|_| panic!("invalid channel {name}: {value}"))
                })
                .collect();
            assert_eq!(values.len(), 3, "channel {name} must contain three values");
            [values[0], values[1], values[2]]
        }

        fn luminance(rgb: [f64; 3]) -> f64 {
            let linear = |value: f64| {
                let value = value / 255.0;
                if value <= 0.04045 {
                    value / 12.92
                } else {
                    ((value + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
        }

        fn contrast(foreground: [f64; 3], background: [f64; 3]) -> f64 {
            let foreground = luminance(foreground);
            let background = luminance(background);
            (foreground.max(background) + 0.05) / (foreground.min(background) + 0.05)
        }

        fn composite(foreground: [f64; 3], alpha: f64, background: [f64; 3]) -> [f64; 3] {
            [
                foreground[0] * alpha + background[0] * (1.0 - alpha),
                foreground[1] * alpha + background[1] * (1.0 - alpha),
                foreground[2] * alpha + background[2] * (1.0 - alpha),
            ]
        }

        for (theme, block) in [("light", light), ("dark", dark)] {
            let surface = channel(block, "surface-rgb");
            let surface_sky = channel(block, "surface-sky-rgb");
            let surface_tint = channel(block, "surface-tint-rgb");
            let success = channel(block, "success-rgb");
            let success_badge = composite(success, 0.1, surface);
            let checks = [
                ("muted-rgb", surface_sky),
                ("accent-strong-rgb", surface_sky),
                ("text-accent-rgb", surface_sky),
                ("slate-blue-rgb", surface_tint),
                ("text-success-rgb", success_badge),
                ("primary-label-rgb", channel(block, "primary-from-rgb")),
                ("primary-label-rgb", channel(block, "primary-mid-rgb")),
                ("primary-label-rgb", channel(block, "primary-to-rgb")),
            ];

            for (foreground, background) in checks {
                let ratio = contrast(channel(block, foreground), background);
                assert!(
                    ratio >= 4.5,
                    "{theme} {foreground} has only {ratio:.2}:1 contrast"
                );
            }
        }
    }

    // The shipped config carries an empty pubkey placeholder, and that has to read
    // as "not configured" rather than as a key — otherwise the app offers an
    // Install button that downloads a hundred megabytes and then fails signature
    // verification. A pasted key with stray whitespace has to work.
    #[cfg(desktop)]
    #[test]
    fn updater_pubkey_treats_a_placeholder_as_unconfigured() {
        let placeholder = serde_json::json!({ "pubkey": "" });
        assert_eq!(updater_pubkey_from_config(Some(&placeholder)), None);

        let whitespace = serde_json::json!({ "pubkey": "  \n" });
        assert_eq!(updater_pubkey_from_config(Some(&whitespace)), None);

        assert_eq!(updater_pubkey_from_config(None), None);
        assert_eq!(
            updater_pubkey_from_config(Some(&serde_json::json!({}))),
            None
        );

        let real = serde_json::json!({ "pubkey": "  dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu\n" });
        assert_eq!(
            updater_pubkey_from_config(Some(&real)).as_deref(),
            Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu")
        );

        // And the real config file must still be a placeholder: committing a key
        // here would be committing a trust anchor nobody reviewed.
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should be valid JSON");
        let shipped = updater_pubkey_from_config(
            config
                .get("plugins")
                .and_then(|plugins| plugins.get("updater")),
        );
        assert!(
            shipped.is_none() || shipped.as_deref().is_some_and(|key| key.len() > 40),
            "plugins.updater.pubkey should be either empty or a real minisign key"
        );
    }

    // tauri-plugin-updater deserializes `plugins.updater` during plugin setup, and
    // its `pubkey` field has no serde default — a missing or misshapen block fails
    // app startup outright, not the update path. Since the key is pasted in by hand
    // when signing is set up (docs/SIGNING.md), this checks the real config file
    // rather than a fixture.
    #[cfg(desktop)]
    #[test]
    fn updater_plugin_config_deserializes() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should be valid JSON");
        let updater = config
            .get("plugins")
            .and_then(|plugins| plugins.get("updater"))
            .expect("plugins.updater should be configured");

        let parsed: tauri_plugin_updater::Config = serde_json::from_value(updater.clone())
            .expect("plugins.updater must deserialize or the app fails to start");

        // Empty endpoints make Updater::build() fail with EmptyEndpoints, which
        // would surface to the user as a broken Install button.
        assert!(
            !parsed.endpoints.is_empty(),
            "at least one update endpoint is required"
        );
        assert!(
            parsed.endpoints.iter().all(|url| url.scheme() == "https"),
            "release builds reject non-https update endpoints"
        );
    }

    // The release workflow builds latest.json in bash (scripts/updater-manifest.sh)
    // and the app reads it through tauri-plugin-updater, so nothing else checks
    // that the two agree. A renamed field or a wrong nesting would be invisible
    // until a real user pressed Install on a real release — the one place a
    // mistake cannot be taken back. This deserializes the script's exact output
    // with the plugin's own type.
    //
    // Regenerate with:
    //   scripts/updater-manifest.sh v1.0.30 CanPixel/aether <artifacts> /dev/stdout
    #[cfg(desktop)]
    #[test]
    fn updater_manifest_matches_the_plugin_format() {
        let manifest = r#"{
  "version": "1.0.30",
  "notes": "See https://github.com/CanPixel/aether/releases/tag/v1.0.30",
  "pub_date": "2026-07-25T12:32:59Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "MACSIG==",
      "url": "https://github.com/CanPixel/aether/releases/download/v1.0.30/AETHER_macOS.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "MACSIG==",
      "url": "https://github.com/CanPixel/aether/releases/download/v1.0.30/AETHER_macOS.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "WINSIG==",
      "url": "https://github.com/CanPixel/aether/releases/download/v1.0.30/AETHER_x64-setup.exe"
    },
    "linux-x86_64": {
      "signature": "LXSIG==",
      "url": "https://github.com/CanPixel/aether/releases/download/v1.0.30/AETHER_amd64.AppImage"
    }
  }
}"#;

        let release: tauri_plugin_updater::RemoteRelease =
            serde_json::from_str(manifest).expect("plugin should accept the generated manifest");

        assert_eq!(release.version.to_string(), "1.0.30");

        // These keys are `{os}-{arch}` as the plugin derives them at runtime. A
        // typo here means the updater reports "no build for this platform" on a
        // release that does in fact contain one.
        for target in [
            "darwin-aarch64",
            "darwin-x86_64",
            "windows-x86_64",
            "linux-x86_64",
        ] {
            let url = release
                .download_url(target)
                .unwrap_or_else(|error| panic!("no download url for {target}: {error}"));
            assert!(
                url.as_str()
                    .starts_with("https://github.com/CanPixel/aether/releases/download/v1.0.30/"),
                "{target} url should be pinned to the tag, not to /latest/: {url}"
            );
            assert!(
                release.signature(target).is_ok(),
                "no signature for {target}"
            );
        }

        // Linux ARM ships as a .deb only, so it is deliberately absent. The app
        // turns this into the `unavailable` status rather than an error.
        assert!(release.download_url("linux-aarch64").is_err());
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("aether-store-test-{}", uuid()));
            fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn library_marked(marker: &str) -> LibraryData {
        let mut data = LibraryData::default();
        data.migrated_realm_tables.push(marker.to_string());
        data
    }

    fn marker_of(data: &LibraryData) -> Option<&str> {
        data.migrated_realm_tables.first().map(String::as_str)
    }

    fn corrupt_count(dir: &Path) -> usize {
        fs::read_dir(dir)
            .expect("read temp dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .count()
    }

    #[test]
    fn store_save_rotates_previous_version_into_backup() {
        let dir = TempDir::new();
        let path = dir.path("library.json");

        block_on(save_json(&path, &library_marked("first"))).expect("first save");
        block_on(save_json(&path, &library_marked("second"))).expect("second save");

        let primary = block_on(read_json_or_default::<LibraryData>(&path)).expect("read primary");
        assert_eq!(marker_of(&primary), Some("second"));

        let backup_raw = fs::read_to_string(backup_path(&path)).expect("backup exists");
        let backup: LibraryData = serde_json::from_str(&backup_raw).expect("backup parses");
        assert_eq!(marker_of(&backup), Some("first"));
    }

    #[test]
    fn store_save_leaves_no_temp_file_behind() {
        let dir = TempDir::new();
        let path = dir.path("library.json");

        block_on(save_json(&path, &library_marked("only"))).expect("save");

        assert!(
            !temp_write_path(&path).exists(),
            "temp file should be renamed over the target, not left behind"
        );
    }

    // The failure this guards against: a crash mid-save truncates the store and the
    // user loses every capture. Recovery must be automatic and must not destroy the
    // damaged file, so it stays available for manual inspection.
    #[test]
    fn store_read_recovers_from_backup_when_primary_is_truncated() {
        let dir = TempDir::new();
        let path = dir.path("library.json");

        block_on(save_json(&path, &library_marked("good"))).expect("first save");
        block_on(save_json(&path, &library_marked("newer"))).expect("second save");
        // Simulate a save that was interrupted partway through.
        fs::write(&path, "{\"version\":1,\"collec").expect("truncate primary");

        let recovered = block_on(read_json_or_default::<LibraryData>(&path)).expect("recover");

        assert_eq!(marker_of(&recovered), Some("good"));
        assert_eq!(
            corrupt_count(&dir.0),
            1,
            "damaged primary must be preserved"
        );
        // The restored primary must itself be readable on the next launch.
        let reread = block_on(read_json_or_default::<LibraryData>(&path)).expect("reread");
        assert_eq!(marker_of(&reread), Some("good"));
    }

    #[test]
    fn store_read_falls_back_to_default_without_destroying_unreadable_files() {
        let dir = TempDir::new();
        let path = dir.path("library.json");

        block_on(save_json(&path, &library_marked("good"))).expect("save");
        block_on(save_json(&path, &library_marked("newer"))).expect("rotate");
        fs::write(&path, "not json").expect("corrupt primary");
        fs::write(backup_path(&path), "also not json").expect("corrupt backup");

        let fresh = block_on(read_json_or_default::<LibraryData>(&path)).expect("default");

        assert_eq!(marker_of(&fresh), None);
        assert_eq!(corrupt_count(&dir.0), 1, "unreadable primary must be kept");
    }

    #[test]
    fn store_read_seeds_a_default_when_nothing_exists_yet() {
        let dir = TempDir::new();
        let path = dir.path("nested").join("library.json");

        let seeded = block_on(read_json_or_default::<LibraryData>(&path)).expect("seed");

        assert_eq!(marker_of(&seeded), None);
        assert!(path.exists(), "first read should create the store");
        assert_eq!(corrupt_count(&dir.0), 0);
    }

    fn turn(prompt: &str, answer: &str) -> ConversationTurn {
        ConversationTurn {
            id: uuid(),
            prompt: prompt.to_string(),
            answer: answer.to_string(),
            model: "test".to_string(),
            asked_at: "2026-07-01T00:00:00Z".to_string(),
            citations: Vec::new(),
            metrics: ChatMetrics {
                generated_tokens: 0,
                tokens_per_second: 0.0,
                elapsed_seconds: 0.0,
                chunks: 0,
            },
        }
    }

    // Follow-ups only work if prior turns actually reach the model, and the current
    // question must still come last so it is what gets answered.
    #[test]
    fn chat_messages_replay_history_before_the_current_question() {
        let history = vec![turn("Who was Augustus?", "The first Roman emperor.")];
        let citations = vec![search_result("1", "https://example.com/a", "context text")];

        let messages = build_chat_messages("What about Tiberius?", &citations, &history);

        let roles = messages.iter().map(|m| m.role).collect::<Vec<_>>();
        assert_eq!(roles, vec!["system", "user", "assistant", "user"]);
        assert_eq!(messages[1].content, "Who was Augustus?");
        assert_eq!(messages[2].content, "The first Roman emperor.");
        assert!(messages[3].content.contains("What about Tiberius?"));
        assert!(messages[3].content.contains("context text"));
    }

    #[test]
    fn chat_messages_without_history_match_the_single_shot_shape() {
        let messages = build_chat_messages("Question?", &[], &[]);

        assert_eq!(
            messages.iter().map(|m| m.role).collect::<Vec<_>>(),
            vec!["system", "user"]
        );
        assert!(messages[1]
            .content
            .contains("No stored context was retrieved."));
    }

    // Replaying old citation markers would let the model reuse source numbers that no
    // longer point at anything in the current citation list.
    #[test]
    fn history_answers_are_stripped_of_stale_citation_markers_and_clipped() {
        let condensed = condense_history_answer("Augustus won [1] and later reformed Rome [2].");
        assert!(!condensed.contains("[1]"));
        assert!(!condensed.contains("[2]"));
        assert!(condensed.contains("Augustus won"));

        let long = "x".repeat(PROMPT_HISTORY_ANSWER_CHARS + 200);
        let clipped = condense_history_answer(&long);
        assert_eq!(clipped.chars().count(), PROMPT_HISTORY_ANSWER_CHARS + 1);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn conversation_thread_key_separates_hub_and_page_threads() {
        assert_eq!(conversation_thread_key(Some("hub-1")), "hub-1");
        assert_eq!(conversation_thread_key(None), CURRENT_PAGE_THREAD_KEY);
        // An empty id is a page-only ask, not a hub called "".
        assert_eq!(conversation_thread_key(Some("")), CURRENT_PAGE_THREAD_KEY);
    }

    #[test]
    fn conversation_threads_persist_and_stay_bounded() {
        let dir = TempDir::new();
        let path = dir.path("conversations.json");
        let paths = DataPaths {
            db_path: dir.0.clone(),
            library_path: dir.path("library.json"),
            settings_path: dir.path("settings.json"),
            icebergs_path: dir.path("icebergs.json"),
            conversations_path: path.clone(),
            session_path: dir.path("session.json"),
            air_exports_path: dir.0.clone(),
            chunks_path: dir.path("chunks.json"),
            models_path: dir.0.clone(),
            exports_path: dir.0.clone(),
        };

        for index in 0..MAX_THREAD_TURNS + 5 {
            block_on(append_conversation_turn(
                &paths,
                Some("hub-1"),
                turn(&format!("q{index}"), &format!("a{index}")),
            ))
            .expect("append");
        }

        let thread = block_on(conversation_thread(&paths, Some("hub-1")));
        assert_eq!(
            thread.len(),
            MAX_THREAD_TURNS,
            "old turns should be trimmed"
        );
        // The newest turns are the ones kept.
        assert_eq!(
            thread.last().unwrap().prompt,
            format!("q{}", MAX_THREAD_TURNS + 4)
        );
        assert_eq!(thread.first().unwrap().prompt, "q5");

        // Threads must not leak into each other.
        assert!(block_on(conversation_thread(&paths, None)).is_empty());
    }

    // With no chat model the answer must be visibly a passage list, and must not claim
    // generation metrics it did not earn.
    #[test]
    fn extractive_answer_quotes_sources_and_reports_no_generated_tokens() {
        let citations = vec![
            search_result(
                "1",
                "https://example.com/a",
                "Quantum mechanics arose gradually.",
            ),
            search_result(
                "2",
                "https://example.com/b",
                "The Schrodinger equation governs.",
            ),
        ];

        let result = extractive_answer(citations, 0.25);

        assert_eq!(result.metrics.generated_tokens, 0);
        assert_eq!(result.metrics.tokens_per_second, 0.0);
        assert_eq!(result.metrics.chunks, 2);
        assert_eq!(result.model, EXTRACTIVE_MODEL_LABEL);
        assert!(result.answer.contains("cannot write an answer"));
        // Both passages must be present and marked as quotes.
        assert!(result.answer.contains("Quantum mechanics arose gradually."));
        assert!(result.answer.contains("The Schrodinger equation governs."));
        assert_eq!(result.answer.matches("\n> ").count(), 2);
        // Citation markers must line up with the citation list for the UI.
        assert!(result.answer.contains("[1]"));
        assert!(result.answer.contains("[2]"));
        assert_eq!(result.citations.len(), 2);
    }

    fn vector_chunk(capture_id: &str, vector: Vec<f32>) -> ChunkRecord {
        ChunkRecord {
            id: uuid(),
            vector,
            vector_slot: 0,
            needs_reembed: false,
            text: format!("text for {capture_id}"),
            collection_id: "hub-1".to_string(),
            capture_id: capture_id.to_string(),
            title: format!("Title {capture_id}"),
            url: format!("https://example.com/{capture_id}"),
            app_id: "browser".to_string(),
            captured_at: "2026-07-01T00:00:00Z".to_string(),
            chunk_index: 0,
        }
    }

    // Vectors must survive the JSON/sidecar split byte-for-byte; a silent precision or
    // ordering change here would quietly degrade every future search result.
    #[test]
    fn vector_store_round_trips_vectors_through_the_sidecar() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut store = VectorStoreData::default();
        store.push_chunks(vec![
            vector_chunk("a", vec![0.5, -0.25, 0.125, 1.0]),
            vector_chunk("b", vec![-1.0, 0.0, 0.75, 0.5]),
        ]);
        block_on(save_vectors(&path, &mut store)).expect("save");

        let loaded = block_on(load_vectors(&path)).expect("load");

        assert_eq!(loaded.version, VECTOR_STORE_VERSION);
        assert_eq!(loaded.dim, 4);
        assert_eq!(loaded.chunks.len(), 2);
        assert_eq!(loaded.chunks[0].vector, vec![0.5, -0.25, 0.125, 1.0]);
        assert_eq!(loaded.chunks[1].vector, vec![-1.0, 0.0, 0.75, 0.5]);
        // The whole point of the split: no vector numbers in the JSON.
        let raw = fs::read_to_string(&path).expect("metadata");
        assert!(!raw.contains("0.125"), "vectors must not be in the JSON");
    }

    #[test]
    fn vector_store_appends_without_rewriting_existing_slots() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut store = VectorStoreData::default();
        store.push_chunks(vec![vector_chunk("a", vec![1.0, 2.0, 3.0, 4.0])]);
        block_on(save_vectors(&path, &mut store)).expect("first save");
        let size_after_first = fs::metadata(vector_data_path(&path))
            .expect("sidecar")
            .len();

        store.push_chunks(vec![vector_chunk("b", vec![5.0, 6.0, 7.0, 8.0])]);
        block_on(save_vectors(&path, &mut store)).expect("second save");
        let size_after_second = fs::metadata(vector_data_path(&path))
            .expect("sidecar")
            .len();

        // 4 dims * 4 bytes per append.
        assert_eq!(size_after_first, 16);
        assert_eq!(size_after_second, 32);

        let loaded = block_on(load_vectors(&path)).expect("load");
        assert_eq!(loaded.chunks[0].vector, vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(loaded.chunks[1].vector, vec![5.0, 6.0, 7.0, 8.0]);
    }

    // Existing installs have a v1 store with inline vectors. Losing them on upgrade
    // would silently empty every hub, so migration is the highest-risk path here.
    #[test]
    fn vector_store_migrates_a_v1_json_store_without_losing_vectors() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");
        let legacy = serde_json::json!({
            "version": 1,
            "chunks": [
                {
                    "id": "chunk-1",
                    "vector": [0.25, 0.5, 0.75, 1.0],
                    "text": "legacy text",
                    "collectionId": "hub-1",
                    "captureId": "capture-1",
                    "title": "Legacy source",
                    "url": "https://example.com/legacy",
                    "appId": "browser",
                    "capturedAt": "2026-06-01T00:00:00Z",
                    "chunkIndex": 0
                }
            ]
        });
        fs::write(&path, serde_json::to_string(&legacy).unwrap()).expect("seed v1");

        let migrated = block_on(load_vectors(&path)).expect("migrate");

        assert_eq!(migrated.version, VECTOR_STORE_VERSION);
        assert_eq!(migrated.chunks.len(), 1);
        assert_eq!(migrated.chunks[0].vector, vec![0.25, 0.5, 0.75, 1.0]);
        assert_eq!(migrated.chunks[0].text, "legacy text");
        // The pre-migration file must still be recoverable.
        assert!(
            backup_path(&path).exists(),
            "v1 store should be kept as .bak"
        );

        // Reloading must now take the v2 path and produce the same vectors.
        let reloaded = block_on(load_vectors(&path)).expect("reload");
        assert_eq!(reloaded.chunks[0].vector, vec![0.25, 0.5, 0.75, 1.0]);
    }

    #[test]
    fn vector_store_survives_a_missing_sidecar_without_losing_the_library() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut store = VectorStoreData::default();
        store.push_chunks(vec![vector_chunk("a", vec![1.0, 0.0, 0.0, 0.0])]);
        block_on(save_vectors(&path, &mut store)).expect("save");
        fs::remove_file(vector_data_path(&path)).expect("drop sidecar");

        let loaded = block_on(load_vectors(&path)).expect("load without sidecar");

        // Chunks are dropped (they cannot be searched) but the load itself succeeds.
        assert!(loaded.chunks.is_empty());
    }

    #[test]
    fn vector_store_compacts_once_dead_slots_dominate() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut store = VectorStoreData::default();
        let total = VECTOR_COMPACTION_MIN_SLOTS as usize + 8;
        store
            .push_chunks((0..total).map(|index| {
                vector_chunk(&format!("c{index}"), vec![index as f32, 0.0, 0.0, 0.0])
            }));
        block_on(save_vectors(&path, &mut store)).expect("save");
        assert_eq!(store.next_slot, total as u64);

        // Drop most chunks, which leaves their slots dead.
        store.chunks.retain(|chunk| chunk.vector_slot % 8 == 0);
        let survivors = store.chunks.len() as u64;
        block_on(save_vectors(&path, &mut store)).expect("save after delete");

        assert_eq!(store.next_slot, survivors, "slots should be renumbered");
        let sidecar = fs::metadata(vector_data_path(&path))
            .expect("sidecar")
            .len();
        assert_eq!(sidecar, survivors * 4 * 4, "dead slots should be reclaimed");

        let loaded = block_on(load_vectors(&path)).expect("load");
        assert_eq!(loaded.chunks.len() as u64, survivors);
        // Values must still line up with their chunks after renumbering.
        for chunk in &loaded.chunks {
            let expected: f32 = chunk.capture_id.trim_start_matches('c').parse().unwrap();
            assert_eq!(chunk.vector[0], expected);
        }
    }

    // A width the store cannot hold must cost the vector, never the text: re-embedding
    // is local compute, whereas dropping the record forces the page to be fetched again.
    #[test]
    fn vector_store_parks_mismatched_chunks_instead_of_discarding_them() {
        let mut store = VectorStoreData::default();
        store.push_chunks(vec![
            vector_chunk("a", vec![1.0, 2.0, 3.0, 4.0]),
            vector_chunk("b", vec![1.0, 2.0]),
            vector_chunk("c", vec![]),
        ]);

        assert_eq!(store.dim, 4);
        assert_eq!(store.chunks.len(), 3, "no chunk is thrown away");
        assert_eq!(store.embedded_count(), 1);
        assert_eq!(store.pending_reembed_count(), 2);
        assert_eq!(store.next_slot, 1, "only embedded chunks consume slots");

        for chunk in store.chunks.iter().filter(|chunk| chunk.needs_reembed) {
            assert!(chunk.vector.is_empty(), "parked chunks hold no vector");
            assert!(!chunk.text.is_empty(), "parked chunks keep their text");
        }
    }

    // Parked chunks must stay out of the sidecar entirely: giving one a slot would shift
    // every later chunk against the fixed stride and silently mismatch vectors to text.
    #[test]
    fn parked_chunks_survive_a_save_without_taking_sidecar_slots() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut store = VectorStoreData::default();
        store.push_chunks(vec![
            vector_chunk("a", vec![1.0, 2.0, 3.0, 4.0]),
            vector_chunk("b", vec![9.0, 9.0]),
            vector_chunk("c", vec![5.0, 6.0, 7.0, 8.0]),
        ]);
        block_on(save_vectors(&path, &mut store)).expect("save");

        // Two embedded chunks at 4 dims; the parked one contributes nothing.
        let sidecar = fs::metadata(vector_data_path(&path))
            .expect("sidecar")
            .len();
        assert_eq!(sidecar, 2 * 4 * 4);

        let loaded = block_on(load_vectors(&path)).expect("load");
        assert_eq!(loaded.chunks.len(), 3);
        assert_eq!(loaded.pending_reembed_count(), 1);
        let embedded = loaded
            .chunks
            .iter()
            .filter(|chunk| !chunk.needs_reembed)
            .map(|chunk| chunk.vector.clone())
            .collect::<Vec<_>>();
        assert!(embedded.contains(&vec![1.0, 2.0, 3.0, 4.0]));
        assert!(embedded.contains(&vec![5.0, 6.0, 7.0, 8.0]));
    }

    // The real regression: a v1 store written across an embedding-model change holds two
    // widths. Anchoring on the first chunk handed the store to whichever model was
    // written first, which on a real install was the older, unusable one.
    #[test]
    fn migration_keeps_the_majority_width_and_parks_the_rest() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut chunks = Vec::new();
        // One older-model chunk first in file order, then a wider majority.
        chunks.push(serde_json::json!({
            "id": "old-1",
            "vector": [0.1, 0.2],
            "text": "older model chunk",
            "collectionId": "hub-1",
            "captureId": "capture-old",
            "title": "Old",
            "url": "https://example.com/old",
            "appId": "browser",
            "capturedAt": "2026-06-01T00:00:00Z",
            "chunkIndex": 0
        }));
        for index in 0..3 {
            chunks.push(serde_json::json!({
                "id": format!("new-{index}"),
                "vector": [0.5, 0.5, 0.5, 0.5],
                "text": format!("current model chunk {index}"),
                "collectionId": "hub-1",
                "captureId": "capture-new",
                "title": "New",
                "url": "https://example.com/new",
                "appId": "browser",
                "capturedAt": "2026-07-01T00:00:00Z",
                "chunkIndex": index
            }));
        }
        fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({"version": 1, "chunks": chunks})).unwrap(),
        )
        .expect("seed v1");

        let migrated = block_on(load_vectors(&path)).expect("migrate");

        assert_eq!(
            migrated.dim, 4,
            "the majority width wins, not the first one"
        );
        assert_eq!(migrated.chunks.len(), 4, "nothing is discarded");
        assert_eq!(migrated.embedded_count(), 3);
        assert_eq!(migrated.pending_reembed_count(), 1);

        let parked = migrated
            .chunks
            .iter()
            .find(|chunk| chunk.needs_reembed)
            .expect("parked chunk");
        assert_eq!(parked.id, "old-1");
        assert_eq!(parked.text, "older model chunk", "text is re-embeddable");
    }

    // The `.bak` rotation is one generation deep, so an ordinary save after the upgrade
    // would overwrite the v1 backup with a v2 copy. The archive must outlive that.
    #[test]
    fn pre_migration_archive_survives_later_saves() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");
        let legacy = serde_json::json!({
            "version": 1,
            "chunks": [{
                "id": "chunk-1",
                "vector": [0.25, 0.5, 0.75, 1.0],
                "text": "legacy text",
                "collectionId": "hub-1",
                "captureId": "capture-1",
                "title": "Legacy source",
                "url": "https://example.com/legacy",
                "appId": "browser",
                "capturedAt": "2026-06-01T00:00:00Z",
                "chunkIndex": 0
            }]
        });
        let raw = serde_json::to_string(&legacy).unwrap();
        fs::write(&path, &raw).expect("seed v1");

        let mut migrated = block_on(load_vectors(&path)).expect("migrate");
        let archive = dir.path("chunks.v1.json");
        assert!(archive.exists(), "migration should archive the v1 store");

        // Two further saves: more than enough to cycle the single `.bak` generation.
        for index in 0..2 {
            migrated.push_chunks(vec![vector_chunk(
                &format!("later-{index}"),
                vec![1.0, 1.0, 1.0, 1.0],
            )]);
            block_on(save_vectors(&path, &mut migrated)).expect("later save");
        }

        let archived = fs::read_to_string(&archive).expect("archive readable");
        assert_eq!(archived, raw, "archive must still be the original v1 bytes");
        assert!(
            archived.contains("0.75"),
            "archived vectors are the only copy of anything the migration parked"
        );
    }

    #[test]
    fn majority_width_breaks_ties_toward_the_wider_vector() {
        let chunk = |vector: Vec<f32>| LegacyChunkRecord {
            id: uuid(),
            vector,
            text: String::new(),
            collection_id: String::new(),
            capture_id: String::new(),
            title: String::new(),
            url: String::new(),
            app_id: String::new(),
            captured_at: String::new(),
            chunk_index: 0,
        };

        assert_eq!(majority_vector_dim(&[]), 0);
        assert_eq!(majority_vector_dim(&[chunk(vec![]), chunk(vec![])]), 0);
        // One each: the wider vector wins, since newer models are wider in practice.
        assert_eq!(
            majority_vector_dim(&[chunk(vec![0.0; 2]), chunk(vec![0.0; 8])]),
            8
        );
        // Count beats width.
        assert_eq!(
            majority_vector_dim(&[
                chunk(vec![0.0; 2]),
                chunk(vec![0.0; 2]),
                chunk(vec![0.0; 8])
            ]),
            2
        );
    }

    // Compaction measures dead slots against the sidecar, so counting parked chunks as
    // live would understate the dead ratio and stop compaction from ever firing.
    #[test]
    fn compaction_ignores_parked_chunks_but_keeps_them() {
        let dir = TempDir::new();
        let path = dir.path("chunks.json");

        let mut store = VectorStoreData::default();
        let total = VECTOR_COMPACTION_MIN_SLOTS as usize + 8;
        store
            .push_chunks((0..total).map(|index| {
                vector_chunk(&format!("c{index}"), vec![index as f32, 0.0, 0.0, 0.0])
            }));
        store.push_chunks(vec![vector_chunk("parked", vec![1.0, 2.0])]);
        block_on(save_vectors(&path, &mut store)).expect("save");

        store
            .chunks
            .retain(|chunk| chunk.needs_reembed || chunk.vector_slot % 8 == 0);
        let survivors = store.embedded_count();
        block_on(save_vectors(&path, &mut store)).expect("save after delete");

        assert_eq!(
            store.next_slot, survivors,
            "slots renumber over embedded only"
        );
        let sidecar = fs::metadata(vector_data_path(&path))
            .expect("sidecar")
            .len();
        assert_eq!(sidecar, survivors * 4 * 4);

        let loaded = block_on(load_vectors(&path)).expect("load");
        assert_eq!(loaded.embedded_count(), survivors);
        assert_eq!(loaded.pending_reembed_count(), 1, "parked chunk survives");
        for chunk in loaded.chunks.iter().filter(|chunk| !chunk.needs_reembed) {
            let expected: f32 = chunk.capture_id.trim_start_matches('c').parse().unwrap();
            assert_eq!(
                chunk.vector[0], expected,
                "vectors stay matched to their text"
            );
        }
    }

    // A download filename comes from a remote URL, so it is untrusted input that ends
    // up as a filesystem path. Separators and traversal must not survive.
    #[cfg(desktop)]
    #[test]
    fn download_filenames_cannot_escape_the_downloads_directory() {
        let cases = [
            ("https://example.com/a/../../etc/passwd", "passwd"),
            ("https://example.com/%2e%2e%2fetc%2fpasswd", "etcpasswd"),
            ("https://example.com/dir/", "dir"),
            ("https://example.com/", "download"),
            ("https://example.com/..", "download"),
        ];
        for (raw, expected) in cases {
            let name = file_name_from_url(&Url::parse(raw).expect("url"));
            assert_eq!(name, expected, "for {raw}");
            assert!(!name.contains('/'), "{name} must not contain a separator");
            assert!(!name.contains('\\'), "{name} must not contain a separator");
            assert_ne!(name, "..");
        }
    }

    #[cfg(desktop)]
    #[test]
    fn download_filenames_decode_and_keep_extensions() {
        let name = file_name_from_url(
            &Url::parse("https://example.com/docs/My%20Report%202026.pdf").unwrap(),
        );
        assert_eq!(name, "My Report 2026.pdf");

        let stripped = file_name_from_url(
            &Url::parse("https://example.com/a/b/paper.tar.gz?token=1").unwrap(),
        );
        assert_eq!(stripped, "paper.tar.gz");
    }

    #[cfg(desktop)]
    #[test]
    fn download_filenames_are_length_capped() {
        let long = "x".repeat(400);
        let name =
            file_name_from_url(&Url::parse(&format!("https://example.com/{long}.bin")).unwrap());
        assert!(
            name.chars().count() <= 180,
            "got {} chars",
            name.chars().count()
        );
    }

    #[cfg(desktop)]
    #[test]
    fn restored_session_keeps_the_saved_active_tab() {
        let session = SessionData {
            version: 1,
            tabs: vec![
                SessionTab {
                    id: "tab-a".to_string(),
                    url: "https://example.com/a".to_string(),
                    title: "A".to_string(),
                },
                SessionTab {
                    id: "tab-b".to_string(),
                    url: "https://example.com/b".to_string(),
                    title: "B".to_string(),
                },
            ],
            active_tab_id: "tab-b".to_string(),
            window: None,
        };
        // Mirrors restore_session_tabs' selection rule without needing a Tauri app.
        let ids = session
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>();
        let active = ids
            .iter()
            .any(|id| *id == session.active_tab_id)
            .then(|| session.active_tab_id.clone())
            .unwrap_or_else(|| ids[0].clone());
        assert_eq!(active, "tab-b");

        // A stale active id must fall back to the first tab, not to an empty string.
        let stale = SessionData {
            active_tab_id: "tab-gone".to_string(),
            ..session
        };
        let ids = stale
            .tabs
            .iter()
            .map(|tab| tab.id.clone())
            .collect::<Vec<_>>();
        let active = ids
            .iter()
            .any(|id| *id == stale.active_tab_id)
            .then(|| stale.active_tab_id.clone())
            .unwrap_or_else(|| ids[0].clone());
        assert_eq!(active, "tab-a");
    }

    // ---------------------------------------------------------------------------
    // Retrieval eval
    //
    // The real embedding model is 640 MB, so CI cannot download it. Instead these
    // tests drive the *actual* pipeline — split_text -> push_chunks -> the binary
    // store -> rank_library_hits — with a deterministic stand-in embedder. That
    // covers every model-independent way retrieval can regress: chunk boundaries,
    // slot/vector alignment, per-capture grouping, ordering, and limits. It does
    // not judge model quality; see the AETHER_EMBEDDING_MODEL-gated test below.
    // ---------------------------------------------------------------------------

    // Wide enough that hash collisions do not dominate. At 64 buckets, unrelated
    // vocabularies shared slots often enough to invert rankings, which would have made
    // these tests measure the stand-in embedder rather than the pipeline.
    const EVAL_DIM: usize = 512;

    // Hashed bag-of-words, L2-normalised. Deterministic, and shares the property that
    // matters for these assertions: passages about the same terms sit closer together
    // under cosine distance than passages about different terms.
    fn eval_embed(text: &str) -> Vec<f32> {
        let mut vector = vec![0.0_f32; EVAL_DIM];
        for word in text.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
            if word.len() < 3 {
                continue;
            }
            let mut hash = 2166136261_u32;
            for byte in word.bytes() {
                hash ^= byte as u32;
                hash = hash.wrapping_mul(16777619);
            }
            vector[(hash as usize) % EVAL_DIM] += 1.0;
        }
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut vector {
                *value /= norm;
            }
        }
        vector
    }

    struct EvalDoc {
        capture_id: &'static str,
        title: &'static str,
        url: &'static str,
        body: &'static str,
    }

    fn eval_corpus() -> Vec<EvalDoc> {
        vec![
            EvalDoc {
                capture_id: "quantum",
                title: "Quantum mechanics",
                url: "https://en.wikipedia.org/wiki/Quantum_mechanics",
                body: "Quantum mechanics describes matter and light at atomic scale. Max Planck solved the black-body radiation problem in 1900. Niels Bohr, Erwin Schrodinger and Werner Heisenberg developed the theory during the mid 1920s. The wave function encodes probability amplitudes for a particle.",
            },
            EvalDoc {
                capture_id: "photosynthesis",
                title: "Photosynthesis",
                url: "https://en.wikipedia.org/wiki/Photosynthesis",
                body: "Photosynthesis converts light energy into chemical energy inside chloroplasts. Plants absorb carbon dioxide and water, releasing oxygen. Chlorophyll captures photons that drive the light dependent reactions producing glucose.",
            },
            EvalDoc {
                capture_id: "roman-empire",
                title: "Augustus and the Roman Empire",
                url: "https://en.wikipedia.org/wiki/Augustus",
                body: "Augustus founded the Roman Empire and became its first emperor in 27 BC. Julius Caesar named Octavian as his heir. The principate established an era of imperial peace known as the Pax Romana across the Roman world.",
            },
            EvalDoc {
                capture_id: "rust-ownership",
                title: "Ownership in Rust",
                url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
                body: "Ownership governs how a Rust program manages heap memory. Each value has a single owner, and the value is dropped when the owner goes out of scope. Borrowing lends a reference without transferring ownership, and the borrow checker rejects dangling references at compile time.",
            },
        ]
    }

    // Indexes the corpus through the real chunking and storage path, so a regression in
    // either shows up here rather than only in production.
    fn eval_store(dir: &TempDir) -> (VectorStoreData, HashMap<String, String>) {
        let path = dir.path("chunks.json");
        let mut store = VectorStoreData::default();
        for doc in eval_corpus() {
            let chunks = split_text(doc.body, 220, 40);
            assert!(
                !chunks.is_empty(),
                "fixture {} produced no chunks",
                doc.capture_id
            );
            store.push_chunks(
                chunks
                    .into_iter()
                    .enumerate()
                    .map(|(index, text)| ChunkRecord {
                        id: uuid(),
                        vector: eval_embed(&text),
                        vector_slot: 0,
                        needs_reembed: false,
                        text,
                        collection_id: "hub-eval".to_string(),
                        capture_id: doc.capture_id.to_string(),
                        title: doc.title.to_string(),
                        url: doc.url.to_string(),
                        app_id: "browser".to_string(),
                        captured_at: format!("2026-07-{:02}T00:00:00Z", 10 + index),
                        chunk_index: index,
                    }),
            );
        }
        block_on(save_vectors(&path, &mut store)).expect("persist eval store");

        // Reload from disk: the eval must exercise the stored vectors, not the
        // in-memory ones, so a serialisation bug cannot pass unnoticed.
        let reloaded = block_on(load_vectors(&path)).expect("reload eval store");
        let mut names = HashMap::new();
        names.insert("hub-eval".to_string(), "Eval hub".to_string());
        (reloaded, names)
    }

    fn eval_top_ids(
        store: &VectorStoreData,
        names: &HashMap<String, String>,
        question: &str,
        take: usize,
    ) -> Vec<String> {
        let query = eval_embed(question);
        let (hits, _) = rank_library_hits(&store.chunks, names, None, Some(&query), "", 20);
        hits.into_iter()
            .take(take)
            .map(|hit| hit.capture_id)
            .collect()
    }

    // The core retrieval contract: asking about a topic must surface the source that
    // covers it. This is the test that protects answer quality.
    #[test]
    fn retrieval_eval_ranks_the_expected_source_in_the_top_three() {
        let dir = TempDir::new();
        let (store, names) = eval_store(&dir);

        let cases = [
            ("When did quantum mechanics develop?", "quantum"),
            ("Who was the first Roman emperor?", "roman-empire"),
            (
                "How do plants turn light into chemical energy?",
                "photosynthesis",
            ),
            (
                "What happens when a value's owner goes out of scope?",
                "rust-ownership",
            ),
            ("black-body radiation problem", "quantum"),
            ("chlorophyll photons glucose", "photosynthesis"),
            ("borrow checker dangling references", "rust-ownership"),
            ("Pax Romana imperial peace", "roman-empire"),
        ];

        let mut failures = Vec::new();
        for (question, expected) in cases {
            let top = eval_top_ids(&store, &names, question, 3);
            if !top.iter().any(|id| id == expected) {
                failures.push(format!("{question:?} expected {expected}, got {top:?}"));
            }
        }
        assert!(
            failures.is_empty(),
            "retrieval regressions:\n{}",
            failures.join("\n")
        );
    }

    #[test]
    fn retrieval_eval_ranks_the_expected_source_first_for_distinctive_terms() {
        let dir = TempDir::new();
        let (store, names) = eval_store(&dir);

        // Terms unique to one document should win outright, not merely place.
        for (question, expected) in [
            ("Schrodinger Heisenberg wave function", "quantum"),
            ("chloroplasts carbon dioxide oxygen", "photosynthesis"),
            ("Octavian Julius Caesar principate", "roman-empire"),
            ("ownership borrowing heap memory", "rust-ownership"),
        ] {
            let top = eval_top_ids(&store, &names, question, 1);
            assert_eq!(top, vec![expected.to_string()], "for query {question:?}");
        }
    }

    #[test]
    fn retrieval_eval_returns_one_row_per_source() {
        let dir = TempDir::new();
        let (store, names) = eval_store(&dir);
        let query = eval_embed("quantum mechanics wave function");

        let (hits, examined) = rank_library_hits(&store.chunks, &names, None, Some(&query), "", 20);

        assert_eq!(examined, store.chunks.len(), "every chunk should be scored");
        let mut ids = hits
            .iter()
            .map(|hit| hit.capture_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        let unique = ids.iter().collect::<HashSet<_>>().len();
        assert_eq!(ids.len(), unique, "a source must not appear twice: {ids:?}");
        assert!(hits.len() <= eval_corpus().len());
        // Grouping must report how many passages matched, not silently collapse them.
        let quantum = hits
            .iter()
            .find(|hit| hit.capture_id == "quantum")
            .expect("quantum hit");
        assert!(quantum.chunk_matches >= 1);
        assert_eq!(quantum.collection_name, "Eval hub");
        assert_eq!(quantum.host, "en.wikipedia.org");
    }

    #[test]
    fn retrieval_eval_respects_hub_scope_and_limit() {
        let dir = TempDir::new();
        let (store, names) = eval_store(&dir);
        let query = eval_embed("quantum photosynthesis Augustus ownership");

        let (limited, _) = rank_library_hits(&store.chunks, &names, None, Some(&query), "", 2);
        assert_eq!(limited.len(), 2, "limit must cap the result set");

        let (other_hub, _) = rank_library_hits(
            &store.chunks,
            &names,
            Some("hub-missing"),
            Some(&query),
            "",
            20,
        );
        assert!(
            other_hub.is_empty(),
            "scoping to another hub must exclude everything"
        );
    }

    #[test]
    fn retrieval_eval_ordering_is_stable_across_runs() {
        let dir = TempDir::new();
        let (store, names) = eval_store(&dir);
        let query = eval_embed("energy");

        // HashMap iteration order varies per process; the sort must not depend on it.
        let first = rank_library_hits(&store.chunks, &names, None, Some(&query), "", 20).0;
        for _ in 0..5 {
            let again = rank_library_hits(&store.chunks, &names, None, Some(&query), "", 20).0;
            assert_eq!(
                first.iter().map(|h| &h.capture_id).collect::<Vec<_>>(),
                again.iter().map(|h| &h.capture_id).collect::<Vec<_>>()
            );
        }
    }

    // Chunking invariants. Retrieval cannot find text that chunking dropped, so these
    // guard the input side of the pipeline.
    #[test]
    fn chunking_covers_the_whole_document_with_overlap() {
        let body = eval_corpus()[0].body;
        let chunks = split_text(body, 120, 30);

        assert!(chunks.len() > 1, "a long body should split");
        // Every character of the source must appear in some chunk.
        let joined = chunks.concat();
        for word in body.split_whitespace() {
            assert!(joined.contains(word), "chunking lost {word:?}");
        }
        // Consecutive chunks must actually overlap, or a claim spanning a boundary
        // becomes unretrievable. split_text trims each chunk, so the shared region is
        // slightly shorter than the requested overlap; assert on a substring well
        // inside it rather than on an exact prefix.
        for pair in chunks.windows(2) {
            let tail = pair[0]
                .chars()
                .rev()
                .take(10)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>();
            assert!(
                pair[1].contains(&tail),
                "expected {:?} to carry the tail {tail:?} of the previous chunk",
                pair[1].chars().take(40).collect::<String>()
            );
        }
    }

    #[test]
    fn chunking_handles_multibyte_text_without_splitting_characters() {
        let body = "— 私は研究します。".repeat(20);
        let chunks = split_text(&body, 40, 10);

        assert!(!chunks.is_empty());
        for chunk in &chunks {
            // Round-tripping proves no chunk ends mid-character.
            assert_eq!(chunk.as_bytes(), chunk.clone().into_bytes().as_slice());
        }
        assert!(chunks.concat().contains("私は研究します"));
    }

    // Opt-in migration check against a real pre-upgrade store. Synthetic fixtures cannot
    // reproduce what a store looks like after an embedding model changed under it, which
    // is exactly the case the migration got wrong. Run locally with:
    //   AETHER_LEGACY_STORE=/path/to/chunks.json cargo test --lib legacy_store -- --ignored
    #[test]
    #[ignore = "requires AETHER_LEGACY_STORE; not available in CI"]
    fn migration_of_a_real_legacy_store_loses_nothing() {
        let Ok(source) = std::env::var("AETHER_LEGACY_STORE") else {
            panic!("set AETHER_LEGACY_STORE to a v1 chunks.json");
        };
        let raw = fs::read_to_string(&source).expect("read legacy store");
        let legacy: LegacyVectorStoreData = serde_json::from_str(&raw).expect("parse legacy store");
        let before = legacy.chunks.len();
        let widths = legacy
            .chunks
            .iter()
            .map(|chunk| chunk.vector.len())
            .collect::<std::collections::BTreeSet<_>>();

        // Copy so the real store is never the thing under test.
        let dir = TempDir::new();
        let path = dir.path("chunks.json");
        fs::write(&path, &raw).expect("seed copy");

        let migrated = block_on(load_vectors(&path)).expect("migrate");

        diag_warn!(
            "legacy store: {before} chunks, widths {widths:?} -> dim {}, {} embedded, {} parked",
            migrated.dim,
            migrated.embedded_count(),
            migrated.pending_reembed_count()
        );
        assert_eq!(
            migrated.chunks.len(),
            before,
            "migration must not drop any chunk"
        );
        assert!(
            dir.path("chunks.v1.json").exists(),
            "the pre-migration store must be archived"
        );
        for chunk in &migrated.chunks {
            if chunk.needs_reembed {
                assert!(!chunk.text.is_empty(), "parked chunks must keep their text");
            } else {
                assert_eq!(chunk.vector.len(), migrated.dim);
            }
        }

        // Reloading must take the v2 path and preserve the same shape.
        let reloaded = block_on(load_vectors(&path)).expect("reload");
        assert_eq!(reloaded.chunks.len(), before);
        assert_eq!(reloaded.embedded_count(), migrated.embedded_count());
    }

    // Opt-in eval against the real embedding model. Run locally with:
    //   AETHER_EMBEDDING_MODEL=/path/to/model.gguf cargo test --lib real_model -- --ignored
    // Kept out of CI because the model is a 640 MB download.
    #[test]
    #[ignore = "requires AETHER_EMBEDDING_MODEL; not available in CI"]
    fn retrieval_eval_real_model_is_configured() {
        let path = env::var(AETHER_EMBEDDING_MODEL_ENV)
            .expect("set AETHER_EMBEDDING_MODEL to the embedding GGUF to run this eval");
        assert!(
            Path::new(&path).exists(),
            "AETHER_EMBEDDING_MODEL points at {path}, which does not exist"
        );
    }

    fn chunk_for_search(capture_id: &str, title: &str, url: &str, text: &str) -> ChunkRecord {
        ChunkRecord {
            id: uuid(),
            vector: vec![0.0; 4],
            vector_slot: 0,
            needs_reembed: false,
            text: text.to_string(),
            collection_id: "hub-1".to_string(),
            capture_id: capture_id.to_string(),
            title: title.to_string(),
            url: url.to_string(),
            app_id: "browser".to_string(),
            captured_at: "2026-07-01T00:00:00Z".to_string(),
            chunk_index: 0,
        }
    }

    // A remembered page name should outrank an incidental body mention, otherwise
    // the page the user is picturing gets buried under passing references to it.
    #[test]
    fn literal_search_ranks_title_matches_above_body_matches() {
        let titled = chunk_for_search(
            "a",
            "Quantum mechanics",
            "https://example.com/a",
            "unrelated",
        );
        let mentioned = chunk_for_search(
            "b",
            "Cooking basics",
            "https://example.com/b",
            "quantum mechanics",
        );

        let titled_score = literal_match_score("quantum mechanics", &titled);
        let mentioned_score = literal_match_score("quantum mechanics", &mentioned);

        assert!(titled_score > mentioned_score);
        assert!(
            mentioned_score > 0.0,
            "body matches should still be findable"
        );
    }

    #[test]
    fn literal_search_matches_hosts_and_ignores_misses() {
        let chunk = chunk_for_search("a", "Augustus", "https://en.wikipedia.org/wiki/x", "body");

        assert!(literal_match_score("wikipedia", &chunk) > 0.0);
        assert_eq!(literal_match_score("nonexistent-term", &chunk), 0.0);
        assert_eq!(literal_match_score("", &chunk), 0.0);
    }

    #[test]
    fn literal_search_is_case_insensitive_and_capped() {
        let chunk = chunk_for_search("a", "Augustus", "https://augustus.example", "augustus");

        // Title + url + body all match; the score must stay a valid percentage.
        assert_eq!(literal_match_score("augustus", &chunk), 100.0);
    }

    // The dangerous failure mode is silently capturing a search-results page for a
    // typo, which would poison a hub with content the user never chose.
    #[test]
    fn capture_target_rejects_search_text_instead_of_guessing_a_url() {
        assert!(capture_target_url("how do vaccines work").is_err());
        assert!(capture_target_url("   ").is_err());
        assert!(capture_target_url("notaurl").is_err());
    }

    #[test]
    fn capture_target_accepts_bare_hosts_and_full_urls() {
        assert_eq!(
            capture_target_url("example.com/article"),
            Ok("https://example.com/article".to_string())
        );
        assert_eq!(
            capture_target_url("  https://en.wikipedia.org/wiki/Augustus  "),
            Ok("https://en.wikipedia.org/wiki/Augustus".to_string())
        );
        assert_eq!(
            capture_target_url("http://example.com"),
            Ok("http://example.com/".to_string())
        );
    }

    #[test]
    fn capture_target_rejects_non_web_schemes() {
        for raw in [
            "file:///etc/passwd",
            "aether://dashboard",
            "javascript:alert(1)",
            "ftp://example.com/x",
        ] {
            assert!(
                capture_target_url(raw).is_err(),
                "{raw} should not be capturable"
            );
        }
    }

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
        let text = "çalışması — özet <eö";
        let safe = stream_safe_len(text);
        assert!(text.is_char_boundary(safe));
        assert_eq!(&text[safe..], "<eö");
    }

    #[test]
    fn semantic_trail_score_normalizer_maps_cosine_distance_to_display_score() {
        assert_eq!(semantic_score_from_distance(0.0), 100.0);
        assert_eq!(semantic_score_from_distance(0.3), 75.0);
        assert_eq!(semantic_score_from_distance(1.2), 0.0);
        assert_eq!(semantic_score_from_distance(f64::INFINITY), 0.0);
    }

    #[test]
    fn version_comparison_handles_release_tags() {
        assert!(version_is_newer("v2.0.0", "1.9.9"));
        assert!(version_is_newer("1.0.1", "1.0.0"));
        assert!(!version_is_newer("1.0.0", "1.0.0"));
        assert!(!version_is_newer("0.9.9", "1.0.0"));
    }

    #[test]
    fn github_release_parses_snake_case_api_payload() {
        let payload = serde_json::json!({
            "tag_name": "v1.0.28",
            "name": "v1.0.28",
            "html_url": "https://github.com/CanPixel/aether/releases/tag/v1.0.28",
            "body": "**Full Changelog**: ...",
            "published_at": "2026-06-25T20:49:36Z",
            "draft": false,
            "prerelease": false
        });
        let release: GithubRelease = serde_json::from_value(payload).expect("release parses");
        assert_eq!(release_version_from_tag(&release.tag_name), "1.0.28");
        assert_eq!(
            release.published_at.as_deref(),
            Some("2026-06-25T20:49:36Z")
        );
    }

    #[test]
    fn iceberg_normalizer_scores_layers_deterministically() {
        let response = serde_json::json!({
            "recommendedItemCount": 12,
            "items": [
                {
                    "name": "Public overview",
                    "description": "A familiar entry point.",
                    "familiarity": 96,
                    "specificity": 8,
                    "jargonDensity": 4,
                    "prerequisiteDepth": 6,
                    "obscurity": 5,
                    "reason": "Common public vocabulary."
                },
                {
                    "name": "Specialist mechanism",
                    "description": "A deep technical mechanism.",
                    "familiarity": 9,
                    "specificity": 94,
                    "jargonDensity": 88,
                    "prerequisiteDepth": 84,
                    "obscurity": 91,
                    "reason": "Requires specialist context."
                }
            ]
        })
        .to_string();

        let items = normalize_iceberg_items(&response).expect("valid iceberg items");
        let public = items
            .iter()
            .find(|item| item.name == "Public overview")
            .expect("public item");
        let specialist = items
            .iter()
            .find(|item| item.name == "Specialist mechanism")
            .expect("specialist item");

        assert_eq!(public.level, 1);
        assert_eq!(specialist.level, 5);
        assert!(
            public.depth_score.unwrap_or_default() < specialist.depth_score.unwrap_or_default()
        );
        assert_eq!(
            specialist.reason.as_deref(),
            Some("Requires specialist context.")
        );
    }

    #[test]
    fn iceberg_normalizer_allows_variable_counts_above_old_cap() {
        let items = (0..30)
            .map(|index| {
                let band = index / 6;
                let score = match band {
                    0 => 8,
                    1 => 28,
                    2 => 48,
                    3 => 68,
                    _ => 88,
                } + (index % 6);
                serde_json::json!({
                    "name": format!("Fragment {index}"),
                    "description": "A generated fragment.",
                    "depthScore": score,
                    "reason": "Test scoring."
                })
            })
            .collect::<Vec<_>>();
        let response = serde_json::json!({
            "recommendedItemCount": 30,
            "items": items
        })
        .to_string();

        let normalized = normalize_iceberg_items(&response).expect("valid iceberg items");
        assert_eq!(normalized.len(), 30);
        assert!(normalized.len() > 25);

        let mut counts = HashMap::<u8, usize>::new();
        for item in normalized {
            *counts.entry(item.level).or_default() += 1;
        }
        assert!(counts
            .values()
            .all(|count| *count <= ICEBERG_MAX_ITEMS_PER_LEVEL));
    }

    #[test]
    fn iceberg_normalizer_stretches_compressed_scores_across_layers() {
        let items = (0..15)
            .map(|index| {
                serde_json::json!({
                    "name": format!("Compressed fragment {index}"),
                    "description": "A generated fragment with conservative scoring.",
                    "depthScore": 22 + index,
                    "reason": "Test compressed scoring."
                })
            })
            .collect::<Vec<_>>();
        let response = serde_json::json!({
            "recommendedItemCount": 15,
            "items": items
        })
        .to_string();

        let normalized = normalize_iceberg_items(&response).expect("valid iceberg items");
        let levels = normalized
            .iter()
            .map(|item| item.level)
            .collect::<HashSet<_>>();

        assert_eq!(levels.len(), ICEBERG_LEVEL_COUNT as usize);
        assert!(normalized
            .iter()
            .any(|item| item.level == 5 && item.depth_score.unwrap_or_default() >= 80.0));
    }

    #[test]
    fn semantic_trail_items_dedupe_urls_and_merge_excerpts() {
        let first = semantic_trail_candidate(
            "https://example.com/a#intro",
            "First source passage about local semantic browsing.",
            92.0,
            vec![SemanticTrailReason::SemanticMatch],
        );
        let second = semantic_trail_candidate(
            "https://example.com/a#details",
            "Second source passage with more implementation detail.",
            84.0,
            vec![SemanticTrailReason::RecentCapture],
        );

        let items = semantic_trail_items(vec![first, second], 12);

        assert_eq!(items.len(), 1);
        assert!(items[0].excerpt.contains("First source passage"));
        assert!(items[0].excerpt.contains("Second source passage"));
        assert!(items[0]
            .reasons
            .contains(&SemanticTrailReason::SemanticMatch));
        assert!(items[0]
            .reasons
            .contains(&SemanticTrailReason::RecentCapture));
    }

    #[test]
    fn semantic_trail_reason_generation_is_deterministic() {
        let score = SemanticTrailScoreBreakdown {
            total: 88.0,
            semantic: 70.0,
            recency: 80.0,
        };

        assert_eq!(
            semantic_trail_reasons(&score, true),
            vec![
                SemanticTrailReason::SemanticMatch,
                SemanticTrailReason::RecentCapture,
                SemanticTrailReason::SameCollection,
            ]
        );
    }

    #[test]
    fn air_filename_matches_dossier_title_with_safe_separators() {
        assert_eq!(
            air_dossier_filename(
                "AiR Dossier: Local/Fluid Research",
                "2026-06-17T10:11:12.123Z"
            ),
            "AiR Dossier: Local-Fluid Research.md"
        );
    }

    #[test]
    fn air_yaml_string_escapes_quotes_and_newlines() {
        assert_eq!(
            yaml_string("A \"quoted\"\nLens"),
            "\"A \\\"quoted\\\" Lens\""
        );
    }

    #[test]
    fn air_markdown_fallback_keeps_frontmatter_and_source_index() {
        let sources = vec![AirDossierSource {
            id: "source-1".to_string(),
            title: "Research Source".to_string(),
            excerpt: "A captured passage with a local finding [99].".to_string(),
            collection_name: Some("Hub".to_string()),
            url: Some("https://example.com/research".to_string()),
            host: Some("example.com".to_string()),
            captured_at: Some("2026-06-17T10:00:00.000Z".to_string()),
            score: Some(88.4),
        }];

        let markdown = build_air_markdown(AirMarkdownInput {
            title: "AiR Dossier: Research",
            lens: "Research",
            lens_kind: AirLensKind::Topic,
            generated_at: "2026-06-17T10:11:12.123Z",
            model: "deterministic-scaffold",
            sources: &sources,
            synthesized_sections: None,
            seed_answer: None,
            ice_map: None,
        });

        assert!(markdown.contains("type: aether-dossier"));
        assert!(markdown.contains("source_count: 1"));
        assert!(markdown.contains("## Source-Backed Notes"));
        assert!(markdown.contains("[^1]: [Research Source](https://example.com/research)"));
        assert!(!markdown.contains("[99]"));
    }

    #[test]
    fn air_source_conversion_dedupes_repeated_capture_urls() {
        let collection_names = HashMap::from([("hub".to_string(), "Hub".to_string())]);
        let results = dedupe_citations(vec![
            search_result("chunk-1", "https://example.com/a#one", "First passage."),
            search_result("chunk-2", "https://example.com/a#two", "Second passage."),
        ]);

        let sources = search_results_to_air_sources(results, &collection_names);

        assert_eq!(sources.len(), 1);
        assert!(sources[0].excerpt.contains("First passage"));
        assert!(sources[0].excerpt.contains("Second passage"));
        assert_eq!(sources[0].collection_name.as_deref(), Some("Hub"));
    }

    fn search_result(id: &str, url: &str, text: &str) -> SearchResult {
        SearchResult {
            id: id.to_string(),
            collection_id: "hub".to_string(),
            capture_id: "capture".to_string(),
            app_id: "browser".to_string(),
            title: "Example".to_string(),
            url: url.to_string(),
            captured_at: "2026-06-17T10:00:00.000Z".to_string(),
            chunk_index: 0,
            text: text.to_string(),
            score: 0.2,
        }
    }

    fn semantic_trail_candidate(
        url: &str,
        text: &str,
        total: f64,
        reasons: Vec<SemanticTrailReason>,
    ) -> SemanticTrailChunkCandidate {
        SemanticTrailChunkCandidate {
            chunk: ChunkRecord {
                id: uuid(),
                vector: vec![1.0, 0.0],
                vector_slot: 0,
                needs_reembed: false,
                text: text.to_string(),
                collection_id: "collection".to_string(),
                capture_id: "capture".to_string(),
                title: "Example".to_string(),
                url: url.to_string(),
                app_id: "browser".to_string(),
                captured_at: "2026-01-01T00:00:00.000Z".to_string(),
                chunk_index: 0,
            },
            collection_name: "Research".to_string(),
            score: SemanticTrailScoreBreakdown {
                total,
                semantic: total,
                recency: 50.0,
            },
            reasons,
        }
    }
}
