import {
  memo,
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
  ConversationTurn,
  ModelDownloadChoice,
  SearchResult,
  SemanticTrailItem,
  SemanticTrailResult,
  SystemStatus
} from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import {
  chatModelRungs,
  countLabel,
  formatDate,
  formatVisibleModelName,
  getCaptureHost
} from '../utils/aether-ui'
import { claimTextForCitation, renderAnswerMarkdown } from './answer-markdown'
import { buildEvidenceBundle } from '../utils/evidence-bundle'
import { writeClipboardText } from '../utils/clipboard'
import { CrystallizingOrb } from './CrystallizingOrb'
import { ModelLevelSlider } from './ModelLevelSlider'
import { AetherSigilIcon, ChevronRightIcon, GearIcon } from './icons'
import { Droplet, HardDriveDownload, Waves, Newspaper } from 'lucide-react'

type IntelligencePanelProps = {
  busy: string | null
  chatBlocked: boolean
  // True when only the embedding model is installed: Ask returns passages, not prose.
  chatIsExtractive: boolean
  // Persisted turns for the active thread, oldest first.
  chatThread: ConversationTurn[]
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
  onClearHistory: () => void
  onOpenSemanticTrailItem: (item: SemanticTrailItem) => Promise<void>
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
  // The optional argument preselects a model in the setup modal, so a click on a
  // greyed slider rung lands on that model rather than on a blank chooser.
  onOpenModelSetup: (preselect?: ModelDownloadChoice) => Promise<void>
}

function modelOptionsWithSelected(models: string[], selected?: string | null): string[] {
  if (!selected || models.includes(selected)) return models
  return [selected, ...models]
}

