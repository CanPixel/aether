import { app, BrowserWindow, ipcMain, shell, WebContentsView } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as lancedb from '@lancedb/lancedb'
import type { Connection, Table } from '@lancedb/lancedb'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { RecursiveCharacterTextSplitter } from '@langchain/classic/text_splitter'
import {
  AetherState,
  AppSummary,
  BrowserTabSummary,
  CaptureResult,
  CaptureSummary,
  ChatResult,
  CollectionSummary,
  HubShortcutSummary,
  SearchResult,
  SystemStatus
} from '../shared/aether'

const SIDEBAR_WIDTH = 76
const TOP_BAR_HEIGHT = 130
const PANEL_WIDTH = 404
const PANEL_COLLAPSED_WIDTH = 58
const CHUNKS_TABLE = 'chunks'
const EMBEDDING_MODEL = 'nomic-embed-text'
const PREFERRED_CHAT_MODELS = ['llama3.1:8b', 'gemma3:latest', 'gemma3']
const MIN_CAPTURE_TEXT_LENGTH = 120
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

interface AppDefinition {
  id: string
  name: string
  category: string
  homeUrl: string
}

interface ManagedTab {
  id: string
  appId: string
  view: WebContentsView
  url: string
  title: string
  isLoading: boolean
  favicon?: string
}

interface CapturedPage {
  title: string
  url: string
  text: string
}

interface ChunkRecord {
  id: string
  vector: number[]
  text: string
  collectionId: string
  captureId: string
  title: string
  url: string
  appId: string
  capturedAt: string
  chunkIndex: number
}

interface LibraryData {
  version: 1
  collections: CollectionSummary[]
  captures: CaptureSummary[]
  shortcuts: HubShortcutSummary[]
  migratedRealmTables: string[]
}

interface UserSettings {
  version: 1
  ollama: {
    embeddingModel: string | null
    chatModel: string | null
  }
}

interface OllamaTagsResponse {
  models: Array<{ name: string; model?: string }>
}

interface OllamaEmbedResponse {
  model: string
  embeddings: number[][]
}

interface OllamaChatResponse {
  model: string
  message: {
    role: string
    content: string
  }
}

const APP_DEFINITIONS: AppDefinition[] = [
  { id: 'browser', name: 'Browser', category: 'Web', homeUrl: 'https://www.google.com' }
]

class LibraryStore {
  private data: LibraryData | null = null

  constructor(private readonly libraryPath: string) {}

  get path(): string {
    return this.libraryPath
  }

