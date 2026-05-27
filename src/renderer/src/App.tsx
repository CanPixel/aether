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
import { BrowserChrome } from './components/BrowserChrome'
import { CollectionDialog, CollectionDialogState } from './components/CollectionDialog'
import { Dashboard } from './components/Dashboard'
import { GlobeIcon, CloudIcon } from './components/icons'
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
  const [dashboardOpen, setDashboardOpen] = useState(true)
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
      ? 'æther://dashboard'
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
        setDashboardOpen(false)
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
      setNotice(error instanceof Error ? error.message : 'Æther hit an unexpected error.')
    } finally {
      setBusy(null)
    }
  }

  const showAppTooltips = dashboardOpen

  return (
    <main className={`aether-shell ${panelCollapsed ? 'panel-collapsed' : ''}`}>
      <div className="window-titlebar" aria-hidden="true">
        <strong>ÆTHER</strong>
      </div>

      <aside className="app-rail">
        <button
          className={`brand-mark tooltip-host ${dashboardOpen ? 'active' : ''}`}
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

        {dashboardOpen ? (
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
    </main>
  )
}

export default App
