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

export interface AppSettings {
  browser: BrowserSettings
  developerMode: boolean
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
  confidence?: number
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
    navigate(tabId: string, url: string): Promise<void>
    scrollToText(tabId: string, text: string): Promise<void>
    find(tabId: string, query?: string, action?: FindAction): Promise<void>
    goBack(tabId: string): Promise<void>
    goForward(tabId: string): Promise<void>
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
    downloadModels(input: {
      chatModels: ModelDownloadChoice[]
      hfToken?: string
    }): Promise<SystemStatus>
  }
  layout: {
    setIntelligencePanelCollapsed(collapsed: boolean): Promise<void>
    setModalOverlayOpen(open: boolean): Promise<void>
    showStatusToast(input: StatusToastInput): Promise<void>
  }
  events: {
    onState(listener: (state: AetherState) => void): () => void
    onCaptureProgress(listener: (progress: CaptureProgress) => void): () => void
    onModelDownloadProgress(listener: (progress: ModelDownloadProgress) => void): () => void
    onChatStream(listener: (event: ChatStreamEvent) => void): () => void
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