  async listCollections(): Promise<CollectionSummary[]> {
    const data = await this.load()
    return [...data.collections].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async listShortcuts(): Promise<HubShortcutSummary[]> {
    const data = await this.load()
    return [...data.shortcuts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async createShortcut(input: { title: string; url: string }): Promise<HubShortcutSummary> {
    const title = input.title.trim()
    const url = normalizeUrl(input.url)
    if (!title) {
      throw new Error('Shortcut title is required.')
    }

    const data = await this.load()
    const existing = data.shortcuts.find((shortcut) => shortcut.url === url)
    if (existing) return existing

    const shortcut: HubShortcutSummary = {
      id: crypto.randomUUID(),
      title,
      url,
      host: getTabHost(url),
      createdAt: new Date().toISOString()
    }
    data.shortcuts.unshift(shortcut)
    await this.save(data)
    return shortcut
  }

  async deleteShortcut(id: string): Promise<void> {
    const data = await this.load()
    data.shortcuts = data.shortcuts.filter((shortcut) => shortcut.id !== id)
    await this.save(data)
  }

  async listCaptures(collectionId: string): Promise<CaptureSummary[]> {
    const data = await this.load()
    return data.captures
      .filter((capture) => capture.collectionId === collectionId)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  }

  async getCollection(collectionId: string): Promise<CollectionSummary> {
    const data = await this.load()
    const collection = data.collections.find((item) => item.id === collectionId)
    if (!collection) {
      throw new Error('Collection not found.')
    }

    return collection
  }

  async createCollection(input: {
    name: string
    description?: string
    icon?: string
  }): Promise<CollectionSummary> {
    const name = input.name.trim()
    if (!name) {
      throw new Error('Collection name is required.')
    }

    const data = await this.load()
    const now = new Date().toISOString()
    const collection: CollectionSummary = {
      id: uniqueSlug(
        name,
        data.collections.map((item) => item.id)
      ),
      name,
      description: input.description?.trim() ?? '',
      icon: input.icon?.trim() || 'book',
      createdAt: now,
      updatedAt: now,
      captureCount: 0,
      chunkCount: 0
    }

    data.collections.push(collection)
    await this.save(data)
    return collection
  }

  async updateCollection(input: {
    id: string
    name?: string
    description?: string
    icon?: string
  }): Promise<CollectionSummary> {
    const data = await this.load()
    const collection = data.collections.find((item) => item.id === input.id)
    if (!collection) {
      throw new Error('Collection not found.')
    }

    if (typeof input.name === 'string') {
      const name = input.name.trim()
      if (!name) {
        throw new Error('Collection name is required.')
      }
      collection.name = name
    }
    if (typeof input.description === 'string') {
      collection.description = input.description.trim()
    }
    if (typeof input.icon === 'string') {
      collection.icon = input.icon.trim() || 'book'
    }
    collection.updatedAt = new Date().toISOString()

    await this.save(data)
    return collection
  }

  async deleteCollection(collectionId: string): Promise<void> {
    const data = await this.load()
    data.collections = data.collections.filter((item) => item.id !== collectionId)
    data.captures = data.captures.filter((item) => item.collectionId !== collectionId)
    await this.save(data)
  }

  async addCapture(capture: CaptureSummary): Promise<void> {
    const data = await this.load()
    const collection = data.collections.find((item) => item.id === capture.collectionId)
    if (!collection) {
      throw new Error('Collection not found.')
    }

    data.captures.push(capture)
    collection.captureCount += 1
    collection.chunkCount += capture.chunkCount
    collection.updatedAt = capture.capturedAt
    await this.save(data)
  }

  async deleteCapture(captureId: string): Promise<CaptureSummary | null> {
    const data = await this.load()
    const capture = data.captures.find((item) => item.id === captureId) ?? null
    if (!capture) return null

    data.captures = data.captures.filter((item) => item.id !== captureId)
    const collection = data.collections.find((item) => item.id === capture.collectionId)
    if (collection) {
      collection.captureCount = Math.max(0, collection.captureCount - 1)
      collection.chunkCount = Math.max(0, collection.chunkCount - capture.chunkCount)
      collection.updatedAt = new Date().toISOString()
    }

    await this.save(data)
    return capture
  }

  async moveCapture(captureId: string, collectionId: string): Promise<CaptureSummary> {
    const data = await this.load()
    const capture = data.captures.find((item) => item.id === captureId)
    if (!capture) {
      throw new Error('Capture not found.')
    }

    const targetCollection = data.collections.find((item) => item.id === collectionId)
    if (!targetCollection) {
      throw new Error('Target collection not found.')
    }

    if (capture.collectionId === collectionId) return capture

    const sourceCollection = data.collections.find((item) => item.id === capture.collectionId)
    const now = new Date().toISOString()

    if (sourceCollection) {
      sourceCollection.captureCount = Math.max(0, sourceCollection.captureCount - 1)
      sourceCollection.chunkCount = Math.max(0, sourceCollection.chunkCount - capture.chunkCount)
      sourceCollection.updatedAt = now
    }

    capture.collectionId = collectionId
    targetCollection.captureCount += 1
    targetCollection.chunkCount += capture.chunkCount
    targetCollection.updatedAt = now

    await this.save(data)
    return capture
  }

  async addMigratedCollection(
    collection: CollectionSummary,
    captures: CaptureSummary[],
    tableName: string
  ): Promise<void> {
    const data = await this.load()
    if (data.migratedRealmTables.includes(tableName)) return

    data.collections.push(collection)
    data.captures.push(...captures)
    data.migratedRealmTables.push(tableName)
    await this.save(data)
  }

  async hasMigrated(tableName: string): Promise<boolean> {
    const data = await this.load()
    return data.migratedRealmTables.includes(tableName)
  }

  private async load(): Promise<LibraryData> {
    if (this.data) return this.data

    try {
      const raw = await readFile(this.libraryPath, 'utf8')
      this.data = JSON.parse(raw) as LibraryData
      this.data.shortcuts ??= []
      this.data.migratedRealmTables ??= []
    } catch {
      this.data = {
        version: 1,
        collections: [],
        captures: [],
        shortcuts: [],
        migratedRealmTables: []
      }
      await this.save(this.data)
    }

    return this.data
  }

  private async save(data: LibraryData): Promise<void> {
    await mkdir(dirname(this.libraryPath), { recursive: true })
    await writeFile(this.libraryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    this.data = data
  }
}

class SettingsStore {
  private data: UserSettings | null = null

  constructor(private readonly settingsPath: string) {}

  get path(): string {
    return this.settingsPath
  }

  async load(): Promise<UserSettings> {
    if (this.data) return this.data

    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UserSettings>
      this.data = {
        version: 1,
        ollama: {
          embeddingModel: parsed.ollama?.embeddingModel ?? null,
          chatModel: parsed.ollama?.chatModel ?? null
        }
      }
    } catch {
      this.data = {
        version: 1,
        ollama: {
          embeddingModel: null,
          chatModel: null
        }
      }
      await this.save(this.data)
    }

    return this.data
  }

  async updateModels(input: {
    embeddingModel?: string
    chatModel?: string
  }): Promise<UserSettings> {
    const data = await this.load()
    if (typeof input.embeddingModel === 'string') {
      data.ollama.embeddingModel = input.embeddingModel.trim() || null
    }
    if (typeof input.chatModel === 'string') {
      data.ollama.chatModel = input.chatModel.trim() || null
    }

    await this.save(data)
    return data
  }

  private async save(data: UserSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true })
    await writeFile(this.settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    this.data = data
  }
}

class AetherDatabase {
  private connection: Connection | null = null

  constructor(private readonly dbPath: string) {}

  get path(): string {
    return this.dbPath
  }

  async addChunks(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return

    const { table, created } = await this.getOrCreateChunksTable(records)
    if (created) return

    await table.add(records.map(asLanceRecord))
  }

  async searchCollection(
    collectionId: string,
    queryVector: number[],
    limit = 8
  ): Promise<SearchResult[]> {
    if (!(await this.hasTable(CHUNKS_TABLE))) return []

    const table = await this.openChunksTable()
    const rows = await table
      .vectorSearch(queryVector)
      .where(`collectionId = '${escapeSql(collectionId)}'`)
      .limit(limit)
      .toArray()

    return (rows as Array<ChunkRecord & { _distance?: number }>)
      .map(toSearchResult)
      .sort((a, b) => a.score - b.score)
  }

  async deleteCapture(captureId: string): Promise<void> {
    if (!(await this.hasTable(CHUNKS_TABLE))) return

    const table = await this.openChunksTable()
    await table.delete(`captureId = '${escapeSql(captureId)}'`)
  }

  async moveCapture(captureId: string, collectionId: string): Promise<void> {
    if (!(await this.hasTable(CHUNKS_TABLE))) return

    const table = await this.openChunksTable()
    await table.update({
      where: `captureId = '${escapeSql(captureId)}'`,
      values: { collectionId }
    })
  }

  async deleteCollection(collectionId: string): Promise<void> {
    if (!(await this.hasTable(CHUNKS_TABLE))) return

    const table = await this.openChunksTable()
    await table.delete(`collectionId = '${escapeSql(collectionId)}'`)
  }

  async migrateLegacyRealms(library: LibraryStore): Promise<void> {
    const db = await this.getConnection()
    const tableNames = (await db.tableNames()).filter((name) => name !== CHUNKS_TABLE)

    for (const tableName of tableNames) {
      if (await library.hasMigrated(tableName)) continue

      const legacyTable = await db.openTable(tableName)
      const rows = (await legacyTable.query().toArray()) as Array<
        Partial<ChunkRecord> & { realmId?: string }
      >
      if (rows.length === 0) continue

      const now = new Date().toISOString()
      const collectionId = uniqueSlug(
        tableName,
        (await library.listCollections()).map((item) => item.id)
      )
      const grouped = new Map<string, Array<Partial<ChunkRecord> & { realmId?: string }>>()

      for (const row of rows) {
        const key = `${row.url ?? 'unknown'}::${row.capturedAt ?? now}`
        grouped.set(key, [...(grouped.get(key) ?? []), row])
      }

      const captures: CaptureSummary[] = Array.from(grouped.values()).map((group) => ({
        id: crypto.randomUUID(),
        collectionId,
        title: group[0].title ?? humanizeId(tableName),
        url: group[0].url ?? '',
        appId: group[0].appId ?? 'legacy',
        capturedAt: group[0].capturedAt ?? now,
        chunkCount: group.length
      }))

      const captureIdsByKey = new Map(
        Array.from(grouped.keys()).map((key, index) => [key, captures[index].id])
      )
      const records: ChunkRecord[] = rows
        .filter(
          (row): row is Partial<ChunkRecord> & { vector: number[]; text: string } =>
            Array.isArray(row.vector) && typeof row.text === 'string'
        )
        .map((row, index) => {
          const key = `${row.url ?? 'unknown'}::${row.capturedAt ?? now}`
          return {
            id: row.id ?? crypto.randomUUID(),
            vector: row.vector,
            text: row.text,
            collectionId,
            captureId: captureIdsByKey.get(key) ?? captures[0].id,
            title: row.title ?? humanizeId(tableName),
            url: row.url ?? '',
            appId: row.appId ?? 'legacy',
            capturedAt: row.capturedAt ?? now,
            chunkIndex: row.chunkIndex ?? index
          }
        })

      if (records.length > 0) {
        await this.addChunks(records)
      }

      await library.addMigratedCollection(
        {
          id: collectionId,
          name: humanizeId(tableName),
          description: `Migrated from legacy realm table "${tableName}".`,
          createdAt: now,
          updatedAt: now,
          captureCount: captures.length,
          chunkCount: records.length
        },
        captures,
        tableName
      )
    }
  }

  private async getConnection(): Promise<Connection> {
    if (!this.connection) {
      this.connection = await lancedb.connect(this.dbPath)
    }

    return this.connection
  }

  private async openChunksTable(): Promise<Table> {
    const db = await this.getConnection()
    return db.openTable(CHUNKS_TABLE)
  }

  private async getOrCreateChunksTable(
    records: ChunkRecord[]
  ): Promise<{ table: Table; created: boolean }> {
    const db = await this.getConnection()
    if (await this.hasTable(CHUNKS_TABLE)) {
      return { table: await db.openTable(CHUNKS_TABLE), created: false }
    }

    const table = await db.createTable(CHUNKS_TABLE, records.map(asLanceRecord), {
      mode: 'create',
      existOk: true
    })

    return { table, created: true }
  }

  private async hasTable(tableName: string): Promise<boolean> {
    const db = await this.getConnection()
    const names = await db.tableNames()
    return names.includes(tableName)
  }
}

class OllamaClient {
  private embeddingModelOverride: string | null = null
  private chatModelOverride: string | null = null

  setModelOverrides(input: { embeddingModel?: string | null; chatModel?: string | null }): void {
    if ('embeddingModel' in input) {
      this.embeddingModelOverride = input.embeddingModel?.trim() || null
    }
    if ('chatModel' in input) {
      this.chatModelOverride = input.chatModel?.trim() || null
    }
  }

  async status(library: LibraryStore, db: AetherDatabase): Promise<SystemStatus> {
    try {
      const availableModels = await this.listModels()
      return {
        ollamaReachable: true,
        embeddingModel: this.pickEmbeddingModel(availableModels),
        chatModel: this.pickChatModel(availableModels),
        availableModels,
        dbPath: db.path,
        libraryPath: library.path,
        collections: await library.listCollections()
      }
    } catch (error) {
      return {
        ollamaReachable: false,
        embeddingModel: EMBEDDING_MODEL,
        chatModel: null,
        availableModels: [],
        dbPath: db.path,
        libraryPath: library.path,
        collections: await library.listCollections(),
        error: error instanceof Error ? error.message : 'Unable to reach Ollama.'
      }
    }
  }

  async updateModels(
    library: LibraryStore,
    db: AetherDatabase,
    input: { embeddingModel?: string; chatModel?: string }
  ): Promise<SystemStatus> {
    this.setModelOverrides(input)
    return this.status(library, db)
  }

  async listModels(): Promise<string[]> {
    const response = await this.request<OllamaTagsResponse>('/api/tags', {
      method: 'GET',
      timeoutMs: 4000
    })
    return response.models.map((model) => model.name)
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const models = await this.listModels()
    const model = this.pickEmbeddingModel(models)
    if (!model) {
      throw new Error(`Ollama embedding model "${EMBEDDING_MODEL}" is not installed.`)
    }

    const inputs = Array.isArray(input) ? input : [input]
    const embeddings: number[][] = []

    for (let index = 0; index < inputs.length; index += 8) {
      const batch = inputs.slice(index, index + 8)
      const response = await this.request<OllamaEmbedResponse>('/api/embed', {
        method: 'POST',
        body: { model, input: batch },
        timeoutMs: 120000
      })
      embeddings.push(...response.embeddings)
    }

    return embeddings
  }

  async chat(prompt: string, context: SearchResult[]): Promise<ChatResult> {
    const models = await this.listModels()
    const model = this.pickChatModel(models)
    if (!model) {
      throw new Error('No local chat model found in Ollama. Install llama3.1:8b or gemma3.')
    }

    const contextBlock = context
      .map(
        (item, index) =>
          `[${index + 1}] ${item.title}\nURL: ${item.url}\nCollection: ${item.collectionId}\n${item.text}`
      )
      .join('\n\n')

    const response = await this.request<OllamaChatResponse>('/api/chat', {
      method: 'POST',
      body: {
        model,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You are Æther, a private local research assistant. Answer only from the supplied local collection context. If the context is insufficient, say what is missing. Cite sources with bracket numbers.'
          },
          {
            role: 'user',
            content: `Local collection context:\n${contextBlock || 'No stored context was retrieved.'}\n\nQuestion: ${prompt}`
          }
        ],
        options: {
          temperature: 0.2
        }
      },
      timeoutMs: 180000
    })

    return {
      answer: response.message.content,
      model,
      citations: context
    }
  }

