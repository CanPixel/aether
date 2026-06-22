import {
  FormEvent,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type WheelEvent
} from 'react'
import {
  ChatResult,
  CollectionSummary,
  SearchResult,
  SemanticTrailItem,
  SemanticTrailResult,
  SystemStatus
} from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import { formatDate, formatVisibleModelName, getCaptureHost } from '../utils/aether-ui'
import { CrystallizingOrb } from './CrystallizingOrb'
import { AetherSigilIcon, ChevronRightIcon, GearIcon } from './icons'
import { Droplet, Waves, Newspaper } from 'lucide-react'

type IntelligencePanelProps = {
  busy: string | null
  chatBlocked: boolean
  chatPrompt: string
  askCollectionId: string
  askCurrentPageOnly: boolean
  askIncludeCurrentPage: boolean
  askPanelOpen: boolean
  askPhase: string | null
  canUseCurrentPage: boolean
  currentPageTitle: string
  currentPageTint: string
  collections: CollectionSummary[]
  dashboardOpen: boolean
  chatResult: ChatResult | null
  notice: string | null
  panelCollapsed: boolean
  status: SystemStatus | null
  streamingAnswer: string
  streamingCitations: SearchResult[]
  semanticTrailQuery: string
  semanticTrailResult: SemanticTrailResult | null
  activePageUrl: string
  developerMode: boolean
  onAsk: (event: FormEvent) => Promise<void>
  onAskPanelOpenChange: (value: boolean) => void
  onBuildSemanticTrail: (query?: string) => Promise<void>
  onCancelAsk: () => void
  onTogglePanel: () => Promise<void>
  onChatPromptChange: (value: string) => void
  onSemanticTrailQueryChange: (value: string) => void
  onAskCollectionChange: (collectionId: string) => void
  onAskCurrentPageOnlyChange: (value: boolean) => void
  onAskIncludeCurrentPageChange: (value: boolean) => void
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
  onOpenSemanticTrailItem: (item: SemanticTrailItem) => Promise<void>
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}

