import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AetherState,
  AppSettings,
  AppSummary,
  BrowserTabSummary,
  CaptureResult,
  CaptureSummary,
  ChatResult,
  CollectionSummary,
  HubShortcutSummary,
  IcebergItem,
  IcebergResult,
  SearchEngineId,
  SearchResult,
  SystemStatus
} from '../../shared/aether'
import { BrowserChrome } from './components/BrowserChrome'
import { CollectionDialog, CollectionDialogState } from './components/CollectionDialog'
import { Crystallizer } from './components/Crystallizer'
import { Dashboard } from './components/Dashboard'
import { GlobeIcon, CloudIcon, GearIcon, SnowflakeIcon } from './components/icons'
import { IntelligencePanel } from './components/IntelligencePanel'
import { QuickAction } from './types/ui'
import { getQuickActions } from './utils/aether-ui'

function App(): React.JSX.Element {
  const [apps, setApps] = useState<AppSummary[]>([])
  const [tabs, setTabs] = useState<BrowserTabSummary[]>([])
  const [shortcuts, setShortcuts] = useState<HubShortcutSummary[]>([])
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [capturesByCollection, setCapturesByCollection] = useState<
    Record<string, CaptureSummary[]>
  >({})
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings>({
    browser: { defaultSearchEngine: 'google' }
  })
  const [dashboardOpen, setDashboardOpen] = useState(true)
  const [workspaceMode, setWorkspaceMode] = useState<'dashboard' | 'crystallizer'>('dashboard')
  const [activeTabId, setActiveTabId] = useState('')
  const [selectedCollectionId, setSelectedCollectionId] = useState('')
  const [addressDraft, setAddressDraft] = useState('aether://dashboard')
  const [addressFocused, setAddressFocused] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [chatPrompt, setChatPrompt] = useState('')
  const [askCollectionId, setAskCollectionId] = useState('')
  const [askIncludeCurrentPage, setAskIncludeCurrentPage] = useState(true)
  const [askCurrentPageOnly, setAskCurrentPageOnly] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [chatResult, setChatResult] = useState<ChatResult | null>(null)
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  const [busy, setBusy] = useState<string | null>('Starting Æther')
  const [notice, setNotice] = useState<string | null>(null)
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs.find((tab) => tab.isActive) ?? tabs[0],
    [activeTabId, tabs]
  )
  const activeApp = useMemo(() => apps.find((app) => app.isActive) ?? apps[0], [apps])
  const selectedCollection = useMemo(
    () =>
      collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0],
    [collections, selectedCollectionId]
  )
  const askCollection = useMemo(
    () => collections.find((collection) => collection.id === askCollectionId),
    [askCollectionId, collections]
  )
  const usableAskCollections = useMemo(
    () =>
      collections.filter((collection) => collection.captureCount > 0 && collection.chunkCount > 0),
    [collections]
  )
  const canUseCurrentPage = Boolean(activeTab?.url)
  const ollamaBlocked = status ? !status.ollamaReachable : false
  const hasEmbeddingModel = status ? status.availableModels.includes(status.embeddingModel) : true
  const chatBlocked = status ? !status.ollamaReachable || !status.chatModel : false
  const quickActions = useMemo<QuickAction[]>(() => getQuickActions(activeTab), [activeTab])
  const addressValue = addressFocused
    ? addressDraft
    : dashboardOpen
      ? workspaceMode === 'crystallizer'
        ? 'ice://crystallizer'
        : 'æther://dashboard'
      : (activeTab?.url ?? '')

  const refreshCollections = useCallback(
    async (preferredCollectionId?: string): Promise<void> => {
      const nextCollections = await window.aether.collections.list()
      setCollections(nextCollections)
      const captureEntries = await Promise.all(
        nextCollections.map(async (collection) => [
          collection.id,
          await window.aether.collections.captures(collection.id)
        ])
      )
      const nextCapturesByCollection = Object.fromEntries(captureEntries) as Record<
        string,
        CaptureSummary[]
      >
      setCapturesByCollection(nextCapturesByCollection)

      const nextSelected =
        preferredCollectionId &&
        nextCollections.some((collection) => collection.id === preferredCollectionId)
          ? preferredCollectionId
          : selectedCollectionId &&
              nextCollections.some((collection) => collection.id === selectedCollectionId)
            ? selectedCollectionId
            : (nextCollections[0]?.id ?? '')

      setSelectedCollectionId(nextSelected)
      setAskCollectionId((current) =>
        current && nextCollections.some((collection) => collection.id === current)
          ? current
          : nextSelected
      )
    },
    [selectedCollectionId]
  )

  const refreshShell = useCallback(async (): Promise<void> => {
    const [nextApps, nextTabs, nextStatus, nextSettings] = await Promise.all([
      window.aether.apps.list(),
      window.aether.tabs.list(),
      window.aether.system.status(),
      window.aether.system.settings()
    ])
    setApps(nextApps)
    setTabs(nextTabs)
    setStatus(nextStatus)
    setSettings(nextSettings)
    setActiveTabId(nextTabs.find((tab) => tab.isActive)?.id ?? nextTabs[0]?.id ?? '')
  }, [])

  const refreshShortcuts = useCallback(async (): Promise<void> => {
    setShortcuts(await window.aether.hub.list())
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([refreshShell(), refreshCollections(), refreshShortcuts()])
  }, [refreshCollections, refreshShell, refreshShortcuts])

  const createTab = useCallback(
    async (input?: { url?: string }): Promise<void> => {
      setBusy('Opening tab')
      setNotice(null)

      try {
        const tab = await window.aether.tabs.create(input)
        setActiveTabId(tab.id)
        setDashboardOpen(false)
        setWorkspaceMode('dashboard')
        await refreshShell()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Æther hit an unexpected error.')
      } finally {
        setBusy(null)
      }
    },
    [refreshShell]
  )

  useEffect(() => {
    const unsubscribe = window.aether.events.onState((state: AetherState) => {
      setApps(state.apps)
      setTabs(state.tabs)
      setActiveTabId(state.activeTabId)
      setDashboardOpen(state.dashboardOpen)
      setPanelCollapsed(state.panelCollapsed)
    })

    const refreshTimer = window.setTimeout(() => {
      refreshAll().finally(() => setBusy(null))
    }, 0)

    return () => {
      window.clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [refreshAll])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'l') {
        event.preventDefault()
        if (!dashboardOpen) addressInputRef.current?.select()
      }
      if ((event.metaKey || event.ctrlKey) && key === 't') {
        event.preventDefault()
        createTab()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [createTab, dashboardOpen])

  async function openDashboard(): Promise<void> {
    await window.aether.dashboard.open()
    setWorkspaceMode('dashboard')
    setDashboardOpen(true)
  }

  async function openCrystallizer(): Promise<void> {
    await window.aether.dashboard.open()
    setWorkspaceMode('crystallizer')
    setDashboardOpen(true)
  }

  async function openBrowser(): Promise<void> {
    if (activeTab) {
      await window.aether.tabs.activate(activeTab.id)
      setWorkspaceMode('dashboard')
      setDashboardOpen(false)
      return
    }
    await createTab()
  }

  async function activateTab(tabId: string): Promise<void> {
    await window.aether.tabs.activate(tabId)
    setActiveTabId(tabId)
    setWorkspaceMode('dashboard')
    setDashboardOpen(false)
  }

  async function closeTab(tabId: string): Promise<void> {
    await runTask('Closing tab', async () => {
      await window.aether.tabs.close(tabId)
      await refreshShell()
    })
  }

  async function navigate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!activeTab) return

    await runTask('Navigating', async () => {
      await window.aether.tabs.navigate(activeTab.id, addressValue)
      setDashboardOpen(false)
      addressInputRef.current?.blur()
    })
  }

  async function goBack(): Promise<void> {
    if (!activeTab) return

    await runTask('Going back', async () => {
      await window.aether.tabs.goBack(activeTab.id)
      await refreshShell()
    })
  }

  async function goForward(): Promise<void> {
    if (!activeTab) return

    await runTask('Going forward', async () => {
      await window.aether.tabs.goForward(activeTab.id)
      await refreshShell()
    })
  }

  async function saveCollectionDialog(input: {
    name: string
    description: string
    icon: string
  }): Promise<void> {
    if (!collectionDialog || collectionDialog.mode === 'delete') return

    await runTask(
      collectionDialog.mode === 'create' ? 'Creating collection' : 'Updating collection',
      async () => {
        const collection =
          collectionDialog.mode === 'create'
            ? await window.aether.collections.create(input)
            : await window.aether.collections.update({
                id: collectionDialog.collection.id,
                name: input.name,
                description: input.description,
                icon: input.icon
              })
        setCollectionDialog(null)
        await refreshCollections(collection.id)
        setNotice(`${collection.name} is ready.`)
      }
    )
  }

  async function confirmDeleteCollection(): Promise<void> {
    if (!collectionDialog || collectionDialog.mode !== 'delete') return

    await runTask('Deleting collection', async () => {
      await window.aether.collections.delete(collectionDialog.collection.id)
      setCollectionDialog(null)
      setSearchResults([])
      setChatResult(null)
      await refreshCollections()
      setStatus(await window.aether.system.status())
      setNotice('Collection deleted.')
    })
  }

  async function selectCollection(collectionId: string): Promise<void> {
    setSelectedCollectionId(collectionId)
    setAskCollectionId(collectionId)
    setSearchResults([])
    setChatResult(null)
  }

  async function capturePage(): Promise<void> {
    if (!selectedCollection) {
      setCollectionDialog({ mode: 'create' })
      setNotice('Create a collection before capturing.')
      return
    }

    await runTask('Capturing page', async () => {
      const result = await window.aether.capture.currentPage({
        collectionId: selectedCollection.id
      })
      setLastCapture(result)
      await refreshCollections(result.collectionId)
      setStatus(await window.aether.system.status())
      setNotice(`Saved ${result.chunkCount} chunks into ${result.collectionName}.`)
    })
  }

  async function deleteCapture(captureId: string): Promise<void> {
    await runTask('Deleting capture', async () => {
      await window.aether.capture.delete(captureId)
      await refreshCollections(selectedCollection?.id)
      setSearchResults((current) => current.filter((result) => result.captureId !== captureId))
      setNotice('Capture deleted.')
    })
  }

  async function moveCapture(captureId: string, collectionId: string): Promise<void> {
    await runTask('Moving capture', async () => {
      const capture = await window.aether.capture.move({ captureId, collectionId })
      await refreshCollections(collectionId)
      setSearchResults([])
      setChatResult(null)
      setNotice(`Moved ${capture.title}.`)
    })
  }

  async function search(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    if (!selectedCollection) return

    await runTask('Searching collection', async () => {
      const results = await window.aether.search.collection({
        collectionId: selectedCollection.id,
        query: searchQuery,
        limit: 8
      })

      setSearchResults(results)
      setNotice(results.length ? `${results.length} local matches.` : 'No local matches found.')
    })
  }

  async function ask(event: FormEvent): Promise<void> {
    event.preventDefault()
    await askPrompt(chatPrompt)
  }

  async function askPrompt(prompt: string): Promise<void> {
    const hasKnowledgeHubs = usableAskCollections.length > 0
    const selectedAskCollection =
      askCollection && askCollection.captureCount > 0 && askCollection.chunkCount > 0
        ? askCollection
        : undefined
    const collectionId =
      hasKnowledgeHubs && !askCurrentPageOnly ? selectedAskCollection?.id : undefined
    const includeCurrentPage = !hasKnowledgeHubs || askCurrentPageOnly || askIncludeCurrentPage

    if (!collectionId && !includeCurrentPage) {
      setPanelCollapsed(false)
      await window.aether.layout.setIntelligencePanelCollapsed(false)
      setChatPrompt(prompt)
      setNotice('Select a knowledge hub or include the current page before asking ÆTHER.')
      return
    }

    if (includeCurrentPage && !canUseCurrentPage) {
      setNotice('Open a page before asking with current-page context.')
      return
    }

    await runTask('Asking Æther', async () => {
      const result = await window.aether.chat.ask({
        prompt,
        collectionId,
        includeCurrentPage
      })

      setChatResult(result)
      setNotice(`Answered with ${result.model}.`)
    })
  }

  async function handleQuickAction(action: QuickAction): Promise<void> {
    setPanelCollapsed(false)
    await window.aether.layout.setIntelligencePanelCollapsed(false)

    if (action.capture) {
      await capturePage()
      return
    }

    if (!action.prompt) return
    setChatPrompt(action.prompt)
    await askPrompt(action.prompt)
  }

  async function saveActiveTabToHub(): Promise<void> {
    if (!activeTab?.url) {
      setNotice('Open a page before saving it to the Hub.')
      return
    }

    await runTask('Saving to Hub', async () => {
      await window.aether.hub.create({
        title: activeTab.title || activeTab.host || activeTab.url,
        url: activeTab.url
      })
      await refreshShortcuts()
      setNotice('Saved to Hub.')
    })
  }

  async function openShortcut(shortcut: HubShortcutSummary): Promise<void> {
    await createTab({ url: shortcut.url })
    setDashboardOpen(false)
  }

  async function openCapture(capture: CaptureSummary): Promise<void> {
    await createTab({ url: capture.url })
    setDashboardOpen(false)
  }

  async function openCitation(citation: SearchResult): Promise<void> {
    await createTab({ url: citation.url })
    setDashboardOpen(false)
  }

  async function generateIceberg(keyword: string): Promise<IcebergResult> {
    setBusy('Crystallizing topic')
    setNotice(null)

    try {
      const result = await window.aether.crystallizer.generate({ keyword })
      setNotice(`Mapped ${result.items.length} fragments with ${result.model}.`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Crystallization failed.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function openCrystallizedTopic(keyword: string, item: IcebergItem): Promise<void> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(`${keyword} ${item.name}`)}`
    await createTab({ url })
    setWorkspaceMode('dashboard')
    setDashboardOpen(false)
  }

  async function deleteShortcut(shortcutId: string): Promise<void> {
    await runTask('Removing shortcut', async () => {
      await window.aether.hub.delete(shortcutId)
      await refreshShortcuts()
    })
  }

  async function reorderShortcuts(ids: string[]): Promise<void> {
    const nextShortcuts = await window.aether.hub.reorder(ids)
    setShortcuts(nextShortcuts)
  }

  async function reorderCollections(ids: string[]): Promise<void> {
    const nextCollections = await window.aether.collections.reorder(ids)
    setCollections(nextCollections)
  }

  async function openSettings(): Promise<void> {
    setSettingsOpen(true)
    await window.aether.layout.setModalOverlayOpen(true)
  }

  async function closeSettings(): Promise<void> {
    setSettingsOpen(false)
    await window.aether.layout.setModalOverlayOpen(false)
  }

  async function updateDefaultSearchEngine(defaultSearchEngine: SearchEngineId): Promise<void> {
    await runTask('Updating settings', async () => {
      const nextSettings = await window.aether.system.updateSettings({
        browser: { defaultSearchEngine }
      })
      setSettings(nextSettings)
      setNotice('Default search engine updated.')
    })
  }

  async function updateOllamaModels(input: {
    embeddingModel?: string
    chatModel?: string
  }): Promise<void> {
    await runTask('Updating Ollama models', async () => {
      const nextStatus = await window.aether.system.updateModels(input)
      setStatus(nextStatus)
      setNotice('Ollama model selection updated.')
    })
  }

  async function togglePanel(): Promise<void> {
    const next = !panelCollapsed
    setPanelCollapsed(next)
    await window.aether.layout.setIntelligencePanelCollapsed(next)
  }

  async function runTask(label: string, task: () => Promise<void>): Promise<void> {
    setBusy(label)
    setNotice(null)

    try {
      await task()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Æther hit an unexpected error.')
    } finally {
      setBusy(null)
    }
  }

  const showAppTooltips = dashboardOpen
  const crystallizerOpen = dashboardOpen && workspaceMode === 'crystallizer'
  const dashboardHomeOpen = dashboardOpen && workspaceMode === 'dashboard'

  return (
    <main className={`aether-shell ${panelCollapsed ? 'panel-collapsed' : ''}`}>
      <div className="window-titlebar" aria-hidden="true">
        <strong>ÆTHER</strong>
      </div>

      <aside className="app-rail">
        <button
          className={`brand-mark tooltip-host ${dashboardHomeOpen ? 'active' : ''}`}
          aria-label="Open ÆTHER dashboard"
          data-tooltip="ÆTHER"
          data-tooltip-side="right"
          onClick={openDashboard}
          title="ÆTHER"
          type="button"
        >
          {/* <img className="brand-mark-image" src="/aether-mark.svg" alt="Aether logo" /> */}
          <CloudIcon />
        </button>
        <nav className="app-list" aria-label="Apps">
          <button
            className={`app-button tooltip-host ${crystallizerOpen ? 'active' : ''}`}
            data-tooltip={showAppTooltips ? 'iCE' : undefined}
            data-tooltip-side={showAppTooltips ? 'right' : undefined}
            onClick={openCrystallizer}
            title={showAppTooltips ? 'iCE' : undefined}
            type="button"
          >
            <SnowflakeIcon />
            <span className="app-dot" aria-hidden="true" />
          </button>
          <button
            className={`app-button tooltip-host ${!dashboardOpen ? 'active' : ''}`}
            data-tooltip={showAppTooltips ? 'Web View' : undefined}
            data-tooltip-side={showAppTooltips ? 'right' : undefined}
            onClick={openBrowser}
            title={
              showAppTooltips ? (activeApp ? `${activeApp.name} view` : 'Web view') : undefined
            }
            type="button"
          >
            <GlobeIcon />
            <span className="app-dot" aria-hidden="true" />
          </button>
        </nav>
        <button
          className="app-button settings-button tooltip-host"
          aria-label="Open Æther settings"
          data-tooltip={showAppTooltips ? 'Settings' : undefined}
          data-tooltip-side={showAppTooltips ? 'right' : undefined}
          onClick={openSettings}
          title={showAppTooltips ? 'Settings' : undefined}
          type="button"
        >
          <GearIcon />
        </button>
      </aside>

      <section className={`workspace ${dashboardOpen ? 'dashboard-open' : ''}`}>
        <BrowserChrome
          activeTab={activeTab}
          addressDraft={addressValue}
          addressInputRef={addressInputRef}
          busy={busy}
          capturesBlocked={
            dashboardOpen || !selectedCollection || ollamaBlocked || !hasEmbeddingModel
          }
          collections={collections}
          dashboardOpen={dashboardOpen}
          dashboardSubtitle={crystallizerOpen ? 'Info Crystallizer Engine' : 'Knowledge Hub'}
          dashboardTitle={crystallizerOpen ? 'iCE' : 'ÆTHER'}
          lastCapture={lastCapture}
          quickActions={dashboardOpen ? [] : quickActions}
          selectedCollection={selectedCollection}
          selectedCollectionId={selectedCollectionId}
          tabs={tabs}
          onAddressBlur={() => setAddressFocused(false)}
          onAddressChange={setAddressDraft}
          onAddressFocus={() => {
            setAddressDraft(addressValue)
            setAddressFocused(true)
          }}
          onBack={goBack}
          onCloseTab={closeTab}
          onCreateTab={() => createTab()}
          onCapture={capturePage}
          onCreateCollection={() => setCollectionDialog({ mode: 'create' })}
          onForward={goForward}
          onNavigate={navigate}
          onQuickAction={handleQuickAction}
          onSelectTab={activateTab}
          onSelectCollection={selectCollection}
        />

        {crystallizerOpen ? (
          <Crystallizer
            busy={busy}
            onGenerate={generateIceberg}
            onOpenTopic={openCrystallizedTopic}
          />
        ) : dashboardOpen ? (
          <Dashboard
            busy={busy}
            capturesByCollection={capturesByCollection}
            collections={collections}
            deleteCapture={deleteCapture}
            deleteShortcut={deleteShortcut}
            moveCapture={moveCapture}
            openCapture={openCapture}
            openShortcut={openShortcut}
            openCollectionDialog={setCollectionDialog}
            reorderCollections={reorderCollections}
            reorderShortcuts={reorderShortcuts}
            saveActiveTabToHub={saveActiveTabToHub}
            selectedCollectionId={selectedCollectionId}
            shortcuts={shortcuts}
            selectCollection={selectCollection}
          />
        ) : (
          <div className="webview-underlay" aria-hidden="true" />
        )}
      </section>

      <IntelligencePanel
        busy={busy}
        chatBlocked={chatBlocked}
        chatPrompt={chatPrompt}
        askCollectionId={askCollectionId}
        askCurrentPageOnly={askCurrentPageOnly}
        askIncludeCurrentPage={askIncludeCurrentPage}
        canUseCurrentPage={canUseCurrentPage}
        collections={collections}
        dashboardOpen={dashboardOpen}
        chatResult={chatResult}
        notice={notice}
        panelCollapsed={panelCollapsed}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        searchResults={searchResults}
        selectedCollection={selectedCollection}
        status={status}
        onAsk={ask}
        onSearch={search}
        onSearchQueryChange={setSearchQuery}
        onTogglePanel={togglePanel}
        onChatPromptChange={setChatPrompt}
        onAskCollectionChange={setAskCollectionId}
        onAskCurrentPageOnlyChange={setAskCurrentPageOnly}
        onAskIncludeCurrentPageChange={setAskIncludeCurrentPage}
        onUpdateModels={updateOllamaModels}
        onOpenCitation={openCitation}
      />

      {collectionDialog && (
        <CollectionDialog
          busy={busy}
          state={collectionDialog}
          onClose={() => setCollectionDialog(null)}
          onDelete={confirmDeleteCollection}
          onSave={saveCollectionDialog}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          busy={busy}
          settings={settings}
          onClose={closeSettings}
          onDefaultSearchEngineChange={updateDefaultSearchEngine}
        />
      )}
    </main>
  )
}

function SettingsModal({
  busy,
  settings,
  onClose,
  onDefaultSearchEngineChange
}: {
  busy: string | null
  settings: AppSettings
  onClose: () => Promise<void>
  onDefaultSearchEngineChange: (value: SearchEngineId) => Promise<void>
}): React.JSX.Element {
  const searchEngines: Array<{ id: SearchEngineId; name: string; description: string }> = [
    { id: 'google', name: 'Google', description: 'Broad default web search.' },
    { id: 'bing', name: 'Bing', description: 'Microsoft web search.' },
    { id: 'yahoo', name: 'Yahoo!', description: 'Classic portal search.' },
    { id: 'ecosia', name: 'Ecosia', description: 'Privacy-aware search that funds trees.' },
    { id: 'duckduckgo', name: 'DuckDuckGo', description: 'Private search by default.' }
  ]

  return (
    <div
      className="settings-overlay"
      onClick={() => {
        void onClose()
      }}
      role="presentation"
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p>General</p>
            <h2 id="settings-title">Æther Settings</h2>
          </div>
          <button
            onClick={() => {
              void onClose()
            }}
            type="button"
          >
            Close
          </button>
        </header>

        <div className="settings-field">
          <label htmlFor="default-search-engine">Default search engine</label>
          <p>Used when the address bar receives plain search text instead of a URL.</p>
          <select
            id="default-search-engine"
            disabled={Boolean(busy)}
            value={settings.browser.defaultSearchEngine}
            onChange={(event) => onDefaultSearchEngineChange(event.target.value as SearchEngineId)}
          >
            {searchEngines.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.name}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-engine-list" aria-label="Available search engines">
          {searchEngines.map((engine) => (
            <button
              className={
                settings.browser.defaultSearchEngine === engine.id ? 'selected' : undefined
              }
              disabled={Boolean(busy)}
              key={engine.id}
              onClick={() => onDefaultSearchEngineChange(engine.id)}
              type="button"
            >
              <strong>{engine.name}</strong>
              <span>{engine.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

export default App