  private pickChatModel(models: string[]): string | null {
    if (this.chatModelOverride && models.includes(this.chatModelOverride)) {
      return this.chatModelOverride
    }
    return this.pickModel(models, PREFERRED_CHAT_MODELS) ?? models[0] ?? null
  }

  private pickEmbeddingModel(models: string[]): string {
    if (this.embeddingModelOverride && models.includes(this.embeddingModelOverride)) {
      return this.embeddingModelOverride
    }
    return this.pickModel(models, [EMBEDDING_MODEL]) ?? EMBEDDING_MODEL
  }

  private pickModel(models: string[], preferred: string[]): string | null {
    for (const candidate of preferred) {
      const exact = models.find((model) => model === candidate)
      if (exact) return exact

      const withLatest = models.find((model) => model === `${candidate}:latest`)
      if (withLatest) return withLatest

      const withoutLatest = candidate.endsWith(':latest') ? candidate.replace(/:latest$/, '') : null
      if (withoutLatest) {
        const normalized = models.find((model) => model === withoutLatest)
        if (normalized) return normalized
      }
    }

    return null
  }

  private async request<T>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number }
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}${path}`, {
        method: options.method,
        signal: controller.signal,
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(`Ollama ${path} failed: ${response.status} ${message}`)
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama ${path} timed out after ${options.timeoutMs / 1000}s.`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