export function IntelligencePanel({
  busy,
  chatBlocked,
  chatPrompt,
  askCollectionId,
  askCurrentPageOnly,
  askIncludeCurrentPage,
  askPanelOpen,
  askPhase,
  canUseCurrentPage,
  currentPageTitle,
  currentPageTint,
  collections,
  dashboardOpen,
  chatResult,
  notice,
  panelCollapsed,
  status,
  streamingAnswer,
  streamingCitations,
  semanticTrailQuery,
  semanticTrailResult,
  activePageUrl,
  developerMode,
  onAsk,
  onAskPanelOpenChange,
  onBuildSemanticTrail,
  onCancelAsk,
  onTogglePanel,
  onChatPromptChange,
  onSemanticTrailQueryChange,
  onAskCollectionChange,
  onAskCurrentPageOnlyChange,
  onAskIncludeCurrentPageChange,
  onOpenCitation,
  onOpenSemanticTrailItem,
  onUpdateModels
}: IntelligencePanelProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [trailPanelOpen, setTrailPanelOpen] = useState(false)
  const showTooltips = dashboardOpen
  const panelRef = useRef<HTMLElement>(null)
  const modelSettingsButtonRef = useRef<HTMLButtonElement>(null)
  const modelSettingsRef = useRef<HTMLElement>(null)
  const askCollections = collections.filter((collection) => collection.captureCount > 0)
  const hasKnowledgeHubs = askCollections.length > 0
  const hasAskContext = !hasKnowledgeHubs
    ? canUseCurrentPage
    : askCurrentPageOnly
      ? canUseCurrentPage
      : Boolean(askCollectionId) || (askIncludeCurrentPage && canUseCurrentPage)
  const normalizedTrailQuery = semanticTrailQuery.trim()
  const hasFocusLens = normalizedTrailQuery.length > 0
  const trailBlocked =
    !status?.embeddingModel ||
    Boolean(busy) ||
    (!hasFocusLens && (dashboardOpen || !canUseCurrentPage))
  const hasCurrentTrail = Boolean(
    semanticTrailResult &&
      (hasFocusLens
        ? !semanticTrailResult.root.url && semanticTrailResult.query.trim() === normalizedTrailQuery
        : Boolean(semanticTrailResult.root.url))
  )
  const footerStatus = busy ?? notice
/*   const trailBlockReason = dashboardOpen || !canUseCurrentPage
    ? 'Open a web page first'
    : !status?.embeddingModel
      ? 'No embedding model'
      : 'Ready' */

  useEffect(() => {
    if (!settingsOpen) return undefined

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target instanceof Node ? event.target : null
      if (!target) return
      if (modelSettingsRef.current?.contains(target)) return
      if (modelSettingsButtonRef.current?.contains(target)) return

      setSettingsOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [settingsOpen])

  useEffect(() => {
    if (!trailPanelOpen || trailBlocked || hasCurrentTrail) return undefined

    const timer = window.setTimeout(() => {
      void onBuildSemanticTrail(normalizedTrailQuery)
    }, 400)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    activePageUrl,
    hasCurrentTrail,
    normalizedTrailQuery,
    onBuildSemanticTrail,
    trailBlocked,
    trailPanelOpen
  ])

  function handlePanelWheel(event: WheelEvent<HTMLElement>): void {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('textarea, select')) return

    const panel = panelRef.current
    if (!panel || panelCollapsed) return

    const maxScroll = panel.scrollHeight - panel.clientHeight
    if (maxScroll <= 0) return

    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * panel.clientHeight
          : event.deltaY
    const nextScroll = Math.min(maxScroll, Math.max(0, panel.scrollTop + delta))
    if (nextScroll === panel.scrollTop) return

    event.preventDefault()
    panel.scrollTop = nextScroll
  }

  function toggleAskPanel(): void {
    const nextOpen = !askPanelOpen
    onAskPanelOpenChange(nextOpen)
    if (nextOpen) setTrailPanelOpen(false)
  }

  function toggleTrailPanel(): void {
    const nextOpen = !trailPanelOpen
    if (nextOpen) onAskPanelOpenChange(false)
    setTrailPanelOpen(nextOpen)
  }

  return (
    <aside
      className={`intelligence-panel ${panelCollapsed ? 'collapsed' : ''}`}
      ref={panelRef}
      onWheelCapture={handlePanelWheel}
    >
      <div
        style={
          panelCollapsed
            ? {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '30px 0'
              }
            : {
                display: 'none'
              }
        }
      >
        <span
          style={{
            fontSize: '11px',
            fontWeight: '800',
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            marginTop: '-3px'
          }}
          className="custom-font"
        >
          AiON
        </span>
        <button
          className="panel-icon-toggle crystal-button"
          aria-hidden={!panelCollapsed}
          onClick={onTogglePanel}
          tabIndex={panelCollapsed ? 0 : -1}
          title="AiON"
          type="button"
        >
          <AetherSigilIcon />
        </button>
      </div>
      <div className="panel-content" aria-hidden={panelCollapsed} inert={panelCollapsed}>
        <header className="panel-header">
          <div>
            <p>AiON <span>• Grounded Local Knowledge</span></p>
            <h2>Ask the web you explore</h2>
          </div>
          <div className="panel-header-actions">
            <StatusPill status={status} />
            <button
              className="panel-close button"
              data-tooltip-side={showTooltips ? 'left' : undefined}
              onClick={onTogglePanel}
              title="Collapse"
              type="button"
            >
              <ChevronRightIcon />
            </button>
          </div>
        </header>

        <section
          className={`panel-section mode-section chat-section ${askPanelOpen ? 'open' : 'collapsed'}`}
        >
          <button
            className="section-heading accordion-heading"
            aria-expanded={askPanelOpen}
            onClick={toggleAskPanel}
            type="button"
            style={{ marginBottom: askPanelOpen ? '10px' : '0' }}
          >
            <h2>Ask</h2>
            <span>
              {formatVisibleModelName(status?.chatModel, { developerMode, role: 'chat' }) ??
                'No model'}
            </span>
            <ChevronRightIcon />
          </button>

          <div
            className={`ask-panel-body ${askPanelOpen ? 'is-open' : 'is-closed'}`}
            aria-hidden={!askPanelOpen}
            style={!askPanelOpen ? { pointerEvents: 'none' } : undefined}
          >
            <AskContextControls
              askCollectionId={askCollectionId}
              askCurrentPageOnly={askCurrentPageOnly}
              askIncludeCurrentPage={askIncludeCurrentPage}
              canUseCurrentPage={canUseCurrentPage}
              currentPageTitle={currentPageTitle}
              collections={askCollections}
              onAskCollectionChange={onAskCollectionChange}
              onAskCurrentPageOnlyChange={onAskCurrentPageOnlyChange}
              onAskIncludeCurrentPageChange={onAskIncludeCurrentPageChange}
            />
            <form
              className="chat-form"
              onSubmit={async (event) => {
                event.preventDefault()

                onAskPanelOpenChange(false)
                setTrailPanelOpen(false)
                await onAsk(event)
              }}
            >
              <textarea
                value={chatPrompt}
                onChange={(event) => onChatPromptChange(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
                    event.preventDefault()
                    event.currentTarget.setSelectionRange(0, event.currentTarget.value.length)
                    return
                  }
                  if (event.key !== 'Enter' || event.shiftKey || !chatPrompt.trim()) return
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }}
                placeholder="Ask this collection and current page"
              />
              <button
                type="submit"
                disabled={Boolean(busy) || !chatPrompt.trim() || !hasAskContext || chatBlocked}
              >
                Ask AiON
              </button>
            </form>
          </div>
        </section>

        {busy === 'Asking ÆTHER' &&
          (streamingAnswer ? (
            <section className="panel-section mode-section answer-section">
              <div className="section-heading">
                <h2>Answer</h2>
                <span>
                  {formatVisibleModelName(status?.chatModel, { developerMode, role: 'chat' }) ??
                    'Local model'}
                </span>
              </div>
              <StreamingAnswerCard
                citations={streamingCitations}
                text={streamingAnswer}
                onCancel={onCancelAsk}
                onOpenCitation={onOpenCitation}
              />
            </section>
          ) : ( 
            <AnswerLoading phase={askPhase} onCancel={onCancelAsk} />
          ))}

        {chatResult && busy !== 'Asking ÆTHER' && (
          <section className="panel-section mode-section answer-section">
            <div className="section-heading" style={{ marginBottom: chatResult ? '10px' : '0' }}>
              <h2>Answer</h2>
              <span>
                {formatVisibleModelName(chatResult.model, { developerMode, role: 'chat' }) ??
                  chatResult.model}
              </span>
            </div>
            <AnswerCard result={chatResult} onOpenCitation={onOpenCitation} />
          </section>
        )}

        <section
          className={`panel-section mode-section trail-section ${trailPanelOpen ? 'open' : 'collapsed'}`}
        >
          <button
            className="section-heading accordion-heading"
            aria-expanded={trailPanelOpen}
            onClick={toggleTrailPanel}
            type="button"
            style={{ marginBottom: trailPanelOpen ? '10px' : '0' }}
          >
            <h2>Flow</h2>
            <span className="flow-heading-icon" aria-hidden="true">
              <Waves size={18} />
            </span>
            <ChevronRightIcon />
          </button>

          <div
            className={`trail-panel-body ${trailPanelOpen ? 'is-open' : 'is-closed'}`}
            aria-hidden={!trailPanelOpen}
            style={!trailPanelOpen ? { pointerEvents: 'none' } : undefined}
          >
            <div className="semantic-trail-description">
              <strong>Find Related Knowledge</strong>
              <span>
                Flow streams across your knowledge for connections<br></br>
              </span>

              <button
                style={{ pointerEvents: 'none' }}
                className={`ask-current-button active frozen-tab`}
              >
                <span
                  className="ask-current-badge"
                  style={{
                    borderColor: canUseCurrentPage && currentPageTint ? currentPageTint : undefined,
                    color: canUseCurrentPage && currentPageTint ? currentPageTint : undefined
                  }}
                  aria-hidden="true"
                >
                  <Newspaper size={18} />
                </span>
                <span className="ask-current-text">
                  <strong
                    style={{
                      color: canUseCurrentPage && currentPageTint ? currentPageTint : 'var(--ink)'
                    }}
                  >
                    Current Page
                  </strong>
                  <small title={canUseCurrentPage ? currentPageTitle : undefined}>
                    {canUseCurrentPage ? currentPageTitle : 'Nothing open'}
                  </small>
                </span>
              </button>
            </div>
            
            <div className="semantic-trail-form">
              <label htmlFor="semantic-trail-query" className="semantic-trail-label">
                Focus (Optional)
              </label>
              <span className="semantic-trail-help">
                Type a topic to channel the flow towards a specific topic.
              </span>
              <input
                id="semantic-trail-query"
                aria-label="Flow query"
                value={semanticTrailQuery}
                onChange={(event) => onSemanticTrailQueryChange(event.target.value)}
                placeholder="Filter the stream by a specific theme..."
              />
            </div>
            {busy === 'Building Flow' ? (
              <div className="semantic-trail-loading" role="status">
                <strong>Ranking local sources</strong>
                <span>Reading the active page and comparing captured hubs.</span>
              </div>
            ) : semanticTrailResult ? (
              <SemanticTrailView result={semanticTrailResult} onOpenItem={onOpenSemanticTrailItem} />
            ) : (<></>)}
          </div>
        </section>

        <footer className="panel-footer">
          {footerStatus && (
            <span className="panel-status-text" title={footerStatus}>
              {footerStatus}
            </span>
          )}
          {developerMode ? (
            <button
              className="model-settings-button tooltip-host"
              ref={modelSettingsButtonRef}
              data-tooltip={showTooltips ? 'Model Settings' : undefined}
              data-tooltip-side={showTooltips ? 'left' : undefined}
              onClick={() => setSettingsOpen((current) => !current)}
              title="Model settings"
              type="button"
            >
              <GearIcon />
              <span>
                {status?.chatModel
                  ? formatVisibleModelName(status.chatModel, { developerMode, role: 'chat' })
                  : 'Model settings'}
              </span>
            </button>
          ) : (
            <label className="inline-model-selector">
              <span>Model:</span>
              <select
                disabled={Boolean(busy) || !status || status.chatModels.length === 0}
                value={status?.chatModel ?? ''}
                onChange={(event) => onUpdateModels({ chatModel: event.target.value })}
              >
                <option value="" disabled>
                  No model
                </option>
                {(status?.chatModels ?? []).map((model) => (
                  <option key={model} value={model}>
                    {formatVisibleModelName(model, { developerMode, role: 'chat' }) ?? model}
                  </option>
                ))}
              </select>
            </label>
          )}
        </footer>
        {developerMode && settingsOpen && (
          <LocalModelSettings
            busy={busy}
            developerMode={developerMode}
            settingsRef={modelSettingsRef}
            status={status}
            onUpdateModels={onUpdateModels}
          />
        )}
      </div>
    </aside>
  )
}

