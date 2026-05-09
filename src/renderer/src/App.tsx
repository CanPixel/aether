import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AetherState,
  AppSummary,
  CaptureResult,
  CaptureSummary,
  ChatResult,
  CollectionSummary,
  SearchResult,
  SystemStatus
} from '../../shared/aether'

function App(): React.JSX.Element {
  const [apps, setApps] = useState<AppSummary[]>([])
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [captures, setCaptures] = useState<CaptureSummary[]>([])
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [dashboardOpen, setDashboardOpen] = useState(true)
  const [selectedCollectionId, setSelectedCollectionId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [chatPrompt, setChatPrompt] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [chatResult, setChatResult] = useState<ChatResult | null>(null)
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [busy, setBusy] = useState<string | null>('Starting Aether')
  const [notice, setNotice] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const activeApp = useMemo(() => apps.find((app) => app.isActive) ?? apps[0], [apps])
  const selectedCollection = useMemo(
    () =>
      collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0],
    [collections, selectedCollectionId]
  )

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

  const refreshAll = useCallback(async (): Promise<void> => {
    const [nextApps, nextStatus] = await Promise.all([
      window.aether.apps.list(),
      window.aether.system.status()
    ])
    setApps(nextApps)
    setStatus(nextStatus)
    await refreshCollections()
  }, [refreshCollections])

  useEffect(() => {
    const unsubscribe = window.aether.events.onState((state: AetherState) => {
      setApps(state.apps)
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
        window.aether.layout.setIntelligencePanelCollapsed(false)
        searchInputRef.current?.focus()
      }
      if ((event.metaKey || event.ctrlKey) && key === 't') {
        event.preventDefault()
        openDashboard()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  async function openDashboard(): Promise<void> {
    await window.aether.dashboard.open()
    setDashboardOpen(true)
  }

  async function activateApp(appId: string): Promise<void> {
    await runTask('Switching app', async () => {
      await window.aether.apps.activate(appId)
      setApps(await window.aether.apps.list())
      setDashboardOpen(false)
    })
  }

  async function navigate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!activeApp) return

    await runTask('Navigating', async () => {
      await window.aether.apps.navigate(activeApp.id, activeApp.currentUrl)
      setDashboardOpen(false)
    })
  }

  async function goBack(): Promise<void> {
    if (!activeApp) return

    await runTask('Going back', async () => {
      await window.aether.apps.goBack(activeApp.id)
      setApps(await window.aether.apps.list())
      setDashboardOpen(false)
    })
  }

  async function goForward(): Promise<void> {
    if (!activeApp) return

    await runTask('Going forward', async () => {
      await window.aether.apps.goForward(activeApp.id)
      setApps(await window.aether.apps.list())
      setDashboardOpen(false)
    })
  }

  async function createCollection(): Promise<void> {
    const name = window.prompt('Collection name')
    if (name === null) return
    const description = window.prompt('Description') ?? undefined

    await runTask('Creating collection', async () => {
      const collection = await window.aether.collections.create({
        name,
        description
      })
      await refreshCollections(collection.id)
      setNotice(`Created ${collection.name}.`)
    })
  }

  async function renameCollection(): Promise<void> {
    if (!selectedCollection) return

    const name = window.prompt('Collection name', selectedCollection.name)
    if (name === null) return
    const description = window.prompt('Description', selectedCollection.description) ?? undefined

    await runTask('Updating collection', async () => {
      const collection = await window.aether.collections.update({
        id: selectedCollection.id,
        name,
        description
      })
      await refreshCollections(collection.id)
      setNotice(`Updated ${collection.name}.`)
    })
  }

  async function deleteCollection(): Promise<void> {
    if (!selectedCollection) return
    const confirmed = window.confirm(
      `Delete "${selectedCollection.name}" and all indexed captures?`
    )
    if (!confirmed) return

    await runTask('Deleting collection', async () => {
      await window.aether.collections.delete(selectedCollection.id)
      setSearchResults([])
      setChatResult(null)
      await refreshCollections()
      setNotice('Collection deleted.')
    })
  }

  async function capturePage(): Promise<void> {
    if (!selectedCollection) {
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
      setNotice(`Captured ${result.chunkCount} chunks into ${result.collectionName}.`)
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
      setNotice(
        results.length ? `Found ${results.length} local matches.` : 'No local matches found.'
      )
    })
  }

  async function ask(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!selectedCollection) return

    await runTask('Asking local model', async () => {
      const result = await window.aether.chat.ask({
        prompt: chatPrompt,
        collectionId: selectedCollection.id,
        includeCurrentPage: !dashboardOpen
      })

      setChatResult(result)
      setNotice(`Answered with ${result.model}.`)
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
    <main className="aether-shell">
      <div className="window-titlebar" aria-hidden="true">
        <div className="traffic-dots">
          <span className="traffic-dot" />
          <span className="traffic-dot" />
          <span className="traffic-dot" />
        </div>
        <strong>Aether</strong>
      </div>
      <aside className="app-rail">
        <div className="traffic-spacer" />
        <button
          className={`brand-mark ${dashboardOpen ? 'active' : ''}`}
          aria-label="Open Aether dashboard"
          onClick={openDashboard}
          type="button"
        >
          <CloudIcon />
        </button>
        <nav className="app-list" aria-label="Apps">
          {apps.map((app) => (
            <button
              className={`app-button ${app.isActive ? 'active' : ''}`}
              key={app.id}
              onClick={() => activateApp(app.id)}
              title={`${app.name} - ${app.category}`}
              type="button"
            >
              <span className="app-initial">
                <GlobeIcon />
              </span>
              <span className="app-dot" aria-hidden="true" />
            </button>
          ))}
        </nav>
      </aside>

      <section className={`workspace ${panelCollapsed ? 'panel-collapsed' : ''}`}>
        <form className="address-bar" onSubmit={navigate}>
          <div className="history-controls" aria-label="Browser history controls">
            <button
              aria-label="Go back"
              disabled={dashboardOpen || !activeApp?.canGoBack}
              onClick={goBack}
              type="button"
            >
              <ChevronLeftIcon />
            </button>
            <button
              aria-label="Go forward"
              disabled={dashboardOpen || !activeApp?.canGoForward}
              onClick={goForward}
              type="button"
            >
              <ChevronRightIcon />
            </button>
          </div>
          <div className="active-app">
            <span>{dashboardOpen ? 'Dashboard' : (activeApp?.name ?? 'Aether')}</span>
            <small>
              {dashboardOpen
                ? 'Collections'
                : activeApp?.isLoading
                  ? 'Loading'
                  : (activeApp?.category ?? 'Local')}
            </small>
          </div>
          <input
            aria-label="Current app URL"
            disabled={dashboardOpen || !activeApp}
            value={dashboardOpen ? 'aether://dashboard' : (activeApp?.currentUrl ?? '')}
            onChange={(event) => {
              if (!activeApp) return
              setApps((current) =>
                current.map((app) =>
                  app.id === activeApp.id ? { ...app, currentUrl: event.target.value } : app
                )
              )
            }}
          />
          <button type="submit" disabled={dashboardOpen || !activeApp}>
            Go
          </button>
        </form>

        {dashboardOpen ? (
          <Dashboard
            busy={busy}
            captures={captures}
            collections={collections}
            createCollection={createCollection}
            deleteCapture={deleteCapture}
            deleteCollection={deleteCollection}
            renameCollection={renameCollection}
            selectedCollection={selectedCollection}
            selectedCollectionId={selectedCollectionId}
            setSelectedCollectionId={(collectionId) => {
              setSelectedCollectionId(collectionId)
              window.aether.collections.captures(collectionId).then(setCaptures)
            }}
          />
        ) : (
          <div className="webview-underlay">
            <span>Native web content</span>
          </div>
        )}
      </section>

      <aside className={`intelligence-panel ${panelCollapsed ? 'collapsed' : ''}`}>
        <button
          className="panel-toggle"
          type="button"
          onClick={togglePanel}
          aria-label={panelCollapsed ? 'Open intelligence panel' : 'Collapse intelligence panel'}
        >
          {panelCollapsed ? 'AI' : 'Hide'}
        </button>

        {!panelCollapsed && (
          <div className="panel-content">
            <header className="panel-header">
              <div>
                <p>Aether Intelligence</p>
                <h1>Search, ask, and discover your knowledge.</h1>
              </div>
              <StatusPill status={status} />
            </header>

            <section className="panel-section">
              <div className="section-heading">
                <h2>Capture</h2>
                <span>
                  {dashboardOpen ? 'Open a website first' : activeApp?.title || activeApp?.name}
                </span>
              </div>
              <label className="field-label" htmlFor="collection-select">
                Collection
              </label>
              <div className="capture-row">
                <select
                  id="collection-select"
                  value={selectedCollection?.id ?? ''}
                  onChange={(event) => {
                    setSelectedCollectionId(event.target.value)
                    window.aether.collections.captures(event.target.value).then(setCaptures)
                  }}
                >
                  <option value="" disabled>
                    Select collection
                  </option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={capturePage}
                  disabled={Boolean(busy) || dashboardOpen || !selectedCollection}
                >
                  Capture
                </button>
              </div>
              {lastCapture && (
                <p className="capture-note">
                  {lastCapture.chunkCount} chunks saved from {lastCapture.title}
                </p>
              )}
            </section>

            <section className="panel-section">
              <div className="section-heading">
                <h2>Search</h2>
                <span>{selectedCollection?.name ?? 'No collection'}</span>
              </div>
              <form className="search-form" onSubmit={search}>
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search selected collection"
                />
                <button
                  type="submit"
                  disabled={Boolean(busy) || !searchQuery.trim() || !selectedCollection}
                >
                  Search
                </button>
              </form>
              <div className="results-list">
                {searchResults.slice(0, 4).map((result) => (
                  <article className="result-item" key={result.id}>
                    <div>
                      <h3>{result.title}</h3>
                      <span>
                        chunk {result.chunkIndex + 1} · {result.score.toFixed(3)}
                      </span>
                    </div>
                    <p>{result.text}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="panel-section chat-section">
              <div className="section-heading">
                <h2>Ask</h2>
                <span>{status?.chatModel ?? 'No model'}</span>
              </div>
              <form className="chat-form" onSubmit={ask}>
                <textarea
                  value={chatPrompt}
                  onChange={(event) => setChatPrompt(event.target.value)}
                  placeholder="Ask this collection"
                />
                <button
                  type="submit"
                  disabled={Boolean(busy) || !chatPrompt.trim() || !selectedCollection}
                >
                  Ask Aether
                </button>
              </form>
              {chatResult && (
                <article className="answer-card">
                  <p>{chatResult.answer}</p>
                  <footer>{chatResult.citations.length} local citations</footer>
                </article>
              )}
            </section>

            <footer className="panel-footer">
              <span>{busy ?? notice ?? 'Cmd+T opens dashboard · Cmd+K focuses search'}</span>
              <span>{status?.dbPath ? 'Local DB ready' : 'Checking local DB'}</span>
            </footer>
          </div>
        )}
      </aside>
    </main>
  )
}

function Dashboard({
  busy,
  captures,
  collections,
  createCollection,
  deleteCapture,
  deleteCollection,
  renameCollection,
  selectedCollection,
  selectedCollectionId,
  setSelectedCollectionId
}: {
  busy: string | null
  captures: CaptureSummary[]
  collections: CollectionSummary[]
  createCollection: () => Promise<void>
  deleteCapture: (captureId: string) => Promise<void>
  deleteCollection: () => Promise<void>
  renameCollection: () => Promise<void>
  selectedCollection?: CollectionSummary
  selectedCollectionId: string
  setSelectedCollectionId: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="dashboard">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>Aether</h1>
          <p>Your browser. Your knowledge. Yours, locally.</p>
        </div>
        <div className="heaven-gate" aria-hidden="true">
          <span className="gate-star" />
          <span className="gate-arch" />
          <span className="gate-step step-one" />
          <span className="gate-step step-two" />
          <span className="gate-cloud cloud-left" />
          <span className="gate-cloud cloud-right" />
          <span className="bird bird-one" />
          <span className="bird bird-two" />
        </div>
      </header>

      <div className="dashboard-grid">
        <section className="collections-pane concept-card">
          <div className="pane-heading concept-heading">
            <div className="heading-icon">
              <CubeIcon />
            </div>
            <div>
              <h2>Persistent Collections</h2>
              <span>Your local knowledge, organized and always available.</span>
            </div>
            <button
              className="new-collection-button"
              disabled={Boolean(busy)}
              onClick={createCollection}
              type="button"
            >
              + New Collection
            </button>
          </div>
          {selectedCollection && (
            <div className="collection-toolbar">
              <span>
                Managing <strong>{selectedCollection.name}</strong>
              </span>
              <div>
                <button type="button" onClick={renameCollection}>
                  Rename
                </button>
                <button type="button" className="danger-button" onClick={deleteCollection}>
                  Delete
                </button>
              </div>
            </div>
          )}
          <div className="collection-list">
            {collections.map((collection) => (
              <button
                className={`collection-row ${collection.id === selectedCollectionId ? 'active' : ''}`}
                key={collection.id}
                onClick={() => setSelectedCollectionId(collection.id)}
                type="button"
              >
                <span className="collection-glyph">
                  <BookIcon />
                </span>
                <span className="collection-main">
                  <strong>{collection.name}</strong>
                  <small>{collection.description || 'Articles, notes and references'}</small>
                </span>
                <span className="collection-meta">
                  <strong>{collection.chunkCount} chunks</strong>
                  <small>{collection.captureCount} captures</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="recent-captures concept-card">
        <div className="recent-heading">
          <div>
            <SparkIcon />
            <h2>Recent Captures</h2>
            <p>Your latest additions, automatically captured and ready.</p>
          </div>
        </div>
        <div className="recent-card-grid">
          {(captures.length ? captures.slice(0, 3) : placeholderCaptures).map((capture) => (
            <article className="recent-card" key={capture.id}>
              <div className="recent-source">
                <span>{capture.url ? getCaptureHost(capture.url) : 'aether.local'}</span>
                {capture.url ? (
                  <button
                    aria-label={`Delete ${capture.title}`}
                    className="recent-delete"
                    onClick={() => deleteCapture(capture.id)}
                    type="button"
                    title="Delete capture"
                  >
                    <TrashIcon />
                  </button>
                ) : (
                  <span className="recent-placeholder-mark" aria-hidden="true" />
                )}
              </div>
              <h3>{capture.title}</h3>
              <p>
                {capture.url
                  ? 'Captured and indexed for local retrieval.'
                  : 'Open Google, capture a page, and it will appear here.'}
              </p>
              <footer>
                <span>{capture.url ? 'Article' : 'Guide'}</span>
                <time>
                  {capture.url ? new Date(capture.capturedAt).toLocaleDateString() : 'Ready'}
                </time>
              </footer>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

const placeholderCaptures: CaptureSummary[] = [
  {
    id: 'placeholder-1',
    collectionId: 'placeholder',
    title: 'The AI-Powered Developer',
    url: '',
    appId: 'browser',
    capturedAt: new Date().toISOString(),
    chunkCount: 0
  },
  {
    id: 'placeholder-2',
    collectionId: 'placeholder',
    title: 'Attention Is All You Need',
    url: '',
    appId: 'browser',
    capturedAt: new Date().toISOString(),
    chunkCount: 0
  },
  {
    id: 'placeholder-3',
    collectionId: 'placeholder',
    title: 'Design Systems Handbook',
    url: '',
    appId: 'browser',
    capturedAt: new Date().toISOString(),
    chunkCount: 0
  }
]

function getCaptureHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
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
