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
  CaptureResult,
  CaptureSummary,
  ChatResult,
  CollectionSummary,
  SearchResult,
  SystemStatus
} from '../shared/aether'

const SIDEBAR_WIDTH = 76
const TOP_BAR_HEIGHT = 92
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

interface ManagedApp extends AppDefinition {
  view: WebContentsView
  currentUrl: string
  title: string
  isLoading: boolean
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
  migratedRealmTables: string[]
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
    } catch {
      this.data = {
        version: 1,
        collections: [],
        captures: [],
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
  async status(library: LibraryStore, db: AetherDatabase): Promise<SystemStatus> {
    try {
      const availableModels = await this.listModels()
      return {
        ollamaReachable: true,
        embeddingModel: this.pickModel(availableModels, [EMBEDDING_MODEL]) ?? EMBEDDING_MODEL,
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

  async listModels(): Promise<string[]> {
    const response = await this.request<OllamaTagsResponse>('/api/tags', {
      method: 'GET',
      timeoutMs: 4000
    })
    return response.models.map((model) => model.name)
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const models = await this.listModels()
    const model = this.pickModel(models, [EMBEDDING_MODEL])
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
              'You are Aether, a private local research assistant. Answer only from the supplied local collection context. If the context is insufficient, say what is missing. Cite sources with bracket numbers.'
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
    return this.pickModel(models, PREFERRED_CHAT_MODELS) ?? models[0] ?? null
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
  private readonly apps = new Map<string, ManagedApp>()
  private activeAppId = APP_DEFINITIONS[0].id
  private dashboardOpen = true
  private panelCollapsed = false

  constructor(private readonly mainWindow: BrowserWindow) {
    for (const definition of APP_DEFINITIONS) {
      this.apps.set(definition.id, this.createManagedApp(definition))
    }

    this.resize()
  }

  list(): AppSummary[] {
    return Array.from(this.apps.values()).map((managedApp) => ({
      id: managedApp.id,
      name: managedApp.name,
      category: managedApp.category,
      homeUrl: managedApp.homeUrl,
      currentUrl: managedApp.currentUrl,
      title: managedApp.title,
      isActive: managedApp.id === this.activeAppId && !this.dashboardOpen,
      isLoading: managedApp.isLoading,
      canGoBack: managedApp.view.webContents.navigationHistory.canGoBack(),
      canGoForward: managedApp.view.webContents.navigationHistory.canGoForward()
    }))
  }

  getState(): AetherState {
    return {
      apps: this.list(),
      activeAppId: this.activeAppId,
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
    if (!this.apps.has(appId)) {
      throw new Error(`Unknown app: ${appId}`)
    }

    this.detachActiveView()
    this.activeAppId = appId
    this.dashboardOpen = false
    this.attachActiveView()
    this.resize()
    this.emitState()
  }

  navigate(appId: string, rawUrl: string): void {
    const managedApp = this.apps.get(appId)
    if (!managedApp) {
      throw new Error(`Unknown app: ${appId}`)
    }

    this.activate(appId)
    managedApp.view.webContents.loadURL(normalizeUrl(rawUrl))
  }

  goBack(appId: string): void {
    const managedApp = this.apps.get(appId)
    if (!managedApp) {
      throw new Error(`Unknown app: ${appId}`)
    }

    this.activate(appId)
    if (managedApp.view.webContents.navigationHistory.canGoBack()) {
      managedApp.view.webContents.navigationHistory.goBack()
    }
  }

  goForward(appId: string): void {
    const managedApp = this.apps.get(appId)
    if (!managedApp) {
      throw new Error(`Unknown app: ${appId}`)
    }

    this.activate(appId)
    if (managedApp.view.webContents.navigationHistory.canGoForward()) {
      managedApp.view.webContents.navigationHistory.goForward()
    }
  }

  setPanelCollapsed(collapsed: boolean): void {
    this.panelCollapsed = collapsed
    this.resize()
    this.emitState()
  }

  resize(): void {
    if (this.dashboardOpen) return

    const active = this.getActiveApp()
    const [width, height] = this.mainWindow.getContentSize()
    const rightWidth = this.panelCollapsed ? PANEL_COLLAPSED_WIDTH : PANEL_WIDTH

    active.view.setBounds({
      x: SIDEBAR_WIDTH,
      y: TOP_BAR_HEIGHT,
      width: Math.max(280, width - SIDEBAR_WIDTH - rightWidth),
      height: Math.max(200, height - TOP_BAR_HEIGHT)
    })
  }

  getActiveApp(): ManagedApp {
    const active = this.apps.get(this.activeAppId)
    if (!active) {
      throw new Error('No active app container.')
    }

    return active
  }

  getCapturableApp(): ManagedApp {
    if (this.dashboardOpen) {
      throw new Error('Open a website before capturing into a collection.')
    }

    return this.getActiveApp()
  }

  private createManagedApp(definition: AppDefinition): ManagedApp {
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:aether-app-${definition.id}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    const managedApp: ManagedApp = {
      ...definition,
      view,
      currentUrl: definition.homeUrl,
      title: definition.name,
      isLoading: false
    }

    view.setBackgroundColor('#f6f7f9')
    view.webContents.setWindowOpenHandler((details) => {
      if (isSameAppFlow(details.url, managedApp)) {
        view.webContents.loadURL(details.url)
      } else {
        shell.openExternal(details.url)
      }

      return { action: 'deny' }
    })
    view.webContents.on('did-start-loading', () => {
      managedApp.isLoading = true
      this.emitState()
    })
    view.webContents.on('did-stop-loading', () => {
      managedApp.isLoading = false
      this.updateNavigationState(managedApp)
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      managedApp.title = title || managedApp.name
      this.emitState()
    })
    view.webContents.on('did-navigate', () => this.updateNavigationState(managedApp))
    view.webContents.on('did-navigate-in-page', () => this.updateNavigationState(managedApp))
    view.webContents.loadURL(definition.homeUrl)

    return managedApp
  }

  private attachActiveView(): void {
    this.mainWindow.contentView.addChildView(this.getActiveApp().view)
  }

  private detachActiveView(): void {
    this.mainWindow.contentView.removeChildView(this.getActiveApp().view)
  }

  private updateNavigationState(managedApp: ManagedApp): void {
    managedApp.currentUrl = managedApp.view.webContents.getURL() || managedApp.homeUrl
    managedApp.title = managedApp.view.webContents.getTitle() || managedApp.name
    this.emitState()
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
const ollamaClient = new OllamaClient()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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
  database.migrateLegacyRealms(library).catch((error) => {
    console.error('Legacy realm migration failed:', error)
  })
  appContainers = new AppContainerManager(mainWindow)
}

async function captureCurrentPage(input: { collectionId: string }): Promise<CaptureResult> {
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
    appId: active.id,
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
  const query = input.query.trim()
  if (!query) return []

  await getLibrary().getCollection(input.collectionId)
  const [queryVector] = await ollamaClient.embed(query)
  return getDatabase().searchCollection(input.collectionId, queryVector, input.limit ?? 8)
}

async function askChat(input: {
  collectionId: string
  prompt: string
  includeCurrentPage?: boolean
}): Promise<ChatResult> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error('Enter a question before asking Aether.')
  }

  const citations = await searchCollection({
    collectionId: input.collectionId,
    query: prompt,
    limit: 8
  })

  if (input.includeCurrentPage) {
    try {
      const active = getContainers().getCapturableApp()
      const captured = await extractReadablePage(active)
      citations.unshift({
        id: `current-${active.id}`,
        collectionId: input.collectionId,
        captureId: 'current-page',
        appId: active.id,
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

  return ollamaClient.chat(prompt, citations.slice(0, 8))
}

async function extractReadablePage(active: ManagedApp): Promise<CapturedPage> {
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
  ipcMain.handle('aether:dashboard:open', () => getContainers().openDashboard())
  ipcMain.handle('aether:collections:list', () => getLibrary().listCollections())
  ipcMain.handle(
    'aether:collections:create',
    (_event, input: { name: string; description?: string }) => getLibrary().createCollection(input)
  )
  ipcMain.handle(
    'aether:collections:update',
    (_event, input: { id: string; name?: string; description?: string }) =>
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
    (_event, input: { collectionId: string; prompt: string; includeCurrentPage?: boolean }) =>
      askChat(input)
  )
  ipcMain.handle('aether:system:status', () => ollamaClient.status(getLibrary(), getDatabase()))
  ipcMain.handle('aether:layout:set-panel-collapsed', (_event, collapsed: boolean) =>
    getContainers().setPanelCollapsed(collapsed)
  )
}

function getContainers(): AppContainerManager {
  if (!appContainers) {
    throw new Error('Aether app containers are not ready.')
  }
  return appContainers
}

function getDatabase(): AetherDatabase {
  if (!database) {
    throw new Error('Aether database is not ready.')
  }
  return database
}

function getLibrary(): LibraryStore {
  if (!library) {
    throw new Error('Aether library is not ready.')
  }
  return library
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
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return `https://${trimmed}`
}

function isSameAppFlow(url: string, managedApp: ManagedApp): boolean {
  try {
    const next = new URL(url)
    const home = new URL(managedApp.homeUrl)
    const current = managedApp.currentUrl ? new URL(managedApp.currentUrl) : home

    return next.hostname === home.hostname || next.hostname === current.hostname
  } catch {
    return false
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
  electronApp.setAppUserModelId('com.aether.browser')

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