function SemanticTrailView({
  result,
  onOpenItem
}: {
  result: SemanticTrailResult
  onOpenItem: (item: SemanticTrailItem) => Promise<void>
}): React.JSX.Element {
  const isFocusLens = !result.root.url

  return (
    <article className="semantic-trail-card">
      <header className="semantic-trail-root">
        <div>
          <span>{isFocusLens ? 'Focus Lens' : 'Active Page Context'}</span>
          <strong>{result.root.title}</strong>
          <small>
            {isFocusLens ? 'Custom topic' : result.root.host || getCaptureHost(result.root.url)}
          </small>
        </div>
        <p>{result.root.excerpt}</p>
      </header>

      {result.items.length === 0 ? (
        <div className="semantic-trail-empty">
          No matching sources.
          Try typing a broader focus topic or capturing related pages.
        </div>
      ) : (
        <div className="semantic-trail-list">
          {result.items.map((item) => {
            const itemHost = item.host || getCaptureHost(item.url)
            const rootHost = result.root.host || getCaptureHost(result.root.url)
            const sameWebsite = Boolean(itemHost && rootHost && itemHost === rootHost)

            return (
              <button
                className="semantic-trail-item"
                key={item.id}
                onClick={() => {
                  void onOpenItem(item)
                }}
                title={item.url}
                type="button"
              >
                <span className="semantic-trail-score" aria-hidden="true">
                  <Droplet size={11} />
                  <strong>{Math.round(item.score.semantic)}%</strong>
                </span>
                <span className="semantic-trail-item-copy">
                  <span className="semantic-trail-item-meta">
                    {itemHost} · {formatDate(item.capturedAt)}
                  </span>
                  <strong>{item.title}</strong>
                  <span className="semantic-trail-excerpt">{item.excerpt}</span>
                  <span className="semantic-trail-reasons">
                    <span>{Math.round(item.score.semantic)}% Match</span>
                    {sameWebsite && <span>Same Website</span>}
                    <span>In {item.collectionName}</span>
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </article>
  )
}

function AnswerLoading({
  phase,
  onCancel
}: {
  phase: string | null
  onCancel: () => void
}): React.JSX.Element {
  const loadingPhase = phase ?? 'Gathering local context'

  return (
    <div
      className="answer-loading"
      role="status"
      aria-live="polite"
      aria-label={`Composing answer. ${loadingPhase}`}
    >
      <CrystallizingOrb
        className="answer-crystallizing-orb"
        title="Composing answer"
        subtitle={loadingPhase}
      />
      <button
        className="answer-stop-button responsive-button"
        onClick={onCancel}
        title="Stop generating"
        type="button"
      >
        Stop
      </button>
    </div>
  )
}

function StreamingAnswerCard({
  citations,
  text,
  onCancel,
  onOpenCitation
}: {
  citations: SearchResult[]
  text: string
  onCancel: () => void
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
}): React.JSX.Element {
  const markdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = markdownRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [text])

  return (
    <article className="answer-card is-streaming">
      <div className="answer-markdown" aria-live="polite" ref={markdownRef}>
        {renderAnswerMarkdown(text, citations, onOpenCitation)}
        <span className="answer-stream-caret" aria-hidden="true" />
      </div>
      <footer>
        <span>Writing answer…</span>
        <button
          className="answer-stop-button responsive-button"
          onClick={onCancel}
          title="Stop generating"
          type="button"
        >
          Stop
        </button>
      </footer>
    </article>
  )
}

function AskContextControls({
  askCollectionId,
  askCurrentPageOnly,
  askIncludeCurrentPage,
  canUseCurrentPage,
  currentPageTitle,
  collections,
  onAskCollectionChange,
  onAskCurrentPageOnlyChange,
  onAskIncludeCurrentPageChange
}: {
  askCollectionId: string
  askCurrentPageOnly: boolean
  askIncludeCurrentPage: boolean
  canUseCurrentPage: boolean
  currentPageTitle: string
  collections: CollectionSummary[]
  onAskCollectionChange: (collectionId: string) => void
  onAskCurrentPageOnlyChange: (value: boolean) => void
  onAskIncludeCurrentPageChange: (value: boolean) => void
}): React.JSX.Element {
  const hasKnowledgeHubs = collections.length > 0
  const hasManyHubs = collections.length > 6
  const currentPageActive = !hasKnowledgeHubs || askCurrentPageOnly || askIncludeCurrentPage

  return (
    <section
      className={`ask-context-controls ${hasKnowledgeHubs ? 'has-hubs' : 'current-only'} ${
        hasManyHubs ? 'has-many-hubs' : ''
      }`}
      aria-label="Ask context"
    >
      {hasKnowledgeHubs ? (
        <>
          <button
            className={`ask-current-button ${currentPageActive ? 'active frozen-tab' : ''}`}
            disabled={!canUseCurrentPage}
            onClick={() => {
              onAskCurrentPageOnlyChange(false)
              onAskIncludeCurrentPageChange(!currentPageActive)
            }}
            type="button"
          >
            <span className="ask-current-badge" style={{ borderColor: currentPageActive ? 'var(--prism)' : undefined, color: currentPageActive ? 'purple' : undefined }} aria-hidden="true">
              <Newspaper size={18} />
            </span>
            <span className="ask-current-text">
              <strong  style={{ color: currentPageActive ? 'purple' : 'var(--ink)' }}>Current Page</strong>
              <small title={canUseCurrentPage ? currentPageTitle : undefined}>
                {canUseCurrentPage ? currentPageTitle : 'Nothing open'}
              </small>
            </span>
            <span
              className={`ask-current-radio ${currentPageActive ? 'is-on' : ''}`}
              aria-hidden="true"
            />
          </button>
          <div className="ask-hub-picker">
            {collections.map((collection) => (
              <button
                className={collection.id === askCollectionId ? 'active' : ''}
                key={collection.id}
                onClick={() => {
                  onAskCurrentPageOnlyChange(false)
                  onAskCollectionChange(collection.id === askCollectionId ? '' : collection.id)
                }}
                type="button"
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '-3px' }}>
                  <CollectionIcon icon={collection.icon} />
                </div>
                <span className="ask-hub-copy">
                  <strong>{collection.name}</strong>
                  <small>
                    {collection.captureCount}{' '}
                    {collection.captureCount === 1 ? 'capture' : 'captures'}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="ask-current-default">
          <span>
            <AetherSigilIcon />
          </span>
          <strong>Current Page</strong>
        </div>
      )}
    </section>
  )
}

function LocalModelSettings({
  busy,
  developerMode,
  settingsRef,
  status,
  onUpdateModels
}: {
  busy: string | null
  developerMode: boolean
  settingsRef: RefObject<HTMLElement | null>
  status: SystemStatus | null
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}): React.JSX.Element {
  const models = status?.availableModels ?? []
  const chatModels = status?.chatModels ?? []
  const embeddingModels = status?.embeddingModels ?? []
  const modelLabel =
    formatVisibleModelName(status?.chatModel, { developerMode, role: 'chat' }) ?? 'No chat model'

  if (!developerMode) {
    return (
      <section
        className="model-island compact-model-island"
        ref={settingsRef}
        aria-label="AiON model"
      >
        <label>
          AiON model
          <select
            disabled={Boolean(busy) || chatModels.length === 0}
            value={status?.chatModel ?? ''}
            onChange={(event) => onUpdateModels({ chatModel: event.target.value })}
          >
            <option value="" disabled>
              No model
            </option>
            {chatModels.map((model) => (
              <option key={model} value={model}>
                {formatVisibleModelName(model, { developerMode, role: 'chat' }) ?? model}
              </option>
            ))}
          </select>
        </label>
      </section>
    )
  }

  return (
    <section className="model-island" ref={settingsRef} aria-label="Built-in model settings">
      <div className="model-heading">
        <div>
          <h2>Built-in Models</h2>
          <p>{status?.runtimeReady ? `${models.length} local models` : 'No local model'}</p>
        </div>
        <span>{modelLabel}</span>
      </div>
      <label>
        Chat model
        <select
          disabled={Boolean(busy) || chatModels.length === 0}
          value={status?.chatModel ?? ''}
          onChange={(event) => onUpdateModels({ chatModel: event.target.value })}
        >
          <option value="" disabled>
            No model
          </option>
          {chatModels.map((model) => (
            <option key={model} value={model}>
              {formatVisibleModelName(model, { developerMode, role: 'chat' }) ?? model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Embeddings
        <select
          disabled={Boolean(busy) || embeddingModels.length === 0}
          value={status?.embeddingModel ?? ''}
          onChange={(event) => onUpdateModels({ embeddingModel: event.target.value })}
        >
          <option value="" disabled>
            No model
          </option>
          {embeddingModels.map((model) => (
            <option key={model} value={model}>
              {formatVisibleModelName(model, { developerMode, role: 'embedding' }) ?? model}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}

// Build the clipboard text: drop the inline [n] / [1, 2] citation markers from the
// prose and move the sources to a footnote list, matching the on-screen citation chips.
function buildAnswerClipboardText(result: ChatResult): string {
  const body = result.answer
    .replace(/ ?\[(?:\d+\s*,\s*)*\d+\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  if (result.citations.length === 0) return body

  const sources = result.citations
    .map((citation, index) => `[${index + 1}] ${citation.title} - ${getCaptureHost(citation.url)}`)
    .join('\n')

  return `${body}\n\nSources:\n${sources}`
}

function formatAnswerMetrics(result: ChatResult): string {
  const tokensPerSecond = Number.isFinite(result.metrics.tokensPerSecond)
    ? result.metrics.tokensPerSecond
    : 0
  const elapsedSeconds = Number.isFinite(result.metrics.elapsedSeconds)
    ? result.metrics.elapsedSeconds
    : 0
  const tokenRate =
    tokensPerSecond >= 10 ? tokensPerSecond.toFixed(0) : tokensPerSecond.toFixed(1)
  const elapsed = elapsedSeconds >= 10 ? elapsedSeconds.toFixed(0) : elapsedSeconds.toFixed(1)
  const chunksLabel = result.metrics.chunks === 1 ? 'chunk' : 'chunks'

  return `${tokenRate} tok/s · ${result.metrics.chunks} ${chunksLabel} · ${elapsed}s`
}

function AnswerCard({
  result,
  onOpenCitation
}: {
  result: ChatResult
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  async function copyAnswer(): Promise<void> {
    await navigator.clipboard.writeText(buildAnswerClipboardText(result))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <article className="answer-card">
      <div className="answer-markdown">
        {renderAnswerMarkdown(result.answer, result.citations, onOpenCitation)}
      </div>
      <p className="answer-metrics-subtitle">{formatAnswerMetrics(result)}</p>
      <div className="citation-list">
        {result.citations.map((citation, index) => {
          const citationNumber = index + 1
          const claimText = claimTextForCitation(result.answer, citationNumber)
          return (
            <button
              key={citation.id}
              onClick={() => onOpenCitation(citation, claimText)}
              type="button"
            >
              [{citationNumber}] {citation.title} - {getCaptureHost(citation.url)}
            </button>
          )
        })}
      </div>
      <footer>
        <span>{result.citations.length} local citations</span>
        <button className="answer-copy-button responsive-button" onClick={copyAnswer} type="button">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </footer>
    </article>
  )
}

function renderAnswerMarkdown(
  markdown: string,
  citations: SearchResult[],
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
): React.ReactNode[] {
  const blocks: React.ReactNode[] = []
  const lines = markdown.split(/\r?\n/)
  let listItems: React.ReactNode[] = []
  let orderedItems: React.ReactNode[] = []

  function flushLists(): void {
    if (listItems.length > 0) {
      blocks.push(<ul key={`ul-${blocks.length}`}>{listItems}</ul>)
      listItems = []
    }
    if (orderedItems.length > 0) {
      blocks.push(<ol key={`ol-${blocks.length}`}>{orderedItems}</ol>)
      orderedItems = []
    }
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      flushLists()
      return
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushLists()
      blocks.push(
        <h3 key={`h-${index}`} className={`answer-heading level-${heading[1].length}`}>
          {renderInlineMarkdown(heading[2], citations, onOpenCitation)}
        </h3>
      )
      return
    }

    // A line of 3+ repeated *, -, or _ (optionally spaced) is a thematic break.
    // Checked before bullets so "* * *" becomes a divider rather than a list item.
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) {
      flushLists()
      blocks.push(<hr key={`hr-${index}`} className="answer-divider" />)
      return
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    if (bullet) {
      orderedItems = []
      listItems.push(
        <li key={`li-${index}`}>{renderInlineMarkdown(bullet[1], citations, onOpenCitation)}</li>
      )
      return
    }

    const numbered = /^\d+\.\s+(.+)$/.exec(trimmed)
    if (numbered) {
      listItems = []
      orderedItems.push(
        <li key={`oli-${index}`}>{renderInlineMarkdown(numbered[1], citations, onOpenCitation)}</li>
      )
      return
    }

    flushLists()
    blocks.push(
      <p key={`p-${index}`}>{renderInlineMarkdown(trimmed, citations, onOpenCitation)}</p>
    )
  })

  flushLists()
  return blocks
}

function markerContainsCitation(marker: string, citationNumber: number): boolean {
  return marker
    .slice(1, -1)
    .split(',')
    .some((value) => Number(value.trim()) === citationNumber)
}

function claimTextForCitation(answer: string, citationNumber: number): string | undefined {
  const normalized = answer.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized]

  for (const sentence of sentences) {
    const markers = sentence.match(/\[(?:\d+\s*,\s*)*\d+\]/g) ?? []
    if (markers.some((marker) => markerContainsCitation(marker, citationNumber))) {
      return stripInlineMarkup(sentence)
    }
  }

  return undefined
}

// Strip inline markup so the remaining text reads as a plain claim sentence, which
// is what we hand to the citation anchor to locate the exact span in the source.
function stripInlineMarkup(text: string): string {
  return text
    .replace(/\*+/g, '')
    .replace(/\[(?:\d+\s*,\s*)*\d+\]/g, ' ')
    .replace(/\\\(|\\\)|\$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderInlineMarkdown(
  text: string,
  citations: SearchResult[],
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>,
  claimText?: string
): React.ReactNode[] {
  // The first (block-level) call establishes the claim; nested calls (e.g. inside
  // bold spans) inherit it so a citation always carries its full sentence.
  const claim = claimText ?? stripInlineMarkup(text)
  const nodes: React.ReactNode[] = []
  // Bold is matched before italic so ** wins over a single *. The italic arm forbids
  // a leading space (`*x*`, not `a * b`) to avoid italicising stray multiplication.
  const pattern =
    /(\*\*[^*]+\*\*|\*(?!\s)[^*\n]+?\*|\$[^$]+\$|\\\([^)]*\\\)|\[(?:\d+\s*,\s*)*\d+\])/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index))
    }

    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={nodes.length}>
          {renderInlineMarkdown(token.slice(2, -2), citations, onOpenCitation, claim)}
        </strong>
      )
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={nodes.length}>
          {renderInlineMarkdown(token.slice(1, -1), citations, onOpenCitation, claim)}
        </em>
      )
    } else if (/^\[(?:\d+\s*,\s*)*\d+\]$/.test(token)) {
      const citationNodes = renderCitationToken(
        token,
        citations,
        onOpenCitation,
        nodes.length,
        claim
      )
      nodes.push(...citationNodes)
    } else {
      nodes.push(
        <span className="answer-inline-math" key={nodes.length}>
          {formatInlineMath(token)}
        </span>
      )
    }

    cursor = match.index + token.length
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}

function renderCitationToken(
  token: string,
  citations: SearchResult[],
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>,
  keyOffset: number,
  claimText?: string
): React.ReactNode[] {
  const indexes = token
    .slice(1, -1)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)

  if (indexes.length === 0) return [token]

  const nodes: React.ReactNode[] = []
  indexes.forEach((citationNumber, index) => {
    const citation = citations[citationNumber - 1]
    if (!citation) {
      return
    }

    if (index > 0) nodes.push(' ')
    nodes.push(
      <button
        className="answer-citation-link"
        key={`citation-${keyOffset}-${citationNumber}-${index}`}
        onClick={() => {
          void onOpenCitation(citation, claimText)
        }}
        title={`${citation.title} - ${getCaptureHost(citation.url)}`}
        type="button"
      >
        [{citationNumber}]
      </button>
    )
  })

  return nodes
}

function formatInlineMath(token: string): string {
  const inner = token.startsWith('$')
    ? token.slice(1, -1)
    : token.startsWith('\\(')
      ? token.slice(2, -2)
      : token

  return inner
    .replace(/\\text\{([^}]+)\}/g, '$1')
    .replace(/\\mathrm\{([^}]+)\}/g, '$1')
    .replace(/\\mathbf\{([^}]+)\}/g, '$1')
    .replace(/\\,/g, ' ')
    .replace(/\\/g, '')
}

function StatusPill({ status }: { status: SystemStatus | null }): React.JSX.Element {
  if (!status) {
    return <span className="status-pill neutral">Checking</span>
  }

  return (
    <span
      className={`status-pill ${status.runtimeReady ? 'online' : 'offline'}`}
      title={status.runtimeReady ? status.runtimeName : undefined}
    >
      {status.runtimeReady ? 'Ready' : 'No model'}
    </span>
  )
}
