import {
  FormEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  type CSSProperties,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  BookOpen,
  Compass,
/*   ExternalLink,
  FolderOpen,
  Layers, */
  Move,
  Search,
  Snowflake
} from 'lucide-react'
import { IcebergItem, IcebergResult } from '../../../shared/aether'
import { ChevronRightIcon, SnowflakeIcon, SpinnerIcon } from './icons'

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

type CrystallizerProps = {
  busy: string | null
  onGenerate: (keyword: string) => Promise<IcebergResult>
  onOpenTopic: (keyword: string, item: IcebergItem) => Promise<void>
}

const CANVAS_WIDTH = 2200
const CANVAS_HEIGHT = 1800
const NODE_WIDTH = 306
const NODE_HEIGHT = 92
const MIN_ZOOM = 0.44
const MAX_ZOOM = 2.25

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getLayer(level: number): LayerDefinition {
  return LAYERS.find((layer) => layer.level === level) ?? LAYERS[LAYERS.length - 1]
}

function positionTopics(items: IcebergItem[]): PositionedTopic[] {
  const layerHeight = CANVAS_HEIGHT / LAYERS.length
  const lanes = [14, 86, 29, 71, 50]

  return LAYERS.flatMap((layer) => {
    const layerItems = items
      .filter((item) => item.level === layer.level)
      .sort((first, second) => first.y - second.y || first.name.localeCompare(second.name))
    const availableHeight = layerHeight - 120
    const yStep = layerItems.length > 1 ? availableHeight / (layerItems.length - 1) : 0

    return layerItems.map((item, index) => {
      const sourceRatio =
        typeof item.x === 'number' ? item.x / 100 : lanes[index % lanes.length] / 100
      const lane = lanes[(layer.level + index) % lanes.length] / 100
      const blendedX = sourceRatio * 0.35 + lane * 0.65

      return {
        item,
        displayX: clamp(blendedX * CANVAS_WIDTH, 210, CANVAS_WIDTH - 210),
        displayY: clamp(
          (layer.level - 1) * layerHeight +
            (layerItems.length > 1 ? 58 + index * yStep : layerHeight / 2),
          (layer.level - 1) * layerHeight + 46,
          layer.level * layerHeight - 46
        )
      }
    })
  })
}

