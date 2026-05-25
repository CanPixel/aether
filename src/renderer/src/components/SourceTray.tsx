export type ContextSource = {
  id: string | number
  included: boolean
  type: 'active-page' | string // 'active-page' has special logic in your code
  title: string
  url?: string
  host?: string
}

type SourceTrayProps = {
  sources: ContextSource[]
  onOpenSource: (source: ContextSource) => Promise<void>
  onToggleSource: (source: ContextSource) => Promise<void>
}

export function SourceTray({
  sources,
  onOpenSource,
  onToggleSource
}: SourceTrayProps): React.JSX.Element {
  const includedCount = sources.filter((source) => source.included).length

  return (
    <section className="source-tray">
      <header>
        <span>Sources</span>
        <strong>{includedCount} active</strong>
      </header>
      <div className="source-list">
        {sources.length === 0 ? (
          <div className="empty-row">Open a page to add live sources.</div>
        ) : (
          sources.slice(0, 10).map((source) => (
            <article className={`source-chip ${source.included ? 'included' : ''}`} key={source.id}>
              <button
                className="source-main"
                onClick={() => onOpenSource(source)}
                title={source.url}
                type="button"
              >
                <span>{source.type === 'active-page' ? 'Live' : source.type}</span>
                <strong>{source.title}</strong>
                <small>{source.host}</small>
              </button>
              <button
                className="source-toggle"
                disabled={source.type === 'active-page'}
                onClick={() => onToggleSource(source)}
                type="button"
              >
                {source.included ? 'On' : 'Add'}
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  )
}
