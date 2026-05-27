import { useState } from 'react'
import { CaptureSummary, CollectionSummary, HubShortcutSummary } from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import { formatDate, getCaptureHost } from '../utils/aether-ui'
import { ChevronRightIcon, CloseIcon, CubeIcon, GridIcon, TrashIcon } from './icons'

type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null

type DashboardProps = {
  busy: string | null
  capturesByCollection: Record<string, CaptureSummary[]>
  collections: CollectionSummary[]
  deleteCapture: (captureId: string) => Promise<void>
  deleteShortcut: (shortcutId: string) => Promise<void>
  moveCapture: (captureId: string, collectionId: string) => Promise<void>
  openCapture: (capture: CaptureSummary) => Promise<void>
  openShortcut: (shortcut: HubShortcutSummary) => Promise<void>
  openCollectionDialog: (state: CollectionDialogState) => void
  saveActiveTabToHub: () => Promise<void>
  selectedCollectionId: string
  shortcuts: HubShortcutSummary[]
  selectCollection: (value: string) => Promise<void>
}

function cleanTitle(title: string): string {
  if (!title) return ''

  const suffixRegex =
    /[\s\-_|—]+(Wikipedia|YouTube|Reddit.*|GitHub|Twitter|X|Medium|Stack Overflow|LinkedIn|The heart of the internet)$/i

  return title.replace(suffixRegex, '').trim()
}

function getRootDomainLetter(hostString: string): string {
  if (!hostString) return 'Æ'

  let hostname = hostString.toLowerCase().trim()
  if (hostname.includes('://')) {
    try {
      hostname = new URL(hostname).hostname
    } catch {
      /* empty */
    }
  }

  const cleanHost = hostname.replace(/^(www\.|en\.|m\.|beta\.)/, '')

  // Grab the very first character of the remaining root domain
  return cleanHost.charAt(0).toUpperCase()
}

export function Dashboard({
  busy,
  capturesByCollection,
  collections,
  deleteCapture,
  deleteShortcut,
  moveCapture,
  openCapture,
  openShortcut,
  openCollectionDialog,
  saveActiveTabToHub,
  selectedCollectionId,
  shortcuts,
  selectCollection
}: DashboardProps): React.JSX.Element {
  const [openCollectionId, setOpenCollectionId] = useState(selectedCollectionId)
  const [draggedCapture, setDraggedCapture] = useState<CaptureSummary | null>(null)
  const [dragOverCollectionId, setDragOverCollectionId] = useState('')
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

  return (
    <div className="dashboard">
      <header className="dashboard-hero">
        <div className="hero-copy">
          <h1>ÆTHER</h1>
          <p>Your browser. Your knowledge.</p>
        </div>
        <div className="hero-orb" aria-hidden="true">
          <span className="hero-orb-aura" />
          <img src={aetherMarkSrc} alt="Aether logo" draggable={false} />
        </div>

        <img className="wavy-lines" src={wavyLinesSrc} alt="Wavy lines" draggable={false} />
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
          <button
            className="save-page-button"
            disabled={Boolean(busy)}
            onClick={saveActiveTabToHub}
            type="button"
          >
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
                  <span>{getRootDomainLetter(shortcut.host)}</span>
                  <strong>{cleanTitle(shortcut.title)}</strong>
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
            {collections.map((collection) => {
              const collectionCaptures = capturesByCollection[collection.id] ?? []
              const isOpen = openCollectionId === collection.id
              const canDropCapture =
                Boolean(draggedCapture) && draggedCapture?.collectionId !== collection.id
              return (
                <article
                  className={`collection-accordion ${isOpen ? 'open' : ''} ${
                    canDropCapture && dragOverCollectionId === collection.id ? 'drop-target' : ''
                  }`}
                  onDragEnter={(event) => {
                    if (!canDropCapture) return
                    event.preventDefault()
                    setDragOverCollectionId(collection.id)
                  }}
                  onDragOver={(event) => {
                    if (!canDropCapture) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDragOverCollectionId('')
                    }
                  }}
                  onDrop={async (event) => {
                    event.preventDefault()
                    setDragOverCollectionId('')
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
                        <strong>{collection.captureCount} captures</strong>
                        <small>{collection.chunkCount} chunks</small>
                      </span>
                      <ChevronRightIcon />
                    </button>
                    <div className="collection-row-actions">
                      <button
                        onClick={() => openCollectionDialog({ mode: 'edit', collection })}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="danger-button"
                        onClick={() => openCollectionDialog({ mode: 'delete', collection })}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="collection-captures" hidden={!isOpen}>
                    {collectionCaptures.length === 0 ? (
                      <div className="empty-row">No captures in this hub yet.</div>
                    ) : (
                      <div className="recent-card-grid">
                        {collectionCaptures.map((capture) => (
                          <CaptureCard
                            capture={capture}
                            collections={getCaptureCollections(capture)}
                            deleteCapture={deleteCapture}
                            dragging={draggedCapture?.id === capture.id}
                            key={capture.id}
                            openCapture={openCapture}
                            onDragEnd={() => {
                              setDraggedCapture(null)
                              setDragOverCollectionId('')
                            }}
                            onDragStart={(event) => {
                              setDraggedCapture(capture)
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('application/x-aether-capture', capture.id)
                              event.dataTransfer.setData('text/plain', capture.title)
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
  onDragEnd,
  onDragStart,
  openCapture
}: {
  capture: CaptureSummary
  collections: CollectionSummary[]
  deleteCapture: (captureId: string) => Promise<void>
  dragging: boolean
  onDragEnd: () => void
  onDragStart: (event: React.DragEvent<HTMLElement>) => void
  openCapture: (capture: CaptureSummary) => Promise<void>
}): React.JSX.Element {
  return (
    <article
      className={`recent-card ${dragging ? 'dragging' : ''}`}
      draggable
      onDragEnd={onDragEnd}
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
          title="Delete capture"
          type="button"
        >
          <TrashIcon />
        </button>
      </div>
      <h3>{capture.title}</h3>
      <div className="capture-hub-row">
        {collections.map((collection) => (
          <span key={collection.id}>
            <CollectionIcon icon={collection.icon} />
            {collection.name}
          </span>
        ))}
      </div>
      <p>Captured and indexed for local retrieval.</p>
      <footer>
        <span>{capture.chunkCount} chunks</span>
        <time>{formatDate(capture.capturedAt)}</time>
      </footer>
    </article>
  )
}
