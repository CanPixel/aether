//! Serde types crossing the IPC boundary, plus the on-disk store shapes.
//!
//! Extracted verbatim from lib.rs. Field names and `serde` attributes here are the
//! contract with src/shared/aether.ts — renaming one silently breaks the renderer.

use super::*;

pub(crate) struct Backend {
    pub(crate) paths: DataPaths,
    pub(crate) tabs: Mutex<TabState>,
    #[cfg(desktop)]
    pub(crate) webviews: Mutex<NativeBrowserViews>,
    // Where the renderer wants live web content placed, in CSS pixels, reported via
    // aether_layout_set_web_content_bounds. Both shells use it; on desktop it takes
    // precedence over the SIDEBAR_WIDTH/BROWSER_VIEW_TOP/PANEL_WIDTH constants.
    pub(crate) web_content_bounds: Mutex<WebContentBounds>,
    pub(crate) client: Client,
    pub(crate) native_runtime: Arc<Mutex<NativeModelRuntime>>,
    pub(crate) vectors: tokio::sync::RwLock<Option<VectorStoreData>>,
    pub(crate) generation_cancelled: Arc<AtomicBool>,
    // Throttle for window geometry writes; resize/move fire continuously.
    #[cfg(desktop)]
    pub(crate) window_geometry_saved_at: Mutex<Option<Instant>>,
    // Destination chosen at request time, keyed by URL. macOS omits the path in the
    // Finished event, so without this the completion toast has nothing to reveal.
    #[cfg(desktop)]
    pub(crate) pending_downloads: Mutex<HashMap<String, PathBuf>>,
}

#[cfg(desktop)]
#[derive(Default)]
pub(crate) struct NativeBrowserViews {
    pub(crate) views: HashMap<String, Webview>,
}

// Where live web content belongs inside the window, in CSS px, as measured by the
// renderer. Both shells report the same rect: Android positions native WebViews with
// it, desktop positions its child webviews with it. Measuring beats hardcoding,
// because the chrome that defines these edges is owned by CSS.
#[derive(Clone, Copy, Default, PartialEq)]
pub(crate) struct WebContentBounds {
    pub(crate) top: f64,
    pub(crate) left: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Default)]
pub(crate) struct NativeModelRuntime {
    pub(crate) backend: Option<LlamaBackend>,
    pub(crate) chat: Option<LoadedNativeModel>,
    pub(crate) embedding: Option<LoadedNativeModel>,
}

pub(crate) struct LoadedNativeModel {
    pub(crate) path: PathBuf,
    pub(crate) model: LlamaModel,
}

#[derive(Clone)]
pub(crate) struct EmbeddingProgress {
    pub(crate) app: AppHandle,
    pub(crate) message: String,
}

impl EmbeddingProgress {
    pub(crate) fn emit(&self, current: usize, total: usize) {
        emit_capture_progress(&self.app, &self.message, Some(current), Some(total));
    }

    pub(crate) fn emit_message(&self, message: impl Into<String>, current: usize, total: usize) {
        emit_capture_progress(&self.app, message, Some(current), Some(total));
    }
}

pub(crate) struct ChatPromptMessage {
    pub(crate) role: &'static str,
    pub(crate) content: String,
}

pub(crate) struct RenderedChatPrompt {
    pub(crate) prompt: String,
    pub(crate) add_bos: AddBos,
}

#[derive(Clone, Copy)]
pub(crate) enum NativeModelKind {
    Chat,
    Embedding,
}

pub(crate) enum WebviewHistoryDirection {
    Back,
    Forward,
}

pub(crate) struct ModelCatalog {
    pub(crate) models: Vec<PathBuf>,
    pub(crate) chat_model: Option<PathBuf>,
    pub(crate) embedding_model: Option<PathBuf>,
    pub(crate) error: Option<String>,
}

