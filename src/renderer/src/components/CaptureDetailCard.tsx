import { useState } from 'react'
import { CaptureSummary } from '../../../shared/aether'
import { formatDate, getCaptureHost } from '../utils/aether-ui'
import { TrashIcon } from './icons'

type CaptureDetailCardProps = {
  capture: CaptureSummary
  onAskCapture?: (capture: CaptureSummary) => Promise<void>
  onDelete: (captureId: string) => Promise<void>
  onOpenCapture?: (capture: CaptureSummary) => Promise<void>
  onUpdateNote?: (captureId: string, note: string) => Promise<void>
}

export function CaptureDetailCard({
  capture,
  onAskCapture,
  onDelete,
  onOpenCapture,
  onUpdateNote
}: CaptureDetailCardProps): React.JSX.Element {
  const [noteDraft, setNoteDraft] = useState(capture.metadata?.note ?? '')

  return (
    <article className="recent-card capture-detail-card">
      <div className="recent-source">
        <span>{getCaptureHost(capture.url)}</span>
        <button
          aria-label={`Delete ${capture.title}`}
          className="recent-delete"
          onClick={() => onDelete(capture.id)}
          title="Delete capture"
          type="button"
        >
          <TrashIcon />
        </button>
      </div>
      <button
        className="capture-open"
        onClick={() => onOpenCapture?.(capture)}
        title={capture.url}
        type="button"
      >
        <h3>{capture.title}</h3>
      </button>
      <p>{capture.metadata?.summary || 'Captured and indexed for local retrieval.'}</p>
      {capture.metadata?.tags && capture.metadata.tags.length > 0 && (
        <div className="capture-tags">
          {capture.metadata.tags.slice(0, 4).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      )}
      {onUpdateNote && (
        <form
          className="capture-note-form"
          onSubmit={(event) => {
            event.preventDefault()
            onUpdateNote(capture.id, noteDraft)
          }}
        >
          <input
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder="Research note"
          />
          <button type="submit">Save</button>
        </form>
      )}
      <footer>
        <span>{capture.chunkCount} chunks</span>
        <time>{formatDate(capture.capturedAt)}</time>
        {onAskCapture && (
          <button onClick={() => onAskCapture(capture)} type="button">
            Ask
          </button>
        )}
      </footer>
    </article>
  )
}