class AppContainerManager {
  private readonly apps = new Map<string, AppDefinition>()
  private readonly tabs = new Map<string, ManagedTab>()
  private activeAppId = APP_DEFINITIONS[0].id
  private activeTabId = ''
  private dashboardOpen = true
  private panelCollapsed = true

  constructor(private readonly mainWindow: BrowserWindow) {
    for (const definition of APP_DEFINITIONS) {
      this.apps.set(definition.id, definition)
    }

    const initialTab = this.createManagedTab(APP_DEFINITIONS[0], APP_DEFINITIONS[0].homeUrl)
    this.tabs.set(initialTab.id, initialTab)
    this.activeTabId = initialTab.id
    this.loadTab(initialTab)
    this.resize()
  }

  list(): AppSummary[] {
    const activeTab = this.getActiveTab()
    return Array.from(this.apps.values()).map((definition) => ({
      id: definition.id,
      name: definition.name,
      category: definition.category,
      homeUrl: definition.homeUrl,
      currentUrl: activeTab.appId === definition.id ? activeTab.url : definition.homeUrl,
      title: activeTab.appId === definition.id ? activeTab.title : definition.name,
      isActive: definition.id === this.activeAppId && !this.dashboardOpen,
      isLoading: activeTab.appId === definition.id ? activeTab.isLoading : false,
      canGoBack:
        activeTab.appId === definition.id
          ? activeTab.view.webContents.navigationHistory.canGoBack()
          : false,
      canGoForward:
        activeTab.appId === definition.id
          ? activeTab.view.webContents.navigationHistory.canGoForward()
          : false
    }))
  }