#[derive(Clone)]
pub(crate) struct DataPaths {
    pub(crate) db_path: PathBuf,
    pub(crate) library_path: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) icebergs_path: PathBuf,
    pub(crate) conversations_path: PathBuf,
    pub(crate) session_path: PathBuf,
    pub(crate) air_exports_path: PathBuf,
    pub(crate) chunks_path: PathBuf,
    pub(crate) models_path: PathBuf,
    // User-owned library snapshots (see aether_system_export_library).
    pub(crate) exports_path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsExportResult {
    pub(crate) path: String,
    pub(crate) filename: String,
    pub(crate) byte_size: u64,
    pub(crate) exported_at: String,
}

#[derive(Clone)]
pub(crate) struct TabState {
    pub(crate) tabs: Vec<ManagedTab>,
    pub(crate) active_app_id: String,
    pub(crate) active_tab_id: String,
    pub(crate) dashboard_open: bool,
    pub(crate) modal_overlay_open: bool,
    pub(crate) panel_collapsed: bool,
}

#[derive(Clone)]
pub(crate) struct ManagedTab {
    pub(crate) id: String,
    pub(crate) app_id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) is_loading: bool,
    pub(crate) favicon: Option<String>,
    pub(crate) theme_color: Option<String>,
    pub(crate) history: Vec<String>,
    pub(crate) history_index: usize,
    // On Android the tab's real history lives in its native WebView, whose
    // canGoBack/canGoForward are reported via aether_tabs_report_native_event.
    // They extend (OR with) the Rust-side history, which still tracks entries
    // the WebView never saw — most notably the aether://start page.
    pub(crate) native_can_go_back: Option<bool>,
    pub(crate) native_can_go_forward: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) home_url: String,
    pub(crate) current_url: String,
    pub(crate) title: String,
    pub(crate) is_active: bool,
    pub(crate) is_loading: bool,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTabSummary {
    pub(crate) id: String,
    pub(crate) app_id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) is_active: bool,
    pub(crate) is_loading: bool,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) favicon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) theme_color: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AetherState {
    pub(crate) apps: Vec<AppSummary>,
    pub(crate) tabs: Vec<BrowserTabSummary>,
    pub(crate) active_app_id: String,
    pub(crate) active_tab_id: String,
    pub(crate) dashboard_open: bool,
    pub(crate) panel_collapsed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubShortcutSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) favicon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) theme_color: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSettings {
    pub(crate) default_search_engine: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSettings {
    #[serde(default = "default_update_auto_check")]
    pub(crate) auto_check: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_checked_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    pub(crate) browser: BrowserSettings,
    pub(crate) developer_mode: bool,
    pub(crate) updates: UpdateSettings,
    pub(crate) appearance: Appearance,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) icon: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) capture_count: usize,
    pub(crate) chunk_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tags: Option<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureSummary {
    pub(crate) id: String,
    pub(crate) collection_id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) app_id: String,
    pub(crate) captured_at: String,
    pub(crate) chunk_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<CaptureMetadata>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureResult {
    #[serde(flatten)]
    pub(crate) capture: CaptureSummary,
    pub(crate) collection_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureProgress {
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub(crate) id: String,
    pub(crate) collection_id: String,
    pub(crate) capture_id: String,
    pub(crate) app_id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) captured_at: String,
    pub(crate) chunk_index: usize,
    pub(crate) text: String,
    pub(crate) score: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticTrailRoot {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) excerpt: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SemanticTrailReason {
    SemanticMatch,
    RecentCapture,
    SameCollection,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SemanticTrailEdgeKind {
    SemanticMatch,
    SameHost,
    SameCollection,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticTrailScoreBreakdown {
    pub(crate) total: f64,
    pub(crate) semantic: f64,
    pub(crate) recency: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticTrailItem {
    pub(crate) id: String,
    pub(crate) collection_id: String,
    pub(crate) collection_name: String,
    pub(crate) capture_id: String,
    pub(crate) app_id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) captured_at: String,
    pub(crate) chunk_index: usize,
    pub(crate) excerpt: String,
    pub(crate) score: SemanticTrailScoreBreakdown,
    pub(crate) reasons: Vec<SemanticTrailReason>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticTrailEdge {
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) kind: SemanticTrailEdgeKind,
    pub(crate) weight: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureHubSuggestion {
    pub(crate) collection_id: String,
    pub(crate) collection_name: String,
    pub(crate) confidence: f64,
    pub(crate) sample_title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticTrailResult {
    pub(crate) query: String,
    pub(crate) generated_at: String,
    pub(crate) root: SemanticTrailRoot,
    pub(crate) items: Vec<SemanticTrailItem>,
    pub(crate) edges: Vec<SemanticTrailEdge>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FlowGraphNodeKind {
    Query,
    Hub,
    Source,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FlowGraphEdgeKind {
    Contains,
    Semantic,
    QueryMatch,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlowGraphNode {
    pub(crate) id: String,
    pub(crate) kind: FlowGraphNodeKind,
    pub(crate) title: String,
    pub(crate) subtitle: String,
    pub(crate) weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) capture_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) captured_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) score: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlowGraphEdge {
    pub(crate) id: String,
    pub(crate) from: String,
    pub(crate) to: String,
    pub(crate) kind: FlowGraphEdgeKind,
    pub(crate) weight: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlowGraphResult {
    pub(crate) query: String,
    pub(crate) generated_at: String,
    pub(crate) nodes: Vec<FlowGraphNode>,
    pub(crate) edges: Vec<FlowGraphEdge>,
    pub(crate) hub_count: usize,
    pub(crate) source_count: usize,
    pub(crate) omitted_source_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatResult {
    pub(crate) answer: String,
    pub(crate) model: String,
    pub(crate) citations: Vec<SearchResult>,
    pub(crate) metrics: ChatMetrics,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMetrics {
    pub(crate) generated_tokens: usize,
    pub(crate) tokens_per_second: f64,
    pub(crate) elapsed_seconds: f64,
    pub(crate) chunks: usize,
}

pub(crate) struct ChatCompletion {
    pub(crate) text: String,
    pub(crate) generated_tokens: usize,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub(crate) enum AirLensKind {
    #[default]
    Topic,
    Flow,
    Hub,
    Answer,
    Iceberg,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AirDossierInput {
    pub(crate) lens: String,
    pub(crate) lens_kind: Option<AirLensKind>,
    pub(crate) collection_id: Option<String>,
    pub(crate) capture_id: Option<String>,
    pub(crate) saved_iceberg_id: Option<String>,
    pub(crate) answer: Option<ChatResult>,
    pub(crate) limit: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AirDossierSource {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) captured_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) score: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AirPreparedDossier {
    pub(crate) title: String,
    pub(crate) lens: String,
    pub(crate) lens_kind: AirLensKind,
    pub(crate) generated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    pub(crate) output_dir: String,
    pub(crate) markdown_preview: String,
    pub(crate) sources: Vec<AirDossierSource>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AirRenderResult {
    pub(crate) path: String,
    pub(crate) filename: String,
    pub(crate) title: String,
    pub(crate) source_count: usize,
    pub(crate) rendered_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AirRecentFile {
    pub(crate) path: String,
    pub(crate) filename: String,
    pub(crate) title: String,
    pub(crate) lens: String,
    pub(crate) source_count: usize,
    pub(crate) rendered_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatStreamPayload {
    pub(crate) request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) citations: Option<Vec<SearchResult>>,
}

#[derive(Clone)]
pub(crate) struct ChatStreamEmitter {
    pub(crate) app: AppHandle,
    pub(crate) request_id: String,
}

impl ChatStreamEmitter {
    pub(crate) fn emit(&self, payload: ChatStreamPayload) {
        let _ = self.app.emit(AETHER_CHAT_STREAM_EVENT, payload);
    }

    pub(crate) fn status(&self, status: &str) {
        self.emit(ChatStreamPayload {
            request_id: self.request_id.clone(),
            status: Some(status.to_string()),
            delta: None,
            citations: None,
        });
    }

    pub(crate) fn citations(&self, citations: &[SearchResult]) {
        self.emit(ChatStreamPayload {
            request_id: self.request_id.clone(),
            status: Some("Generating answer".to_string()),
            delta: None,
            citations: Some(citations.to_vec()),
        });
    }

    pub(crate) fn delta(&self, delta: &str) {
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
pub(crate) struct IcebergItem {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) level: u8,
    pub(crate) x: f64,
    pub(crate) y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) depth_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) familiarity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) specificity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) jargon_density: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prerequisite_depth: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) obscurity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IcebergResult {
    pub(crate) keyword: String,
    pub(crate) model: String,
    pub(crate) items: Vec<IcebergItem>,
    pub(crate) generated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedIcebergSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) keyword: String,
    pub(crate) model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) icon: Option<String>,
    pub(crate) generated_at: String,
    pub(crate) saved_at: String,
    pub(crate) updated_at: String,
    pub(crate) item_count: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedIceberg {
    #[serde(flatten)]
    pub(crate) iceberg: IcebergResult,
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) icon: Option<String>,
    pub(crate) saved_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemStatus {
    pub(crate) runtime_ready: bool,
    pub(crate) runtime_name: String,
    pub(crate) embedding_model: Option<String>,
    pub(crate) chat_model: Option<String>,
    pub(crate) available_models: Vec<String>,
    pub(crate) chat_models: Vec<String>,
    pub(crate) embedding_models: Vec<String>,
    pub(crate) model_dir: String,
    pub(crate) db_path: String,
    pub(crate) library_path: String,
    pub(crate) collections: Vec<CollectionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTabInput {
    pub(crate) url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateShortcutInput {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) favicon: Option<String>,
    pub(crate) theme_color: Option<String>,
}

#[cfg(desktop)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageMetadataSnapshot {
    pub(crate) theme_color: Option<String>,
    pub(crate) favicon: Option<String>,
}

#[cfg(desktop)]
#[derive(Deserialize)]
pub(crate) struct FindMatchSnapshot {
    pub(crate) current: usize,
    pub(crate) total: usize,
}

// Event payload forwarded by the renderer from the Kotlin TabsPlugin
// (window.__AETHER_TAB_EVENT__): per-tab navigation, title, and find updates.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTabEventInput {
    pub(crate) tab_id: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) is_loading: Option<bool>,
    #[serde(default)]
    pub(crate) can_go_back: Option<bool>,
    #[serde(default)]
    pub(crate) can_go_forward: Option<bool>,
    #[serde(default)]
    pub(crate) current: Option<usize>,
    #[serde(default)]
    pub(crate) total: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FindResultPayload {
    pub(crate) tab_id: String,
    pub(crate) current: usize,
    pub(crate) total: usize,
}

#[derive(Deserialize)]
pub(crate) struct CreateCollectionInput {
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) icon: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateCollectionInput {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) icon: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureCurrentPageInput {
    pub(crate) collection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchLibraryInput {
    pub(crate) query: String,
    // None searches every hub.
    #[serde(default)]
    pub(crate) collection_id: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySearchHit {
    pub(crate) capture_id: String,
    pub(crate) collection_id: String,
    pub(crate) collection_name: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) host: String,
    pub(crate) captured_at: String,
    pub(crate) excerpt: String,
    // 0-100 display score, not raw cosine distance.
    pub(crate) score: f64,
    pub(crate) chunk_matches: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySearchResult {
    pub(crate) query: String,
    pub(crate) hits: Vec<LibrarySearchHit>,
    // "semantic" when an embedding model ranked the results, "literal" when it fell
    // back to substring matching so the UI can say which happened.
    pub(crate) mode: String,
    pub(crate) searched_chunks: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureUrlInput {
    pub(crate) collection_id: String,
    pub(crate) url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureUrlsInput {
    pub(crate) collection_id: String,
    pub(crate) urls: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BulkCaptureFailure {
    pub(crate) url: String,
    pub(crate) reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BulkCaptureResult {
    pub(crate) captured: Vec<CaptureSummary>,
    pub(crate) collection_name: String,
    pub(crate) failures: Vec<BulkCaptureFailure>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveCaptureInput {
    pub(crate) capture_id: String,
    pub(crate) collection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchCollectionInput {
    pub(crate) collection_id: String,
    pub(crate) query: String,
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticTrailInput {
    pub(crate) query: Option<String>,
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlowGraphInput {
    pub(crate) query: Option<String>,
    pub(crate) source_limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskChatInput {
    pub(crate) collection_id: Option<String>,
    pub(crate) prompt: String,
    pub(crate) include_current_page: Option<bool>,
    pub(crate) request_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct GenerateIcebergInput {
    pub(crate) keyword: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveIcebergInput {
    pub(crate) title: String,
    pub(crate) keyword: String,
    pub(crate) model: String,
    pub(crate) icon: Option<String>,
    pub(crate) generated_at: String,
    pub(crate) items: Vec<IcebergItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSettingsInput {
    pub(crate) browser: Option<PartialBrowserSettings>,
    pub(crate) developer_mode: Option<bool>,
    pub(crate) updates: Option<PartialUpdateSettings>,
    pub(crate) appearance: Option<Appearance>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartialBrowserSettings {
    pub(crate) default_search_engine: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartialUpdateSettings {
    pub(crate) auto_check: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    // "started" | "finished" | "failed"
    pub(crate) status: String,
    pub(crate) filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    pub(crate) url: String,
}

// Restored on launch so quitting no longer discards every open tab. Only what is
// needed to reopen is stored: per-tab history stays in the webview.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionTab {
    pub(crate) id: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) title: String,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWindow {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionData {
    pub(crate) version: u8,
    #[serde(default)]
    pub(crate) tabs: Vec<SessionTab>,
    #[serde(default)]
    pub(crate) active_tab_id: String,
    #[serde(default)]
    pub(crate) window: Option<SessionWindow>,
}

impl Default for SessionData {
    fn default() -> Self {
        Self {
            version: 1,
            tabs: Vec::new(),
            active_tab_id: String::new(),
            window: None,
        }
    }
}

// One completed exchange. Stored per thread so a research session survives quitting
// the app, which is the whole point of keeping answers at all.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationTurn {
    pub(crate) id: String,
    pub(crate) prompt: String,
    pub(crate) answer: String,
    pub(crate) model: String,
    pub(crate) asked_at: String,
    pub(crate) citations: Vec<SearchResult>,
    pub(crate) metrics: ChatMetrics,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationData {
    pub(crate) version: u8,
    // Keyed by hub id, or CURRENT_PAGE_THREAD_KEY for page-only asks.
    #[serde(default)]
    pub(crate) threads: HashMap<String, Vec<ConversationTurn>>,
}

impl Default for ConversationData {
    fn default() -> Self {
        Self {
            version: 1,
            threads: HashMap::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryExportResult {
    pub(crate) path: String,
    pub(crate) exported_at: String,
    pub(crate) files: Vec<String>,
    pub(crate) capture_count: usize,
    pub(crate) chunk_count: usize,
    pub(crate) byte_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryIndexStatus {
    pub(crate) dim: usize,
    pub(crate) embedded: usize,
    pub(crate) pending_reembed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryReindexResult {
    pub(crate) embedded: usize,
    // Chunks the re-index could not embed. Non-zero means the model rejected them, so
    // the number is worth showing rather than reporting a clean success.
    pub(crate) still_pending: usize,
    pub(crate) dim: usize,
    pub(crate) reindexed_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheckResult {
    pub(crate) current_version: String,
    pub(crate) checked_at: String,
    pub(crate) update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latest_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

// The in-app install can legitimately end four ways, and only one of them is a
// failure. Collapsing "this build has no signing key", "your install method
// updates by hand", and "the endpoint has nothing for this platform" into one
// error string would leave the user with no idea which applies to them.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateInstallStatus {
    /// Downloaded, verified, and written over the installed bundle.
    Installed,
    /// No updater signing key was compiled into this build.
    Unconfigured,
    /// This platform or install method cannot replace itself in place.
    Unsupported,
    /// The updater endpoint has no newer build for this target.
    Unavailable,
}

impl UpdateInstallStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Unconfigured => "unconfigured",
            Self::Unsupported => "unsupported",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInstallResult {
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    /// Only macOS and Linux hand control back to us; the Windows installer exits
    /// the app itself, so the renderer never gets to act on this there.
    pub(crate) needs_restart: bool,
    pub(crate) message: String,
}

impl UpdateInstallResult {
    pub(crate) fn new(status: UpdateInstallStatus, message: impl Into<String>) -> Self {
        Self {
            status: status.as_str().to_string(),
            version: None,
            needs_restart: status == UpdateInstallStatus::Installed,
            message: message.into(),
        }
    }
}

#[cfg(desktop)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInstallProgress {
    pub(crate) downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total_bytes: Option<u64>,
    pub(crate) done: bool,
}

#[derive(Deserialize)]
pub(crate) struct GithubRelease {
    pub(crate) tag_name: String,
    pub(crate) name: Option<String>,
    pub(crate) html_url: String,
    pub(crate) body: Option<String>,
    pub(crate) published_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateModelsInput {
    pub(crate) embedding_model: Option<String>,
    pub(crate) chat_model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadModelsInput {
    pub(crate) chat_models: Vec<String>,
    #[serde(default)]
    pub(crate) hf_token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDownloadProgress {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) filename: String,
    pub(crate) status: String,
    pub(crate) downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) total_bytes: Option<u64>,
    pub(crate) overall_downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) overall_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusToastInput {
    pub(crate) message: String,
    pub(crate) tone: String,
    pub(crate) duration_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryData {
    pub(crate) version: u8,
    pub(crate) collections: Vec<CollectionSummary>,
    pub(crate) captures: Vec<CaptureSummary>,
    pub(crate) shortcuts: Vec<HubShortcutSummary>,
    pub(crate) migrated_realm_tables: Vec<String>,
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
pub(crate) struct UserSettings {
    #[serde(default = "default_settings_version")]
    pub(crate) version: u8,
    #[serde(default)]
    pub(crate) browser: BrowserSettings,
    #[serde(default)]
    pub(crate) developer_mode: bool,
    #[serde(default)]
    pub(crate) updates: UpdateSettings,
    #[serde(default)]
    pub(crate) appearance: Appearance,
    #[serde(default, alias = "ollama")]
    pub(crate) local_model: LocalModelSettings,
}

// Which theme the renderer stamps onto the root element. `System` follows the OS
// via prefers-color-scheme; the other two override it in both directions, so a
// user on a dark desktop can still choose the light theme.
#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalModelSettings {
    pub(crate) embedding_model: Option<String>,
    pub(crate) chat_model: Option<String>,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            default_search_engine: "google".to_string(),
        }
    }
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: default_update_auto_check(),
            last_checked_at: None,
        }
    }
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            version: default_settings_version(),
            browser: BrowserSettings::default(),
            developer_mode: false,
            updates: UpdateSettings::default(),
            appearance: Appearance::default(),
            local_model: LocalModelSettings::default(),
        }
    }
}

pub(crate) fn default_settings_version() -> u8 {
    1
}

pub(crate) fn default_update_auto_check() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
pub(crate) struct IcebergData {
    pub(crate) version: u8,
    pub(crate) icebergs: Vec<SavedIceberg>,
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
pub(crate) struct ChunkRecord {
    pub(crate) id: String,
    // Vectors live in the binary sidecar, not in this JSON. Serializing 1024 f32s as
    // decimal text cost ~12 KB per chunk and forced a full rewrite of every vector on
    // every capture; `vector_slot` is the fixed-stride index into `chunks.vec`.
    #[serde(skip)]
    pub(crate) vector: Vec<f32>,
    #[serde(default)]
    pub(crate) vector_slot: u64,
    // Set when the chunk's text is retained but its vector is not usable with the
    // store's current width — typically because the embedding model changed. Such a
    // chunk holds no sidecar slot and is invisible to semantic search until a
    // re-index re-embeds it. Keeping the text is the whole point: re-embedding is
    // local compute, whereas dropping the record would force a re-fetch of the page.
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) needs_reembed: bool,
    pub(crate) text: String,
    pub(crate) collection_id: String,
    pub(crate) capture_id: String,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) app_id: String,
    pub(crate) captured_at: String,
    pub(crate) chunk_index: usize,
}

pub(crate) fn is_false(value: &bool) -> bool {
    !*value
}

pub(crate) const VECTOR_STORE_VERSION: u8 = 2;
// Reclaim dead slots only once they dominate the file, so routine deletes stay O(1)
// instead of triggering a full rewrite each time.
pub(crate) const VECTOR_COMPACTION_MIN_SLOTS: u64 = 512;
pub(crate) const VECTOR_COMPACTION_DEAD_RATIO: f64 = 0.5;
// Re-index batch size. Small enough that progress moves visibly on a large library
// and peak memory stays bounded; large enough to keep the model's batching useful.
pub(crate) const REINDEX_BATCH_SIZE: usize = 64;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VectorStoreData {
    pub(crate) version: u8,
    // Embedding width. Fixes the sidecar stride, so the store holds exactly one width
    // at a time. A fresh store learns it from the first vector; a migrated store takes
    // the width the most chunks already use; a re-index resets it to the loaded model's.
    #[serde(default)]
    pub(crate) dim: usize,
    // Monotonic slot allocator. Counts every slot ever handed out, including slots
    // whose chunk was later deleted, so appends always land past live data.
    #[serde(default)]
    pub(crate) next_slot: u64,
    pub(crate) chunks: Vec<ChunkRecord>,
}

impl Default for VectorStoreData {
    fn default() -> Self {
        Self {
            version: VECTOR_STORE_VERSION,
            dim: 0,
            next_slot: 0,
            chunks: Vec::new(),
        }
    }
}

impl VectorStoreData {
    // Single place that hands out vector slots, so no caller can append a chunk whose
    // slot does not match its position in the sidecar.
    pub(crate) fn push_chunks(&mut self, records: impl IntoIterator<Item = ChunkRecord>) {
        for mut record in records {
            if self.dim == 0 && !record.vector.is_empty() {
                self.dim = record.vector.len();
            }
            // A chunk whose width does not match the store is parked, not discarded.
            // Dropping it would throw away the text as well, turning a re-embeddable
            // problem into one that needs the page fetched again.
            if record.vector.is_empty() || record.vector.len() != self.dim {
                if !record.vector.is_empty() {
                    diag_info!(
                        "chunk {} has {} dims (store is {}); parked for re-indexing",
                        record.id,
                        record.vector.len(),
                        self.dim
                    );
                }
                record.vector.clear();
                record.vector_slot = 0;
                record.needs_reembed = true;
                self.chunks.push(record);
                continue;
            }
            record.needs_reembed = false;
            record.vector_slot = self.next_slot;
            self.next_slot += 1;
            self.chunks.push(record);
        }
    }

    // Chunks holding a sidecar slot. Parked chunks are excluded, so this — not
    // `chunks.len()` — is what the slot accounting must be measured against.
    pub(crate) fn embedded_count(&self) -> u64 {
        self.chunks
            .iter()
            .filter(|chunk| !chunk.needs_reembed)
            .count() as u64
    }

    pub(crate) fn pending_reembed_count(&self) -> usize {
        self.chunks
            .iter()
            .filter(|chunk| chunk.needs_reembed)
            .count()
    }
}

// Vectors sit next to the metadata as `chunks.vec`.