function IntelligencePanelComponent({
  busy,
  chatBlocked,
  chatIsExtractive,
  chatThread,
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
  onClearHistory,
  onOpenSemanticTrailItem,
  onUpdateModels,
  onOpenModelSetup
}: IntelligencePanelProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [trailPanelOpen, setTrailPanelOpen] = useState(false)
  const showTooltips = dashboardOpen
  const panelRef = useRef<HTMLElement>(null)
  const modelSettingsButtonRef = useRef<HTMLButtonElement>(null)
  const modelSettingsRef = useRef<HTMLElement>(null)
  const chatModelOptions = modelOptionsWithSelected(status?.chatModels ?? [], status?.chatModel)
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
  // The newest stored turn and chatResult are the same exchange; drop it here so the
  // live answer card is not duplicated above itself.
  const priorTurns =
    chatResult &&
    chatThread.length > 0 &&
    chatThread[chatThread.length - 1].answer === chatResult.answer
      ? chatThread.slice(0, -1)
      : chatThread
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
            <p>
              AiON <span>• Grounded Local Knowledge</span>
            </p>
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
                placeholder="Ask this hub and current page"
              />
              <button
                type="submit"
                disabled={Boolean(busy) || !chatPrompt.trim() || !hasAskContext || chatBlocked}
              >
                {chatIsExtractive ? 'Find Passages' : 'Ask AiON'}
              </button>
              {/* Say up front that nothing will be written, so a passage list is not
                  read as a failed answer. */}
              {chatIsExtractive && (
                <p className="chat-extractive-note">
                  No chat model installed — AiON will return the best matching passages from your
                  sources instead of a written answer.
                </p>
              )}
            </form>
          </div>
        </section>

        {/* Earlier turns in this thread. Rendered above the live answer so the panel
            reads top-to-bottom as a conversation. */}
        {priorTurns.length > 0 && (
          <section className="panel-section mode-section thread-section">
            <div className="section-heading">
              <h2>Earlier</h2>
              <button className="thread-clear-button" onClick={onClearHistory} type="button">
                Clear
              </button>
            </div>
            {priorTurns.map((turn) => (
              <article className="thread-turn" key={turn.id}>
                <p className="thread-turn-prompt">{turn.prompt}</p>
                <AnswerCard
                  result={{
                    answer: turn.answer,
                    model: turn.model,
                    citations: turn.citations,
                    metrics: turn.metrics
                  }}
                  onOpenCitation={onOpenCitation}
                />
              </article>
            ))}
          </section>
        )}

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
              <SemanticTrailView
                result={semanticTrailResult}
                onOpenItem={onOpenSemanticTrailItem}
              />
            ) : (
              <></>
            )}
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
              title="Model Settings"
              type="button"
            >
              <GearIcon />
              <span>
                {status?.chatModel
                  ? formatVisibleModelName(status.chatModel, { developerMode, role: 'chat' })
                  : 'Model Settings'}
              </span>
            </button>
          ) : chatModelOptions.length === 0 ? (
            // With nothing installed the select is a dead control, so the slot carries
            // the action that resolves it instead. This is the only route to setup from
            // the panel where a missing model actually shows up.
            <button
              className="inline-model-setup-button"
              disabled={Boolean(busy)}
              onClick={() => {
                void onOpenModelSetup()
              }}
              type="button"
            >
              <HardDriveDownload size={14} aria-hidden="true" />
              <span>Install Models</span>
            </button>
          ) : (
            <div className="inline-model-controls">
              <ModelLevelSlider
                activeModel={status?.chatModel}
                developerMode={developerMode}
                disabled={Boolean(busy) || !status}
                onInstall={(choice) => {
                  void onOpenModelSetup(choice)
                }}
                onSelect={(chatModel) => {
                  void onUpdateModels({ chatModel })
                }}
                rungs={chatModelRungs(chatModelOptions)}
              />
              <button
                aria-label="Manage Models"
                className="inline-model-manage-button"
                disabled={Boolean(busy)}
                onClick={() => {
                  void onOpenModelSetup()
                }}
                title="Manage Models"
                type="button"
              >
                <HardDriveDownload size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </footer>
        {developerMode && settingsOpen && (
          <LocalModelSettings
            busy={busy}
            developerMode={developerMode}
            settingsRef={modelSettingsRef}
            status={status}
            onUpdateModels={onUpdateModels}
            onOpenModelSetup={onOpenModelSetup}
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
          No matching sources. Try typing a broader focus topic or capturing related pages.
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
            <span
              className="ask-current-badge"
              style={{
                borderColor: currentPageActive ? 'var(--prism)' : undefined,
                color: currentPageActive ? 'purple' : undefined
              }}
              aria-hidden="true"
            >
              <Newspaper size={18} />
            </span>
            <span className="ask-current-text">
              <strong style={{ color: currentPageActive ? 'purple' : 'var(--ink)' }}>
                Current Page
              </strong>
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
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '-3px'
                  }}
                >
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
  onUpdateModels,
  onOpenModelSetup
}: {
  busy: string | null
  developerMode: boolean
  settingsRef: RefObject<HTMLElement | null>
  status: SystemStatus | null
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
  onOpenModelSetup: () => Promise<void>
}): React.JSX.Element {
  const models = status?.availableModels ?? []
  const chatModels = modelOptionsWithSelected(status?.chatModels ?? [], status?.chatModel)
  const embeddingModels = modelOptionsWithSelected(
    status?.embeddingModels ?? [],
    status?.embeddingModel
  )
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
          <p>
            {status?.runtimeReady ? countLabel(models.length, 'local model') : 'No local model'}
          </p>
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
      <button
        className="model-island-setup-button"
        disabled={Boolean(busy)}
        onClick={() => {
          void onOpenModelSetup()
        }}
        type="button"
      >
        <HardDriveDownload size={14} aria-hidden="true" />
        <span>{models.length === 0 ? 'Install Models' : 'Manage Models'}</span>
      </button>
    </section>
  )
}

function formatAnswerMetrics(result: ChatResult): string {
  const tokensPerSecond = Number.isFinite(result.metrics.tokensPerSecond)
    ? result.metrics.tokensPerSecond
    : 0
  const elapsedSeconds = Number.isFinite(result.metrics.elapsedSeconds)
    ? result.metrics.elapsedSeconds
    : 0
  const tokenRate = tokensPerSecond >= 10 ? tokensPerSecond.toFixed(0) : tokensPerSecond.toFixed(1)
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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyAnswer(): Promise<void> {
    try {
      await writeClipboardText(buildEvidenceBundle(result))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => setCopyState('idle'), 1600)
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
        <span>{countLabel(result.citations.length, 'local citation')}</span>
        <button className="answer-copy-button responsive-button" onClick={copyAnswer} type="button">
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : 'Copy evidence'}
        </button>
      </footer>
    </article>
  )
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

// Wrapped in memo because App owns almost all of this app's state: a keystroke in
// the address bar, a status toast, a streaming token — each re-renders App, and
// without this every one of them re-renders this panel too. The handlers App
// passes down go through useStableHandler so those props stay equal between
// renders; without that this wrapper would compare unequal every time and do
// nothing.
export const IntelligencePanel = memo(IntelligencePanelComponent)
