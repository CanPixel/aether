import { memo, CSSProperties, DragEvent, useRef, useState, type ComponentType } from 'react'
import {
  Atom,
  BookOpen,
  BrainCircuit,
  BriefcaseBusiness,
  Code2,
  Cpu,
  Dna,
  Film,
  FlaskConical,
  Gamepad2,
  Globe2,
  HeartPulse,
  Landmark,
  Microscope,
  Music,
  Palette,
  Shield,
  Snowflake,
  Sprout,
  Telescope
} from 'lucide-react'
import {
  CaptureSummary,
  CollectionSummary,
  HubShortcutSummary,
  LibrarySearchHit,
  LibrarySearchResult,
  SavedIcebergSummary
} from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import {
  cleanTitle,
  countLabel,
  formatDate,
  getCaptureHost,
  getPortalTint,
  getRootDomainLetter,
  inferIcebergIcon
} from '../utils/aether-ui'
import { ChevronRightIcon, AetherSigilIcon, CloseIcon, CubeIcon } from './icons'
import { SquarePen, Trash2 as TrashIcon } from 'lucide-react'
import { portals } from '../constants/Features'
import { writeClipboardText } from '../utils/clipboard'
import { buildExtractionReceipt } from '../utils/extraction-receipt'

type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null

// A drag carries a capturable link when it is not one of ÆTHER's own internal
// reorder/move drags. Internal drags are identified by their private MIME types,
// which is the only thing readable during dragover.
function isLinkDrag(types: readonly string[]): boolean {
  if (types.includes('application/x-aether-capture')) return false
  if (types.includes('application/x-aether-collection')) return false
  return types.includes('application/x-aether-tab') || types.includes('text/uri-list')
}

function readDroppedLink(transfer: DataTransfer): string {
  const tabUrl = transfer.getData('application/x-aether-tab')
  if (tabUrl) return tabUrl
  // text/uri-list may hold several lines; the first non-comment line is the link.
  const uriList = transfer.getData('text/uri-list')
  if (uriList) {
    const first = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'))
    if (first) return first
  }
  return transfer.getData('text/plain').trim()
}

type DashboardProps = {
  busy: string | null
  searchResult: LibrarySearchResult | null
  searching: boolean
  searchLibrary: (query: string, collectionId?: string) => Promise<void>
  clearSearch: () => void
  openSearchHit: (hit: LibrarySearchHit) => Promise<void>
  capturesByCollection: Record<string, CaptureSummary[]>
  capturingLink: boolean
  captureLink: (url: string, collectionId: string) => Promise<void>
  captureOpenTabs: (collectionId: string) => Promise<void>
  openTabCount: number
  collections: CollectionSummary[]
  deleteCapture: (captureId: string) => Promise<void>
  deleteSavedIceberg: (id: string) => Promise<void>
  deleteShortcut: (shortcutId: string) => Promise<void>
  moveCapture: (captureId: string, collectionId: string) => Promise<void>
  openCapture: (capture: CaptureSummary) => Promise<void>
  openSavedIceberg: (id: string) => Promise<unknown>
  openShortcut: (shortcut: HubShortcutSummary) => Promise<void>
  openCollectionDialog: (state: NonNullable<CollectionDialogState>) => void
  askCollection: (collectionId: string) => void
  reorderCollections: (ids: string[]) => Promise<void>
  reorderSavedIcebergs: (ids: string[]) => Promise<void>
  reorderShortcuts: (ids: string[]) => Promise<void>
  selectedCollectionId: string
  savedIcebergs: SavedIcebergSummary[]
  shortcuts: HubShortcutSummary[]
  selectCollection: (value: string) => Promise<void>
}

