import { useState } from 'react'
import { CaptureSummary, CollectionSummary, HubShortcutSummary } from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import { formatDate, getCaptureHost } from '../utils/aether-ui'
import { ChevronRightIcon, CloseIcon, CubeIcon, GridIcon, SparkIcon, TrashIcon } from './icons'

type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null

type DashboardProps = {
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
}

export function Dashboard({
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
}: DashboardProps): React.JSX.Element {
  const [recentOpen, setRecentOpen] = useState(false)
  const aetherMarkSrc = new URL('aether-mark.svg', window.location.href).toString()
  const wavyLinesSrc = new URL('wavy-lines.svg', window.location.href).toString()

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
                  <CollectionIcon icon={collection.icon} />
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