  listTabs(): BrowserTabSummary[] {
    return Array.from(this.tabs.values()).map((tab) => this.toTabSummary(tab))
  }

  getState(): AetherState {
    return {
      apps: this.list(),
      tabs: this.listTabs(),
      activeAppId: this.activeAppId,
      activeTabId: this.activeTabId,
      dashboardOpen: this.dashboardOpen,
      panelCollapsed: this.panelCollapsed
    }
  }

  openDashboard(): void {
    this.detachActiveView()
    this.dashboardOpen = true
    this.emitState()
  }

  activate(appId: string): void {
    const tab = this.listTabs().find((item) => item.appId === appId)
    if (!tab) throw new Error(`Unknown app: ${appId}`)
    this.activateTab(tab.id)
  }

  navigate(appId: string, rawUrl: string): void {
    const tab = this.getActiveTab()
    if (tab.appId !== appId) this.activate(appId)
    this.navigateTab(this.activeTabId, rawUrl)
  }

  goBack(appId: string): void {
    const tab = this.getActiveTab()
    if (tab.appId !== appId) this.activate(appId)
    this.goBackTab(this.activeTabId)
  }

  goForward(appId: string): void {
    const tab = this.getActiveTab()
    if (tab.appId !== appId) this.activate(appId)
    this.goForwardTab(this.activeTabId)
  }

  createTab(input?: { url?: string }): BrowserTabSummary {
    const definition = this.apps.get(this.activeAppId) ?? APP_DEFINITIONS[0]
    const tab = this.createManagedTab(definition, input?.url || definition.homeUrl)
    this.tabs.set(tab.id, tab)
    this.activateTab(tab.id)
    this.loadTab(tab)
    return this.toTabSummary(tab)
  }

  activateTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`)
    }

    this.detachActiveView()
    this.activeTabId = tab.id
    this.activeAppId = tab.appId
    this.dashboardOpen = false
    this.attachActiveView()
    this.resize()
    this.emitState()
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    const wasActive = tab.id === this.activeTabId
    let shouldAttachActiveView = false
    this.detachView(tab)
    this.tabs.delete(tab.id)
    tab.view.webContents.close()

    if (this.tabs.size === 0) {
      const definition = this.apps.get(this.activeAppId) ?? APP_DEFINITIONS[0]
      const replacement = this.createManagedTab(definition, definition.homeUrl)
      this.tabs.set(replacement.id, replacement)
      this.activeTabId = replacement.id
      this.loadTab(replacement)
      shouldAttachActiveView = true
    } else if (wasActive) {
      this.activeTabId = Array.from(this.tabs.keys())[this.tabs.size - 1]
      shouldAttachActiveView = true
    }

    if (!this.dashboardOpen && shouldAttachActiveView) {
      this.attachActiveView()
      this.resize()
    }
    this.emitState()
  }

  navigateTab(tabId: string, rawUrl: string): void {
    const tab = this.getTab(tabId)
    if (tab.id !== this.activeTabId) this.activateTab(tab.id)
    tab.view.webContents.loadURL(normalizeUrl(rawUrl))
  }

  goBackTab(tabId: string): void {
    const tab = this.getTab(tabId)
    if (tab.id !== this.activeTabId) this.activateTab(tab.id)
    if (tab.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack()
    }
  }

  goForwardTab(tabId: string): void {
    const tab = this.getTab(tabId)
    if (tab.id !== this.activeTabId) this.activateTab(tab.id)
    if (tab.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward()
    }
  }

  setPanelCollapsed(collapsed: boolean): void {
    this.panelCollapsed = collapsed
    this.resize()
    this.emitState()
  }

  resize(): void {
    if (this.dashboardOpen) return

    const active = this.getActiveTab()
    const [width, height] = this.mainWindow.getContentSize()
    const rightWidth = this.panelCollapsed ? PANEL_COLLAPSED_WIDTH : PANEL_WIDTH

    active.view.setBounds({
      x: SIDEBAR_WIDTH,
      y: TOP_BAR_HEIGHT,
      width: Math.max(280, width - SIDEBAR_WIDTH - rightWidth),
      height: Math.max(200, height - TOP_BAR_HEIGHT)
    })
  }

  getActiveTab(): ManagedTab {
    const active = this.tabs.get(this.activeTabId)
    if (!active) {
      throw new Error('No active browser tab.')
    }

    return active
  }

  getCapturableApp(): ManagedTab {
    if (this.dashboardOpen) {
      throw new Error('Open a website before capturing into a collection.')
    }

    return this.getActiveTab()
  }

  getReadableActiveTab(): ManagedTab {
    return this.getActiveTab()
  }

  private getTab(tabId: string): ManagedTab {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`)
    }
    return tab
  }

  private createManagedTab(definition: AppDefinition, rawUrl: string): ManagedTab {
    const id = crypto.randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:aether-app-${definition.id}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    const tab: ManagedTab = {
      id,
      appId: definition.id,
      view,
      url: normalizeUrl(rawUrl || definition.homeUrl),
      title: 'New tab',
      isLoading: false
    }

    view.setBackgroundColor('#f6f7f9')
    view.webContents.setWindowOpenHandler((details) => {
      this.createTab({ url: details.url })
      return { action: 'deny' }
    })
    view.webContents.on('did-start-loading', () => {
      tab.isLoading = true
      this.emitState()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.isLoading = false
      this.updateNavigationState(tab)
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || getTabHost(tab.url) || 'Untitled'
      this.emitState()
    })
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0]
      this.emitState()
    })
    view.webContents.on('did-navigate', () => this.updateNavigationState(tab))
    view.webContents.on('did-navigate-in-page', () => this.updateNavigationState(tab))

    return tab
  }

  private loadTab(tab: ManagedTab): void {
    tab.view.webContents.loadURL(tab.url)
  }

  private attachActiveView(): void {
    this.mainWindow.contentView.addChildView(this.getActiveTab().view)
  }

  private detachActiveView(): void {
    this.detachView(this.getActiveTab())
  }

  private detachView(tab: ManagedTab): void {
    try {
      this.mainWindow.contentView.removeChildView(tab.view)
    } catch {
      // Electron throws if the view is not currently attached.
    }
  }

  private updateNavigationState(tab: ManagedTab): void {
    tab.url = tab.view.webContents.getURL() || tab.url
    tab.title = tab.view.webContents.getTitle() || getTabHost(tab.url) || 'Untitled'
    this.emitState()
  }

  private toTabSummary(tab: ManagedTab): BrowserTabSummary {
    return {
      id: tab.id,
      appId: tab.appId,
      title: tab.title,
      url: tab.url,
      host: getTabHost(tab.url),
      isActive: tab.id === this.activeTabId && !this.dashboardOpen,
      isLoading: tab.isLoading,
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
      favicon: tab.favicon
    }
  }

  private emitState(): void {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('aether:state', this.getState())
    }
  }
}

let appContainers: AppContainerManager | null = null
let database: AetherDatabase | null = null
let library: LibraryStore | null = null
let settings: SettingsStore | null = null
const ollamaClient = new OllamaClient()

app.setName('Æther')

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    title: 'Æther',
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    appContainers?.resize()
  })
  mainWindow.on('resize', () => appContainers?.resize())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  database = new AetherDatabase(join(app.getPath('userData'), 'aether-realms'))
  library = new LibraryStore(join(app.getPath('userData'), 'aether-library', 'library.json'))
  settings = new SettingsStore(join(app.getPath('userData'), 'aether-settings', 'settings.json'))
  settings
    .load()
    .then((data) => ollamaClient.setModelOverrides(data.ollama))
    .catch((error) => console.error('Æther settings load failed:', error))
  database.migrateLegacyRealms(library).catch((error) => {
    console.error('Legacy realm migration failed:', error)
  })
  appContainers = new AppContainerManager(mainWindow)
}

