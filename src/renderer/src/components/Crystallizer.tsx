import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  type CSSProperties,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Archive,
  BookOpen,
  ChevronDown,
  Compass,
  /*   ExternalLink,
  FolderOpen, */
  Layers,
  Move,
  Save,
  Search,
  Snowflake,
  Trash2
} from 'lucide-react'
import {
  IcebergItem,
  IcebergResult,
  SaveIcebergInput,
  SavedIceberg,
  SavedIcebergSummary
} from '../../../shared/aether'
import { formatVisibleModelName, inferIcebergIcon } from '../utils/aether-ui'
import { ChevronRightIcon } from './icons'
import { CrystallizingOrb } from './CrystallizingOrb'
import { Quantum } from 'ldrs/react'

type LayerDefinition = {
  level: number
  name: string
  shortName: string
  caption: string
  depth: string
  accent: string
}

type PositionedTopic = {
  item: IcebergItem
  displayX: number
  displayY: number
}

// The raised card is rendered as plain HTML positioned over (not inside) the SVG.
// Touching the SVG on hover is what triggered WebKit's foreignObject "teleport to
// 0,0" bug, so the SVG now stays completely static and this HTML layer floats on top.
type RaisedCard = {
  item: IcebergItem
  accent: string
  left: number
  top: number
  width: number
}

type DepthPath = {
  from: PositionedTopic
  to: PositionedTopic
}

type CrystallizerProps = {
  busy: string | null
  openedIceberg: SavedIceberg | null
  savedIcebergs: SavedIcebergSummary[]
  onDeleteSaved: (id: string) => Promise<void>
  onGenerate: (keyword: string) => Promise<IcebergResult>
  onOpenSaved: (id: string) => Promise<SavedIceberg>
  onOpenTopic: (keyword: string, item: IcebergItem) => Promise<void>
  onSave: (input: SaveIcebergInput) => Promise<SavedIceberg>
}

const CANVAS_WIDTH = 2200
const CANVAS_HEIGHT = 1800
const NODE_WIDTH = 286
const NODE_HEIGHT = 82
const MIN_ZOOM = 0.74
const MAX_ZOOM = 2.25
const FITTED_ZOOM = 0.74
const NODE_FIELD = {
  minX: 600,
  maxX: CANVAS_WIDTH - 430,
  topInset: 128,
  bottomInset: 58
}
const ICEBERG_BOUNDS = {
  minX: 172,
  maxX: 2028,
  minY: 120,
  maxY: 1790
}

const LAYERS: LayerDefinition[] = [
  {
    level: 1,
    name: 'Surface',
    shortName: 'Surface',
    caption: 'Common language',
    depth: '0-20%',
    accent: '#0f8cc2'
  },
  {
    level: 2,
    name: 'Formation',
    shortName: 'Formation',
    caption: 'Adjacent concepts',
    depth: '20-40%',
    accent: '#0f8f80'
  },
  {
    level: 3,
    name: 'Cold Current',
    shortName: 'Current',
    caption: 'Methods and mechanisms',
    depth: '40-60%',
    accent: '#64748b'
  },
  {
    level: 4,
    name: 'Black Ice',
    shortName: 'Black Ice',
    caption: 'Specialist patterns',
    depth: '60-80%',
    accent: '#7560b1'
  },
  {
    level: 5,
    name: 'Abyssal Lattice',
    shortName: 'Abyssal',
    caption: 'Hidden edge knowledge',
    depth: '80-100%',
    accent: '#b76e2d'
  }
]

const LAYER_HEIGHT = CANVAS_HEIGHT / LAYERS.length

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getLayer(level: number): LayerDefinition {
  return LAYERS.find((layer) => layer.level === level) ?? LAYERS[LAYERS.length - 1]
}

function formatDepthScore(item: IcebergItem): string | null {
  return typeof item.depthScore === 'number' ? `Depth ${Math.round(item.depthScore)}` : null
}

function formatConfidence(item: IcebergItem): string | null {
  if (typeof item.confidence !== 'number') return null
  const normalized = item.confidence <= 1 ? item.confidence * 100 : item.confidence
  return `Confidence ${Math.round(normalized)}%`
}

