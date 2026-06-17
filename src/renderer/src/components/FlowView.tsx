import { CSSProperties, FormEvent, useMemo, useState } from 'react'
import {
  CollectionSummary,
  FlowGraphEdge,
  FlowGraphNode,
  FlowGraphResult,
  SystemStatus
} from '../../../shared/aether'
import { formatDate, formatVisibleModelName, getCaptureHost } from '../utils/aether-ui'
import { ExternalLink, LocateFixed, Network, Search, Waves } from 'lucide-react'

const CANVAS_WIDTH = 1120
const CANVAS_HEIGHT = 640
const CENTER_X = CANVAS_WIDTH / 2
const CENTER_Y = CANVAS_HEIGHT / 2

type PositionedFlowNode = FlowGraphNode & {
  x: number
  y: number
  radius: number
}

type PositionedFlowEdge = FlowGraphEdge & {
  fromNode?: PositionedFlowNode
  toNode?: PositionedFlowNode
}

type FlowLayout = {
  nodes: PositionedFlowNode[]
  edges: PositionedFlowEdge[]
}

type FlowViewProps = {
  busy: string | null
  collections: CollectionSummary[]
  query: string
  result: FlowGraphResult | null
  status: SystemStatus | null
  onBuildGraph: (query?: string) => Promise<void>
  onOpenHub: (collectionId: string) => Promise<void>
  onOpenSource: (node: FlowGraphNode) => Promise<void>
  onQueryChange: (value: string) => void
}

