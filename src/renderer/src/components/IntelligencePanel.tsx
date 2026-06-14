import { CSSProperties, FormEvent, useEffect, useRef, useState } from 'react'
import { ChatResult, CollectionSummary, SearchResult, SystemStatus } from '../../../shared/aether'
import { CollectionIcon } from '../utils/collection-icons'
import { formatLocalModelName, getCaptureHost } from '../utils/aether-ui'
import { AetherSigilIcon, ChevronRightIcon } from './icons'

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
  collections: CollectionSummary[]
  dashboardOpen: boolean
  chatResult: ChatResult | null
  notice: string | null
  panelCollapsed: boolean
  status: SystemStatus | null
  streamingAnswer: string
  streamingCitations: SearchResult[]
  onAsk: (event: FormEvent) => Promise<void>
  onAskPanelOpenChange: (value: boolean) => void
  onCancelAsk: () => void
  onTogglePanel: () => Promise<void>
  onChatPromptChange: (value: string) => void
  onAskCollectionChange: (collectionId: string) => void
  onAskCurrentPageOnlyChange: (value: boolean) => void
  onAskIncludeCurrentPageChange: (value: boolean) => void
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
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
  collections,
  dashboardOpen,
  chatResult,
  notice,
  panelCollapsed,
  status,
  streamingAnswer,
  streamingCitations,
  onAsk,
  onAskPanelOpenChange,
  onCancelAsk,
  onTogglePanel,
  onChatPromptChange,
  onAskCollectionChange,
  onAskCurrentPageOnlyChange,
  onAskIncludeCurrentPageChange,
  onOpenCitation,
  onUpdateModels
}: IntelligencePanelProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const showTooltips = dashboardOpen
  const askCollections = collections.filter((collection) => collection.captureCount > 0)
  const hasKnowledgeHubs = askCollections.length > 0
  const hasAskContext = !hasKnowledgeHubs
    ? canUseCurrentPage
    : askCurrentPageOnly
      ? canUseCurrentPage
      : Boolean(askCollectionId) || (askIncludeCurrentPage && canUseCurrentPage)

  return (
    <aside className={`intelligence-panel ${panelCollapsed ? 'collapsed' : ''}`}>
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
          className="panel-icon-toggle tooltip-host crystal-button"
          data-tooltip={showTooltips ? 'Open sidepanel' : undefined}
          data-tooltip-side={showTooltips ? 'left' : undefined}
          aria-hidden={!panelCollapsed}
          onClick={onTogglePanel}
          tabIndex={panelCollapsed ? 0 : -1}
          title="Open sidepanel"
          type="button"
        >
          <AetherSigilIcon />
        </button>
      </div>
      <div className="panel-content" aria-hidden={panelCollapsed} inert={panelCollapsed}>
        <header className="panel-header">
          <div>
            <p>AiON • Local AI</p>
            <h1>Talk to the web you explored.</h1>
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
            onClick={() => onAskPanelOpenChange(!askPanelOpen)}
            type="button"
          >
            <h2>Ask</h2>
            <span>{formatLocalModelName(status?.chatModel) ?? 'No model'}</span>
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

        {busy === 'Asking Æther' &&
          (streamingAnswer ? (
            <section className="panel-section mode-section answer-section">
              <div className="section-heading">
                <h2>Answer</h2>
                <span>{formatLocalModelName(status?.chatModel) ?? 'Local model'}</span>
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

        {chatResult && busy !== 'Asking Æther' && (
          <section className="panel-section mode-section answer-section">
            <div className="section-heading">
              <h2>Answer</h2>
              <span>{formatLocalModelName(chatResult.model) ?? chatResult.model}</span>
            </div>
            <AnswerCard result={chatResult} onOpenCitation={onOpenCitation} />
          </section>
        )}

        <footer className="panel-footer">
          <span>{busy ?? notice ?? ''}</span>
          <button
            className="model-settings-button tooltip-host"
            data-tooltip={showTooltips ? 'Model Settings' : undefined}
            data-tooltip-side={showTooltips ? 'left' : undefined}
            onClick={() => setSettingsOpen((current) => !current)}
            title="Model settings"
            type="button"
          >
            {status?.chatModel
              ? `Model ${formatLocalModelName(status.chatModel)}`
              : 'Model settings'}
          </button>
        </footer>
        {settingsOpen && (
          <LocalModelSettings busy={busy} status={status} onUpdateModels={onUpdateModels} />
        )}
      </div>
    </aside>
  )
}

function AnswerLoading({
  phase,
  onCancel
}: {
  phase: string | null
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="answer-loading" role="status" aria-live="polite">
      <div className="answer-loading-haze" aria-hidden="true" />
      <div className="answer-loading-ring" aria-hidden="true">
        {Array.from({ length: 14 }).map((_, index) => (
          <span key={index} style={{ '--particle-index': index } as CSSProperties} />
        ))}
      </div>
      <div className="answer-loading-copy">
        <strong>Composing answer</strong>
        <span>{phase ?? 'Gathering local context'}</span>
      </div>
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
  collections,
  onAskCollectionChange,
  onAskCurrentPageOnlyChange,
  onAskIncludeCurrentPageChange
}: {
  askCollectionId: string
  askCurrentPageOnly: boolean
  askIncludeCurrentPage: boolean
  canUseCurrentPage: boolean
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
            Current page
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
                <span>
                  <CollectionIcon icon={collection.icon} />
                </span>
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
          <strong>Current page</strong>
        </div>
      )}
    </section>
  )
}

function LocalModelSettings({
  busy,
  status,
  onUpdateModels
}: {
  busy: string | null
  status: SystemStatus | null
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}): React.JSX.Element {
  const models = status?.availableModels ?? []
  const chatModels = status?.chatModels ?? []
  const embeddingModels = status?.embeddingModels ?? []
  const modelLabel = formatLocalModelName(status?.chatModel) ?? 'No chat model'

  return (
    <section className="model-island" aria-label="Local model settings">
      <div className="model-heading">
        <div>
          <h2>Local models</h2>
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
              {formatLocalModelName(model) ?? model}
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
              {formatLocalModelName(model) ?? model}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
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
    await navigator.clipboard.writeText(result.answer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <article className="answer-card">
      <div className="answer-markdown">
        {renderAnswerMarkdown(result.answer, result.citations, onOpenCitation)}
      </div>
      <div className="citation-list">
        {result.citations.map((citation, index) => (
          <button key={citation.id} onClick={() => onOpenCitation(citation)} type="button">
            [{index + 1}] {citation.title} - {getCaptureHost(citation.url)}
          </button>
        ))}
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

// Strip inline markup so the remaining text reads as a plain claim sentence, which
// is what we hand to the citation anchor to locate the exact span in the source.
function stripInlineMarkup(text: string): string {
  return text
    .replace(/\*\*/g, '')
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
  const pattern = /(\*\*[^*]+\*\*|\$[^$]+\$|\\\([^)]*\\\)|\[(?:\d+\s*,\s*)*\d+\])/g
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
    <span className={`status-pill ${status.runtimeReady ? 'online' : 'offline'}`}>
      {status.runtimeReady ? status.runtimeName : 'No model'}
    </span>
  )
}