function getCenteredPan(zoom: number): { x: number; y: number } {
  const icebergCenterX = (ICEBERG_BOUNDS.minX + ICEBERG_BOUNDS.maxX) / 2
  const icebergCenterY = (ICEBERG_BOUNDS.minY + ICEBERG_BOUNDS.maxY) / 2

  return {
    x: CANVAS_WIDTH / 2 - icebergCenterX * zoom,
    y: CANVAS_HEIGHT / 2 - icebergCenterY * zoom
  }
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3)
}

function positionTopics(items: IcebergItem[]): PositionedTopic[] {
  const lanes = [14, 86, 29, 71, 50]

  return LAYERS.flatMap((layer) => {
    const layerItems = items
      .filter((item) => item.level === layer.level)
      .sort((first, second) => first.y - second.y || first.name.localeCompare(second.name))
    const layerTop = (layer.level - 1) * LAYER_HEIGHT
    const layerBottom = layer.level * LAYER_HEIGHT
    const yMin = layerTop + NODE_FIELD.topInset
    const yMax = layerBottom - NODE_FIELD.bottomInset
    const availableHeight = Math.max(0, yMax - yMin)
    const yStep = layerItems.length > 1 ? availableHeight / (layerItems.length - 1) : 0

    return layerItems.map((item, index) => {
      const sourceRatio =
        typeof item.x === 'number' ? item.x / 100 : lanes[index % lanes.length] / 100
      const lane = lanes[(layer.level + index) % lanes.length] / 100
      const blendedX = sourceRatio * 0.84 + lane * 0.16

      return {
        item,
        displayX: clamp(blendedX * CANVAS_WIDTH, NODE_FIELD.minX, NODE_FIELD.maxX),
        displayY: clamp(
          layerItems.length > 1 ? yMin + index * yStep : layerTop + LAYER_HEIGHT / 2,
          yMin,
          yMax
        )
      }
    })
  })
}