export function Crystallizer({
  busy,
  onGenerate,
  onOpenTopic
}: CrystallizerProps): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IcebergResult | null>(null)
  const [selectedItem, setSelectedItem] = useState<IcebergItem | null>(null)
  const [activeLayer, setActiveLayer] = useState<number | 'all'>('all')
  const [zoom, setZoom] = useState(0.62)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

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
  const layerCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const layer of LAYERS) counts.set(layer.level, 0)
    for (const item of result?.items ?? []) {
      counts.set(item.level, (counts.get(item.level) ?? 0) + 1)
    }
    return counts
  }, [result])
  const semanticThreads = useMemo(() => {
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
      .filter((thread): thread is { from: PositionedTopic; to: PositionedTopic } => Boolean(thread))
  }, [activeLayer, positionedItems])

  async function generate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const topic = keyword.trim()
    if (!topic || loading) return

    setLoading(true)
    setError(null)
    setResult(null)
    setSelectedItem(null)
    setActiveLayer('all')
    setZoom(0.62)
    setPan({ x: 0, y: 0 })

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

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>): void {
    event.preventDefault()
    setZoom((currentZoom) => clamp(currentZoom - event.deltaY * 0.001, MIN_ZOOM, MAX_ZOOM))
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    if ((event.target as Element).closest('.ice-node-hit')) return

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
    setPan({
      x: dragStart.current.panX + event.clientX - dragStart.current.x,
      y: dragStart.current.panY + event.clientY - dragStart.current.y
    })
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
            {/* <SnowflakeIcon className="brand-crystal animate-spin-slow" /> */}
          </span>
          <h1>ICE</h1>
          <div className="brand-divider" />
          <div className="brand-copy">
            <div className="crystallizer-brand">
              <h1 style={{ fontSize: '23px', fontStyle: 'normal' }}>
                Information Complexity Explorer
              </h1>
              <span className="crystallizer-brand-subtitle">Knowledge Crystallizer</span>
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
              placeholder="Explore a topic"
              value={keyword}
            />
          </div>
          <button disabled={loading || Boolean(busy) || !keyword.trim()} type="submit">
            {loading ? <SpinnerIcon /> : <SnowflakeIcon />}
            <span>{loading ? 'Crystallizing' : 'Crystallize'}</span>
          </button>
        </form>
      </header>

      <section className="crystallizer-body">
        <div className="crystallizer-canvas-shell">
          <div className="crystallizer-tools" aria-label="Crystallizer canvas controls">
            <button
              onClick={() => setZoom((current) => clamp(current - 0.12, MIN_ZOOM, MAX_ZOOM))}
              type="button"
            >
              -
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((current) => clamp(current + 0.12, MIN_ZOOM, MAX_ZOOM))}
              type="button"
            >
              +
            </button>
            <button
              onClick={() => {
                setZoom(0.62)
                setPan({ x: 0, y: 0 })
              }}
              type="button"
            >
              Reset
            </button>
          </div>

          <svg
            className={`crystallizer-canvas ${dragging ? 'dragging' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onWheel={handleWheel}
            role="img"
            viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
          >
            <defs>
              <linearGradient id="iceberg-body" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="48%" stopColor="#dff5ff" />
                <stop offset="100%" stopColor="#bcd2ea" />
              </linearGradient>
            </defs>
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              <path
                className="iceberg-shape"
                d="M1100 88 1780 286 2070 822 1688 1538 1100 1742 514 1538 130 822 420 286Z"
              />
              <path className="iceberg-facet" d="M1100 88 1268 1742 514 1538 130 822 420 286Z" />
              <line className="waterline" x1="0" x2={CANVAS_WIDTH} y1="360" y2="360" />

              {LAYERS.map((layer) => (
                <g className="crystallizer-layer" key={layer.level}>
                  <line
                    x1="74"
                    x2={CANVAS_WIDTH - 74}
                    y1={(CANVAS_HEIGHT / LAYERS.length) * layer.level}
                    y2={(CANVAS_HEIGHT / LAYERS.length) * layer.level}
                  />
                  <text x="118" y={(CANVAS_HEIGHT / LAYERS.length) * (layer.level - 0.5)}>
                    {layer.level} / {layer.shortName}
                  </text>
                </g>
              ))}

              {semanticThreads.map((thread) => (
                <path
                  className="semantic-thread"
                  d={`M${thread.from.displayX} ${thread.from.displayY} C ${thread.from.displayX} ${
                    thread.from.displayY + 128
                  }, ${thread.to.displayX} ${thread.to.displayY - 128}, ${thread.to.displayX} ${
                    thread.to.displayY
                  }`}
                  key={`${thread.from.item.id}-${thread.to.item.id}`}
                />
              ))}

              {visiblePositionedItems.map(({ item, displayX, displayY }) => {
                const layer = getLayer(item.level)
                const selected = activeSelectedItem?.id === item.id
                return (
                  <g
                    className={`ice-node-hit ${selected ? 'selected' : ''}`}
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    style={{ '--layer-accent': layer.accent } as CSSProperties}
                    tabIndex={0}
                  >
                    <foreignObject
                      height={NODE_HEIGHT}
                      width={NODE_WIDTH}
                      x={displayX - NODE_WIDTH / 2}
                      y={displayY - NODE_HEIGHT / 2}
                    >
                      <button className="ice-node" type="button">
                        <span>{item.level}</span>
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </button>
                    </foreignObject>
                  </g>
                )
              })}
            </g>
          </svg>

          {!result && !loading && !error && (
            <div className="crystallizer-empty">
              <SnowflakeIcon />
              <h2>Enter a topic to begin.</h2>
            </div>
          )}

          {loading && (
            <div className="crystallizer-empty">
              <SpinnerIcon />
              <h2>Crystallizing</h2>
            </div>
          )}

          {error && (
            <div className="crystallizer-empty error">
              <h2>{error}</h2>
            </div>
          )}
        </div>

        <aside className="crystallizer-dock" aria-label="Crystallizer details">
          <div className="dock-head">
            <div>
              <span>
                <BookOpen size={15} />
                Ordered Topics
              </span>
              <h2>{result ? `${visibleItems.length} fragments` : 'Awaiting query'}</h2>
            </div>
          </div>
          <div className="layer-strip compact" aria-label="Layer filters">
            <button
              className={activeLayer === 'all' ? 'active' : undefined}
              onClick={() => setActiveLayer('all')}
              type="button"
            >
              All
              <span>{result?.items.length ?? 0}</span>
            </button>
            {LAYERS.map((layer) => (
              <button
                className={activeLayer === layer.level ? 'active' : undefined}
                key={layer.level}
                onClick={() => setActiveLayer(layer.level)}
                style={{ '--layer-accent': layer.accent } as CSSProperties}
                type="button"
              >
                {layer.level}
                <span>{layerCounts.get(layer.level) ?? 0}</span>
              </button>
            ))}
          </div>

          {activeSelectedItem ? (
            <article
              className="crystallizer-detail"
              style={
                { '--layer-accent': getLayer(activeSelectedItem.level).accent } as CSSProperties
              }
            >
              <p>
                Layer {activeSelectedItem.level} / {getLayer(activeSelectedItem.level).name}
              </p>
              <h2>{activeSelectedItem.name}</h2>
              <span>{getLayer(activeSelectedItem.level).caption}</span>
              <small>{activeSelectedItem.description}</small>
              <button
                onClick={() => {
                  if (result) void onOpenTopic(result.keyword, activeSelectedItem)
                }}
                type="button"
              >
                Explore in Browser
                <ChevronRightIcon />
              </button>
            </article>
          ) : (
            <div className="crystallizer-placeholder">
              <span>
                {loading ? (
                  <div style={{ width: '30px' }}>
                    <SnowflakeIcon className="animate-spin-fast" />
                  </div>
                ) : (
                  <Snowflake size={30} />
                )}
                {loading ? 'Crystallizing' : 'SELECT A TOPIC'}
              </span>
            </div>
          )}

          <div className="crystallizer-list">
            {visibleItems.map((item) => (
              <button
                className={activeSelectedItem?.id === item.id ? 'active' : undefined}
                key={item.id}
                onClick={() => setSelectedItem(item)}
                type="button"
              >
                <span>{item.level}</span>
                <strong>{item.name}</strong>
              </button>
            ))}
          </div>

          <span className="atlas-heading" style={{ margin: 'auto' }}>
            Local-first Semantic Cartography
          </span>
        </aside>
      </section>

      <div style={{ position: 'absolute', bottom: '10px', left: '12px' }}>
        <span className="atlas-heading">
          <Compass size={15} />
          Complexity Atlas
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
