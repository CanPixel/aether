import {
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useMemo,
  useRef
} from 'react'
import {
  CollectionSummary,
  FlowGraphEdge,
  FlowGraphNode,
  FlowGraphResult,
  SystemStatus
} from '../../../shared/aether'
import { formatDate, formatVisibleModelName, getCaptureHost } from '../utils/aether-ui'
import { ExternalLink, LocateFixed, Network, Search, Waves } from 'lucide-react'

const CANVAS_WIDTH = 1320
const CANVAS_HEIGHT = 760
const CENTER_X = CANVAS_WIDTH / 2
const CENTER_Y = CANVAS_HEIGHT / 2
const MATCH_LIST_LIMIT = 8

// Force-simulation tuning. The graph now settles instead of animating forever, which keeps
// Flow responsive once the initial layout has relaxed.
const REPULSION = 5200
const REPULSION_CAP = 8
const DAMPING = 0.82
const MAX_VELOCITY = 7
const ALPHA_DECAY = 0.965
const ALPHA_STOP = 0.018
const AMBIENT = 0.006

type SimNode = {
  id: string
  radius: number
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
  phase: number
  isQuery: boolean
}

type SimEdge = {
  id: string
  from: string
  to: string
  rest: number
  strength: number
  bend: number
}

type FlowViewProps = {
  busy: string | null
  collections: CollectionSummary[]
  query: string
  result: FlowGraphResult | null
  status: SystemStatus | null
  selectedNodeId: string | null
  onBuildGraph: (query?: string) => Promise<void>
  onOpenHub: (collectionId: string) => Promise<void>
  onOpenSource: (node: FlowGraphNode) => Promise<void>
  onQueryChange: (value: string) => void
  onSelectedNodeChange: (nodeId: string | null) => void
}

