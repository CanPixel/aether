import { FormEvent } from 'react'
import {
  AirDossierInput,
  AirLensKind,
  AirPreparedDossier,
  AirRecentFile,
  AirRenderResult,
  ChatResult,
  CollectionSummary,
  FlowGraphResult,
  SavedIceberg,
  SystemStatus
} from '../../../shared/aether'
import {
  BookOpen,
  ExternalLink,
  FileText,
  FolderOpen,
  History,
  Layers3,
  Search,
  Sparkles,
  WandSparkles
} from 'lucide-react'
import { formatDate, formatVisibleModelName } from '../utils/aether-ui'

type AirViewProps = {
  busy: string | null
  lens: string
  lensKind: AirLensKind
  prepared: AirPreparedDossier | null
  recent: AirRecentFile[]
  result: AirRenderResult | null
  collections: CollectionSummary[]
  selectedCollection?: CollectionSummary
  selectedHub?: CollectionSummary
  selectedHubId: string
  flowGraphResult: FlowGraphResult | null
  selectedFlowNode?: FlowGraphResult['nodes'][number] | null
  selectedFlowNodeId: string | null
  chatResult: ChatResult | null
  activeSavedIceberg: SavedIceberg | null
  status: SystemStatus | null
  onLensChange: (value: string) => void
  onLensKindChange: (value: AirLensKind) => void
  onPrepare: () => Promise<void>
  onRender: () => Promise<void>
  onOpenFile: (path: string) => Promise<void>
  onRevealFile: (path: string) => Promise<void>
  onSelectFlowNode: (nodeId: string) => void
  onSelectHub: (collectionId: string) => void
  onUseLens: (kind: AirLensKind, lens: string) => void
}

const QUICK_LENSES: Array<{
  kind: AirLensKind
  label: string
  icon: typeof Search
}> = [
  { kind: 'topic', label: 'Topic', icon: Search },
  { kind: 'flow', label: 'Flow', icon: Sparkles },
  { kind: 'hub', label: 'Hub', icon: BookOpen },
  { kind: 'answer', label: 'AiON', icon: WandSparkles },
  { kind: 'iceberg', label: 'iCE', icon: Layers3 }
]