function DashboardComponent({
  busy,
  searchResult,
  searching,
  searchLibrary,
  clearSearch,
  openSearchHit,
  capturesByCollection,
  capturingLink,
  captureLink,
  captureOpenTabs,
  openTabCount,
  collections,
  deleteCapture,
  deleteSavedIceberg,
  deleteShortcut,
  moveCapture,
  openCapture,
  openSavedIceberg,
  openShortcut,
  openCollectionDialog,
  askCollection,
  reorderCollections,
  reorderSavedIcebergs,
  reorderShortcuts,
  selectedCollectionId,
  savedIcebergs,
  shortcuts,
  selectCollection
}: DashboardProps): React.JSX.Element {
  const [openCollectionId, setOpenCollectionId] = useState(selectedCollectionId)
  const [draggedShortcutId, setDraggedShortcutId] = useState('')
  const [dragOverShortcutId, setDragOverShortcutId] = useState('')
  const [draggedIcebergId, setDraggedIcebergId] = useState('')
  const [dragOverIcebergId, setDragOverIcebergId] = useState('')
  const [draggedCollectionId, setDraggedCollectionId] = useState('')
  const [draggedCapture, setDraggedCapture] = useState<CaptureSummary | null>(null)
  const [dragOverCaptureId, setDragOverCaptureId] = useState('')
  const [captureOrder, setCaptureOrder] = useState<Record<string, string[]>>({})
  // Source of an in-flight capture drag. A ref (not state) so the drag handlers read
  // a synchronously-correct value mid-drag, the way the cross-hub move reads dataTransfer.
  const captureDragRef = useRef<{ id: string; from: string } | null>(null)
  const [dragOverCollectionId, setDragOverCollectionId] = useState('')
  const [linkDraft, setLinkDraft] = useState('')
  const [linkTargetId, setLinkTargetId] = useState(selectedCollectionId)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchScopeId, setSearchScopeId] = useState('')
  const aetherMarkSrc = new URL('aether-mark.svg', window.location.href).toString()
  const wavyLinesSrc = new URL('wavy-lines.svg', window.location.href).toString()

  function getCaptureCollections(capture: CaptureSummary): CollectionSummary[] {
    const matches = collections.filter((collection) =>
      (capturesByCollection[collection.id] ?? []).some((item) => item.url === capture.url)
    )
    return matches.length > 0
      ? matches
      : collections.filter((item) => item.id === capture.collectionId)
  }

  async function reorderPortal(targetId: string): Promise<void> {
    if (!draggedShortcutId || draggedShortcutId === targetId) return

    const currentIds = shortcuts.map((shortcut) => shortcut.id)
    const fromIndex = currentIds.indexOf(draggedShortcutId)
    const toIndex = currentIds.indexOf(targetId)
    if (fromIndex === -1 || toIndex === -1) return

    const nextIds = [...currentIds]
    const [movedId] = nextIds.splice(fromIndex, 1)
    nextIds.splice(toIndex, 0, movedId)
    await reorderShortcuts(nextIds)
  }

  async function reorderIceberg(targetId: string): Promise<void> {
    if (!draggedIcebergId || draggedIcebergId === targetId) return

    const currentIds = savedIcebergs.map((iceberg) => iceberg.id)
    const fromIndex = currentIds.indexOf(draggedIcebergId)
    const toIndex = currentIds.indexOf(targetId)
    if (fromIndex === -1 || toIndex === -1) return

    const nextIds = [...currentIds]
    const [movedId] = nextIds.splice(fromIndex, 1)
    nextIds.splice(toIndex, 0, movedId)
    await reorderSavedIcebergs(nextIds)
  }

  async function reorderCollection(targetId: string): Promise<void> {
    if (!draggedCollectionId || draggedCollectionId === targetId) return

    const currentIds = collections.map((collection) => collection.id)
    const fromIndex = currentIds.indexOf(draggedCollectionId)
    const toIndex = currentIds.indexOf(targetId)
    if (fromIndex === -1 || toIndex === -1) return

    const nextIds = [...currentIds]
    const [movedId] = nextIds.splice(fromIndex, 1)
    nextIds.splice(toIndex, 0, movedId)
    await reorderCollections(nextIds)
  }

  // Cosmetic, in-memory ordering of sources within a single hub. The backend has no
  // notion of capture order, so this just sorts the rendered list by a local override.
  function orderedCaptures(collectionId: string, captures: CaptureSummary[]): CaptureSummary[] {
    const order = captureOrder[collectionId]
    if (!order || order.length === 0) return captures

    const remaining = new Map(captures.map((capture) => [capture.id, capture]))
    const result: CaptureSummary[] = []
    for (const id of order) {
      const capture = remaining.get(id)
      if (capture) {
        result.push(capture)
        remaining.delete(id)
      }
    }
    for (const capture of captures) {
      if (remaining.has(capture.id)) result.push(capture)
    }
    return result
  }

  function reorderCaptureWithin(
    collectionId: string,
    captures: CaptureSummary[],
    draggedId: string,
    targetId: string
  ): void {
    if (!draggedId || draggedId === targetId) return

    const currentIds = orderedCaptures(collectionId, captures).map((capture) => capture.id)
    const fromIndex = currentIds.indexOf(draggedId)
    if (fromIndex === -1) return

    const nextIds = [...currentIds]
    const [movedId] = nextIds.splice(fromIndex, 1)
    const targetIndex = targetId ? nextIds.indexOf(targetId) : -1
    if (targetIndex === -1) nextIds.push(movedId)
    else nextIds.splice(targetIndex, 0, movedId)
    setCaptureOrder((prev) => ({ ...prev, [collectionId]: nextIds }))
  }

  return (
    <div className="dashboard">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>ÆTHER</h1>
          <p>Your browser and your knowledge.</p>
        </div>
        <div className="hero-orb" aria-hidden="true">
          <span className="hero-orb-aura" />
          <img src={aetherMarkSrc} alt="Aether logo" draggable={false} />
        </div>

        <img className="wavy-lines" src={wavyLinesSrc} alt="Wavy lines" draggable={false} />
      </header>

      <div className="saved-shelves">
        <section className="hub-row">
          <div className="section-title compact">
            <span className="section-symbol">
              <span style={{ margin: '3px 2px 0 0' }}>{portals.icon}</span>
            </span>
            <div>
              <h2>Portals</h2>
              <p>Launch saved pages like local workspaces.</p>
            </div>
          </div>
          {shortcuts.length === 0 ? (
            <div className="empty-row">Saved pages will appear here as launch tiles.</div>
          ) : (
            <div className="hub-shortcuts">
              {shortcuts.map((shortcut) => (
                <article
                  className={`hub-shortcut ${
                    draggedShortcutId === shortcut.id ? 'dragging' : ''
                  } ${dragOverShortcutId === shortcut.id ? 'drop-target' : ''}`}
                  draggable
                  key={shortcut.id}
                  onDragEnd={() => {
                    setDraggedShortcutId('')
                    setDragOverShortcutId('')
                  }}
                  onDragEnter={(event) => {
                    if (!draggedShortcutId || draggedShortcutId === shortcut.id) return
                    event.preventDefault()
                    setDragOverShortcutId(shortcut.id)
                  }}
                  onDragOver={(event) => {
                    if (!draggedShortcutId || draggedShortcutId === shortcut.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDragStart={(event) => {
                    setDraggedShortcutId(shortcut.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('application/x-aether-shortcut', shortcut.id)
                    event.dataTransfer.setData('text/plain', shortcut.title)
                  }}
                  onDrop={async (event) => {
                    event.preventDefault()
                    await reorderPortal(shortcut.id)
                    setDraggedShortcutId('')
                    setDragOverShortcutId('')
                  }}
                  style={
                    {
                      '--portal-tint': getPortalTint(shortcut.host, shortcut.themeColor)
                    } as CSSProperties
                  }
                >
                  <button
                    className="hub-launch"
                    draggable={false}
                    onClick={() => openShortcut(shortcut)}
                    title={shortcut.url}
                    type="button"
                  >
                    <span>{getRootDomainLetter(shortcut.host)}</span>
                    <strong>{cleanTitle(shortcut.title)}</strong>
                    <small>{shortcut.host}</small>
                  </button>
                  <button
                    className="hub-delete"
                    draggable={false}
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

        <section className="iceberg-band">
          <div className="section-title compact">
            <span className="section-symbol">
              <Snowflake />
            </span>
            <div>
              <h2>Saved Icebergs</h2>
              <p>Reopen complexity atlases from iCE.</p>
            </div>
          </div>

          {savedIcebergs.length === 0 ? (
            <div className="empty-row">Saved iCE atlases will appear here.</div>
          ) : (
            <div className="saved-iceberg-grid">
              {savedIcebergs.map((iceberg) => (
                <article
                  className={`saved-iceberg-card ${
                    draggedIcebergId === iceberg.id ? 'dragging' : ''
                  } ${dragOverIcebergId === iceberg.id ? 'drop-target' : ''}`}
                  draggable
                  key={iceberg.id}
                  onDragEnd={() => {
                    setDraggedIcebergId('')
                    setDragOverIcebergId('')
                  }}
                  onDragEnter={(event) => {
                    if (!draggedIcebergId || draggedIcebergId === iceberg.id) return
                    event.preventDefault()
                    setDragOverIcebergId(iceberg.id)
                  }}
                  onDragOver={(event) => {
                    if (!draggedIcebergId || draggedIcebergId === iceberg.id) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDragStart={(event) => {
                    setDraggedIcebergId(iceberg.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('application/x-aether-iceberg', iceberg.id)
                    event.dataTransfer.setData('text/plain', iceberg.title)
                  }}
                  onDrop={async (event) => {
                    event.preventDefault()
                    await reorderIceberg(iceberg.id)
                    setDraggedIcebergId('')
                    setDragOverIcebergId('')
                  }}
                >
                  <button
                    className="saved-iceberg-open"
                    disabled={Boolean(busy)}
                    draggable={false}
                    onClick={() => {
                      void openSavedIceberg(iceberg.id)
                    }}
                    type="button"
                  >
                    <span>{countLabel(iceberg.itemCount, 'topic')}</span>
                    <strong>{iceberg.title}</strong>
                    <small>
                      {formatDate(iceberg.savedAt)}
                      {/* {' • '} */}
                      {/* {formatVisibleModelName(iceberg.model) ?? iceberg.model} */}
                    </small>
                  </button>
                  <button
                    aria-label={`Delete ${iceberg.title}`}
                    className="saved-iceberg-delete"
                    disabled={Boolean(busy)}
                    draggable={false}
                    onClick={() => deleteSavedIceberg(iceberg.id)}
                    title="Delete saved iceberg"
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                  <span className="saved-iceberg-flair" aria-hidden="true">
                    <IcebergFlairIcon icon={iceberg.icon ?? inferIcebergIcon(iceberg)} />
                  </span>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="knowledge-band">
        <div className="section-title">
          <span className="section-symbol">
            <CubeIcon />
          </span>
          <div style={{ marginTop: '-6px' }}>
            <h2>Knowledge Hubs</h2>
            <p>Persistent local hubs for captured pages, notes, and research trails.</p>
          </div>
          <button
            className="new-collection-button"
            disabled={Boolean(busy)}
            onClick={() => openCollectionDialog({ mode: 'create' })}
            type="button"
          >
            Add
          </button>
        </div>

        {collections.length > 0 && (
          <form
            className="library-search"
            onSubmit={(event) => {
              event.preventDefault()
              const query = searchDraft.trim()
              if (!query) return
              void searchLibrary(query, searchScopeId || undefined)
            }}
            role="search"
          >
            <input
              aria-label="Search captured sources"
              disabled={Boolean(busy)}
              onChange={(event) => {
                setSearchDraft(event.target.value)
                if (!event.target.value.trim()) clearSearch()
              }}
              placeholder="Search your captured sources…"
              type="search"
              value={searchDraft}
            />
            <select
              aria-label="Search scope"
              disabled={Boolean(busy)}
              onChange={(event) => setSearchScopeId(event.target.value)}
              value={searchScopeId}
            >
              <option value="">All hubs</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
            <button disabled={Boolean(busy) || searching || !searchDraft.trim()} type="submit">
              {searching ? 'Searching…' : 'Search'}
            </button>
            {searchResult && (
              <button
                className="library-search-clear"
                onClick={() => {
                  setSearchDraft('')
                  clearSearch()
                }}
                type="button"
              >
                Clear
              </button>
            )}

            {searchResult && (
              <div className="library-search-results">
                <p className="library-search-summary">
                  {searchResult.hits.length === 0
                    ? `No sources match "${searchResult.query}".`
                    : `${countLabel(searchResult.hits.length, 'source')} for "${searchResult.query}"`}
                  {/* Say when ranking was literal, so a weak result set is not
                      mistaken for an empty library. */}
                  {searchResult.mode === 'literal' && (
                    <span className="library-search-mode">
                      name matching only — install an embedding model for meaning-based search
                    </span>
                  )}
                </p>
                <ul>
                  {searchResult.hits.map((hit) => (
                    <li key={hit.captureId}>
                      <button
                        onClick={() => {
                          void openSearchHit(hit)
                        }}
                        type="button"
                      >
                        <span className="library-search-hit-head">
                          <strong>{cleanTitle(hit.title)}</strong>
                          <span className="library-search-score">{Math.round(hit.score)}%</span>
                        </span>
                        <span className="library-search-hit-meta">
                          {hit.host} · {hit.collectionName} · {formatDate(hit.capturedAt)}
                          {hit.chunkMatches > 1 ? ` · ${hit.chunkMatches} passages` : ''}
                        </span>
                        <span className="library-search-excerpt">{hit.excerpt}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </form>
        )}

        {collections.length > 0 && (
          <form
            className="hub-link-capture"
            onSubmit={(event) => {
              event.preventDefault()
              const url = linkDraft.trim()
              const target = linkTargetId || collections[0].id
              if (!url) return
              void captureLink(url, target).then(() => setLinkDraft(''))
            }}
          >
            <input
              aria-label="Link to capture"
              disabled={capturingLink || Boolean(busy)}
              onChange={(event) => setLinkDraft(event.target.value)}
              placeholder="Paste a link to capture without opening it…"
              type="text"
              value={linkDraft}
            />
            <select
              aria-label="Capture into hub"
              disabled={capturingLink || Boolean(busy)}
              onChange={(event) => setLinkTargetId(event.target.value)}
              value={linkTargetId || collections[0].id}
            >
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
            <button disabled={capturingLink || Boolean(busy) || !linkDraft.trim()} type="submit">
              {capturingLink ? 'Capturing…' : 'Capture Link'}
            </button>
            {openTabCount > 0 && (
              <button
                className="hub-link-capture-tabs"
                disabled={capturingLink || Boolean(busy)}
                onClick={() => {
                  void captureOpenTabs(linkTargetId || collections[0].id)
                }}
                type="button"
              >
                Capture {countLabel(openTabCount, 'open tab')}
              </button>
            )}
            <small>Or drag a tab or link onto a hub below.</small>
          </form>
        )}

        {collections.length === 0 ? (
          <div className="empty-state hub-empty-state">
            <h3>No hubs yet</h3>
            <p>Create a hub, open a page, and capture it into your local knowledge base.</p>
            <button onClick={() => openCollectionDialog({ mode: 'create' })} type="button">
              Create First Hub
            </button>
          </div>
        ) : (
          <div className="collection-list">
            {collections.map((collection) => {
              const collectionCaptures = capturesByCollection[collection.id] ?? []
              const isOpen = openCollectionId === collection.id
              const canDropCapture =
                Boolean(draggedCapture) && draggedCapture?.collectionId !== collection.id
              const canDropCollection =
                Boolean(draggedCollectionId) && draggedCollectionId !== collection.id
              return (
                <article
                  className={`collection-accordion ${isOpen ? 'open' : ''} ${
                    draggedCollectionId === collection.id ? 'dragging' : ''
                  } ${
                    canDropCapture && dragOverCollectionId === collection.id ? 'drop-target' : ''
                  } ${
                    canDropCollection && dragOverCollectionId === collection.id
                      ? 'reorder-target'
                      : ''
                  }`}
                  draggable
                  onDragEnter={(event) => {
                    const canDropLink = isLinkDrag(event.dataTransfer.types)
                    if (!canDropCapture && !canDropCollection && !canDropLink) return
                    event.preventDefault()
                    setDragOverCollectionId(collection.id)
                  }}
                  onDragOver={(event) => {
                    const canDropLink = isLinkDrag(event.dataTransfer.types)
                    if (!canDropCapture && !canDropCollection && !canDropLink) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = canDropLink ? 'copy' : 'move'
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDragOverCollectionId('')
                    }
                  }}
                  onDragStart={(event) => {
                    if ((event.target as HTMLElement).closest('.collection-captures')) return
                    setDraggedCollectionId(collection.id)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('application/x-aether-collection', collection.id)
                    event.dataTransfer.setData('text/plain', collection.name)
                  }}
                  onDragEnd={() => {
                    setDraggedCollectionId('')
                    setDragOverCollectionId('')
                  }}
                  onDrop={async (event) => {
                    event.preventDefault()
                    setDragOverCollectionId('')

                    // A dragged tab chip or an external link becomes a new capture.
                    // Checked before the internal branches so a link drop is never
                    // mistaken for a reorder.
                    if (isLinkDrag(event.dataTransfer.types)) {
                      const url = readDroppedLink(event.dataTransfer)
                      if (url) {
                        setOpenCollectionId(collection.id)
                        await captureLink(url, collection.id)
                      }
                      return
                    }

                    const collectionId = event.dataTransfer.getData(
                      'application/x-aether-collection'
                    )
                    if (collectionId && canDropCollection) {
                      await reorderCollection(collection.id)
                      setDraggedCollectionId('')
                      return
                    }

                    const captureId =
                      event.dataTransfer.getData('application/x-aether-capture') ||
                      draggedCapture?.id
                    if (!captureId || !canDropCapture) return

                    await moveCapture(captureId, collection.id)
                    setDraggedCapture(null)
                    setOpenCollectionId(collection.id)
                  }}
                  key={collection.id}
                >
                  <div
                    className={`collection-row ${collection.id === selectedCollectionId ? 'active' : ''}`}
                  >
                    <button
                      className="collection-toggle"
                      onClick={() => {
                        selectCollection(collection.id)
                        setOpenCollectionId((current) =>
                          current === collection.id ? '' : collection.id
                        )
                      }}
                      type="button"
                    >
                      <span className="collection-glyph">
                        <CollectionIcon icon={collection.icon} />
                      </span>
                      <span className="collection-main">
                        <strong>{collection.name}</strong>
                        <small>
                          {collection.description || 'Captured sources and local context'}
                        </small>
                      </span>
                      <span className="collection-meta">
                        <strong>{countLabel(collection.captureCount, 'capture')}</strong>
                      </span>
                      <ChevronRightIcon />
                    </button>
                    <div className="collection-row-actions">
                      <button
                        className="collection-ask"
                        disabled={collection.captureCount === 0 || collection.chunkCount === 0}
                        onClick={() => askCollection(collection.id)}
                        title={`Ask ${collection.name}`}
                        type="button"
                      >
                        <AetherSigilIcon />
                        <span>Ask</span>
                      </button>
                      <button
                        aria-label={`Edit ${collection.name}`}
                        className="collection-edit"
                        onClick={() => openCollectionDialog({ mode: 'edit', collection })}
                        title={`Edit ${collection.name}`}
                        type="button"
                      >
                        <SquarePen size={13} />
                      </button>
                      <button
                        aria-label={`Delete ${collection.name}`}
                        className="danger-button collection-delete"
                        onClick={() => openCollectionDialog({ mode: 'delete', collection })}
                        title={`Delete ${collection.name}`}
                        type="button"
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="collection-captures" hidden={!isOpen}>
                    {collectionCaptures.length === 0 ? (
                      <div className="empty-row">No captures in this hub yet.</div>
                    ) : (
                      <div
                        className="collection-capture-list"
                        onDragOver={(event) => {
                          const info = captureDragRef.current
                          if (!info || info.from !== collection.id) return
                          event.preventDefault()
                          event.dataTransfer.dropEffect = 'move'
                        }}
                        onDrop={(event) => {
                          const info = captureDragRef.current
                          if (!info || info.from !== collection.id) return
                          event.preventDefault()
                          event.stopPropagation()
                          reorderCaptureWithin(
                            collection.id,
                            collectionCaptures,
                            info.id,
                            dragOverCaptureId
                          )
                          setDragOverCaptureId('')
                        }}
                      >
                        {orderedCaptures(collection.id, collectionCaptures).map((capture) => (
                          <CaptureCard
                            capture={capture}
                            collections={getCaptureCollections(capture)}
                            deleteCapture={deleteCapture}
                            dragging={draggedCapture?.id === capture.id}
                            reorderTarget={dragOverCaptureId === capture.id}
                            key={capture.id}
                            openCapture={openCapture}
                            onDragEnd={() => {
                              captureDragRef.current = null
                              setDraggedCapture(null)
                              setDragOverCaptureId('')
                              setDragOverCollectionId('')
                            }}
                            onDragStart={(event) => {
                              captureDragRef.current = { id: capture.id, from: collection.id }
                              setDraggedCapture(capture)
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('application/x-aether-capture', capture.id)
                              event.dataTransfer.setData('text/plain', capture.title)
                            }}
                            onReorderEnter={() => {
                              const info = captureDragRef.current
                              if (!info || info.from !== collection.id || info.id === capture.id) {
                                return
                              }
                              setDragOverCaptureId(capture.id)
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function CaptureCard({
  capture,
  collections,
  deleteCapture,
  dragging,
  reorderTarget,
  onDragEnd,
  onDragStart,
  onReorderEnter,
  openCapture
}: {
  capture: CaptureSummary
  collections: CollectionSummary[]
  deleteCapture: (captureId: string) => Promise<void>
  dragging: boolean
  reorderTarget: boolean
  onDragEnd: () => void
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onReorderEnter: (event: DragEvent<HTMLElement>) => void
  openCapture: (capture: CaptureSummary) => Promise<void>
}): React.JSX.Element {
  const [receiptCopyState, setReceiptCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyReceipt(): Promise<void> {
    try {
      await writeClipboardText(buildExtractionReceipt(capture))
      setReceiptCopyState('copied')
    } catch {
      setReceiptCopyState('failed')
    }
    window.setTimeout(() => setReceiptCopyState('idle'), 1600)
  }

  return (
    <article
      className={`recent-card ${dragging ? 'dragging' : ''} ${
        reorderTarget ? 'reorder-target' : ''
      }`}
      draggable
      onDragEnd={onDragEnd}
      onDragEnter={onReorderEnter}
      onDragStart={onDragStart}
    >
      <div className="recent-source">
        <button
          className="capture-link-button"
          draggable={false}
          onClick={() => openCapture(capture)}
          type="button"
        >
          {getCaptureHost(capture.url)}
        </button>
        <button
          aria-label={`Delete ${capture.title}`}
          className="recent-delete"
          draggable={false}
          onClick={() => deleteCapture(capture.id)}
          title={`Delete ${capture.title}`}
          type="button"
        >
          <TrashIcon style={{ width: '13px' }} />
        </button>
      </div>
      <div className="recent-card-title-row">
        <h3>{capture.title}</h3>
        <div className="data-badges">
          <time>{formatDate(capture.capturedAt)}</time>
          <span>{countLabel(capture.chunkCount, 'chunk')}</span>
          {/* Library hygiene, not a privacy marker — capture writes locally and
              emits nothing. It exists so private-session research stays findable
              afterwards instead of blending into every other source. */}
          {capture.fromPrivateTab && (
            <span className="private-origin-badge" title="Saved from a private tab">
              Private
            </span>
          )}
        </div>
      </div>
      <div className="capture-hub-row">
        {collections.map((collection) => (
          <span key={collection.id}>
            <CollectionIcon icon={collection.icon} />
            {collection.name}
          </span>
        ))}
      </div>
      {capture.provenance && (
        <details
          className="extraction-receipt"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
        >
          <summary>Extraction receipt</summary>
          <dl>
            <div>
              <dt>Captured</dt>
              <dd>{capture.capturedAt}</dd>
            </div>
            <div>
              <dt>Record</dt>
              <dd>
                Immutable · {capture.provenance.contentScope} · receipt{' '}
                {capture.provenance.receiptVersion || 'legacy'}
              </dd>
            </div>
            <div>
              <dt>Extracted</dt>
              <dd>
                {capture.provenance.wordCount > 0
                  ? countLabel(capture.provenance.wordCount, 'word')
                  : 'Legacy record'}{' '}
                · {capture.provenance.contentSelector || 'legacy extractor'}
              </dd>
            </div>
            <div>
              <dt>Method</dt>
              <dd>{capture.provenance.extractionMethod}</dd>
            </div>
            <div>
              <dt>Extractor</dt>
              <dd>{capture.provenance.extractorVersion || 'legacy extractor'}</dd>
            </div>
            {capture.provenance.requestedUrl && capture.provenance.requestedUrl !== capture.url && (
              <div>
                <dt>Requested</dt>
                <dd title={capture.provenance.requestedUrl}>{capture.provenance.requestedUrl}</dd>
              </div>
            )}
            {capture.provenance.author && (
              <div>
                <dt>Author</dt>
                <dd>{capture.provenance.author}</dd>
              </div>
            )}
            {capture.provenance.publishedAt && (
              <div>
                <dt>Published</dt>
                <dd>{capture.provenance.publishedAt}</dd>
              </div>
            )}
            {capture.provenance.canonicalUrl && (
              <div>
                <dt>Canonical</dt>
                <dd title={capture.provenance.canonicalUrl}>
                  {getCaptureHost(capture.provenance.canonicalUrl)}
                </dd>
              </div>
            )}
            {capture.provenance.siteName && (
              <div>
                <dt>Site</dt>
                <dd>{capture.provenance.siteName}</dd>
              </div>
            )}
            {capture.provenance.language && (
              <div>
                <dt>Language</dt>
                <dd>{capture.provenance.language}</dd>
              </div>
            )}
            {capture.provenance.fallbackReason && (
              <div className="extraction-receipt-wide">
                <dt>Fallback</dt>
                <dd>{capture.provenance.fallbackReason}</dd>
              </div>
            )}
            <div>
              <dt>Fingerprint</dt>
              <dd title={capture.provenance.contentHash}>
                {capture.provenance.contentHash.slice(0, 12)}
              </dd>
            </div>
          </dl>
          <button
            className="extraction-receipt-copy"
            draggable={false}
            onClick={copyReceipt}
            type="button"
          >
            {receiptCopyState === 'copied'
              ? 'Receipt copied'
              : receiptCopyState === 'failed'
                ? 'Copy failed'
                : 'Copy full receipt'}
          </button>
        </details>
      )}
    </article>
  )
}

function IcebergFlairIcon({ icon }: { icon: string }): React.JSX.Element {
  const icons: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
    atom: Atom,
    book: BookOpen,
    brain: BrainCircuit,
    briefcase: BriefcaseBusiness,
    code: Code2,
    cpu: Cpu,
    dna: Dna,
    film: Film,
    flask: FlaskConical,
    gamepad: Gamepad2,
    globe: Globe2,
    heart: HeartPulse,
    landmark: Landmark,
    microscope: Microscope,
    music: Music,
    palette: Palette,
    shield: Shield,
    snowflake: Snowflake,
    sprout: Sprout,
    telescope: Telescope
  }
  const Icon = icons[icon] ?? Snowflake

  return <Icon size={20} strokeWidth={1.9} />
}

// Wrapped in memo because App owns almost all of this app's state: a keystroke in
// the address bar, a status toast, a streaming token — each re-renders App, and
// without this every one of them re-renders this panel too. The handlers App
// passes down go through useStableHandler so those props stay equal between
// renders; without that this wrapper would compare unequal every time and do
// nothing.
export const Dashboard = memo(DashboardComponent)
