import { Check, CircleCheck, CloudDownload, ExternalLink, ShieldCheck, Wind, Waves } from 'lucide-react'
import { Quantum } from 'ldrs/react'
import 'ldrs/react/Quantum.css'
import { ModelDownloadChoice, ModelDownloadProgress } from '../../../shared/aether'

const MODEL_SETUP_OPTIONS: Array<{
  id: ModelDownloadChoice
  name: string
  title: string
  description: string
  size: string
  source: string
}> = [
  {
    id: 'lite',
    name: 'AiON LiTE',
    title: 'Answers like a breeze',
    description: 'Smaller, faster. Good for everyday capture, search, page summaries, and quick grounded answers.',
    size: '3.35 GB',
    source: 'Gemma 4 E2B QAT Q4_0'
  },
  {
    id: 'wise',
    name: 'AiON WiSE',
    title: 'Deeper local reasoning',
    description: 'Larger, slower. Richer synthesis, iCE maps, and longer answers.',
    size: '5.15 GB',
    source: 'Gemma 4 E4B QAT Q4_0'
  }
]

const MODEL_NOTICE_LINKS = [
  {
    label: 'Embedding source',
    href: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF'
  },
  {
    label: 'LiTE source',
    href: 'https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf'
  },
  {
    label: 'WiSE source',
    href: 'https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf'
  },
  {
    label: 'License details',
    href: 'https://www.apache.org/licenses/LICENSE-2.0'
  }
]

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const fractionDigits = value >= 10 || unitIndex < 2 ? 0 : 1
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`
}

function progressPercent(current?: number, total?: number): number {
  if (!current || !total || total <= 0) return 0
  return Math.max(0, Math.min(100, (current / total) * 100))
}

type ModelSetupModalProps = {
  busy: boolean
  complete: boolean
  coreInstalled: boolean
  error: string | null
  installedModels: ModelDownloadChoice[]
  modelDir: string
  progress: ModelDownloadProgress[]
  selectedModels: ModelDownloadChoice[]
  onClose: () => void
  onStart: () => void
  onToggleModel: (model: ModelDownloadChoice) => void
}

export function ModelSetupModal({
  busy,
  complete,
  coreInstalled,
  error,
  installedModels,
  modelDir,
  progress,
  selectedModels,
  onClose,
  onStart,
  onToggleModel
}: ModelSetupModalProps): React.JSX.Element {
  const progressTotal = [...progress]
    .reverse()
    .find((item) => item.overallTotalBytes)?.overallTotalBytes
  const progressDownloaded = progress.reduce(
    (max, item) => Math.max(max, item.overallDownloadedBytes),
    0
  )
  const overallPercent = complete ? 100 : progressPercent(progressDownloaded, progressTotal)
  const hasNewChatSelection = selectedModels.some((model) => !installedModels.includes(model))
  const canStart = (hasNewChatSelection || !coreInstalled) && !busy && !complete
  const primaryLabel = busy
    ? 'Installing'
    : complete
      ? 'Installed'
      : hasNewChatSelection
        ? 'Begin Install'
        : coreInstalled
          ? 'All Installed'
          : 'Install Core'

  return (
    <div className="model-setup-overlay" role="presentation">
      <section
        className="model-setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-setup-title"
      >
        <div className="model-setup-glass" aria-hidden="true" />
        <div className="model-setup-hero">
          <div className="model-setup-copy">
            <span className="model-setup-kicker">
              <span className="model-setup-spark" aria-hidden="true" />
              Local intelligence
            </span>
            <h1 id="model-setup-title">AiON Assembly</h1>
            <p>
              Choose the local model pack for this device. AiON MiST installs with every selection
              for private semantic search.
            </p>
          </div>
          <div className="model-setup-crystal" aria-hidden="true">
            <img alt="" src="/aether-plusless-crystal.png" />
          </div>
        </div>

        <div className="model-setup-grid">
          <div className="model-setup-options" aria-label="AiON model choices">
            {MODEL_SETUP_OPTIONS.map((option) => {
              const installed = installedModels.includes(option.id)
              const selected = selectedModels.includes(option.id) && !installed
              return (
                <label
                  className={`model-choice ${selected ? 'selected' : ''} ${installed ? 'installed' : ''}`}
                  key={option.id}
                >
                  <input
                    checked={selected}
                    disabled={busy || installed}
                    onChange={() => onToggleModel(option.id)}
                    type="checkbox"
                  />
                  <span className="model-choice-check" aria-hidden="true">
                    <Check />
                  </span>
                  <span className="model-choice-icon" aria-hidden="true">
                    {option.id === 'lite' ? <Wind /> : <Waves />}
                  </span>
                  <span className="model-choice-copy">
                    <strong>{option.name}</strong>
                    <em>{option.title}</em>
                    <small>{option.description}</small>
                    <code>{installed ? 'Contained locally' : option.source}</code>
                  </span>
                  <span className="model-choice-size">{installed ? 'Installed' : option.size}</span>
                </label>
              )
            })}
          </div>

          <aside className="model-setup-side">
            <div className={`model-core-card ${coreInstalled ? 'installed' : ''}`}>
              <span>
                <ShieldCheck aria-hidden="true" />
                Required core
              </span>
              <strong>AiON MiST</strong>
              <small>
                {coreInstalled
                  ? 'Already contained locally'
                  : 'The misty semantic search core · 610 MB'}
              </small>
              <code>Qwen3 Embedding 0.6B</code>
            </div>

            <div className="model-access-card">
              <span>Verified sources</span>
              <p>Models download from their official publishers. Details stay available here.</p>
              <div className="model-access-links">
                {MODEL_NOTICE_LINKS.map((link) => (
                  <a href={link.href} key={link.href} rel="noreferrer" target="_blank">
                    {link.label}
                    <ExternalLink aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>

            <div className="model-dir-card">
              <span>Install location</span>
              <code>{modelDir || 'App data model directory'}</code>
            </div>
          </aside>
        </div>

        <div className={`model-setup-progress ${progress.length ? 'active' : ''}`}>
          <div className="model-progress-heading">
            <span>
              {complete ? 'Ready' : busy ? 'Installing' : progress.length ? 'Prepared' : 'Waiting'}
            </span>
            <strong>
              {progressTotal
                ? `${formatBytes(progressDownloaded)} / ${formatBytes(progressTotal)}`
                : complete
                  ? 'Complete'
                  : hasNewChatSelection || !coreInstalled
                    ? 'Ready'
                    : 'Nothing to install'}
            </strong>
          </div>
          <div
            className="model-progress-meter"
            aria-label="Overall model download progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(overallPercent)}
            role="progressbar"
          >
            <span style={{ transform: `scaleX(${overallPercent / 100})` }} />
          </div>

          {progress.length > 0 ? (
            <div className="model-progress-list">
              {progress.map((item) => {
                const itemPercent =
                  item.status === 'complete' || item.status === 'skipped'
                    ? 100
                    : progressPercent(item.downloadedBytes, item.totalBytes)
                return (
                  <div className={`model-progress-row ${item.status}`} key={item.id}>
                    <span className="model-progress-icon" aria-hidden="true">
                      {item.status === 'complete' || item.status === 'skipped' ? (
                        <CircleCheck />
                      ) : item.status === 'downloading' ? (
                        <Quantum size={18} speed={1.35} color="currentColor" />
                      ) : (
                        <CloudDownload />
                      )}
                    </span>
                    <span className="model-progress-copy">
                      <strong>{item.label}</strong>
                      <small>{item.message ?? item.filename}</small>
                    </span>
                    <span className="model-progress-size">
                      {item.totalBytes
                        ? `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`
                        : formatBytes(item.downloadedBytes)}
                    </span>
                    <span className="model-progress-line" aria-hidden="true">
                      <i style={{ transform: `scaleX(${itemPercent / 100})` }} />
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>

        {error && <p className="model-setup-error">{error}</p>}

        <footer className="model-setup-actions">
          <button disabled={busy} onClick={onClose} type="button">
            {complete ? 'Done' : 'Later'}
          </button>
          <button className="primary-button" disabled={!canStart} onClick={onStart} type="button">
            {primaryLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
