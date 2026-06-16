import { CSSProperties, FormEvent, useState } from 'react'
import { HubShortcutSummary } from '../../../shared/aether'
import { cleanTitle, getPortalTint, getRootDomainLetter } from '../utils/aether-ui'

// The Æther start page replaces a blank new tab's default search-engine landing.
// It keeps Portals one click away from the web view (where they belong) and offers a
// search box that hands the query straight to the active tab's navigation.
export function StartPage({
  shortcuts,
  onNavigate
}: {
  shortcuts: HubShortcutSummary[]
  onNavigate: (input: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const aetherMarkSrc = new URL('aether-mark.svg', window.location.href).toString()
  const wavyLinesSrc = new URL('wavy-lines.svg', window.location.href).toString()

  function submitSearch(event: FormEvent): void {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return
    onNavigate(trimmed)
    setQuery('')
  }

  return (
    <div className="start-page">
      <div className="start-page-hero-copy">
        <h1>DiSCOVER</h1>
      </div>
      <div className="start-page-inner">
        <img
          className="wavy-lines-start-page"
          src={wavyLinesSrc}
          alt="Wavy lines"
          draggable={false}
        />
        <div className="start-mark" aria-hidden="true">
          <div className="start-orb">
            <span className="start-orb-aura" />
            <img src={aetherMarkSrc} alt="" draggable={false} />
          </div>
        </div>
        <form className="start-search" onSubmit={submitSearch}>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the web or enter a URL"
            aria-label="Search the web or enter a URL"
            type="text"
          />
          <button className="" type="submit">
            Go
          </button>
        </form>
        {shortcuts.length === 0 ? (
          <p className="start-empty">
            Explore the web, then save pages as Portals to launch them from here.
          </p>
        ) : (
          <div className="start-portals">
            {shortcuts.map((shortcut) => (
              <button
                className="start-portal"
                key={shortcut.id}
                onClick={() => onNavigate(shortcut.url)}
                title={shortcut.url}
                type="button"
                style={
                  {
                    '--portal-tint': getPortalTint(shortcut.host, shortcut.themeColor)
                  } as CSSProperties
                }
              >
                <span>{getRootDomainLetter(shortcut.host)}</span>
                <strong>{cleanTitle(shortcut.title)}</strong>
                <small>{shortcut.host}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