export function FlowView({
  busy,
  collections,
  query,
  result,
  status,
  selectedNodeId,
  onBuildGraph,
  onOpenHub,
  onOpenSource,
  onQueryChange,
  onSelectedNodeChange
}: FlowViewProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const simNodesRef = useRef<SimNode[]>([])
  const simIndexRef = useRef<Map<string, SimNode>>(new Map())
  const simEdgesRef = useRef<SimEdge[]>([])
  const nodeElsRef = useRef<Map<string, SVGGElement>>(new Map())
  const edgeElsRef = useRef<Map<string, SVGPathElement>>(new Map())
  const alphaRef = useRef(1)
  const rafRef = useRef<number | null>(null)
  const animationTickRef = useRef<((now: number) => void) | null>(null)
  const draggingRef = useRef<string | null>(null)

  const selectedNode =
    result?.nodes.find((node) => node.id === selectedNodeId) ??
    result?.nodes.find((node) => node.kind === 'query') ??
    result?.nodes.find((node) => node.kind === 'hub') ??
    result?.nodes[0]

  const connectedNodeIds = useMemo(() => {
    if (!selectedNode || !result) return new Set<string>()
    const ids = new Set<string>([selectedNode.id])
    for (const edge of result.edges) {
      if (edge.from === selectedNode.id) ids.add(edge.to)
      if (edge.to === selectedNode.id) ids.add(edge.from)
    }
    return ids
  }, [result, selectedNode])

  // Sources ranked by how closely they match the typed query — the sidebar Flow's "matched
  // results", surfaced here as a readable, comprehensive list rather than just nudged dots.
  const matchedSources = useMemo(() => {
    if (!result || result.query.trim().length === 0) return []
    return result.nodes
      .filter((node) => node.kind === 'source' && typeof node.score === 'number')
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, MATCH_LIST_LIMIT)
  }, [result])
  const matchedIds = useMemo(() => new Set(matchedSources.map((node) => node.id)), [matchedSources])

  const indexedSources =
    result?.sourceCount ?? collections.reduce((sum, item) => sum + item.captureCount, 0)
  const graphBlocked = Boolean(busy) || (!status?.embeddingModel && query.trim().length > 0)

  function selectNode(nodeId: string | null): void {
    onSelectedNodeChange(nodeId)
  }

  // Build (or rebuild) the physics model whenever the graph data changes, carrying over the
  // positions of nodes that persist so re-querying glides instead of snapping, then run the
  // animation loop for as long as this view is mounted.
  useLayoutEffect(() => {
    if (!result) {
      simNodesRef.current = []
      simIndexRef.current = new Map()
      simEdgesRef.current = []
      return
    }

    const previous = new Map(simNodesRef.current.map((node) => [node.id, node]))
    const { nodes, edges } = buildSimulation(result, previous)
    simNodesRef.current = nodes
    simIndexRef.current = new Map(nodes.map((node) => [node.id, node]))
    simEdgesRef.current = edges
    alphaRef.current = 1
    writeNodePositions(nodes, nodeElsRef.current)
    writeEdgePaths(edges, simIndexRef.current, edgeElsRef.current)

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    function tick(now: number): void {
      stepSimulation(simNodesRef.current, simEdgesRef.current, simIndexRef.current, alphaRef, now, Boolean(reduceMotion))
      writeNodePositions(simNodesRef.current, nodeElsRef.current)
      writeEdgePaths(simEdgesRef.current, simIndexRef.current, edgeElsRef.current)
      if (alphaRef.current <= ALPHA_STOP && draggingRef.current === null) {
        rafRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    animationTickRef.current = tick
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      animationTickRef.current = null
    }
  }, [result])

  function toSvgPoint(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: CENTER_X, y: CENTER_Y }
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: CENTER_X, y: CENTER_Y }
    const mapped = point.matrixTransform(ctm.inverse())
    return { x: mapped.x, y: mapped.y }
  }

  function reheat(value: number): void {
    alphaRef.current = Math.max(alphaRef.current, value)
    if (rafRef.current === null && animationTickRef.current) {
      rafRef.current = requestAnimationFrame(animationTickRef.current)
    }
  }

  function handleNodePointerDown(event: ReactPointerEvent<SVGGElement>, id: string): void {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = id
    selectNode(id)
    const node = simIndexRef.current.get(id)
    if (node) {
      node.fx = node.x
      node.fy = node.y
    }
    reheat(0.7)
  }

  function handleNodePointerMove(event: ReactPointerEvent<SVGGElement>, id: string): void {
    if (draggingRef.current !== id) return
    const node = simIndexRef.current.get(id)
    if (!node) return
    const point = toSvgPoint(event.clientX, event.clientY)
    node.fx = point.x
    node.fy = point.y
    reheat(0.6)
  }

  function handleNodePointerUp(event: ReactPointerEvent<SVGGElement>, id: string): void {
    if (draggingRef.current !== id) return
    const node = simIndexRef.current.get(id)
    if (node) {
      node.fx = null
      node.fy = null
    }
    draggingRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    reheat(0.5)
  }

  async function submitSearch(event: FormEvent): Promise<void> {
    event.preventDefault()
    await onBuildGraph(query)
  }

  async function useNodeAsLens(node: FlowGraphNode): Promise<void> {
    const nextQuery = node.kind === 'hub' ? node.title : node.title || node.subtitle
    onQueryChange(nextQuery)
    await onBuildGraph(nextQuery)
  }

  const registerNode = (id: string) => (element: SVGGElement | null): void => {
    if (element) {
      nodeElsRef.current.set(id, element)
      const node = simIndexRef.current.get(id)
      if (node) element.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
    } else {
      nodeElsRef.current.delete(id)
    }
  }

  const registerEdge = (id: string) => (element: SVGPathElement | null): void => {
    if (element) edgeElsRef.current.set(id, element)
    else edgeElsRef.current.delete(id)
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
          {result && result.nodes.length > 0 ? (
            <svg
              className="flow-graph"
              ref={svgRef}
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
              </defs>
              <g className="flow-current-field" aria-hidden="true">
                {Array.from({ length: 5 }).map((_, index) => (
                  <path key={index} d={currentPath(index)} />
                ))}
              </g>
              <g className="flow-edges flow-edge-currents">
                {result.edges.map((edge) => {
                  const selected = selectedNode
                    ? edge.from === selectedNode.id || edge.to === selectedNode.id
                    : false
                  return (
                    <path
                      className={`flow-edge ${edge.kind} ${selected ? 'selected' : ''}`}
                      key={edge.id}
                      ref={registerEdge(edge.id)}
                      style={{ '--edge-strength': edge.weight / 100 } as CSSProperties}
                    />
                  )
                })}
              </g>
              <g className="flow-nodes">
                {result.nodes.map((node) => {
                  const selected = selectedNode?.id === node.id
                  const muted = selectedNode ? !connectedNodeIds.has(node.id) : false
                  const matched = node.kind === 'source' && matchedIds.has(node.id)
                  const radius = nodeRadius(node)
                  return (
                    <g
                      className={`flow-node ${node.kind} ${selected ? 'selected' : ''} ${muted ? 'muted' : ''} ${matched ? 'matched' : ''}`}
                      key={node.id}
                      ref={registerNode(node.id)}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                      onPointerMove={(event) => handleNodePointerMove(event, node.id)}
                      onPointerUp={(event) => handleNodePointerUp(event, node.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          selectNode(node.id)
                        }
                      }}
                    >
                      <circle className="flow-node-aura" r={radius + 10} />
                      <circle className="flow-node-core" r={radius} />
                      {(node.kind !== 'source' || matched) && (
                        <text className="flow-node-label" y={radius + 18}>
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

          {matchedSources.length > 0 ? (
            <div className="flow-matches">
              <strong>
                {matchedSources.length} {matchedSources.length === 1 ? 'match' : 'matches'} for “
                {result?.query}”
              </strong>
              <div className="flow-match-list">
                {matchedSources.map((node) => (
                  <FlowMatchCard
                    active={selectedNode?.id === node.id}
                    key={node.id}
                    node={node}
                    onOpen={() => onOpenSource(node)}
                    onSelect={() => selectNode(node.id)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flow-recommendations">
              <strong>Connect concepts</strong>
              <span className="flow-hint">
                {result?.query
                  ? 'No strong matches yet — try a broader topic, or capture more sources.'
                  : 'Type a topic and Map to rank every source by how closely it matches.'}
              </span>
            </div>
          )}

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

function FlowMatchCard({
  active,
  node,
  onOpen,
  onSelect
}: {
  active: boolean
  node: FlowGraphNode
  onOpen: () => Promise<void>
  onSelect: () => void
}): React.JSX.Element {
  const score = node.score ?? 0
  const host = node.host || (node.url ? getCaptureHost(node.url) : '')

  return (
    <button
      className={`flow-match ${active ? 'active' : ''}`}
      onClick={onSelect}
      onDoubleClick={() => {
        void onOpen()
      }}
      title={node.title}
      type="button"
    >
      <span className="flow-match-score" aria-hidden="true">
        {Math.round(score)}
      </span>
      <span className="flow-match-copy">
        <span className="flow-match-meta">
          {node.collectionName ?? node.subtitle}
          {node.capturedAt ? ` · ${formatDate(node.capturedAt)}` : ''}
          {host ? ` · ${host}` : ''}
        </span>
        <strong>{node.title}</strong>
        {node.excerpt && <span className="flow-match-excerpt">{node.excerpt}</span>}
        <span className="flow-match-tags">
          <span className="flow-match-strength">{flowMatchLabel(score)}</span>
          {node.url && (
            <span
              className="flow-match-open"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation()
                void onOpen()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  void onOpen()
                }
              }}
            >
              <ExternalLink size={12} />
              Open
            </span>
          )}
        </span>
      </span>
    </button>
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

function nodeRadius(node: FlowGraphNode): number {
  if (node.kind === 'query') return 28
  if (node.kind === 'hub') return clamp(node.weight / 2.8, 21, 34)
  return clamp(8 + node.weight / 8 + (node.score ?? 0) / 70, 9, 16)
}

// Seed each node from a tidy radial layout (so the first frame is legible), then let the
// force loop relax it. Positions of nodes that survived a previous build are carried over.
function buildSimulation(
  result: FlowGraphResult,
  previous: Map<string, SimNode>
): { nodes: SimNode[]; edges: SimEdge[] } {
  const hubNodes = result.nodes.filter((node) => node.kind === 'hub')
  const sourceNodes = result.nodes.filter((node) => node.kind === 'source')
  const queryNode = result.nodes.find((node) => node.kind === 'query')
  const hubRadius = queryNode ? 286 : 238
  const hubPositions = new Map<string, { x: number; y: number }>()
  const hubAngles = new Map<string, number>()
  const nodes: SimNode[] = []

  const make = (node: FlowGraphNode, x: number, y: number): void => {
    const carried = previous.get(node.id)
    nodes.push({
      id: node.id,
      radius: nodeRadius(node),
      x: carried?.x ?? x,
      y: carried?.y ?? y,
      vx: carried?.vx ?? 0,
      vy: carried?.vy ?? 0,
      fx: null,
      fy: null,
      phase: hashUnit(node.id) * Math.PI * 2,
      isQuery: node.kind === 'query'
    })
  }

  if (queryNode) make(queryNode, CENTER_X, CENTER_Y)

  hubNodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, hubNodes.length) - Math.PI / 2
    const x = CENTER_X + Math.cos(angle) * hubRadius
    const y = CENTER_Y + Math.sin(angle) * (hubRadius * 0.72)
    hubPositions.set(node.collectionId ?? node.id, { x, y })
    hubAngles.set(node.collectionId ?? node.id, angle)
    make(node, x, y)
  })

  const sourcesByHub = new Map<string, FlowGraphNode[]>()
  for (const node of sourceNodes) {
    const key = node.collectionId ?? 'unfiled'
    sourcesByHub.set(key, [...(sourcesByHub.get(key) ?? []), node])
  }
  for (const [collectionId, list] of sourcesByHub) {
    const hubPosition = hubPositions.get(collectionId) ?? { x: CENTER_X, y: CENTER_Y }
    const hubAngle = hubAngles.get(collectionId) ?? 0
    list.forEach((node, index) => {
      const localIndex = index - (list.length - 1) / 2
      const spread = Math.min(1.9, 0.42 + list.length * 0.06)
      const angle = hubAngle + localIndex * spread + hashUnit(node.id) * 0.34
      const radius = 116 + (index % 5) * 28 + hashUnit(`${node.id}-r`) * 30
      make(node, hubPosition.x + Math.cos(angle) * radius, hubPosition.y + Math.sin(angle) * radius * 0.82)
    })
  }

  const edges: SimEdge[] = result.edges.map((edge) => {
    const [rest, strength] = restAndStrength(edge)
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      rest,
      strength,
      bend: (hashUnit(edge.id) - 0.5) * 0.72
    }
  })

  return { nodes, edges }
}

function restAndStrength(edge: FlowGraphEdge): [number, number] {
  if (edge.kind === 'query-match') return [220, 0.018]
  if (edge.kind === 'semantic') return [148, 0.009]
  return [112, 0.016]
}

function stepSimulation(
  nodes: SimNode[],
  edges: SimEdge[],
  index: Map<string, SimNode>,
  alphaRef: { current: number },
  now: number,
  reduceMotion: boolean
): void {
  const alpha = alphaRef.current

  // Repulsion: every node pushes every other apart (n is small, so all-pairs is cheap).
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let distanceSq = dx * dx + dy * dy
      if (distanceSq < 1) {
        dx = (hashUnit(a.id + b.id) - 0.5) * 2
        dy = (hashUnit(b.id + a.id) - 0.5) * 2
        distanceSq = 1
      }
      const distance = Math.sqrt(distanceSq)
      const force = Math.min(REPULSION / distanceSq, REPULSION_CAP) * alpha
      const ux = dx / distance
      const uy = dy / distance
      a.vx -= ux * force
      a.vy -= uy * force
      b.vx += ux * force
      b.vy += uy * force
    }
  }

  // Springs: edges pull their endpoints toward a rest length.
  for (const edge of edges) {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const distance = Math.max(0.01, Math.hypot(dx, dy))
    const force = (distance - edge.rest) * edge.strength * alpha
    const ux = dx / distance
    const uy = dy / distance
    a.vx += ux * force
    a.vy += uy * force
    b.vx -= ux * force
    b.vy -= uy * force
  }

  for (const node of nodes) {
    if (node.fx !== null && node.fy !== null) {
      node.x = node.fx
      node.y = node.fy
      node.vx = 0
      node.vy = 0
      continue
    }
    // Gravity toward center keeps the graph from drifting away; the query lens is held tight.
    const gravity = (node.isQuery ? 0.02 : 0.0016) * alpha
    node.vx += (CENTER_X - node.x) * gravity
    node.vy += (CENTER_Y - node.y) * gravity
    // Small initial buoyancy prevents stacked nodes while the graph settles.
    if (!reduceMotion && alpha > 0.12) {
      node.vx += Math.cos(now * 0.0005 + node.phase) * AMBIENT
      node.vy += Math.sin(now * 0.0006 + node.phase) * AMBIENT
    }
    node.vx = clamp(node.vx * DAMPING, -MAX_VELOCITY, MAX_VELOCITY)
    node.vy = clamp(node.vy * DAMPING, -MAX_VELOCITY, MAX_VELOCITY)
    node.x = clamp(node.x + node.vx, node.radius + 8, CANVAS_WIDTH - node.radius - 8)
    node.y = clamp(node.y + node.vy, node.radius + 8, CANVAS_HEIGHT - node.radius - 8)
  }

  alphaRef.current = alpha * (reduceMotion ? 0.88 : ALPHA_DECAY)
}

function writeNodePositions(nodes: SimNode[], elements: Map<string, SVGGElement>): void {
  for (const node of nodes) {
    const element = elements.get(node.id)
    if (element) element.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
  }
}

function writeEdgePaths(
  edges: SimEdge[],
  index: Map<string, SimNode>,
  elements: Map<string, SVGPathElement>
): void {
  for (const edge of edges) {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    const element = elements.get(edge.id)
    if (a && b && element) element.setAttribute('d', curvePath(a.x, a.y, b.x, b.y, edge.bend))
  }
}

function curvePath(ax: number, ay: number, bx: number, by: number, bend: number): string {
  const midX = (ax + bx) / 2
  const midY = (ay + by) / 2
  const dx = bx - ax
  const dy = by - ay
  const length = Math.max(1, Math.hypot(dx, dy))
  const offset = bend * Math.min(34, length * 0.07)
  const controlX = midX - (dy / length) * offset
  const controlY = midY + (dx / length) * offset
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`
}

function currentPath(index: number): string {
  const y = 132 + index * 118
  const lift = index % 2 === 0 ? 34 : -28
  return `M 84 ${y} C 314 ${y - lift}, 424 ${y + lift * 0.55}, 642 ${y + lift * 0.18} S 998 ${y - lift * 0.62}, 1238 ${y + lift * 0.08}`
}

function flowMatchLabel(score: number): string {
  if (score >= 70) return 'Strong match'
  if (score >= 55) return 'Related'
  return 'Loose match'
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
