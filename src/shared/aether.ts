export interface AppSummary {
  id: string
  name: string
  category: string
  homeUrl: string
  currentUrl: string
  title: string
  isActive: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserTabSummary {
  id: string
  appId: string
  title: string
  url: string
  host: string
  isActive: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  themeColor?: string
}

export interface HubShortcutSummary {
  id: string
  title: string
  url: string
  host: string
  createdAt: string
  favicon?: string
  themeColor?: string
}

export type SearchEngineId = 'google' | 'bing' | 'yahoo' | 'ecosia' | 'duckduckgo'

export interface BrowserSettings {
  defaultSearchEngine: SearchEngineId
}

export interface UpdateSettings {
  autoCheck: boolean
  lastCheckedAt?: string
}

// 'system' follows prefers-color-scheme; 'light' and 'dark' override it in both
// directions, so a light theme stays available on a dark desktop.
export type Appearance = 'system' | 'light' | 'dark'

export interface AppSettings {
  browser: BrowserSettings
  developerMode: boolean
  updates: UpdateSettings
  appearance: Appearance
}

export interface CollectionSummary {
  id: string
  name: string
  description: string
  icon?: string
  createdAt: string
  updatedAt: string
  captureCount: number
  chunkCount: number
}

export interface CaptureSummary {
  id: string
  collectionId: string
  title: string
  url: string
  appId: string
  capturedAt: string
  chunkCount: number
  metadata?: {
    note?: string
    summary?: string
    tags?: string[]
  }
}

export interface CaptureResult extends CaptureSummary {
  collectionName: string
}

export interface BulkCaptureFailure {
  url: string
  reason: string
}

export interface BulkCaptureResult {
  captured: CaptureSummary[]
  collectionName: string
  failures: BulkCaptureFailure[]
}

export interface CaptureProgress {
  message: string
  current?: number
  total?: number
}

export interface SearchResult {
  id: string
  collectionId: string
  captureId: string
  appId: string
  title: string
  url: string
  capturedAt: string
  chunkIndex: number
  text: string
  score: number
}

export interface LibrarySearchHit {
  captureId: string
  collectionId: string
  collectionName: string
  title: string
  url: string
  host: string
  capturedAt: string
  excerpt: string
  /** 0-100 display score, not raw cosine distance. */
  score: number
  chunkMatches: number
}

export interface LibrarySearchResult {
  query: string
  hits: LibrarySearchHit[]
  /** 'literal' when no embedding model was available to rank semantically. */
  mode: 'semantic' | 'literal'
  searchedChunks: number
}

export interface SemanticTrailInput {
  query?: string
  limit?: number
}

export interface SemanticTrailRoot {
  title: string
  url: string
  host: string
  excerpt: string
}

export interface SemanticTrailScoreBreakdown {
  total: number
  semantic: number
  recency: number
}

export type SemanticTrailReason = 'semantic-match' | 'recent-capture' | 'same-collection'

export interface SemanticTrailItem {
  id: string
  collectionId: string
  collectionName: string
  captureId: string
  appId: string
  title: string
  url: string
  host: string
  capturedAt: string
  chunkIndex: number
  excerpt: string
  score: SemanticTrailScoreBreakdown
  reasons: SemanticTrailReason[]
}

export type SemanticTrailEdgeKind = 'semantic-match' | 'same-host' | 'same-collection'

export interface SemanticTrailEdge {
  from: string
  to: string
  kind: SemanticTrailEdgeKind
  weight: number
}

export interface SemanticTrailResult {
  query: string
  generatedAt: string
  root: SemanticTrailRoot
  items: SemanticTrailItem[]
  edges: SemanticTrailEdge[]
}

export type FlowGraphNodeKind = 'query' | 'hub' | 'source'
export type FlowGraphEdgeKind = 'contains' | 'semantic' | 'query-match'

export interface FlowGraphNode {
  id: string
  kind: FlowGraphNodeKind
  title: string
  subtitle: string
  weight: number
  collectionId?: string
  collectionName?: string
  captureId?: string
  url?: string
  host?: string
  capturedAt?: string
  excerpt?: string
  score?: number
}

export interface FlowGraphEdge {
  id: string
  from: string
  to: string
  kind: FlowGraphEdgeKind
  weight: number
}

export interface FlowGraphInput {
  query?: string
  sourceLimit?: number
}

export interface FlowGraphResult {
  query: string
  generatedAt: string
  nodes: FlowGraphNode[]
  edges: FlowGraphEdge[]
  hubCount: number
  sourceCount: number
  omittedSourceCount: number
}

export interface CaptureHubSuggestion {
  collectionId: string
  collectionName: string
  confidence: number
  sampleTitle: string
}

export interface ChatResult {
  answer: string
  model: string
  citations: SearchResult[]
  metrics: ChatMetrics
}

export interface ChatMetrics {
  generatedTokens: number
  tokensPerSecond: number
  elapsedSeconds: number
  chunks: number
}

/** One completed exchange, persisted per hub (or per current-page thread). */
export interface ConversationTurn {
  id: string
  prompt: string
  answer: string
  model: string
  askedAt: string
  citations: SearchResult[]
  metrics: ChatMetrics
}

export type AirLensKind = 'topic' | 'flow' | 'hub' | 'answer' | 'iceberg'

export interface AirDossierInput {
  lens: string
  lensKind?: AirLensKind
  collectionId?: string
  captureId?: string
  savedIcebergId?: string
  answer?: ChatResult
  limit?: number
}

export interface AirDossierSource {
  id: string
  title: string
  excerpt: string
  collectionName?: string
  url?: string
  host?: string
  capturedAt?: string
  score?: number
}

export interface AirPreparedDossier {
  title: string
  lens: string
  lensKind: AirLensKind
  generatedAt: string
  model?: string
  outputDir: string
  markdownPreview: string
  sources: AirDossierSource[]
}

export interface AirRenderResult {
  path: string
  filename: string
  title: string
  sourceCount: number
  renderedAt: string
}

export interface AirRecentFile extends AirRenderResult {
  lens: string
}

/** Emitted while a webview download starts, completes, or fails. */
export interface DownloadProgress {
  status: 'started' | 'finished' | 'failed'
  filename: string
  path?: string
  url: string
}

export interface ChatStreamEvent {
  requestId: string
  status?: string
  delta?: string
  citations?: SearchResult[]
}

export interface IcebergItem {
  id: string
  name: string
  description: string
  level: number
  x: number
  y: number
  depthScore?: number
  familiarity?: number
  specificity?: number
  jargonDensity?: number
  prerequisiteDepth?: number
  obscurity?: number
  reason?: string
}

export interface IcebergResult {
  keyword: string
  model: string
  items: IcebergItem[]
  generatedAt: string
}

export interface SavedIcebergSummary {
  id: string
  title: string
  keyword: string
  model: string
  icon?: string
  generatedAt: string
  savedAt: string
  updatedAt: string
  itemCount: number
}

export interface SavedIceberg extends IcebergResult {
  id: string
  title: string
  icon?: string
  savedAt: string
  updatedAt: string
}

export interface SaveIcebergInput {
  title: string
  keyword: string
  model: string
  icon?: string
  generatedAt: string
  items: IcebergItem[]
}

export interface SystemStatus {
  runtimeReady: boolean
  runtimeName: string
  embeddingModel: string | null
  chatModel: string | null
  availableModels: string[]
  chatModels: string[]
  embeddingModels: string[]
  modelDir: string
  dbPath: string
  libraryPath: string
  collections: CollectionSummary[]
  error?: string
}

export interface LibraryExportResult {
  path: string
  exportedAt: string
  files: string[]
  captureCount: number
  chunkCount: number
  byteSize: number
}

export interface LibraryIndexStatus {
  /** Embedding width the store is built around. 0 before anything is indexed. */
  dim: number
  embedded: number
  /** Chunks whose text is kept but whose vector is unusable until a re-index. */
  pendingReembed: number
}

export interface LibraryReindexResult {
  embedded: number
  stillPending: number
  dim: number
  reindexedAt: string
}

export interface UpdateCheckResult {
  currentVersion: string
  checkedAt: string
  updateAvailable: boolean
  latestVersion?: string
  latestName?: string
  releaseUrl?: string
  releaseNotes?: string
  publishedAt?: string
  error?: string
}

// `installed` is the only success. The other three are distinct reasons the app
// cannot update itself, and the UI has to tell them apart: `unconfigured` means
// this build has no signing key, `unsupported` means the install method is owned
// by a package manager or an app store, `unavailable` means the signed manifest
// has nothing newer for this platform even though a release exists.
export type UpdateInstallStatus = 'installed' | 'unconfigured' | 'unsupported' | 'unavailable'

export interface UpdateInstallResult {
  status: UpdateInstallStatus
  version?: string
  needsRestart: boolean
  message: string
}

export interface UpdateInstallProgress {
  downloadedBytes: number
  totalBytes?: number
  done: boolean
}

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface DiagnosticEntry {
  at: string
  level: DiagnosticLevel
  message: string
}

export interface DiagnosticsExportResult {
  path: string
  filename: string
  byteSize: number
  exportedAt: string
}

export type ModelDownloadChoice = 'lite' | 'wise'
export type ModelDownloadStatus = 'queued' | 'downloading' | 'skipped' | 'complete' | 'error'

export interface ModelDownloadProgress {
  id: string
  label: string
  filename: string
  status: ModelDownloadStatus
  downloadedBytes: number
  totalBytes?: number
  overallDownloadedBytes: number
  overallTotalBytes?: number
  message?: string
}

export interface AetherState {
  apps: AppSummary[]
  tabs: BrowserTabSummary[]
  activeAppId: string
  activeTabId: string
  dashboardOpen: boolean
  panelCollapsed: boolean
}

export type StatusToastTone = 'info' | 'success' | 'error'

export interface StatusToastInput {
  message: string
  tone: StatusToastTone
  durationMs?: number
}

export type AetherShortcutId =
  | 'focus-address'
  | 'new-tab'
  | 'open-dashboard'
  | 'open-ice'
  | 'open-browser'
  | 'toggle-aion'
  | 'capture-page'
  | 'find-page'

export interface AetherApi {
  apps: {
    list(): Promise<AppSummary[]>
    activate(appId: string): Promise<void>
    navigate(appId: string, url: string): Promise<void>
    goBack(appId: string): Promise<void>
    goForward(appId: string): Promise<void>
  }
  tabs: {
    list(): Promise<BrowserTabSummary[]>
    create(input?: { url?: string }): Promise<BrowserTabSummary>
    activate(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
    reorder(ids: string[]): Promise<BrowserTabSummary[]>
    navigate(tabId: string, url: string): Promise<void>
    scrollToText(tabId: string, text: string): Promise<void>
    find(tabId: string, query?: string, action?: FindAction): Promise<void>
    goBack(tabId: string): Promise<void>
    goForward(tabId: string): Promise<void>
    // Android-only tab-grid preview (data-URI JPEG); resolves null on desktop.
    thumbnail(tabId: string): Promise<string | null>
  }
  dashboard: {
    open(): Promise<void>
  }
  hub: {
    list(): Promise<HubShortcutSummary[]>
    create(input: {
      title: string
      url: string
      favicon?: string
      themeColor?: string
    }): Promise<HubShortcutSummary>
    reorder(ids: string[]): Promise<HubShortcutSummary[]>
    delete(id: string): Promise<void>
  }
  collections: {
    list(): Promise<CollectionSummary[]>
    create(input: { name: string; description?: string; icon?: string }): Promise<CollectionSummary>
    update(input: {
      id: string
      name?: string
      description?: string
      icon?: string
    }): Promise<CollectionSummary>
    reorder(ids: string[]): Promise<CollectionSummary[]>
    delete(id: string): Promise<void>
    captures(collectionId: string): Promise<CaptureSummary[]>
  }
  capture: {
    currentPage(input: { collectionId: string }): Promise<CaptureResult>
    // Captures a page ÆTHER never loaded, by fetching the URL directly.
    url(input: { collectionId: string; url: string }): Promise<CaptureResult>
    // Bulk sibling of url(); reports per-link failures instead of aborting.
    urls(input: { collectionId: string; urls: string[] }): Promise<BulkCaptureResult>
    move(input: { captureId: string; collectionId: string }): Promise<CaptureSummary>
    delete(captureId: string): Promise<void>
    suggestHub(): Promise<CaptureHubSuggestion | null>
  }
  search: {
    collection(input: {
      collectionId: string
      query: string
      limit?: number
    }): Promise<SearchResult[]>
    // Grouped one-row-per-source search. Omit collectionId to search every hub.
    library(input: {
      query: string
      collectionId?: string
      limit?: number
    }): Promise<LibrarySearchResult>
  }
  semanticTrail: {
    generate(input?: SemanticTrailInput): Promise<SemanticTrailResult>
  }
  flow: {
    graph(input?: FlowGraphInput): Promise<FlowGraphResult>
  }
  air: {
    prepare(input: AirDossierInput): Promise<AirPreparedDossier>
    render(input: AirDossierInput): Promise<AirRenderResult>
    listRecent(): Promise<AirRecentFile[]>
    open(path: string): Promise<void>
    reveal(path: string): Promise<void>
  }
  chat: {
    ask(input: {
      collectionId?: string
      prompt: string
      includeCurrentPage?: boolean
      requestId?: string
    }): Promise<ChatResult>
    cancel(): Promise<void>
    // Omit collectionId for the current-page thread.
    history(collectionId?: string): Promise<ConversationTurn[]>
    clearHistory(collectionId?: string): Promise<void>
  }
  crystallizer: {
    generate(input: { keyword: string }): Promise<IcebergResult>
    listSaved(): Promise<SavedIcebergSummary[]>
    getSaved(id: string): Promise<SavedIceberg>
    save(input: SaveIcebergInput): Promise<SavedIceberg>
    reorderSaved(ids: string[]): Promise<SavedIcebergSummary[]>
    deleteSaved(id: string): Promise<void>
  }
  system: {
    status(): Promise<SystemStatus>
    settings(): Promise<AppSettings>
    updateSettings(input: Partial<AppSettings>): Promise<AppSettings>
    updateModels(input: { embeddingModel?: string; chatModel?: string }): Promise<SystemStatus>
    checkForUpdate(): Promise<UpdateCheckResult>
    // Downloads, signature-verifies, and installs the newest signed release.
    // Reads the updater manifest, not the GitHub API that checkForUpdate uses, so
    // the two can legitimately disagree — see UpdateInstallStatus.
    installUpdate(): Promise<UpdateInstallResult>
    // Quits and relaunches. Only meaningful after installUpdate reported
    // needsRestart, and never returns when it succeeds.
    relaunch(): Promise<void>
    // Snapshots every local store into a timestamped folder and reveals it.
    exportLibrary(): Promise<LibraryExportResult>
    // Recent operational log entries, newest first. Local only — see
    // src-tauri/src/diagnostics.rs for what is deliberately never recorded.
    diagnostics(): Promise<DiagnosticEntry[]>
    // Copies the log somewhere attachable and reveals it. The only way anything
    // here leaves the machine, and only when the user asks.
    exportDiagnostics(): Promise<DiagnosticsExportResult>
    // Loads the vector store, so Settings asks for this on open rather than at startup.
    indexStatus(): Promise<LibraryIndexStatus>
    // Re-embeds retained chunk text with the loaded model. The only way to recover
    // chunks embedded by a previous model, whose widths cannot be compared.
    reindexLibrary(): Promise<LibraryReindexResult>
    openExternalUrl(url: string): Promise<void>
    downloadModels(input: {
      chatModels: ModelDownloadChoice[]
      hfToken?: string
    }): Promise<SystemStatus>
  }
  layout: {
    setIntelligencePanelCollapsed(collapsed: boolean): Promise<void>
    setModalOverlayOpen(open: boolean): Promise<void>
    showStatusToast(input: StatusToastInput): Promise<void>
    // Edge-to-edge system-bar insets in CSS px (Android); zeros on desktop.
    windowInsets(): Promise<{ top: number; bottom: number; left: number; right: number }>
    // Where live web content belongs, in CSS px. Both shells report it; the native
    // webviews (desktop child webviews, Android WebViews) are positioned from it.
    setWebContentBounds(bounds: WebContentBounds): Promise<void>
  }
  events: {
    onState(listener: (state: AetherState) => void): () => void
    onCaptureProgress(listener: (progress: CaptureProgress) => void): () => void
    onModelDownloadProgress(listener: (progress: ModelDownloadProgress) => void): () => void
    onUpdateProgress(listener: (progress: UpdateInstallProgress) => void): () => void
    onChatStream(listener: (event: ChatStreamEvent) => void): () => void
    onDownload(listener: (progress: DownloadProgress) => void): () => void
    onShortcut(listener: (shortcut: AetherShortcutId) => void): () => void
    onFindRequested(listener: () => void): () => void
    onFindResult(listener: (result: FindResult) => void): () => void
  }
}

export type FindAction = 'find' | 'next' | 'prev' | 'clear'

export interface FindResult {
  tabId: string
  current: number
  total: number
}

export interface WebContentBounds {
  top: number
  left: number
  width: number
  height: number
}

// Payload the Kotlin TabsPlugin delivers through window.__AETHER_TAB_EVENT__;
// forwarded verbatim to the aether_tabs_report_native_event command.
export interface NativeTabEvent {
  tabId: string
  kind: 'navigation' | 'title' | 'find' | 'scroll'
  url?: string
  title?: string
  isLoading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  current?: number
  total?: number
  scrollY?: number
  deltaY?: number
}

// Renderer-local DOM event dispatched for NativeTabEvent kind "scroll"; the
// mobile chrome listens for it to auto-hide. Never forwarded to Rust.
export const MOBILE_TAB_SCROLL_EVENT = 'aether:mobile-tab-scroll'