async function captureCurrentPage(input: { collectionId: string }): Promise<CaptureResult> {
  await loadOllamaSettings()
  const containers = getContainers()
  const collection = await getLibrary().getCollection(input.collectionId)
  const active = containers.getCapturableApp()
  const capturedPage = await extractReadablePage(active)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 2200,
    chunkOverlap: 240
  })
  const chunks = (await splitter.splitText(capturedPage.text))
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  if (chunks.length === 0) {
    throw new Error('No readable text found on the current page.')
  }

  const embeddings = await ollamaClient.embed(chunks)
  if (embeddings.length !== chunks.length) {
    throw new Error('Ollama returned an unexpected number of embeddings.')
  }

  const captureId = crypto.randomUUID()
  const capturedAt = new Date().toISOString()
  const records: ChunkRecord[] = chunks.map((chunk, index) => ({
    id: crypto.randomUUID(),
    vector: embeddings[index],
    text: chunk,
    collectionId: collection.id,
    captureId,
    title: capturedPage.title,
    url: capturedPage.url,
    appId: active.appId,
    capturedAt,
    chunkIndex: index
  }))

  await getDatabase().addChunks(records)

  const capture: CaptureSummary = {
    id: captureId,
    collectionId: collection.id,
    title: capturedPage.title,
    url: capturedPage.url,
    appId: active.id,
    capturedAt,
    chunkCount: records.length
  }
  await getLibrary().addCapture(capture)

  return {
    ...capture,
    collectionName: collection.name
  }
}

async function searchCollection(input: {
  collectionId: string
  query: string
  limit?: number
}): Promise<SearchResult[]> {
  await loadOllamaSettings()
  const query = input.query.trim()
  if (!query) return []

  await getLibrary().getCollection(input.collectionId)
  const [queryVector] = await ollamaClient.embed(query)
  return getDatabase().searchCollection(input.collectionId, queryVector, input.limit ?? 8)
}

async function askChat(input: {
  collectionId?: string
  prompt: string
  includeCurrentPage?: boolean
}): Promise<ChatResult> {
  await loadOllamaSettings()
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error('Enter a question before asking Æther.')
  }

  const citations = input.collectionId
    ? await searchCollection({
        collectionId: input.collectionId,
        query: prompt,
        limit: 8
      })
    : []

  if (input.includeCurrentPage) {
    try {
      const active = getContainers().getReadableActiveTab()
      const captured = await extractReadablePage(active)
      citations.unshift({
        id: `current-${active.id}`,
        collectionId: input.collectionId ?? 'current-page',
        captureId: 'current-page',
        appId: active.appId,
        title: captured.title,
        url: captured.url,
        capturedAt: new Date().toISOString(),
        chunkIndex: 0,
        text: captured.text.slice(0, 5000),
        score: 0
      })
    } catch {
      // Current-page context is optional. Stored collection context remains authoritative.
    }
  }

  return ollamaClient.chat(prompt, dedupeCitations(citations).slice(0, 8))
}

function dedupeCitations(citations: SearchResult[]): SearchResult[] {
  const unique = new Map<string, SearchResult>()

  for (const citation of citations) {
    const key = normalizeCitationKey(citation.url)
    const existing = unique.get(key)
    if (!existing) {
      unique.set(key, citation)
      continue
    }

    if (!existing.text.includes(citation.text)) {
      existing.text =
        `${existing.text}\n\nChunk ${citation.chunkIndex + 1}:\n${citation.text}`.slice(0, 9000)
    }
    existing.score = Math.min(existing.score, citation.score)
  }

  return [...unique.values()]
}

function normalizeCitationKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

