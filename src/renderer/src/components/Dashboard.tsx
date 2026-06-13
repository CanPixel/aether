import { CSSProperties, DragEvent, useState, type ComponentType } from 'react'
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
  SavedIcebergSummary
} from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import {
  formatDate,
  formatLocalModelName,
  getCaptureHost,
  inferIcebergIcon
} from '../utils/aether-ui'
import { ChevronRightIcon, CloseIcon, CubeIcon, GridIcon, SnowflakeIcon } from './icons'
import { Trash2 as TrashIcon } from 'lucide-react'

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
  deleteSavedIceberg: (id: string) => Promise<void>
  deleteShortcut: (shortcutId: string) => Promise<void>
  moveCapture: (captureId: string, collectionId: string) => Promise<void>
  openCapture: (capture: CaptureSummary) => Promise<void>
  openSavedIceberg: (id: string) => Promise<unknown>
  openShortcut: (shortcut: HubShortcutSummary) => Promise<void>
  openCollectionDialog: (state: NonNullable<CollectionDialogState>) => void
  reorderCollections: (ids: string[]) => Promise<void>
  reorderSavedIcebergs: (ids: string[]) => Promise<void>
  reorderShortcuts: (ids: string[]) => Promise<void>
  selectedCollectionId: string
  savedIcebergs: SavedIcebergSummary[]
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

function getPortalTint(host: string, themeColor?: string): string {
  const normalized = host.replace(/^www\./, '')
  const brandColors: Record<string, string> = {
    'reddit.com': '#ff8800',
    'youtube.com': '#ff0000',
    'youtu.be': '#ff0000',
    'google.com': '#4285f4',
    'github.com': '#6e7681',
    'duckduckgo.com': '#de5833',
    'ecosia.org': '#39a96b',
    'wikipedia.org': '#727b86'
  }
  const matchedBrand = Object.entries(brandColors).find(
    ([domain]) => normalized === domain || normalized.endsWith(`.${domain}`)
  )
  if (matchedBrand) return matchedBrand[1]
  if (themeColor) return themeColor

  const palette = ['#4f8fd6', '#3aaea1', '#c07f43', '#7772d6', '#4e9a62', '#b95f79', '#547aa5']
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0
  }

  return palette[hash % palette.length]
}

export function Dashboard({
  busy,
  capturesByCollection,
  collections,
  deleteCapture,
  deleteSavedIceberg,
  deleteShortcut,
  moveCapture,
  openCapture,
  openSavedIceberg,
  openShortcut,
  openCollectionDialog,
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
            <SnowflakeIcon />
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
                  <span>{iceberg.itemCount} frozen fragments</span>
                  <strong>{iceberg.title}</strong>
                  <small>
                    {formatDate(iceberg.savedAt)}{' '}
                    {formatLocalModelName(iceberg.model) ?? iceberg.model}
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
                    if (!canDropCapture && !canDropCollection) return
                    event.preventDefault()
                    setDragOverCollectionId(collection.id)
                  }}
                  onDragOver={(event) => {
                    if (!canDropCapture && !canDropCollection) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
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
                        <strong>
                          {collection.captureCount} capture
                          {collection.captureCount !== 1 ? 's' : ''}
                        </strong>
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
                        aria-label={`Delete ${collection.name}`}
                        className="danger-button"
                        onClick={() => openCollectionDialog({ mode: 'delete', collection })}
                        title={`Delete ${collection.name}`}
                        type="button"
                        style={{ padding: '0 4px' }}
                      >
                        <TrashIcon size={13} style={{ marginTop: '4px' }} />
                      </button>
                    </div>
                  </div>
                  <div className="collection-captures" hidden={!isOpen}>
                    {collectionCaptures.length === 0 ? (
                      <div className="empty-row">No captures in this hub yet.</div>
                    ) : (
                      <div className="collection-capture-list">
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
  onDragStart: (event: DragEvent<HTMLElement>) => void
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
          <span>{capture.chunkCount} chunks</span>
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

  return <Icon size={24} strokeWidth={1.9} />
}