export function Crystallizer({
  busy,
  openedIceberg,
  savedIcebergs,
  onDeleteSaved,
  onGenerate,
  onOpenSaved,
  onOpenTopic,
  onSave
}: CrystallizerProps): React.JSX.Element {
  const [keyword, setKeyword] = useState(openedIceberg?.keyword ?? '')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IcebergResult | null>(() =>
    openedIceberg
      ? {
          keyword: openedIceberg.keyword,
          model: openedIceberg.model,
          generatedAt: openedIceberg.generatedAt,
          items: openedIceberg.items
        }
      : null
  )
  const [savedId, setSavedId] = useState<string | null>(openedIceberg?.id ?? null)
  const [selectedItem, setSelectedItem] = useState<IcebergItem | null>(
    openedIceberg?.items[0] ?? null
  )
  const [activeLayer, setActiveLayer] = useState<number | 'all'>('all')
  const [zoom, setZoom] = useState(FITTED_ZOOM)
  const [pan, setPan] = useState(() => getCenteredPan(FITTED_ZOOM))
  const [dragging, setDragging] = useState(false)
  const [savedDrawerOpen, setSavedDrawerOpen] = useState(() => !openedIceberg)
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)
  const [raisedCard, setRaisedCard] = useState<RaisedCard | null>(null)
  const [raisedVisible, setRaisedVisible] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const animationFrame = useRef<number | null>(null)

  // Snapshot the hovered/focused node's on-screen box so the HTML raised card can
  // sit exactly over it. Computed from the live DOM rect (includes pan/zoom), so no
  // coordinate math is needed and the SVG is never mutated.
  function raiseCard(target: SVGGElement, item: IcebergItem, accent: string): void {
    const shell = shellRef.current
    if (!shell) return
    const nodeRect = target.getBoundingClientRect()
    const shellRect = shell.getBoundingClientRect()
    // The raised card is wider than the node so the description has room to breathe;
    // keep it centred on the node so it reads as that card expanding, not a new one
    // dropped on top. Width scales with the node's on-screen size (i.e. with zoom).
    const width = nodeRect.width * 1.34
    const centerX = nodeRect.left - shellRect.left + nodeRect.width / 2
    setRaisedCard({
      item,
      accent,
      left: centerX - width / 2,
      top: nodeRect.top - shellRect.top,
      width
    })
    setRaisedVisible(true)
  }

  const positionedItems = useMemo(() => positionTopics(result?.items ?? []), [result])
  const visiblePositionedItems = useMemo(
    () =>
      activeLayer === 'all'
        ? positionedItems
        : positionedItems.filter(({ item }) => item.level === activeLayer),
    [activeLayer, positionedItems]
  )
  const visibleItems = useMemo(
    () => visiblePositionedItems.map(({ item }) => item),
    [visiblePositionedItems]
  )
  const activeSelectedItem =
    selectedItem && visibleItems.some((item) => item.id === selectedItem.id)
      ? selectedItem
      : (visibleItems[0] ?? null)
  const hasResults = Boolean(result?.items.length)
  const hasUnsavedResult = Boolean(result && !savedId)
  const hasSavedAtlases = savedIcebergs.length > 0
  const savedAtlasExpanded = savedDrawerOpen
  const focusedItemId = hoveredItemId ?? activeSelectedItem?.id ?? null
  const layerCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const layer of LAYERS) counts.set(layer.level, 0)
    for (const item of result?.items ?? []) {
      counts.set(item.level, (counts.get(item.level) ?? 0) + 1)
    }
    return counts
  }, [result])
  const depthPaths = useMemo(() => {
    if (activeLayer !== 'all') return []

    return LAYERS.slice(0, -1)
      .flatMap((layer) => {
        const current = positionedItems.filter(({ item }) => item.level === layer.level)
        const next = positionedItems.filter(({ item }) => item.level === layer.level + 1)

        return current.map((topic) => {
          const target = next.reduce<PositionedTopic | null>((closest, candidate) => {
            if (!closest) return candidate

            const closestDistance =
              Math.abs(closest.displayX - topic.displayX) +
              Math.abs(closest.displayY - topic.displayY)
            const candidateDistance =
              Math.abs(candidate.displayX - topic.displayX) +
              Math.abs(candidate.displayY - topic.displayY)

            return candidateDistance < closestDistance ? candidate : closest
          }, null)

          return target ? { from: topic, to: target } : null
        })
      })
      .filter((path): path is DepthPath => Boolean(path))
  }, [activeLayer, positionedItems])

  async function generate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const topic = keyword.trim()
    if (!topic || loading) return

    setLoading(true)
    setError(null)
    setResult(null)
    setSavedId(null)
    setSelectedItem(null)
    setActiveLayer('all')
    setSavedDrawerOpen(false)
    resetView()

    try {
      const nextResult = await onGenerate(topic)
      setResult(nextResult)
      setSelectedItem(nextResult.items[0] ?? null)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Crystallization failed.')
    } finally {
      setLoading(false)
    }
  }

  async function saveResult(): Promise<void> {
    if (!result || savedId || saving) return

    setSaving(true)
    setError(null)

    try {
      const saved = await onSave({
        title: result.keyword,
        keyword: result.keyword,
        model: result.model,
        icon: inferIcebergIcon(result),
        generatedAt: result.generatedAt,
        items: result.items
      })
      setSavedId(saved.id)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Saving iceberg failed.')
    } finally {
      setSaving(false)
    }
  }

  async function openSaved(id: string): Promise<void> {
    setLoading(true)
    setError(null)
    setSavedDrawerOpen(false)

    try {
      await onOpenSaved(id)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not reopen saved iceberg.')
    } finally {
      setLoading(false)
    }
  }

  async function deleteSaved(id: string): Promise<void> {
    try {
      await onDeleteSaved(id)
      if (savedId === id) {
        setSavedId(null)
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not delete saved iceberg.')
    }
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>): void {
    event.preventDefault()
    if (animationFrame.current) {
      cancelAnimationFrame(animationFrame.current)
      animationFrame.current = null
    }

    const bounds = event.currentTarget.getBoundingClientRect()
    const cursorX = ((event.clientX - bounds.left) / bounds.width) * CANVAS_WIDTH
    const cursorY = ((event.clientY - bounds.top) / bounds.height) * CANVAS_HEIGHT
    const nextZoom = clamp(zoom * Math.exp(-event.deltaY * 0.001), MIN_ZOOM, MAX_ZOOM)

    if (nextZoom === zoom) return

    const worldX = (cursorX - pan.x) / zoom
    const worldY = (cursorY - pan.y) / zoom

    // Zooming slides the node out from under the raised card's snapshot; hide it
    // and let the next hover re-place it.
    setRaisedVisible(false)
    setZoom(nextZoom)
    setPan({
      x: cursorX - worldX * nextZoom,
      y: cursorY - worldY * nextZoom
    })
  }

  function animateView(nextZoom: number, nextPan = pan): void {
    if (animationFrame.current) cancelAnimationFrame(animationFrame.current)

    // The view is about to move, so the raised card's snapshot no longer lines up
    // with its node — hide it; the next hover re-places it.
    setRaisedVisible(false)

    const startZoom = zoom
    const startPan = pan
    let startedAt: number | null = null
    const duration = 340

    const step = (timestamp: number): void => {
      startedAt ??= timestamp
      const progress = Math.min((timestamp - startedAt) / duration, 1)
      const eased = easeOutCubic(progress)
      setZoom(startZoom + (nextZoom - startZoom) * eased)
      setPan({
        x: startPan.x + (nextPan.x - startPan.x) * eased,
        y: startPan.y + (nextPan.y - startPan.y) * eased
      })

      if (progress < 1) {
        animationFrame.current = requestAnimationFrame(step)
      } else {
        animationFrame.current = null
      }
    }

    animationFrame.current = requestAnimationFrame(step)
  }

  function resetView(): void {
    animateView(FITTED_ZOOM, getCenteredPan(FITTED_ZOOM))
  }

  function focusItem(item: IcebergItem): void {
    const positionedItem = positionedItems.find(({ item: candidate }) => candidate.id === item.id)
    if (!positionedItem) return

    const nextZoom = clamp(Math.max(zoom, 1.72), MIN_ZOOM, MAX_ZOOM)
    animateView(nextZoom, {
      x: CANVAS_WIDTH / 2 - positionedItem.displayX * nextZoom,
      y: CANVAS_HEIGHT / 2 - positionedItem.displayY * nextZoom
    })
  }

  function selectItem(item: IcebergItem): void {
    setSelectedItem(item)
    focusItem(item)
  }

  function handleNodeKeyDown(
    event: ReactKeyboardEvent<SVGGElement>,
    item: IcebergItem
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectItem(item)
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if ((event.target as Element).closest('.ice-node-hit')) return
    event.preventDefault()
    setRaisedVisible(false)
    if (animationFrame.current) {
      cancelAnimationFrame(animationFrame.current)
      animationFrame.current = null
    }

    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y
    }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (!dragStart.current) return
    event.preventDefault()

    const SENSITIVITY = 1.75

    const deltaX = (event.clientX - dragStart.current.x) * SENSITIVITY
    const deltaY = (event.clientY - dragStart.current.y) * SENSITIVITY

    setPan({
      x: dragStart.current.panX + deltaX,
      y: dragStart.current.panY + deltaY
    })
  }

  function handlePointerLeave(): void {
    dragStart.current = null
    setDragging(false)
    setRaisedVisible(false)
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>): void {
    dragStart.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className="crystallizer">
      <header className="crystallizer-header">
        <div className="brand-cluster" aria-label="ICE Knowledge Crystallizer">
          <span className="crystallizer-mark">
            <Snowflake size={25} className="brand-crystal animate-spin-slow" />
          </span>
          <h1>ICE</h1>
          <div className="brand-divider" />
          <div className="brand-copy">
            <div className="crystallizer-brand">
              <h1 style={{ fontSize: '23px', fontStyle: 'normal' }}>
                Information Complexity Explorer
              </h1>
              <span className="crystallizer-brand-subtitle">Topics Crystallizer</span>
            </div>
          </div>
        </div>

        <form className="crystallizer-search" onSubmit={generate}>
          <div className="crystallizer-search-shell">
            <Search size={15} aria-hidden />
            <input
              aria-label="Crystallizer topic"
              disabled={loading || Boolean(busy)}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="Delve into a topic"
              value={keyword}
            />
          </div>
          <button disabled={loading || Boolean(busy) || !keyword.trim()} type="submit">
            {loading ? <Quantum size={18} speed={1.35} color="currentColor" /> : <Snowflake />}
            <span>{loading ? 'Crystallizing' : 'Crystallize'}</span>
          </button>
          {hasUnsavedResult && (
            <button
              className="crystallizer-save-button"
              disabled={saving || Boolean(busy)}
              onClick={() => {
                void saveResult()
              }}
              type="button"
            >
              <Save size={16} aria-hidden />
              <span>{saving ? 'Saving' : 'Save'}</span>
            </button>
          )}
        </form>
      </header>

      <section className={`crystallizer-body ${hasResults ? 'results-ready' : ''}`}>
        <div className="crystallizer-canvas-shell" ref={shellRef}>
          <div className="crystallizer-tools" aria-label="Crystallizer canvas controls">
            <button
              className="button"
              onClick={() => animateView(clamp(zoom - 0.12, MIN_ZOOM, MAX_ZOOM))}
              type="button"
            >
              -
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              className="button"
              onClick={() => animateView(clamp(zoom + 0.12, MIN_ZOOM, MAX_ZOOM))}
              type="button"
            >
              +
            </button>
            <button onClick={resetView} type="button" className="responsive-button">
              Reset
            </button>
          </div>

          <div className="layer-strip compact canvas-layer-hud" aria-label="Layer filters">
            <button
              style={{ display: 'grid', gridTemplateColumns: '24px 1fr 40px' }}
              className={activeLayer === 'all' ? 'active' : undefined}
              disabled={!hasResults}
              onClick={() => setActiveLayer('all')}
              type="button"
            >
              <Layers size={16} aria-hidden />
              <strong>All</strong>
              <span className="filter-count">{result?.items.length ?? 0}</span>
            </button>
            {LAYERS.map((layer) => (
              <button
                className={activeLayer === layer.level ? 'active' : undefined}
                disabled={!hasResults}
                key={layer.level}
                onClick={() => setActiveLayer(layer.level)}
                style={
                  {
                    '--layer-accent': layer.accent,
                    display: 'grid',
                    gridTemplateColumns: '24px 1fr 40px'
                  } as CSSProperties
                }
                type="button"
              >
                <span className="layer-number">{layer.level}</span>
                <strong>{layer.shortName}</strong>
                <span className="filter-count">{layerCounts.get(layer.level) ?? 0}</span>
              </button>
            ))}
          </div>

          <svg
            className={`crystallizer-canvas ${dragging ? 'dragging' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onWheel={handleWheel}
            role="img"
            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
          >
            <defs>
              <linearGradient id="iceberg-body" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="28%" stopColor="#e5f8ff" />
                <stop offset="62%" stopColor="#b8ddf2" />
                <stop offset="100%" stopColor="#5d6a7e" />
              </linearGradient>
              <linearGradient id="iceberg-shadow" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
                <stop offset="55%" stopColor="#8ecae6" stopOpacity="0.16" />
                <stop offset="100%" stopColor="#0f172a" stopOpacity="0.5" />
              </linearGradient>
              <clipPath id="iceberg-clip">
                <path d="M516 372 776 216 1010 292 1154 120 1372 326 1560 288 1818 458 2028 710 1732 1498 1392 1668 1100 1790 792 1668 468 1498 172 710Z" />
              </clipPath>
            </defs>
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              <path
                className="iceberg-shape"
                d="M516 372 776 216 1010 292 1154 120 1372 326 1560 288 1818 458 2028 710 1732 1498 1392 1668 1100 1790 792 1668 468 1498 172 710Z"
              />
              <g clipPath="url(#iceberg-clip)">
                {LAYERS.map((layer) => (
                  <rect
                    className="iceberg-layer-zone"
                    fill={layer.accent}
                    height={CANVAS_HEIGHT / LAYERS.length}
                    key={layer.level}
                    opacity={0.1 + layer.level * 0.025}
                    width={CANVAS_WIDTH}
                    x="0"
                    y={(CANVAS_HEIGHT / LAYERS.length) * (layer.level - 1)}
                  />
                ))}
              </g>
              <path
                className="iceberg-shade"
                d="M1154 120 2028 710 1732 1498 1100 1790 1230 804Z"
              />
              <path
                className="iceberg-facet"
                d="M516 372 776 216 1010 292 1230 804 792 1668 468 1498 172 710Z"
              />
              <path
                className="iceberg-facet soft"
                d="M776 216 1010 292 1154 120 1372 326 1560 288 1230 804Z"
              />
              <path
                className="iceberg-facet low"
                d="M172 710 1230 804 2028 710 1732 1498 1100 1790 468 1498Z"
              />
              <path className="iceberg-ridge" d="M1154 120 1230 804 1100 1790" />
              <path className="iceberg-ridge" d="M516 372 1230 804 2028 710" />
              <path className="iceberg-ridge faint" d="M468 1498 1230 804 1732 1498" />
              <path className="iceberg-ridge faint" d="M776 216 1010 292 1230 804" />
              <line className="waterline" x1="0" x2={CANVAS_WIDTH} y1="360" y2="360" />
              <text className="waterline-label" x={CANVAS_WIDTH / 2} y="354">
                Waterline
              </text>

              {LAYERS.map((layer) => (
                <g
                  className="crystallizer-layer"
                  key={layer.level}
                  style={{ '--layer-accent': layer.accent } as CSSProperties}
                >
                  <line
                    x1="74"
                    x2={CANVAS_WIDTH - 74}
                    y1={(CANVAS_HEIGHT / LAYERS.length) * layer.level}
                    y2={(CANVAS_HEIGHT / LAYERS.length) * layer.level}
                  />
                  <g
                    className="crystallizer-layer-label"
                    transform={`translate(94 ${(CANVAS_HEIGHT / LAYERS.length) * (layer.level - 1) + 24})`}
                  >
                    <rect height="58" rx="18" width="324" />
                    <circle className="layer-label-number-mark" cx="31" cy="29" r="18" />
                    <text className="layer-label-number" x="31" y="36">
                      {layer.level}
                    </text>
                    <text className="layer-label-name" x="64" y="25">
                      {layer.name}
                    </text>
                    <text className="layer-label-caption" x="64" y="45">
                      {layer.caption}
                    </text>
                  </g>
                  <text
                    className="layer-depth-label"
                    x={CANVAS_WIDTH - 122}
                    y={(CANVAS_HEIGHT / LAYERS.length) * (layer.level - 0.5)}
                  >
                    {layer.depth}
                  </text>
                </g>
              ))}

              {depthPaths.map((thread, index) => (
                <path
                  className={`depth-thread ${
                    focusedItemId &&
                    (thread.from.item.id === focusedItemId || thread.to.item.id === focusedItemId)
                      ? 'is-highlighted'
                      : ''
                  }`}
                  d={`M${thread.from.displayX} ${thread.from.displayY} C ${thread.from.displayX} ${
                    thread.from.displayY + 128
                  }, ${thread.to.displayX} ${thread.to.displayY - 128}, ${thread.to.displayX} ${
                    thread.to.displayY
                  }`}
                  key={`${thread.from.item.id}-${thread.to.item.id}`}
                  style={{ '--reveal-index': index } as CSSProperties}
                >
                  <title>
                    {`Nearest next-layer path: ${thread.from.item.name} to ${thread.to.item.name}`}
                  </title>
                </path>
              ))}

              {visiblePositionedItems.map(({ item, displayX, displayY }, index) => {
                const layer = getLayer(item.level)
                const selected = activeSelectedItem?.id === item.id
                const hovered = hoveredItemId === item.id
                return (
                  <g
                    aria-label={`${item.name}, layer ${item.level}`}
                    aria-pressed={selected}
                    className={`ice-node-hit ${selected ? 'selected' : ''} ${
                      hovered ? 'hovered' : ''
                    }`}
                    key={item.id}
                    onClick={() => {
                      selectItem(item)
                    }}
                    onFocus={(event) => {
                      setHoveredItemId(item.id)
                      raiseCard(event.currentTarget, item, layer.accent)
                    }}
                    onBlur={() => {
                      setHoveredItemId(null)
                      setRaisedVisible(false)
                    }}
                    onKeyDown={(event) => handleNodeKeyDown(event, item)}
                    onMouseEnter={(event) => {
                      setHoveredItemId(item.id)
                      raiseCard(event.currentTarget, item, layer.accent)
                    }}
                    onMouseLeave={() => {
                      // Keep the raised card during node→node sweeps (the next node's
                      // mouseEnter repositions it); it's cleared when the pointer
                      // actually leaves the canvas via handlePointerLeave.
                      setHoveredItemId(null)
                    }}
                    role="button"
                    style={
                      {
                        '--layer-accent': layer.accent,
                        '--reveal-index': index
                      } as CSSProperties
                    }
                    tabIndex={0}
                    transform={`translate(${displayX} ${displayY})`}
                  >
                    <g className="ice-node-scale">
                      <foreignObject
                        height={NODE_HEIGHT}
                        width={NODE_WIDTH}
                        x={-NODE_WIDTH / 2}
                        y={-NODE_HEIGHT / 2}
                      >
                        <button className="ice-node" type="button">
                          <span>{item.level}</span>
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                        </button>
                      </foreignObject>
                    </g>
                  </g>
                )
              })}
            </g>
          </svg>

          {!result && !loading && !error && (
            <div className="crystallizer-empty">
              <div className="crystallizer-state-card">
                <Snowflake />
                <h2>Enter a topic to begin.</h2>
              </div>
            </div>
          )}

          {loading && (
            <div className="crystallizer-empty crystallizing">
              <div className="crystallizer-state-card crystallizing-card">
                <CrystallizingOrb title="Crystallizing" />
              </div>
            </div>
          )}

          {error && (
            <div className="crystallizer-empty error">
              <h2>{error}</h2>
            </div>
          )}

          {/* Raised card: an HTML layer floating over the SVG (never inside it), shown
              over the hovered/focused node with its full, untruncated description.
              Always mounted and faded via the is-visible class so it animates both in
              and out; pointer-events:none keeps the node beneath interactive. */}
          <div
            aria-hidden="true"
            className={`ice-raised-card ${raisedVisible && raisedCard ? 'is-visible' : ''}`}
            style={
              raisedCard
                ? ({
                    '--layer-accent': raisedCard.accent,
                    left: `${raisedCard.left}px`,
                    top: `${raisedCard.top}px`,
                    width: `${raisedCard.width}px`
                  } as CSSProperties)
                : undefined
            }
          >
            <span className="ice-raised-badge">{raisedCard?.item.level ?? ''}</span>
            <strong>{raisedCard?.item.name ?? ''}</strong>
            <small>{raisedCard?.item.description ?? ''}</small>
          </div>
        </div>

        <aside
          className={`crystallizer-dock ${
            hasSavedAtlases && !hasResults && !loading ? 'saved-atlas-priority' : ''
          } ${savedAtlasExpanded ? 'saved-atlas-open' : ''}`}
          aria-label="Crystallizer details"
        >
          <div className="dock-head">
            <div>
              <span>
                <BookOpen size={15} />
                Ordered Topics
              </span>
              <h2>{result ? `${visibleItems.length} fragments` : 'Awaiting query'}</h2>
            </div>
          </div>

          {activeSelectedItem ? (
            <article
              className="crystallizer-detail"
              style={
                { '--layer-accent': getLayer(activeSelectedItem.level).accent } as CSSProperties
              }
            >
              <p>
                Layer {activeSelectedItem.level} • {getLayer(activeSelectedItem.level).name}
              </p>
              <h2>{activeSelectedItem.name}</h2>
              <span>{getLayer(activeSelectedItem.level).caption}</span>
              {(formatDepthScore(activeSelectedItem) || formatConfidence(activeSelectedItem)) && (
                <div className="crystallizer-depth-meta">
                  {formatDepthScore(activeSelectedItem) && (
                    <strong>{formatDepthScore(activeSelectedItem)}</strong>
                  )}
                  {formatConfidence(activeSelectedItem) && (
                    <span>{formatConfidence(activeSelectedItem)}</span>
                  )}
                </div>
              )}
              <small style={{ fontSize: '10px' }}>{activeSelectedItem.description}</small>
              {activeSelectedItem.reason && (
                <em className="crystallizer-depth-reason">{activeSelectedItem.reason}</em>
              )}
              <button
                className="explore-web-button"
                onClick={() => {
                  if (result) void onOpenTopic(result.keyword, activeSelectedItem)
                }}
                type="button"
              >
                Explore in Web
                <ChevronRightIcon />
              </button>
            </article>
          ) : (
            <div className="crystallizer-placeholder">
              <span>
                {loading ? (
                  <div style={{ width: '30px' }}>
                    <Snowflake className="animate-spin-fast" />
                  </div>
                ) : (
                  <Snowflake size={30} />
                )}
                {loading ? 'Crystallizing' : 'SELECT A TOPIC'}
              </span>
            </div>
          )}

          <div className="crystallizer-list">
            {visibleItems.map((item, index) => (
              <button
                className={`button ${activeSelectedItem?.id === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => {
                  selectItem(item)
                }}
                onMouseEnter={() => setHoveredItemId(item.id)}
                onMouseLeave={() => setHoveredItemId(null)}
                style={
                  {
                    '--layer-accent': getLayer(item.level).accent,
                    '--reveal-index': index
                  } as CSSProperties
                }
                type="button"
              >
                <span>{item.level}</span>
                <strong>{item.name}</strong>
              </button>
            ))}
          </div>

          <div className={`saved-atlas-drawer ${savedAtlasExpanded ? 'open' : ''}`}>
            <button
              className="saved-atlas-head"
              aria-expanded={savedAtlasExpanded}
              onClick={() => setSavedDrawerOpen((current) => !current)}
              type="button"
            >
              <span className="saved-atlas-title">
                <Archive size={14} />
                <span>Saved Icebergs</span>
                <strong>{savedIcebergs.length}</strong>
              </span>
              <ChevronDown size={14} aria-hidden />
            </button>
            {savedIcebergs.length === 0 ? (
              <p>No icebergs crystallized yet.</p>
            ) : (
              <div className="saved-atlas-list">
                {savedIcebergs.map((iceberg) => (
                  <article
                    className={savedId === iceberg.id ? 'active' : undefined}
                    key={iceberg.id}
                  >
                    <button
                      className="responsive-button"
                      disabled={loading || Boolean(busy)}
                      onClick={() => {
                        void openSaved(iceberg.id)
                      }}
                      type="button"
                    >
                      <strong>{iceberg.title}</strong>
                      <small>
                        {iceberg.itemCount} fragments •{' '}
                        {formatVisibleModelName(iceberg.model) ?? iceberg.model}
                      </small>
                    </button>
                    <button
                      className="danger-button"
                      aria-label={`Delete ${iceberg.title}`}
                      disabled={loading || Boolean(busy)}
                      onClick={() => {
                        void deleteSaved(iceberg.id)
                      }}
                      title="Delete saved iceberg"
                      type="button"
                    >
                      <Trash2 size={13} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </aside>
      </section>

      <div style={{ position: 'absolute', bottom: '10px', left: '12px' }}>
        <span className="atlas-heading">
          <Compass size={15} />
          Semantic Cartography
        </span>
      </div>

      <div style={{ position: 'absolute', bottom: '10px', right: '330px' }}>
        <span className="atlas-heading">
          <Move size={15} />
          Pan
        </span>
      </div>
    </div>
  )
}
