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
  // Non-persistent webview data store, never written to the session. Capture and
  // AiON both read these normally — they are local writes, not emissions — and a
  // capture from one is marked with `fromPrivateTab` so it stays findable.
  isPrivate: boolean
  // Opt-in storage partition. Cookies and local storage are isolated from the
  // default jar and from every other container, and persist across restarts.
  // macOS 14+ only; elsewhere the tab shares the default store.
  container?: string
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
  // Ask the search engine for results without AI-generated answers. On unless
  // turned off, including for settings files written before the field existed.
  // What it actually sends depends on the engine — see SystemStatus.aiFreeSearch.
  aiFreeSearch: boolean
  proxy: ProxySettings
  // Report UTC and a fixed locale to pages. Off by default: the cost (wrong local
  // times in web calendars) is visible in ordinary use and the benefit is not.
  pinTimezone: boolean
}

// Off by default, unlike aiFreeSearch: a proxy pointing at a daemon that isn't
// running fails every request, so it waits to be asked for.
export interface ProxySettings {
  enabled: boolean
  // socks5://host:port, or http://host:port for an HTTP CONNECT proxy.
  url: string
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

// Mirrors UpdateSettingsInput in src-tauri/src/types.rs, where every field of every
// group is optional. `Partial<AppSettings>` was not the same thing: it makes the
// groups optional but each group whole, so sending one field of `browser` only
// type-checked while BrowserSettings happened to have exactly one field.
// `browser.proxy` needs the same treatment one level down: Partial<BrowserSettings>
// would make `proxy` optional but whole, so toggling `enabled` alone would force
// the caller to resend `url`. PartialProxySettings mirrors the Rust type instead.
export interface UpdateSettingsInput {
  browser?: Omit<Partial<BrowserSettings>, 'proxy'> & { proxy?: Partial<ProxySettings> }
  developerMode?: boolean
  updates?: Partial<UpdateSettings>
  appearance?: Appearance
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
  /** Provenance for the locally extracted representation of the live web source. */
  provenance?: {
    receiptVersion: number
    extractorVersion: string
    requestedUrl?: string
    canonicalUrl?: string
    author?: string
    publishedAt?: string
    siteName?: string
    language?: string
    /** SHA-256 of the normalized text that was chunked and embedded. */
    contentHash: string
    extractionMethod: 'live-dom' | 'http-fetch'
    contentScope: 'page' | 'selection'
    contentSelector: string
    wordCount: number
    fallbackReason?: string
    selectionContextBefore?: string
    selectionContextAfter?: string
  }
  // Present only when the source came out of a private tab. Library hygiene, not
  // a privacy control: it keeps private-session research findable so it can be
  // purged later, rather than blending into every other source.
  fromPrivateTab?: boolean
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
  contentBlocking: ContentBlockingStatus
  aiFreeSearch: AiFreeSearchStatus
  proxy: ProxyStatus
  timezonePin: TimezonePinStatus
  error?: string
}

// Whether traffic is genuinely being proxied, which is not the same as whether
// the setting is on: proxying needs macOS 14+ and is unavailable on Android.
// A search engine ignoring an AI opt-out shows an AI answer; a proxy silently
// doing nothing shows the page over the user's own IP, so `active` is the only
// field an "IP hidden" affordance should key off.
// Whether pages are actually being told UTC. Separate from the setting because
// the mobile shell has nowhere to inject the document-start script that does it.
export interface TimezonePinStatus {
  enabled: boolean
  available: boolean
  unsupportedReason?: string
  active: boolean
}

export interface ProxyStatus {
  enabled: boolean
  url: string
  available: boolean
  unsupportedReason?: string
  active: boolean
}

// Reported by the backend rather than inferred from the user agent: the three
// platforms block genuinely different things, and a claim hardcoded here would
// keep asserting cookie blocking on Windows long after anyone remembered that
// WebView2 has no equivalent for it.
// Reported per selected engine, for the same reason as ContentBlockingStatus: the
// five engines have five unrelated answers and two of them have none, so a fixed
// string here would keep promising AI-free results on Yahoo forever.
export interface AiFreeSearchStatus {
  enabled: boolean
  // What is actually sent: "udm=14 Web filter", "-ai operator",
  // "noai.duckduckgo.com". Empty when the engine offers nothing.
  mechanism: string
  // False when the selected engine has no URL-level opt-out (Yahoo has no control
  // of its own; Ecosia's is an account setting, and region-gated). `enabled` with
  // `available: false` is a real state and the UI should say so rather than imply
  // the toggle did something.
  available: boolean
}

export interface ContentBlockingStatus {
  // Human-readable name of the engine doing the blocking, e.g. "WebKit content
  // rules". Empty when there is none.
  engine: string
  blockedHostCount: number
  // False on Windows. A tracker that is not on the host list still sets
  // third-party cookies there.
  blocksThirdPartyCookies: boolean
  available: boolean
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
    create(input?: {
      url?: string
      // Search terms, for callers holding a concept rather than a URL. Kept apart
      // from `url` because the backend has to guess whether a bare string is a
      // query or a host, and it guesses on the presence of a dot — so a concept
      // named "Node.js" would open https://Node.js instead of being searched for.
      // Takes precedence over `url` when both are given.
      search?: string
      private?: boolean
      container?: string
    }): Promise<BrowserTabSummary>
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
    // Site icon as a data URI, fetched in Rust. The privileged window must not
    // request one directly: that is an outbound call to every visited host from
    // the context that holds the IPC bridge. Resolves null when there is none.
    favicon(url: string): Promise<string | null>
    // Clears the shared webview data store: cookies, caches, local storage.
    // Touches nothing ÆTHER stores itself, and leaves private and container tabs
    // alone — they have their own stores. Desktop only; on Windows it needs
    // WebView2 runtime 1.0.1518.46 or newer and reports when it does not have it.
    // See docs/SECURITY.md.
    clearBrowsingData(): Promise<void>
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
    selection(input: { collectionId: string }): Promise<CaptureResult>
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
    updateSettings(input: UpdateSettingsInput): Promise<AppSettings>
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
