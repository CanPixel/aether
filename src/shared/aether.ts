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

export interface ChatResult {
  answer: string
  model: string
  citations: SearchResult[]
}

export interface IcebergItem {
  id: string
  name: string
  description: string
  level: number
  x: number
  y: number
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
    find(tabId: string, query?: string): Promise<void>
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
  }
  search: {
    collection(input: {
      collectionId: string
      query: string
      limit?: number
    }): Promise<SearchResult[]>
  }
  chat: {
    ask(input: {
      collectionId?: string
      prompt: string
      includeCurrentPage?: boolean
    }): Promise<ChatResult>
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
  }
  layout: {
    setIntelligencePanelCollapsed(collapsed: boolean): Promise<void>
    setModalOverlayOpen(open: boolean): Promise<void>
    showStatusToast(input: StatusToastInput): Promise<void>
  }
  events: {
    onState(listener: (state: AetherState) => void): () => void
    onCaptureProgress(listener: (progress: CaptureProgress) => void): () => void
    onFindRequested(listener: () => void): () => void
  }
}