async function extractReadablePage(active: ManagedTab): Promise<CapturedPage> {
  const page = (await active.view.webContents.executeJavaScriptInIsolatedWorld(999, [
    {
      code: `(() => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, iframe, form, nav, footer, svg').forEach((node) => node.remove());
        return {
          html: '<!doctype html>' + clone.outerHTML,
          url: location.href,
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
          bodyText: document.body?.innerText || ''
        };
      })()`
    }
  ])) as { html?: string; url?: string; title?: string; description?: string; bodyText?: string }

  if (!page.html || !page.url) {
    throw new Error('Unable to read the active page.')
  }

  const dom = new JSDOM(page.html, { url: page.url })
  const article = new Readability(dom.window.document).parse()
  const articleText = [article?.title, article?.excerpt, article?.textContent]
    .filter(Boolean)
    .join('\n\n')
  const text = normalizeCapturedText(
    articleText.length >= MIN_CAPTURE_TEXT_LENGTH ? articleText : page.bodyText || ''
  )

  if (text.length < MIN_CAPTURE_TEXT_LENGTH) {
    throw new Error('This page does not contain enough readable text to capture.')
  }

  return {
    title: article?.title || page.title || active.title,
    url: page.url,
    text
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('aether:apps:list', () => getContainers().list())
  ipcMain.handle('aether:apps:activate', (_event, appId: string) => getContainers().activate(appId))
  ipcMain.handle('aether:apps:navigate', (_event, appId: string, url: string) =>
    getContainers().navigate(appId, url)
  )
  ipcMain.handle('aether:apps:go-back', (_event, appId: string) => getContainers().goBack(appId))
  ipcMain.handle('aether:apps:go-forward', (_event, appId: string) =>
    getContainers().goForward(appId)
  )
  ipcMain.handle('aether:tabs:list', () => getContainers().listTabs())
  ipcMain.handle('aether:tabs:create', (_event, input?: { url?: string }) =>
    getContainers().createTab(input)
  )
  ipcMain.handle('aether:tabs:activate', (_event, tabId: string) =>
    getContainers().activateTab(tabId)
  )
  ipcMain.handle('aether:tabs:close', (_event, tabId: string) => getContainers().closeTab(tabId))
  ipcMain.handle('aether:tabs:navigate', (_event, tabId: string, url: string) =>
    getContainers().navigateTab(tabId, url)
  )
  ipcMain.handle('aether:tabs:go-back', (_event, tabId: string) => getContainers().goBackTab(tabId))
  ipcMain.handle('aether:tabs:go-forward', (_event, tabId: string) =>
    getContainers().goForwardTab(tabId)
  )
  ipcMain.handle('aether:dashboard:open', () => getContainers().openDashboard())
  ipcMain.handle('aether:hub:list', () => getLibrary().listShortcuts())
  ipcMain.handle('aether:hub:create', (_event, input: { title: string; url: string }) =>
    getLibrary().createShortcut(input)
  )
  ipcMain.handle('aether:hub:delete', (_event, id: string) => getLibrary().deleteShortcut(id))
  ipcMain.handle('aether:collections:list', () => getLibrary().listCollections())
  ipcMain.handle(
    'aether:collections:create',
    (_event, input: { name: string; description?: string; icon?: string }) =>
      getLibrary().createCollection(input)
  )
  ipcMain.handle(
    'aether:collections:update',
    (_event, input: { id: string; name?: string; description?: string; icon?: string }) =>
      getLibrary().updateCollection(input)
  )
  ipcMain.handle('aether:collections:delete', async (_event, id: string) => {
    await getDatabase().deleteCollection(id)
    await getLibrary().deleteCollection(id)
  })
  ipcMain.handle('aether:collections:captures', (_event, collectionId: string) =>
    getLibrary().listCaptures(collectionId)
  )
  ipcMain.handle('aether:capture:current-page', (_event, input: { collectionId: string }) =>
    captureCurrentPage(input)
  )
  ipcMain.handle(
    'aether:capture:move',
    async (_event, input: { captureId: string; collectionId: string }) => {
      await getLibrary().getCollection(input.collectionId)
      const capture = await getLibrary().moveCapture(input.captureId, input.collectionId)
      await getDatabase().moveCapture(input.captureId, input.collectionId)
      return capture
    }
  )
  ipcMain.handle('aether:capture:delete', async (_event, captureId: string) => {
    await getDatabase().deleteCapture(captureId)
    await getLibrary().deleteCapture(captureId)
  })
  ipcMain.handle(
    'aether:search:collection',
    (_event, input: { collectionId: string; query: string; limit?: number }) =>
      searchCollection(input)
  )
  ipcMain.handle(
    'aether:chat:ask',
    (_event, input: { collectionId?: string; prompt: string; includeCurrentPage?: boolean }) =>
      askChat(input)
  )
  ipcMain.handle('aether:system:status', async () => {
    await loadOllamaSettings()
    return ollamaClient.status(getLibrary(), getDatabase())
  })
  ipcMain.handle(
    'aether:system:update-models',
    async (_event, input: { embeddingModel?: string; chatModel?: string }) => {
      const nextSettings = await getSettings().updateModels(input)
      ollamaClient.setModelOverrides(nextSettings.ollama)
      return ollamaClient.updateModels(getLibrary(), getDatabase(), input)
    }
  )
  ipcMain.handle('aether:layout:set-panel-collapsed', (_event, collapsed: boolean) =>
    getContainers().setPanelCollapsed(collapsed)
  )
}

function getContainers(): AppContainerManager {
  if (!appContainers) {
    throw new Error('Æther app containers are not ready.')
  }
  return appContainers
}

function getDatabase(): AetherDatabase {
  if (!database) {
    throw new Error('Æther database is not ready.')
  }
  return database
}

function getLibrary(): LibraryStore {
  if (!library) {
    throw new Error('Æther library is not ready.')
  }
  return library
}

function getSettings(): SettingsStore {
  if (!settings) {
    throw new Error('Æther settings are not ready.')
  }
  return settings
}

async function loadOllamaSettings(): Promise<void> {
  const data = await getSettings().load()
  ollamaClient.setModelOverrides(data.ollama)
}

function normalizeCapturedText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return 'https://www.google.com'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed
  }
  if (/\s/.test(trimmed) || !/[.:]/.test(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`
  }

  return `https://${trimmed}`
}

function getTabHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function asLanceRecord(record: ChunkRecord): Record<string, unknown> {
  return { ...record }
}

function toSearchResult(row: ChunkRecord & { _distance?: number }): SearchResult {
  return {
    id: row.id,
    collectionId: row.collectionId,
    captureId: row.captureId,
    appId: row.appId,
    title: row.title,
    url: row.url,
    capturedAt: row.capturedAt,
    chunkIndex: row.chunkIndex,
    text: row.text,
    score: typeof row._distance === 'number' ? row._distance : Number.POSITIVE_INFINITY
  }
}

function uniqueSlug(name: string, existing: string[]): string {
  const base = slugify(name)
  let candidate = base
  let suffix = 2

  while (existing.includes(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }

  return candidate
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'collection'
  )
}

function humanizeId(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }
  electronApp.setAppUserModelId('com.canur.aether')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
