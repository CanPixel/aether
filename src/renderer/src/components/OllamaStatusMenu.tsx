import { useState } from 'react'
import { SystemStatus } from '../../../shared/aether'

type OllamaStatusMenuProps = {
  busy: string | null
  status: SystemStatus | null
  onUpdateModels: (input: { embeddingModel?: string; chatModel?: string }) => Promise<void>
}

export function OllamaStatusMenu({
  busy,
  status,
  onUpdateModels
}: OllamaStatusMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const models = status?.availableModels ?? []

  return (
    <div className="ollama-menu">
      <button
        className={`status-pill ${
          status ? (status.ollamaReachable ? 'online' : 'offline') : 'neutral'
        } tooltip-host`}
        data-tooltip="Ollama models"
        data-tooltip-side="left"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {status ? (status.ollamaReachable ? status.chatModel || 'Ollama' : 'Offline') : 'Checking'}
      </button>
      {open && (
        <section className="ollama-popover" aria-label="Ollama settings">
          <header>
            <strong>Ollama</strong>
            <span>{status?.ollamaReachable ? `${models.length} models` : 'Unavailable'}</span>
          </header>
          <label>
            Chat
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
      )}
    </div>
  )
}
