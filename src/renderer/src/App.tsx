import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '../../shared/aether'

type PanelMode = 'search' | 'ask'

type QuickAction = {
  id: string
  label: string
  prompt?: string
  mode?: PanelMode
  capture?: boolean
}

type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null

function App(): React.JSX.Element {
  const [apps, setApps] = useState<AppSummary[]>([])
  const [tabs, setTabs] = useState<BrowserTabSummary[]>([])
  const [shortcuts, setShortcuts] = useState<HubShortcutSummary[]>([])
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [captures, setCaptures] = useState<CaptureSummary[]>([])
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [dashboardOpen, setDashboardOpen] = useState(true)
  const [activeTabId, setActiveTabId] = useState('')
  const [selectedCollectionId, setSelectedCollectionId] = useState('')
  const [addressDraft, setAddressDraft] = useState('aether://dashboard')
  const [addressFocused, setAddressFocused] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>('ask')
  const [searchQuery, setSearchQuery] = useState('')
  const [chatPrompt, setChatPrompt] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [chatResult, setChatResult] = useState<ChatResult | null>(null)
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [busy, setBusy] = useState<string | null>('Starting Aether')
  const [notice, setNotice] = useState<string | null>(null)
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState>(null)
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
  const ollamaBlocked = status ? !status.ollamaReachable : false
  const hasEmbeddingModel = status ? status.availableModels.includes(status.embeddingModel) : true
  const chatBlocked = status ? !status.ollamaReachable || !status.chatModel : false
  const quickActions = useMemo(() => getQuickActions(activeTab), [activeTab])
  const addressValue = addressFocused
    ? addressDraft
    : dashboardOpen
      ? 'aether://dashboard'
      : (activeTab?.url ?? '')

  const refreshCollections = useCallback(
    async (preferredCollectionId?: string): Promise<void> => {
      const nextCollections = await window.aether.collections.list()
      setCollections(nextCollections)

      const nextSelected =
        preferredCollectionId &&
        nextCollections.some((collection) => collection.id === preferredCollectionId)
          ? preferredCollectionId
          : selectedCollectionId &&
              nextCollections.some((collection) => collection.id === selectedCollectionId)
            ? selectedCollectionId
            : (nextCollections[0]?.id ?? '')

      setSelectedCollectionId(nextSelected)
      setCaptures(nextSelected ? await window.aether.collections.captures(nextSelected) : [])
    },
    [selectedCollectionId]
  )

  const refreshShell = useCallback(async (): Promise<void> => {
    const [nextApps, nextTabs, nextStatus] = await Promise.all([
      window.aether.apps.list(),
      window.aether.tabs.list(),
      window.aether.system.status()
    ])
    setApps(nextApps)
    setTabs(nextTabs)
    setStatus(nextStatus)
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
        await refreshShell()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Aether hit an unexpected error.')
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
      if ((event.metaKey || event.ctrlKey) && key === 'k') {
        event.preventDefault()
        setPanelCollapsed(false)
        setPanelMode('search')
        window.aether.layout.setIntelligencePanelCollapsed(false)
        window.setTimeout(() => searchInputRef.current?.focus(), 0)
      }
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
    setDashboardOpen(true)
  }

  async function openBrowser(): Promise<void> {
    if (activeTab) {
      await window.aether.tabs.activate(activeTab.id)
      setDashboardOpen(false)
      return
    }
    await createTab()
  }

  async function activateTab(tabId: string): Promise<void> {
    await window.aether.tabs.activate(tabId)
    setActiveTabId(tabId)
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

  async function saveCollectionDialog(input: { name: string; description: string }): Promise<void> {
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
                description: input.description
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
    setCaptures(collectionId ? await window.aether.collections.captures(collectionId) : [])
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
    if (!selectedCollection) return

    await askPrompt(chatPrompt)
  }

  async function askPrompt(prompt: string): Promise<void> {
    if (!selectedCollection) {
      setPanelMode('ask')
      setPanelCollapsed(false)
      await window.aether.layout.setIntelligencePanelCollapsed(false)
      setChatPrompt(prompt)
      setNotice('Select or create a collection before asking AETHER.')
      return
    }

    await runTask('Asking Aether', async () => {
      const result = await window.aether.chat.ask({
        prompt,
        collectionId: selectedCollection.id,
        includeCurrentPage: !dashboardOpen
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

    if (action.mode) {
      setPanelMode(action.mode)
      return
    }

    if (!action.prompt) return
    setPanelMode('ask')
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
  }

  async function deleteShortcut(shortcutId: string): Promise<void> {
    await runTask('Removing shortcut', async () => {
      await window.aether.hub.delete(shortcutId)
      await refreshShortcuts()
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
      setNotice(error instanceof Error ? error.message : 'Aether hit an unexpected error.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className={`aether-shell ${panelCollapsed ? 'panel-collapsed' : ''}`}>
      <div className="window-titlebar" aria-hidden="true">
        <strong>AETHER</strong>
      </div>

      <aside className="app-rail">
        <button
          className={`brand-mark ${dashboardOpen ? 'active' : ''}`}
          aria-label="Open AETHER dashboard"
          onClick={openDashboard}
          title="AETHER"
          type="button"
        >
          <CloudIcon />
        </button>
        <nav className="app-list" aria-label="Apps">
          <button
            className={`app-button ${!dashboardOpen ? 'active' : ''}`}
            onClick={openBrowser}
            title={activeApp ? `${activeApp.name} view` : 'Web view'}
            type="button"
          >
            <GlobeIcon />
            <span className="app-dot" aria-hidden="true" />
          </button>
        </nav>
      </aside>

      <section className="workspace">
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
          lastCapture={lastCapture}
          quickActions={quickActions}
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

        {dashboardOpen ? (
          <Dashboard
            busy={busy}
            captures={captures}
            collections={collections}
            deleteCapture={deleteCapture}
            deleteShortcut={deleteShortcut}
            openShortcut={openShortcut}
            openCollectionDialog={setCollectionDialog}
            saveActiveTabToHub={saveActiveTabToHub}
            selectedCollection={selectedCollection}
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
        chatResult={chatResult}
        mode={panelMode}
        notice={notice}
        panelCollapsed={panelCollapsed}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        searchResults={searchResults}
        selectedCollection={selectedCollection}
        status={status}
        onAsk={ask}
        onModeChange={setPanelMode}
        onSearch={search}
        onSearchQueryChange={setSearchQuery}
        onTogglePanel={togglePanel}
        onChatPromptChange={setChatPrompt}
        onUpdateModels={updateOllamaModels}
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
    </main>
  )
}

function BrowserChrome({
  activeTab,
  addressDraft,
  addressInputRef,
  busy,
  capturesBlocked,
  collections,
  dashboardOpen,
  lastCapture,
  quickActions,
  selectedCollection,
  selectedCollectionId,
  tabs,
  onAddressBlur,
  onAddressChange,
  onAddressFocus,
  onBack,
  onCloseTab,
  onCreateTab,
  onCapture,
  onCreateCollection,
  onForward,
  onNavigate,
  onQuickAction,
  onSelectTab,
  onSelectCollection
}: {
  activeTab?: BrowserTabSummary
  addressDraft: string
  addressInputRef: React.RefObject<HTMLInputElement | null>
  busy: string | null
  capturesBlocked: boolean
  collections: CollectionSummary[]
  dashboardOpen: boolean
  lastCapture: CaptureResult | null
  quickActions: QuickAction[]
  selectedCollection?: CollectionSummary
  selectedCollectionId: string
  tabs: BrowserTabSummary[]
  onAddressBlur: () => void
  onAddressChange: (value: string) => void
  onAddressFocus: () => void
  onBack: () => Promise<void>
  onCloseTab: (tabId: string) => Promise<void>
  onCreateTab: () => void
  onCapture: () => Promise<void>
  onCreateCollection: () => void
  onForward: () => Promise<void>
  onNavigate: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onQuickAction: (action: QuickAction) => Promise<void>
  onSelectTab: (tabId: string) => Promise<void>
  onSelectCollection: (value: string) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="browser-chrome">
      <form className="address-bar" onSubmit={onNavigate}>
        <div className="history-controls" aria-label="Browser history controls">
          <button
            aria-label="Go back"
            disabled={dashboardOpen || !activeTab?.canGoBack}
            onClick={onBack}
            title="Back"
            type="button"
          >
            <ChevronLeftIcon />
          </button>
          <button
            aria-label="Go forward"
            disabled={dashboardOpen || !activeTab?.canGoForward}
            onClick={onForward}
            title="Forward"
            type="button"
          >
            <ChevronRightIcon />
          </button>
        </div>
        <div className="active-app">
          <span>{dashboardOpen ? 'AETHER' : activeTab?.title || 'Browser'}</span>
          <small>
            {dashboardOpen ? 'Knowledge' : activeTab?.isLoading ? 'Loading' : activeTab?.host}
          </small>
        </div>
        <input
          ref={addressInputRef}
          aria-label="Address or search"
          disabled={dashboardOpen || !activeTab}
          value={addressDraft}
          onBlur={onAddressBlur}
          onChange={(event) => onAddressChange(event.target.value)}
          onFocus={onAddressFocus}
          placeholder="Search or enter website"
        />
        <button type="submit" disabled={dashboardOpen || !activeTab || !addressDraft.trim()}>
          Go
        </button>
      </form>

      <div className="tab-strip" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <button
            className={`tab-chip ${tab.isActive && !dashboardOpen ? 'active' : ''}`}
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            title={tab.title}
            type="button"
          >
            <span className="tab-status" aria-hidden="true">
              {tab.isLoading ? (
                <SpinnerIcon />
              ) : tab.favicon ? (
                <img src={tab.favicon} alt="" />
              ) : (
                <GlobeIcon />
              )}
            </span>
            <span className="tab-title">{tab.title || tab.host || 'New tab'}</span>
            <span
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation()
                onCloseTab(tab.id)
              }}
              role="button"
              tabIndex={0}
              title="Close tab"
            >
              <CloseIcon />
            </span>
          </button>
        ))}
        <button className="new-tab-button" onClick={onCreateTab} title="New tab" type="button">
          <PlusIcon />
        </button>
      </div>
      <div className="quick-action-row" aria-label="AI quick actions">
        {quickActions.map((action) => (
          <button
            className="quick-action-chip"
            key={action.id}
            onClick={() => onQuickAction(action)}
            type="button"
          >
            {action.label}
          </button>
        ))}
        <div className="browser-capture-dock">
          <select
            aria-label="Capture collection"
            value={selectedCollectionId}
            onChange={(event) => onSelectCollection(event.target.value)}
          >
            <option value="" disabled>
              Collection
            </option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={onCreateCollection}>
            New
          </button>
          <button
            className="capture-page-button"
            disabled={Boolean(busy) || capturesBlocked}
            onClick={onCapture}
            title={lastCapture ? `Last saved to ${lastCapture.collectionName}` : 'Capture page'}
            type="button"
          >
            Capture
          </button>
          <span>{selectedCollection?.name ?? 'No hub'}</span>
        </div>
      </div>
    </div>
  )
}

function Dashboard({
  busy,
  captures,
  collections,
  deleteCapture,
  deleteShortcut,
  openShortcut,
  openCollectionDialog,
  saveActiveTabToHub,
  selectedCollection,
  selectedCollectionId,
  shortcuts,
  selectCollection
}: {
  busy: string | null
  captures: CaptureSummary[]
  collections: CollectionSummary[]
  deleteCapture: (captureId: string) => Promise<void>
  deleteShortcut: (shortcutId: string) => Promise<void>
  openShortcut: (shortcut: HubShortcutSummary) => Promise<void>
  openCollectionDialog: (state: CollectionDialogState) => void
  saveActiveTabToHub: () => Promise<void>
  selectedCollection?: CollectionSummary
  selectedCollectionId: string
  shortcuts: HubShortcutSummary[]
  selectCollection: (value: string) => Promise<void>
}): React.JSX.Element {
  const [recentOpen, setRecentOpen] = useState(false)

  return (
    <div className="dashboard">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>AETHER</h1>
          <p>Your browser. Your knowledge. Yours, locally.</p>
        </div>
        <div className="heaven-gate" aria-hidden="true">
          <span className="gate-star" />
          <span className="gate-arch" />
          <span className="gate-step step-one" />
          <span className="gate-step step-two" />
          <span className="gate-cloud cloud-left" />
          <span className="gate-cloud cloud-right" />
        </div>
      </header>

      <section className="hub-row">
        <div className="section-title compact">
          <span className="section-symbol">
            <GridIcon />
          </span>
          <div>
            <h2>Portals</h2>
            <p>Launch saved pages like local workspaces.</p>
          </div>
          <button disabled={Boolean(busy)} onClick={saveActiveTabToHub} type="button">
            Save Current Page
          </button>
        </div>
        {shortcuts.length === 0 ? (
          <div className="empty-row">Saved pages will appear here as launch tiles.</div>
        ) : (
          <div className="hub-shortcuts">
            {shortcuts.slice(0, 8).map((shortcut) => (
              <article className="hub-shortcut" key={shortcut.id}>
                <button
                  className="hub-launch"
                  onClick={() => openShortcut(shortcut)}
                  title={shortcut.url}
                  type="button"
                >
                  <span>{shortcut.title.slice(0, 1).toUpperCase()}</span>
                  <strong>{shortcut.title}</strong>
                  <small>{shortcut.host}</small>
                </button>
                <button
                  className="hub-delete"
                  onClick={() => deleteShortcut(shortcut.id)}
                  title="Remove from Hub"
                  type="button"
                >
                  <CloseIcon />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="knowledge-band">
        <div className="section-title">
          <span className="section-symbol">
            <CubeIcon />
          </span>
          <div>
            <h2>Knowledge Hubs</h2>
            <p>Persistent local collections for captured pages, notes, and research trails.</p>
          </div>
          <button
            className="new-collection-button"
            disabled={Boolean(busy)}
            onClick={() => openCollectionDialog({ mode: 'create' })}
            type="button"
          >
            New Collection
          </button>
        </div>

        {collections.length === 0 ? (
          <div className="empty-state">
            <h3>No collections yet</h3>
            <p>Create a collection, open a page, and capture it into your local knowledge base.</p>
            <button onClick={() => openCollectionDialog({ mode: 'create' })} type="button">
              Create first collection
            </button>
          </div>
        ) : (
          <div className="collection-list">
            {collections.map((collection) => (
              <button
                className={`collection-row ${collection.id === selectedCollectionId ? 'active' : ''}`}
                key={collection.id}
                onClick={() => selectCollection(collection.id)}
                type="button"
              >
                <span className="collection-glyph">
                  <BookIcon />
                </span>
                <span className="collection-main">
                  <strong>{collection.name}</strong>
                  <small>{collection.description || 'Captured sources and local context'}</small>
                </span>
                <span className="collection-meta">
                  <strong>{collection.captureCount} captures</strong>
                  <small>{collection.chunkCount} chunks</small>
                </span>
              </button>
            ))}
          </div>
        )}

        {selectedCollection && (
          <div className="collection-actions">
            <span>
              Managing <strong>{selectedCollection.name}</strong>
            </span>
            <div>
              <button
                onClick={() =>
                  openCollectionDialog({ mode: 'edit', collection: selectedCollection })
                }
                type="button"
              >
                Rename
              </button>
              <button
                className="danger-button"
                onClick={() =>
                  openCollectionDialog({ mode: 'delete', collection: selectedCollection })
                }
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </section>

      <section className={`recent-captures ${recentOpen ? 'open' : ''}`}>
        <button
          className="recent-toggle"
          onClick={() => setRecentOpen((current) => !current)}
          type="button"
        >
          <span className="section-symbol">
            <SparkIcon />
          </span>
          <span>
            <strong>Recent Captures</strong>
            <small>
              {captures.length
                ? `${captures.length} saved in ${selectedCollection?.name ?? 'this collection'}`
                : 'No captures yet'}
            </small>
          </span>
          <ChevronRightIcon />
        </button>
        <div className="recent-content" hidden={!recentOpen}>
          {captures.length === 0 ? (
            <div className="empty-row">
              <span>No captures in this collection yet.</span>
            </div>
          ) : (
            <div className="recent-card-grid">
              {captures.slice(0, 6).map((capture) => (
                <article className="recent-card" key={capture.id}>
                  <div className="recent-source">
                    <span>{getCaptureHost(capture.url)}</span>
                    <button
                      aria-label={`Delete ${capture.title}`}
                      className="recent-delete"
                      onClick={() => deleteCapture(capture.id)}
                      title="Delete capture"
                      type="button"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  <h3>{capture.title}</h3>
                  <p>Captured and indexed for local retrieval.</p>
                  <footer>
                    <span>{capture.chunkCount} chunks</span>
                    <time>{formatDate(capture.capturedAt)}</time>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function IntelligencePanel({
  busy,
  chatBlocked,
  chatPrompt,
  chatResult,
  mode,
  notice,
  panelCollapsed,
  searchInputRef,
  searchQuery,
  searchResults,
  selectedCollection,
  status,
  onAsk,
  onModeChange,
  onSearch,
  onSearchQueryChange,
  onTogglePanel,
  onChatPromptChange,
  onUpdateModels
}: {
  busy: string | null
  chatBlocked: boolean
  chatPrompt: string
  chatResult: ChatResult | null
  mode: PanelMode
  notice: string | null
  panelCollapsed: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  searchQuery: string
  searchResults: SearchResult[]
  selectedCollection?: CollectionSummary
  status: SystemStatus | null
  onAsk: (event: FormEvent) => Promise<void>
  onModeChange: (mode: PanelMode) => void
  onSearch: (event?: FormEvent) => Promise<void>
  onSearchQueryChange: (value: string) => void
  onTogglePanel: () => Promise<void>
  onChatPromptChange: (value: string) => void
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (panelCollapsed) {
    return (
      <aside className="intelligence-panel collapsed">
        <button
          className="panel-icon-toggle"
          onClick={onTogglePanel}
          title="Open AI sidepanel"
          type="button"
        >
          <SparkIcon />
        </button>
      </aside>
    )
  }

  return (
    <aside className="intelligence-panel">
      <div className="panel-content">
        <header className="panel-header">
          <div>
            <p>AETHER</p>
            <h1>Local context for the web you explore.</h1>
          </div>
          <div className="panel-header-actions">
            <StatusPill status={status} />
            <button
              className="panel-close"
              onClick={onTogglePanel}
              title="Collapse AI sidepanel"
              type="button"
            >
              <ChevronRightIcon />
            </button>
          </div>
        </header>

        <div className="panel-tabs" role="tablist" aria-label="Aether modes">
          {(['search', 'ask'] as PanelMode[]).map((item) => (
            <button
              className={mode === item ? 'active' : ''}
              key={item}
              onClick={() => onModeChange(item)}
              role="tab"
              type="button"
            >
              {item}
            </button>
          ))}
        </div>

        <section className="panel-context-line">
          <span>Context</span>
          <strong>{selectedCollection?.name ?? 'No collection selected'}</strong>
        </section>

        {mode === 'search' && (
          <section className="panel-section mode-section">
            <div className="section-heading">
              <h2>Search</h2>
              <span>{selectedCollection?.captureCount ?? 0} captures</span>
            </div>
            <form className="search-form" onSubmit={onSearch}>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder="Search selected collection"
              />
              <button
                type="submit"
                disabled={
                  Boolean(busy) ||
                  !searchQuery.trim() ||
                  !selectedCollection ||
                  !status?.ollamaReachable
                }
              >
                Search
              </button>
            </form>
            <ResultList results={searchResults} />
          </section>
        )}

        {mode === 'ask' && (
          <section className="panel-section mode-section chat-section">
            <div className="section-heading">
              <h2>Ask</h2>
              <span>{status?.chatModel ?? 'No model'}</span>
            </div>
            <form className="chat-form" onSubmit={onAsk}>
              <textarea
                value={chatPrompt}
                onChange={(event) => onChatPromptChange(event.target.value)}
                placeholder="Ask this collection and current page"
              />
              <button
                type="submit"
                disabled={Boolean(busy) || !chatPrompt.trim() || !selectedCollection || chatBlocked}
              >
                Ask AETHER
              </button>
            </form>
            {chatResult && <AnswerCard result={chatResult} />}
          </section>
        )}

        <footer className="panel-footer">
          <span>{busy ?? notice ?? 'Cmd+T new tab - Cmd+K search - Cmd+L address'}</span>
          <button
            className="model-settings-button"
            onClick={() => setSettingsOpen((current) => !current)}
            title="Model settings"
            type="button"
          >
            {status?.chatModel ? `Model ${status.chatModel}` : 'Model settings'}
          </button>
        </footer>
        {settingsOpen && (
          <OllamaSettings busy={busy} status={status} onUpdateModels={onUpdateModels} />
        )}
      </div>
    </aside>
  )
}

function OllamaSettings({
  busy,
  status,
  onUpdateModels
}: {
  busy: string | null
  status: SystemStatus | null
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}): React.JSX.Element {
  const models = status?.availableModels ?? []
  const modelLabel = status?.chatModel ?? 'No chat model'

  return (
    <section className="ollama-island" aria-label="Ollama settings">
      <div className="ollama-heading">
        <div>
          <h2>Ollama</h2>
          <p>{status?.ollamaReachable ? `${models.length} loaded models` : 'Offline'}</p>
        </div>
        <span>{modelLabel}</span>
      </div>
      <label>
        Chat model
        <select
          disabled={Boolean(busy) || !status?.ollamaReachable || models.length === 0}
          value={status?.chatModel ?? ''}
          onChange={(event) => onUpdateModels({ chatModel: event.target.value })}
        >
          <option value="" disabled>
            No model
          </option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Embeddings
        <select
          disabled={Boolean(busy) || !status?.ollamaReachable || models.length === 0}
          value={status?.embeddingModel ?? ''}
          onChange={(event) => onUpdateModels({ embeddingModel: event.target.value })}
        >
          <option value="" disabled>
            No model
          </option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}

function CollectionDialog({
  busy,
  state,
  onClose,
  onDelete,
  onSave
}: {
  busy: string | null
  state: CollectionDialogState
  onClose: () => void
  onDelete: () => Promise<void>
  onSave: (input: { name: string; description: string }) => Promise<void>
}): React.JSX.Element | null {
  const collection = state && 'collection' in state ? state.collection : null
  const [name, setName] = useState(collection?.name ?? '')
  const [description, setDescription] = useState(collection?.description ?? '')

  if (!state) return null

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (state?.mode === 'delete') {
      await onDelete()
      return
    }
    await onSave({ name, description })
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="collection-dialog" onSubmit={submit}>
        <header>
          <div>
            <p>Collection</p>
            <h2>
              {state.mode === 'create'
                ? 'New knowledge hub'
                : state.mode === 'edit'
                  ? 'Edit knowledge hub'
                  : 'Delete knowledge hub'}
            </h2>
          </div>
          <button aria-label="Close dialog" onClick={onClose} type="button">
            <CloseIcon />
          </button>
        </header>

        {state.mode === 'delete' ? (
          <p className="delete-copy">
            Delete <strong>{collection?.name}</strong> and all indexed captures in it?
          </p>
        ) : (
          <div className="dialog-fields">
            <label>
              Name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Electronic parts"
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Research notes, references, and captured pages"
              />
            </label>
          </div>
        )}

        <footer>
          <button onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className={state.mode === 'delete' ? 'danger-primary' : 'primary-button'}
            disabled={Boolean(busy) || (state.mode !== 'delete' && !name.trim())}
            type="submit"
          >
            {state.mode === 'delete' ? 'Delete' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}

function ResultList({ results }: { results: SearchResult[] }): React.JSX.Element {
  if (results.length === 0) {
    return <div className="empty-row">Search results will appear here.</div>
  }
  return (
    <div className="results-list">
      {results.slice(0, 6).map((result) => (
        <article className="result-item" key={result.id}>
          <div>
            <h3>{result.title}</h3>
            <span>
              {getCaptureHost(result.url)} - chunk {result.chunkIndex + 1}
            </span>
          </div>
          <p>{result.text}</p>
        </article>
      ))}
    </div>
  )
}

function AnswerCard({ result }: { result: ChatResult }): React.JSX.Element {
  return (
    <article className="answer-card">
      <p>{result.answer}</p>
      <div className="citation-list">
        {result.citations.slice(0, 5).map((citation, index) => (
          <span key={citation.id}>
            [{index + 1}] {citation.title} - {getCaptureHost(citation.url)}
          </span>
        ))}
      </div>
      <footer>{result.citations.length} local citations</footer>
    </article>
  )
}

function StatusPill({ status }: { status: SystemStatus | null }): React.JSX.Element {
  if (!status) {
    return <span className="status-pill neutral">Checking</span>
  }

  return (
    <span className={`status-pill ${status.ollamaReachable ? 'online' : 'offline'}`}>
      {status.ollamaReachable ? 'Ollama' : 'Offline'}
    </span>
  )
}

function getCaptureHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url || 'local'
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getQuickActions(activeTab?: BrowserTabSummary): QuickAction[] {
  if (!activeTab) {
    return [{ id: 'ask-chat', label: 'Ask Chat', mode: 'ask' }]
  }

  const baseActions: QuickAction[] = [
    { id: 'ask-chat', label: 'Ask Chat', mode: 'ask' },
    {
      id: 'summarize',
      label: 'Summarize',
      prompt: 'Summarize the current page clearly, using concise sections and local citations.'
    },
    {
      id: 'key-points',
      label: 'Key points',
      prompt: 'Extract the key points from the current page and explain what matters most.'
    },
    { id: 'capture', label: 'Capture', capture: true }
  ]

  if (activeTab.host.includes('wikipedia.org')) {
    return [
      { id: 'ask-chat', label: 'Ask Chat', mode: 'ask' },
      {
        id: 'wiki-overview',
        label: 'Wikipedia overview',
        prompt:
          'Give me a clean overview of this Wikipedia article, including the topic, why it matters, and the most important sections.'
      },
      {
        id: 'wiki-timeline',
        label: 'Timeline',
        prompt:
          'Create a brief timeline from this Wikipedia article if dates or historical events appear.'
      },
      {
        id: 'wiki-related',
        label: 'Related concepts',
        prompt:
          'Identify related concepts, people, places, and terms from this Wikipedia article that are worth exploring next.'
      },
      { id: 'capture', label: 'Capture', capture: true }
    ]
  }

  if (activeTab.host.includes('github.com')) {
    return [
      { id: 'ask-chat', label: 'Ask Chat', mode: 'ask' },
      {
        id: 'repo-summary',
        label: 'Repo summary',
        prompt:
          'Summarize this GitHub page and explain the project purpose, setup, and important files or issues.'
      },
      {
        id: 'risk-scan',
        label: 'Risks',
        prompt:
          'Review this GitHub page for risks, open questions, missing setup details, or maintenance concerns.'
      },
      { id: 'capture', label: 'Capture', capture: true }
    ]
  }

  return baseActions
}

function CloudIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28">
      <path
        d="M9.7 20.2h11.1a4.7 4.7 0 0 0 .4-9.4 7.1 7.1 0 0 0-13.4-1.5 5.5 5.5 0 0 0 1.9 10.9Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function GlobeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28">
      <circle cx="14" cy="14" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4.8 14h18.4M14 4.5c2.6 2.5 4 5.6 4 9.5s-1.4 7-4 9.5c-2.6-2.5-4-5.6-4-9.5s1.4-7 4-9.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="M12.5 4.5 7 10l5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="m7.5 4.5 5.5 5.5-5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="M10 4v12M4 10h12"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="m5.5 5.5 9 9m0-9-9 9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function SpinnerIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="spinner" viewBox="0 0 20 20">
      <path
        d="M10 3a7 7 0 1 1-6.4 4.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function SparkIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M12 3.8 13.7 9l5.3 1.7-5.3 1.7L12 17.6l-1.7-5.2L5 10.7 10.3 9 12 3.8Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function CubeIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="m12 3 7 4v10l-7 4-7-4V7l7-4Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m5.4 7.3 6.6 3.9 6.6-3.9M12 21V11.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function GridIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M5 5h5v5H5V5Zm9 0h5v5h-5V5ZM5 14h5v5H5v-5Zm9 0h5v5h-5v-5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function BookIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M6.5 4.5h7A3.5 3.5 0 0 1 17 8v11.5h-7A3.5 3.5 0 0 0 6.5 23V4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="M17 19.5h.5A3.5 3.5 0 0 1 21 23V7.5A3.5 3.5 0 0 0 17.5 4H17"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="M5.5 6.8h9m-6.8 0v8.1m4.6-8.1v8.1M8 4.8h4l.5 1H15m-10 0h2.5m-1.2 1 1 9.1h5.4l1-9.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  )
}

export default App
