import { FormEvent, useState } from 'react'
import { ChatResult, CollectionSummary, SearchResult, SystemStatus } from '../../../shared/aether'
import { PanelMode } from '../types/ui'
import { getCaptureHost } from '../utils/aether-ui'
import { ChevronRightIcon, SparkIcon } from './icons'

type IntelligencePanelProps = {
  busy: string | null
  chatBlocked: boolean
  chatPrompt: string
  chatResult: ChatResult | null
  mode: PanelMode
  notice: string | null
  panelCollapsed: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  searchQuery: string
  searchResults: SearchResult[]
  selectedCollection?: CollectionSummary
  status: SystemStatus | null
  onAsk: (event: FormEvent) => Promise<void>
  onModeChange: (mode: PanelMode) => void
  onSearch: (event?: FormEvent) => Promise<void>
  onSearchQueryChange: (value: string) => void
  onTogglePanel: () => Promise<void>
  onChatPromptChange: (value: string) => void
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}

export function IntelligencePanel({
  busy,
  chatBlocked,
  chatPrompt,
  chatResult,
  mode,
  notice,
  panelCollapsed,
  searchInputRef,
  searchQuery,
  searchResults,
  selectedCollection,
  status,
  onAsk,
  onModeChange,
  onSearch,
  onSearchQueryChange,
  onTogglePanel,
  onChatPromptChange,
  onUpdateModels
}: IntelligencePanelProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (panelCollapsed) {
    return (
      <aside className="intelligence-panel collapsed">
        <button
          className="panel-icon-toggle tooltip-host"
          data-tooltip="Open AI Sidepanel"
          data-tooltip-side="left"
          onClick={onTogglePanel}
          title="Open AI sidepanel"
          type="button"
        >
          <SparkIcon />
        </button>
      </aside>
    )
  }

  return (
    <aside className="intelligence-panel">
      <div className="panel-content">
        <header className="panel-header">
          <div>
            <p>ÆTHER</p>
            <h1>Local context for the web you explore.</h1>
          </div>
          <div className="panel-header-actions">
            <StatusPill status={status} />
            <button
              className="panel-close tooltip-host"
              data-tooltip="Collapse AI Sidepanel"
              data-tooltip-side="left"
              onClick={onTogglePanel}
              title="Collapse AI sidepanel"
              type="button"
            >
              <ChevronRightIcon />
            </button>
          </div>
        </header>

        <div className="panel-tabs" role="tablist" aria-label="Aether modes">
          {(['search', 'ask'] as PanelMode[]).map((item) => (
            <button
              className={mode === item ? 'active' : ''}
              key={item}
              onClick={() => onModeChange(item)}
              role="tab"
              type="button"
            >
              {item}
            </button>
          ))}
        </div>

        <section className="panel-context-line">
          <span>Context</span>
          <strong>{selectedCollection?.name ?? 'No collection selected'}</strong>
        </section>

        {mode === 'search' && (
          <section className="panel-section mode-section">
            <div className="section-heading">
              <h2>Search</h2>
              <span>{selectedCollection?.captureCount ?? 0} captures</span>
            </div>
            <form className="search-form" onSubmit={onSearch}>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder="Search selected collection"
              />
              <button
                type="submit"
                disabled={
                  Boolean(busy) ||
                  !searchQuery.trim() ||
                  !selectedCollection ||
                  !status?.ollamaReachable
                }
              >
                Search
              </button>
            </form>
            <ResultList results={searchResults} />
          </section>
        )}

        {mode === 'ask' && (
          <section className="panel-section mode-section chat-section">
            <div className="section-heading">
              <h2>Ask</h2>
              <span>{status?.chatModel ?? 'No model'}</span>
            </div>
            <form className="chat-form" onSubmit={onAsk}>
              <textarea
                value={chatPrompt}
                onChange={(event) => onChatPromptChange(event.target.value)}
                placeholder="Ask this collection and current page"
              />
              <button
                type="submit"
                disabled={Boolean(busy) || !chatPrompt.trim() || !selectedCollection || chatBlocked}
              >
                Ask ÆTHER
              </button>
            </form>
            {chatResult && <AnswerCard result={chatResult} />}
          </section>
        )}

        <footer className="panel-footer">
          <span>{busy ?? notice ?? 'Cmd+T new tab - Cmd+K search - Cmd+L address'}</span>
          <button
            className="model-settings-button tooltip-host"
            data-tooltip="Model Settings"
            data-tooltip-side="left"
            onClick={() => setSettingsOpen((current) => !current)}
            title="Model settings"
            type="button"
          >
            {status?.chatModel ? `Model ${status.chatModel}` : 'Model settings'}
          </button>
        </footer>
        {settingsOpen && (
          <OllamaSettings busy={busy} status={status} onUpdateModels={onUpdateModels} />
        )}
      </div>
    </aside>
  )
}

function OllamaSettings({
  busy,
  status,
  onUpdateModels
}: {
  busy: string | null
  status: SystemStatus | null
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}): React.JSX.Element {
  const models = status?.availableModels ?? []
  const modelLabel = status?.chatModel ?? 'No chat model'

  return (
    <section className="ollama-island" aria-label="Ollama settings">
      <div className="ollama-heading">
        <div>
          <h2>Ollama</h2>
          <p>{status?.ollamaReachable ? `${models.length} loaded models` : 'Offline'}</p>
        </div>
        <span>{modelLabel}</span>
      </div>
      <label>
        Chat model
        <select
          disabled={Boolean(busy) || !status?.ollamaReachable || models.length === 0}
          value={status?.chatModel ?? ''}
          onChange={(event) => onUpdateModels({ chatModel: event.target.value })}
        >
          <option value="" disabled>
            No model
          </option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Embeddings
        <select
          disabled={Boolean(busy) || !status?.ollamaReachable || models.length === 0}
          value={status?.embeddingModel ?? ''}
          onChange={(event) => onUpdateModels({ embeddingModel: event.target.value })}
        >
          <option value="" disabled>
            No model
          </option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}

function ResultList({ results }: { results: SearchResult[] }): React.JSX.Element {
  if (results.length === 0) {
    return <div className="empty-row">Search results will appear here.</div>
  }
  return (
    <div className="results-list">
      {results.slice(0, 6).map((result) => (
        <article className="result-item" key={result.id}>
          <div>
            <h3>{result.title}</h3>
            <span>
              {getCaptureHost(result.url)} - chunk {result.chunkIndex + 1}
            </span>
          </div>
          <p>{result.text}</p>
        </article>
      ))}
    </div>
  )
}

function AnswerCard({ result }: { result: ChatResult }): React.JSX.Element {
  return (
    <article className="answer-card">
      <p>{result.answer}</p>
      <div className="citation-list">
        {result.citations.slice(0, 5).map((citation, index) => (
          <span key={citation.id}>
            [{index + 1}] {citation.title} - {getCaptureHost(citation.url)}
          </span>
        ))}
      </div>
      <footer>{result.citations.length} local citations</footer>
    </article>
  )
}

function StatusPill({ status }: { status: SystemStatus | null }): React.JSX.Element {
  if (!status) {
    return <span className="status-pill neutral">Checking</span>
  }

  return (
    <span className={`status-pill ${status.ollamaReachable ? 'online' : 'offline'}`}>
      {status.ollamaReachable ? 'Ollama' : 'Offline'}
    </span>
  )
}
