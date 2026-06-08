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
  SaveIcebergInput,
  SavedIceberg,
  SavedIcebergSummary,
  StatusToastInput,
  SystemStatus
} from '../../shared/aether'
import { BrowserChrome } from './components/BrowserChrome'
import { CollectionDialog, CollectionDialogState } from './components/CollectionDialog'
import { Crystallizer } from './components/Crystallizer'
import { Dashboard } from './components/Dashboard'
import { GlobeIcon, CloudIcon, GearIcon, SnowflakeIcon } from './components/icons'
import { IntelligencePanel } from './components/IntelligencePanel'
import { QuickAction } from './types/ui'
import { getQuickActions, normalizeComparableUrl } from './utils/aether-ui'
import { SearchIcon } from 'lucide-react'

const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url'
])

function getEditableShortcutTarget(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null

  const editable = target.closest(
    'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
  )
  if (!editable) return null
  if (editable instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(editable.type) && !editable.readOnly && !editable.disabled
      ? editable
      : null
  }
  if (editable instanceof HTMLTextAreaElement) {
    return !editable.readOnly && !editable.disabled ? editable : null
  }
  return editable instanceof HTMLElement && editable.isContentEditable ? editable : null
}

function selectEditableContent(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement
): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.select()
    return
  }

  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function getNoticeTone(message: string): StatusToastInput['tone'] {
  const errorPattern =
    /\b(failed|could not|unexpected|error|select|open a page|create a collection|already captured|already in)\b/i
  return errorPattern.test(message) ? 'error' : 'success'
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Æther hit an unexpected error.'

  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function App(): React.JSX.Element {
  const [apps, setApps] = useState<AppSummary[]>([])
  const [tabs, setTabs] = useState<BrowserTabSummary[]>([])
  const [shortcuts, setShortcuts] = useState<HubShortcutSummary[]>([])
  const [savedIcebergs, setSavedIcebergs] = useState<SavedIcebergSummary[]>([])
  const [activeSavedIceberg, setActiveSavedIceberg] = useState<SavedIceberg | null>(null)
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
  const [askPanelOpen, setAskPanelOpen] = useState(true)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [chatResult, setChatResult] = useState<ChatResult | null>(null)
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  const [busy, setBusy] = useState<string | null>('')
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
  const chatBlocked = status ? !status.ollamaReachable || !status.chatModel : false
  const quickActions = useMemo<QuickAction[]>(() => getQuickActions(activeTab), [activeTab])
  const activeTabUrl = activeTab?.url ?? ''
  const addressValue = addressFocused
    ? addressDraft
    : dashboardOpen
      ? workspaceMode === 'crystallizer'
        ? 'ice://crystallizer'
        : 'æther://dashboard'
      : activeTabUrl
  const activeTabHubShortcut = useMemo(() => {
    if (!activeTabUrl) return undefined
    const activeUrl = normalizeComparableUrl(activeTabUrl)
    return shortcuts.find((shortcut) => normalizeComparableUrl(shortcut.url) === activeUrl)
  }, [activeTabUrl, shortcuts])
  const activeTabSavedToHub = Boolean(activeTabHubShortcut)
  const activeTabHubNeedsMetadata = Boolean(
    activeTabHubShortcut &&
    ((!activeTabHubShortcut.themeColor && activeTab?.themeColor) ||
      (!activeTabHubShortcut.favicon && activeTab?.favicon))
  )

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

  const refreshSavedIcebergs = useCallback(async (): Promise<void> => {
    setSavedIcebergs(await window.aether.crystallizer.listSaved())
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshShell(),
      refreshCollections(),
      refreshShortcuts(),
      refreshSavedIcebergs()
    ])
  }, [refreshCollections, refreshSavedIcebergs, refreshShell, refreshShortcuts])

  const createTab = useCallback(
    async (input?: { url?: string }): Promise<void> => {
      setNotice(null)

      try {
        const tab = await window.aether.tabs.create(input)
        setActiveTabId(tab.id)
        setDashboardOpen(false)
        setWorkspaceMode('dashboard')
        await refreshShell()
      } catch (error) {
        setNotice(getErrorMessage(error))
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
      const editableTarget = getEditableShortcutTarget(event.target)
      if (editableTarget) {
        if ((event.metaKey || event.ctrlKey) && key === 'a') {
          event.preventDefault()
          event.stopPropagation()
          selectEditableContent(editableTarget)
        }
        return
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

  useEffect(() => {
    const message = busy ?? notice
    if (!message || /^starting\s+æ?ther$/i.test(message)) return

    const toast: StatusToastInput = {
      message,
      tone: busy ? 'info' : getNoticeTone(message),
      durationMs: busy ? 2600 : undefined
    }
    window.aether.layout.showStatusToast(toast).catch(() => undefined)
  }, [busy, notice])

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
    try {
      await window.aether.tabs.close(tabId)
      await refreshShell()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
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
        await closeCollectionDialog()
        await refreshCollections(collection.id)
        setNotice(`${collection.name} is ready.`)
      }
    )
  }

  async function confirmDeleteCollection(): Promise<void> {
    if (!collectionDialog || collectionDialog.mode !== 'delete') return

    await runTask('Deleting collection', async () => {
      await window.aether.collections.delete(collectionDialog.collection.id)
      await closeCollectionDialog()
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
      await openCollectionDialog({ mode: 'create' })
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

  async function askPrompt(
    prompt: string,
    contextOverride?: { collectionId?: string; includeCurrentPage?: boolean }
  ): Promise<void> {
    const hasKnowledgeHubs = usableAskCollections.length > 0
    const selectedAskCollection =
      askCollection && askCollection.captureCount > 0 && askCollection.chunkCount > 0
        ? askCollection
        : undefined
    const collectionId = contextOverride
      ? contextOverride.collectionId
      : hasKnowledgeHubs && !askCurrentPageOnly
        ? selectedAskCollection?.id
        : undefined
    const includeCurrentPage =
      contextOverride?.includeCurrentPage ??
      (!hasKnowledgeHubs || askCurrentPageOnly || askIncludeCurrentPage)

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
      setAskPanelOpen(false)
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
    setAskCollectionId('')
    setAskCurrentPageOnly(true)
    setAskIncludeCurrentPage(true)
    setChatPrompt(action.prompt)
    await askPrompt(action.prompt, { collectionId: undefined, includeCurrentPage: true })
  }

  async function saveActiveTabToHub(): Promise<void> {
    if (!activeTab?.url) {
      setNotice('Open a page before saving it to the Hub.')
      return
    }
    if (activeTabSavedToHub && !activeTabHubNeedsMetadata) {
      setNotice('This page is already saved as a portal.')
      return
    }

    const updatingPortal = activeTabSavedToHub
    await runTask('Saving to Hub', async () => {
      await window.aether.hub.create({
        title: activeTab.title || activeTab.host || activeTab.url,
        url: activeTab.url,
        favicon: activeTab.favicon,
        themeColor: activeTab.themeColor
      })
      await refreshShortcuts()
      setNotice(updatingPortal ? 'Updated portal appearance.' : 'Saved to Hub.')
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
      const message = error instanceof Error ? getErrorMessage(error) : 'Crystallization failed.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function saveIceberg(input: SaveIcebergInput): Promise<SavedIceberg> {
    setBusy('Saving iceberg')
    setNotice(null)

    try {
      const saved = await window.aether.crystallizer.save(input)
      setActiveSavedIceberg(saved)
      await refreshSavedIcebergs()
      setNotice(`Saved ${saved.title}.`)
      return saved
    } catch (error) {
      const message = error instanceof Error ? getErrorMessage(error) : 'Saving iceberg failed.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function openSavedIceberg(id: string): Promise<SavedIceberg> {
    setBusy('Opening saved iceberg')
    setNotice(null)

    try {
      const saved = await window.aether.crystallizer.getSaved(id)
      await window.aether.dashboard.open()
      setActiveSavedIceberg(saved)
      setWorkspaceMode('crystallizer')
      setDashboardOpen(true)
      setNotice(`Opened ${saved.title}.`)
      return saved
    } catch (error) {
      const message =
        error instanceof Error ? getErrorMessage(error) : 'Could not open saved iceberg.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function deleteSavedIceberg(id: string): Promise<void> {
    setBusy('Deleting iceberg')
    setNotice(null)

    try {
      await window.aether.crystallizer.deleteSaved(id)
      if (activeSavedIceberg?.id === id) {
        setActiveSavedIceberg(null)
      }
      await refreshSavedIcebergs()
      setNotice('Saved iceberg deleted.')
    } catch (error) {
      const message =
        error instanceof Error ? getErrorMessage(error) : 'Could not delete saved iceberg.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function openCrystallizedTopic(_keyword: string, item: IcebergItem): Promise<void> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(`${item.name}`)}`
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

  async function reorderSavedIcebergs(ids: string[]): Promise<void> {
    const nextIcebergs = await window.aether.crystallizer.reorderSaved(ids)
    setSavedIcebergs(nextIcebergs)
  }

  async function openCollectionDialog(state: NonNullable<CollectionDialogState>): Promise<void> {
    setCollectionDialog(state)
    await window.aether.layout.setModalOverlayOpen(true)
  }

  async function closeCollectionDialog(): Promise<void> {
    setCollectionDialog(null)
    await window.aether.layout.setModalOverlayOpen(false)
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
      setNotice(getErrorMessage(error))
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
          capturesBlocked={dashboardOpen}
          collections={collections}
          dashboardOpen={dashboardOpen}
          dashboardSubtitle={crystallizerOpen ? 'Info Crystallizer Engine' : 'Knowledge Hub'}
          dashboardTitle={crystallizerOpen ? 'iCE' : 'ÆTHER'}
          lastCapture={lastCapture}
          portalSaveBlocked={
            dashboardOpen || !activeTab?.url || (activeTabSavedToHub && !activeTabHubNeedsMetadata)
          }
          portalSaveTitle={
            activeTabSavedToHub
              ? activeTabHubNeedsMetadata
                ? 'Refresh portal appearance'
                : 'Already saved as a portal'
              : 'Save current page as portal'
          }
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
          onCreateCollection={() => {
            void openCollectionDialog({ mode: 'create' })
          }}
          onForward={goForward}
          onNavigate={navigate}
          onQuickAction={handleQuickAction}
          onSavePortal={saveActiveTabToHub}
          onSelectTab={activateTab}
          onSelectCollection={selectCollection}
        />

        {crystallizerOpen ? (
          <Crystallizer
            busy={busy}
            key={activeSavedIceberg?.id ?? 'new-iceberg'}
            openedIceberg={activeSavedIceberg}
            savedIcebergs={savedIcebergs}
            onDeleteSaved={deleteSavedIceberg}
            onGenerate={generateIceberg}
            onOpenSaved={openSavedIceberg}
            onOpenTopic={openCrystallizedTopic}
            onSave={saveIceberg}
          />
        ) : dashboardOpen ? (
          <Dashboard
            busy={busy}
            capturesByCollection={capturesByCollection}
            collections={collections}
            deleteCapture={deleteCapture}
            deleteSavedIceberg={deleteSavedIceberg}
            deleteShortcut={deleteShortcut}
            moveCapture={moveCapture}
            openCapture={openCapture}
            openSavedIceberg={openSavedIceberg}
            openShortcut={openShortcut}
            openCollectionDialog={(state) => {
              void openCollectionDialog(state)
            }}
            reorderCollections={reorderCollections}
            reorderSavedIcebergs={reorderSavedIcebergs}
            reorderShortcuts={reorderShortcuts}
            selectedCollectionId={selectedCollectionId}
            savedIcebergs={savedIcebergs}
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
        askPanelOpen={askPanelOpen}
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
        onAskPanelOpenChange={setAskPanelOpen}
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
          onClose={() => {
            void closeCollectionDialog()
          }}
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
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '18px' }}>
            <GearIcon
              style={{ width: '25px', color: 'var(--accent-strong)', marginBottom: '2px' }}
            />
            <p
              id="settings-title"
              style={{ textAlign: 'center', margin: 'auto', fontSize: '18px' }}
            >
              <span
                style={{
                  fontWeight: 'bold',
                  marginRight: '-1px',
                  color: 'var(--accent-strong)',
                  fontSize: '23px'
                }}
              >
                Æ
              </span>
              ther Settings
            </p>
          </div>
          <button
            className="button"
            onClick={() => {
              void onClose()
            }}
            type="button"
          >
            Close
          </button>
        </header>

        <div className="settings-field">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SearchIcon height={30} width={30} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ margin: 0 }} htmlFor="default-search-engine">
                Default search engine
              </label>
              <p style={{ margin: 0 }}>
                Used when the address bar receives plain search text instead of a URL.
              </p>
            </div>
          </div>
          <div className="settings-engine-list" aria-label="Available search engines">
            {searchEngines.map((engine) => (
              <button
                className={
                  settings.browser.defaultSearchEngine === engine.id ? 'crystal-button' : ''
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
        </div>
      </section>
    </div>
  )
}

export default App