export function FlowView({
  busy,
  collections,
  query,
  result,
  status,
  onBuildGraph,
  onOpenHub,
  onOpenSource,
  onQueryChange
}: FlowViewProps): React.JSX.Element {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const layout = useMemo(() => buildFlowLayout(result), [result])
  const selectedNode =
    layout.nodes.find((node) => node.id === selectedNodeId) ??
    layout.nodes.find((node) => node.kind === 'query') ??
    layout.nodes.find((node) => node.kind === 'hub') ??
    layout.nodes[0]
  const connectedNodeIds = useMemo(() => {
    if (!selectedNode) return new Set<string>()
    const ids = new Set<string>([selectedNode.id])
    for (const edge of layout.edges) {
      if (edge.from === selectedNode.id) ids.add(edge.to)
      if (edge.to === selectedNode.id) ids.add(edge.from)
    }
    return ids
  }, [layout.edges, selectedNode])
  const indexedSources = result?.sourceCount ?? collections.reduce((sum, item) => sum + item.captureCount, 0)
  const graphBlocked = Boolean(busy) || (!status?.embeddingModel && query.trim().length > 0)

  async function submitSearch(event: FormEvent): Promise<void> {
    event.preventDefault()
    await onBuildGraph(query)
  }

  async function useNodeAsLens(node: FlowGraphNode): Promise<void> {
    const nextQuery = node.kind === 'hub' ? node.title : node.title || node.subtitle
    onQueryChange(nextQuery)
    await onBuildGraph(nextQuery)
  }

  return (
    <div className="flow-view">
      <header className="flow-header">
        <div className="flow-brand">
          <span className="flow-brand-mark" aria-hidden="true">
            <Waves size={26} />
          </span>
          <div>
            <h1>Flow</h1>
            <p>{formatVisibleModelName(status?.embeddingModel, { role: 'embedding' }) ?? 'Local graph'}</p>
          </div>
        </div>
        <form className="flow-search" onSubmit={submitSearch}>
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="Search knowledge hubs"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search all knowledge hubs"
          />
          <button disabled={graphBlocked} type="submit">
            <span>Map</span>
          </button>
        </form>
      </header>

      <section className="flow-stage" aria-label="Semantic Flow graph">
        <div className="flow-canvas">
          {result && layout.nodes.length > 0 ? (
            <svg
              className="flow-graph"
              role="img"
              viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
              aria-label={`${result.sourceCount} captured sources across ${result.hubCount} hubs`}
            >
              <defs>
                <radialGradient id="flow-node-hub" cx="35%" cy="25%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="45%" stopColor="#bdf7ff" />
                  <stop offset="100%" stopColor="#3a91c9" />
                </radialGradient>
                <radialGradient id="flow-node-source" cx="34%" cy="26%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="42%" stopColor="#d7fbff" />
                  <stop offset="100%" stopColor="#78bde7" />
                </radialGradient>
                <radialGradient id="flow-node-query" cx="36%" cy="24%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="48%" stopColor="#c7fff2" />
                  <stop offset="100%" stopColor="#41a99e" />
                </radialGradient>
                <filter id="flow-glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <g className="flow-current-field" aria-hidden="true">
                {Array.from({ length: 9 }).map((_, index) => (
                  <path key={index} d={currentPath(index)} />
                ))}
              </g>
              <g className="flow-edges">
                {layout.edges.map((edge, index) => {
                  if (!edge.fromNode || !edge.toNode) return null
                  const selected = selectedNode
                    ? edge.from === selectedNode.id || edge.to === selectedNode.id
                    : false
                  return (
                    <path
                      className={`flow-edge ${edge.kind} ${selected ? 'selected' : ''}`}
                      d={edgePath(edge.fromNode, edge.toNode, index)}
                      key={edge.id}
                      style={{ '--edge-strength': edge.weight / 100 } as CSSProperties}
                    />
                  )
                })}
              </g>
              <g className="flow-nodes">
                {layout.nodes.map((node) => {
                  const selected = selectedNode?.id === node.id
                  const muted = selectedNode ? !connectedNodeIds.has(node.id) : false
                  return (
                    <g
                      className={`flow-node ${node.kind} ${selected ? 'selected' : ''} ${muted ? 'muted' : ''}`}
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      transform={`translate(${node.x} ${node.y})`}
                      onClick={() => setSelectedNodeId(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedNodeId(node.id)
                        }
                      }}
                    >
                      <circle className="flow-node-aura" r={node.radius + 10} />
                      <circle className="flow-node-core" r={node.radius} />
                      {node.kind !== 'source' && (
                        <text className="flow-node-label" y={node.radius + 18}>
                          {shortenNodeTitle(node.title)}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            </svg>
          ) : (
            <div className="flow-empty-state">
              <Waves size={32} aria-hidden="true" />
              <strong>{busy === 'Mapping Flow' ? 'Mapping Flow' : 'No indexed sources yet'}</strong>
              <span>
                {busy === 'Mapping Flow'
                  ? 'Drawing semantic currents'
                  : 'Capture pages into knowledge hubs to populate Flow.'}
              </span>
              {collections.length > 0 && (
                <button disabled={Boolean(busy)} onClick={() => onBuildGraph()} type="button">
                  Build graph
                </button>
              )}
            </div>
          )}
        </div>

        <aside className="flow-inspector" aria-label="Flow details">
          <div className="flow-stats">
            <span>
              <strong>{result?.hubCount ?? collections.length}</strong>
              <small>Hubs</small>
            </span>
            <span>
              <strong>{indexedSources}</strong>
              <small>Sources</small>
            </span>
            <span>
              <strong>{result?.edges.filter((edge) => edge.kind === 'semantic').length ?? 0}</strong>
              <small>Currents</small>
            </span>
          </div>

          {selectedNode ? (
            <FlowNodeDetail
              busy={busy}
              node={selectedNode}
              onOpenHub={onOpenHub}
              onOpenSource={onOpenSource}
              onUseNodeAsLens={useNodeAsLens}
            />
          ) : (
            <div className="flow-node-detail empty">
              <Network size={21} aria-hidden="true" />
              <strong>Flow surface</strong>
              <span>Semantic relationships will appear as captured sources are indexed.</span>
            </div>
          )}

          <div className="flow-recommendations">
            <strong>Click options</strong>
            <button disabled type="button">
              Open a source
            </button>
            <button disabled type="button">
              Focus the graph from this node
            </button>
            <button disabled type="button">
              Ask AiON from this neighborhood
            </button>
          </div>

          {result?.omittedSourceCount ? (
            <div className="flow-omitted">
              {result.omittedSourceCount} older indexed sources are folded out for performance.
            </div>
          ) : null}
        </aside>
      </section>
    </div>
  )
}

function FlowNodeDetail({
  busy,
  node,
  onOpenHub,
  onOpenSource,
  onUseNodeAsLens
}: {
  busy: string | null
  node: FlowGraphNode
  onOpenHub: (collectionId: string) => Promise<void>
  onOpenSource: (node: FlowGraphNode) => Promise<void>
  onUseNodeAsLens: (node: FlowGraphNode) => Promise<void>
}): React.JSX.Element {
  const host = node.host || (node.url ? getCaptureHost(node.url) : '')

  return (
    <article className={`flow-node-detail ${node.kind}`}>
      <header>
        <span>
          {node.kind === 'hub' ? <Waves size={17} /> : node.kind === 'source' ? <ExternalLink size={17} /> : <LocateFixed size={17} />}
        </span>
        <div>
          <small>{node.kind === 'query' ? 'Search lens' : node.collectionName || node.subtitle}</small>
          <h2>{node.title}</h2>
        </div>
      </header>
      <div className="flow-node-meta">
        {node.score !== undefined && <span>{node.score.toFixed(0)} match</span>}
        {host && <span>{host}</span>}
        {node.capturedAt && <span>{formatDate(node.capturedAt)}</span>}
      </div>
      {node.excerpt && <p>{node.excerpt}</p>}
      <footer>
        {node.kind === 'source' && (
          <button disabled={Boolean(busy)} onClick={() => onOpenSource(node)} type="button">
            <ExternalLink size={15} />
            <span>Open source</span>
          </button>
        )}
        {node.kind === 'hub' && node.collectionId && (
          <button disabled={Boolean(busy)} onClick={() => onOpenHub(node.collectionId!)} type="button">
            <Network size={15} />
            <span>Open hub</span>
          </button>
        )}
        {node.kind !== 'query' && (
          <button disabled={Boolean(busy)} onClick={() => onUseNodeAsLens(node)} type="button">
            <LocateFixed size={15} />
            <span>Use as lens</span>
          </button>
        )}
      </footer>
    </article>
  )
}

function buildFlowLayout(result: FlowGraphResult | null): FlowLayout {
  if (!result) return { nodes: [], edges: [] }

  const hubNodes = result.nodes.filter((node) => node.kind === 'hub')
  const sourceNodes = result.nodes.filter((node) => node.kind === 'source')
  const queryNode = result.nodes.find((node) => node.kind === 'query')
  const hubAngles = new Map<string, number>()
  const hubPositions = new Map<string, { x: number; y: number }>()
  const positionedNodes = new Map<string, PositionedFlowNode>()
  const hubRadius = queryNode ? 218 : 174

  if (queryNode) {
    positionedNodes.set(queryNode.id, {
      ...queryNode,
      x: CENTER_X,
      y: CENTER_Y,
      radius: 32
    })
  }

  hubNodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, hubNodes.length) - Math.PI / 2
    const x = CENTER_X + Math.cos(angle) * hubRadius
    const y = CENTER_Y + Math.sin(angle) * (hubRadius * 0.72)
    hubAngles.set(node.collectionId ?? node.id, angle)
    hubPositions.set(node.collectionId ?? node.id, { x, y })
    positionedNodes.set(node.id, {
      ...node,
      x,
      y,
      radius: Math.max(24, Math.min(38, node.weight / 2.4))
    })
  })

  const sourcesByHub = new Map<string, FlowGraphNode[]>()
  for (const node of sourceNodes) {
    const key = node.collectionId ?? 'unfiled'
    sourcesByHub.set(key, [...(sourcesByHub.get(key) ?? []), node])
  }

  for (const [collectionId, nodes] of sourcesByHub) {
    const hubPosition = hubPositions.get(collectionId) ?? { x: CENTER_X, y: CENTER_Y }
    const hubAngle = hubAngles.get(collectionId) ?? 0
    nodes.forEach((node, index) => {
      const localIndex = index - (nodes.length - 1) / 2
      const spread = Math.min(1.35, 0.28 + nodes.length * 0.045)
      const angle = hubAngle + localIndex * spread + hashUnit(node.id) * 0.24
      const radius = 72 + (index % 4) * 19 + hashUnit(`${node.id}-r`) * 16
      let x = hubPosition.x + Math.cos(angle) * radius
      let y = hubPosition.y + Math.sin(angle) * radius * 0.78
      if (queryNode && node.score) {
        const pull = Math.min(0.34, Math.max(0, (node.score - 42) / 170))
        x = x * (1 - pull) + CENTER_X * pull
        y = y * (1 - pull) + CENTER_Y * pull
      }
      positionedNodes.set(node.id, {
        ...node,
        x: clamp(x, 46, CANVAS_WIDTH - 46),
        y: clamp(y, 46, CANVAS_HEIGHT - 46),
        radius: Math.max(10, Math.min(19, 9 + node.weight / 7 + (node.score ?? 0) / 55))
      })
    })
  }

  const nodes = Array.from(positionedNodes.values())
  const edges = result.edges.map((edge) => ({
    ...edge,
    fromNode: positionedNodes.get(edge.from),
    toNode: positionedNodes.get(edge.to)
  }))
  return { nodes, edges }
}

function edgePath(from: PositionedFlowNode, to: PositionedFlowNode, index: number): string {
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const bend = ((index % 2 === 0 ? 1 : -1) * Math.min(72, length * 0.18)) / length
  const controlX = midX - dy * bend
  const controlY = midY + dx * bend * 0.82
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`
}

function currentPath(index: number): string {
  const y = 92 + index * 58
  const lift = index % 2 === 0 ? 42 : -34
  return `M 42 ${y} C 252 ${y + lift}, 348 ${y - lift}, 548 ${y + lift * 0.4} S 874 ${y - lift * 0.8}, 1078 ${y + lift * 0.2}`
}

function hashUnit(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return (hash % 1000) / 1000
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function shortenNodeTitle(title: string): string {
  if (title.length <= 18) return title
  return `${title.slice(0, 17)}…`
}