export function AirView({
  busy,
  lens,
  lensKind,
  prepared,
  recent,
  result,
  collections,
  selectedCollection,
  selectedHub,
  selectedHubId,
  flowGraphResult,
  selectedFlowNode,
  selectedFlowNodeId,
  chatResult,
  activeSavedIceberg,
  status,
  onLensChange,
  onLensKindChange,
  onPrepare,
  onRender,
  onOpenFile,
  onRevealFile,
  onSelectFlowNode,
  onSelectHub,
  onUseLens
}: AirViewProps): React.JSX.Element {
  const isBusy = Boolean(busy)
  const hasPrepared = Boolean(prepared)
  const canRender = hasPrepared
  const selectedQuickLens = quickLensLabel(lensKind, lens, {
    flowGraphResult,
    selectedFlowNode,
    selectedCollection,
    selectedHub,
    chatResult,
    activeSavedIceberg
  })

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await onPrepare()
  }

  return (
    <section className="air-view">
      <header className="air-hero">
        <div className="air-identity">
          <span className="air-mark" aria-hidden="true">
            <FileText />
          </span>
          <div>
            <h1>AiR</h1>
            <p>Automated Info Renderer</p>
          </div>
        </div>
        <div className="air-output-note">
          <span>{prepared?.outputDir ?? '~/Documents/Æther/AiR'}</span>
        </div>
      </header>

      <div className="air-grid">
        <section className="air-panel air-lens-panel" aria-label="AiR lens">
          <form className="air-lens-form" onSubmit={submit}>
            <label htmlFor={lensKind === 'hub' ? 'air-hub-select' : lensKind === 'flow' ? 'air-flow-select' : 'air-lens'}>
              Research lens
            </label>
            <div className="air-search-row">
              <Search aria-hidden="true" />
              {lensKind === 'hub' ? (
                <select
                  id="air-hub-select"
                  value={selectedHubId}
                  onChange={(event) => onSelectHub(event.target.value)}
                >
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              ) : lensKind === 'flow' ? (
                <select
                  id="air-flow-select"
                  value={selectedFlowNodeId ?? ''}
                  onChange={(event) => onSelectFlowNode(event.target.value)}
                >
                  {flowGraphResult?.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {flowNodeOptionLabel(node)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="air-lens"
                  value={lens}
                  onChange={(event) => {
                    onLensKindChange('topic')
                    onLensChange(event.target.value)
                  }}
                  placeholder="Topic, question, source, or hub"
                />
              )}
              <button disabled={isBusy} type="submit">
                Preview
              </button>
            </div>
          </form>

          <div className="air-lens-buttons" aria-label="Quick lens sources">
            {QUICK_LENSES.map((item) => {
              const Icon = item.icon
              const disabled = quickLensDisabled(item.kind, {
                flowGraphResult,
                selectedCollection,
                chatResult,
                activeSavedIceberg
              })
              return (
                <button
                  className={lensKind === item.kind ? 'active' : ''}
                  disabled={disabled}
                  key={item.kind}
                  onClick={() =>
                    onUseLens(
                      item.kind,
                      quickLensValue(item.kind, lens, {
                        flowGraphResult,
                        selectedFlowNode,
                        selectedCollection,
                        selectedHub,
                        chatResult,
                        activeSavedIceberg
                      })
                    )
                  }
                  type="button"
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>

          <div className="air-lens-meta">
            <span>{selectedQuickLens}</span>
            <span>{collections.length} hubs indexed</span>
            <span>{status?.chatModel ? formatVisibleModelName(status.chatModel) : 'Deterministic fallback ready'}</span>
          </div>
        </section>

        <section className="air-panel air-actions-panel" aria-label="Render controls">
          <div>
            <h2>Render</h2>
            <p>{prepared ? `${prepared.sources.length} sources prepared` : 'Preview context before writing a file.'}</p>
          </div>
          <div className="air-action-buttons">
            <button disabled={isBusy || !canRender} onClick={onRender} type="button">
              <FileText aria-hidden="true" />
              Render Markdown
            </button>
            <button disabled={!result || isBusy} onClick={() => result && onOpenFile(result.path)} type="button">
              <ExternalLink aria-hidden="true" />
              Open File
            </button>
            <button disabled={!result || isBusy} onClick={() => result && onRevealFile(result.path)} type="button">
              <FolderOpen aria-hidden="true" />
              Reveal Folder
            </button>
          </div>
        </section>

        <section className="air-panel air-preview-panel" aria-label="Context preview">
          <div className="air-section-heading">
            <div>
              <h2>Context Preview</h2>
              <p>
                {prepared
                  ? `${prepared.sources.length} citations · ${formatVisibleModelName(prepared.model ?? 'deterministic-scaffold')}`
                  : 'Sources, citations, coverage, and Markdown will appear here.'}
              </p>
            </div>
            {prepared && <span>{formatDate(prepared.generatedAt)}</span>}
          </div>

          {prepared ? (
            <div className="air-preview-layout">
              <div className="air-source-stack">
                {prepared.sources.length === 0 ? (
                  <div className="air-empty-state">No local sources matched this lens yet.</div>
                ) : (
                  prepared.sources.map((source, index) => (
                    <article className="air-source-row" key={`${source.id}-${index}`}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{source.title}</strong>
                        <p>{source.excerpt}</p>
                        <small>
                          {source.collectionName ?? 'Knowledge Hub'}
                          {source.score ? ` · ${source.score.toFixed(1)} match` : ''}
                        </small>
                      </div>
                    </article>
                  ))
                )}
              </div>
              <pre className="air-markdown-preview">{prepared.markdownPreview}</pre>
            </div>
          ) : (
            <div className="air-empty-state">
              Select a lens and preview it to inspect coverage before AiR writes a dossier.
            </div>
          )}
        </section>

        <section className="air-panel air-history-panel" aria-label="Recent AiR renders">
          <div className="air-section-heading">
            <div>
              <h2>Recent Renders</h2>
              <p>{recent.length} local dossiers</p>
            </div>
            <History aria-hidden="true" />
          </div>
          <div className="air-history-list">
            {recent.length === 0 ? (
              <div className="air-empty-state">Rendered dossiers will collect here.</div>
            ) : (
              recent.map((file) => (
                <article className="air-history-row" key={file.path}>
                  <div>
                    <strong>{file.title}</strong>
                    <span>{file.lens || 'AiR lens'}</span>
                    <small>
                      {formatDate(file.renderedAt)} · {file.sourceCount} sources
                    </small>
                  </div>
                  <div>
                    <button onClick={() => onOpenFile(file.path)} type="button" title="Open file">
                      <ExternalLink aria-hidden="true" />
                    </button>
                    <button onClick={() => onRevealFile(file.path)} type="button" title="Reveal folder">
                      <FolderOpen aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

function quickLensDisabled(
  kind: AirLensKind,
  context: {
    flowGraphResult: FlowGraphResult | null
    selectedFlowNode?: FlowGraphResult['nodes'][number] | null
    selectedCollection?: CollectionSummary
    selectedHub?: CollectionSummary
    chatResult: ChatResult | null
    activeSavedIceberg: SavedIceberg | null
  }
): boolean {
  if (kind === 'flow') return !context.flowGraphResult
  if (kind === 'hub') return !context.selectedHub && !context.selectedCollection
  if (kind === 'answer') return !context.chatResult
  if (kind === 'iceberg') return !context.activeSavedIceberg
  return false
}

function quickLensValue(
  kind: AirLensKind,
  currentLens: string,
  context: {
    flowGraphResult: FlowGraphResult | null
    selectedFlowNode?: FlowGraphResult['nodes'][number] | null
    selectedCollection?: CollectionSummary
    selectedHub?: CollectionSummary
    chatResult: ChatResult | null
    activeSavedIceberg: SavedIceberg | null
  }
): string {
  if (kind === 'flow') return context.selectedFlowNode?.title || context.flowGraphResult?.query || currentLens || 'Current Flow map'
  if (kind === 'hub') return context.selectedHub?.name ?? context.selectedCollection?.name ?? 'Selected knowledge hub'
  if (kind === 'answer') return 'Latest AiON answer'
  if (kind === 'iceberg') return context.activeSavedIceberg?.title ?? 'Saved iCE map'
  return currentLens
}

function quickLensLabel(
  kind: AirLensKind,
  currentLens: string,
  context: {
    flowGraphResult: FlowGraphResult | null
    selectedFlowNode?: FlowGraphResult['nodes'][number] | null
    selectedCollection?: CollectionSummary
    selectedHub?: CollectionSummary
    chatResult: ChatResult | null
    activeSavedIceberg: SavedIceberg | null
  }
): string {
  const value = quickLensValue(kind, currentLens, context).trim()
  return value ? `${kindLabel(kind)} · ${value}` : kindLabel(kind)
}

function kindLabel(kind: AirLensKind): string {
  if (kind === 'answer') return 'AiON'
  if (kind === 'iceberg') return 'iCE'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function flowNodeOptionLabel(node: FlowGraphResult['nodes'][number]): string {
  if (node.kind === 'query') return `Search lens · ${node.title}`
  if (node.kind === 'hub') return `Hub · ${node.title}`
  return `Source · ${node.title}`
}

export type { AirDossierInput }
