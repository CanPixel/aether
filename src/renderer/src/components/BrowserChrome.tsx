import { CSSProperties, FormEvent, useState } from 'react'
import { BrowserTabSummary, CaptureResult, CollectionSummary } from '../../../shared/aether'
import { QuickAction } from '../types/ui'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  GlobeIcon,
  PlusIcon,
  SpinnerIcon
} from './icons'

type BrowserChromeProps = {
  activeTab?: BrowserTabSummary
  addressDraft: string
  addressInputRef: React.RefObject<HTMLInputElement | null>
  busy: string | null
  capturesBlocked: boolean
  collections: CollectionSummary[]
  dashboardOpen: boolean
  lastCapture: CaptureResult | null
  quickActions: QuickAction[]
  selectedCollection?: CollectionSummary
  selectedCollectionId: string
  tabs: BrowserTabSummary[]
  onAddressBlur: () => void
  onAddressChange: (value: string) => void
  onAddressFocus: () => void
  onBack: () => Promise<void>
  onCloseTab: (tabId: string) => Promise<void>
  onCreateTab: () => void
  onCapture: () => Promise<void>
  onCreateCollection: () => void
  onForward: () => Promise<void>
  onNavigate: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onQuickAction: (action: QuickAction) => Promise<void>
  onSelectTab: (tabId: string) => Promise<void>
  onSelectCollection: (value: string) => Promise<void>
}

export function BrowserChrome({
  activeTab,
  addressDraft,
  addressInputRef,
  busy,
  capturesBlocked,
  collections,
  dashboardOpen,
  lastCapture,
  quickActions,
  /* selectedCollection, */
  selectedCollectionId,
  tabs,
  onAddressBlur,
  onAddressChange,
  onAddressFocus,
  onBack,
  onCloseTab,
  onCreateTab,
  onCapture,
  /* onCreateCollection, */
  onForward,
  onNavigate,
  onQuickAction,
  onSelectTab,
  onSelectCollection
}: BrowserChromeProps): React.JSX.Element {
  return (
    <div className={`browser-chrome ${dashboardOpen ? 'dashboard-open' : ''}`}>
      <form className="address-bar" onSubmit={onNavigate}>
        <div className="history-controls" aria-label="Browser history controls">
          <button
            aria-label="Go back"
            disabled={dashboardOpen || !activeTab?.canGoBack}
            onClick={onBack}
            title="Back"
            type="button"
          >
            <ChevronLeftIcon />
          </button>
          <button
            aria-label="Go forward"
            disabled={dashboardOpen || !activeTab?.canGoForward}
            onClick={onForward}
            title="Forward"
            type="button"
          >
            <ChevronRightIcon />
          </button>
        </div>
        <div className="active-app">
          <span>{dashboardOpen ? 'ÆTHER' : activeTab?.title || 'Browser'}</span>
          <small>
            {dashboardOpen ? 'Knowledge Hub' : activeTab?.isLoading ? 'Loading' : activeTab?.host}
          </small>
        </div>
        <input
          ref={addressInputRef}
          aria-label="Address or search"
          disabled={dashboardOpen || !activeTab}
          value={addressDraft}
          onBlur={onAddressBlur}
          onChange={(event) => onAddressChange(event.target.value)}
          onFocus={onAddressFocus}
          placeholder="Search or enter website"
        />
        <button type="submit" disabled={dashboardOpen || !activeTab || !addressDraft.trim()}>
          Go
        </button>
      </form>

      <div className="tab-strip" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <button
            className={`tab-chip ${tabs.length > 1 ? 'closable' : ''} ${
              tab.isActive && !dashboardOpen ? 'active' : ''
            }`}
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            style={getTabStyle(tab)}
            title={tab.title}
            type="button"
          >
            <span className="tab-status" aria-hidden="true">
              {tab.isLoading ? (
                <SpinnerIcon />
              ) : (
                <PageFavicon key={`${tab.id}-${tab.favicon ?? ''}`} icon={tab.favicon} />
              )}
            </span>
            <span className="tab-title">{tab.title || tab.host || 'New tab'}</span>
            {tabs.length > 1 && (
              <span
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseTab(tab.id)
                }}
                role="button"
                tabIndex={0}
                title="Close tab"
              >
                <CloseIcon />
              </span>
            )}
          </button>
        ))}
        <button className="new-tab-button" onClick={onCreateTab} title="New tab" type="button">
          <PlusIcon />
        </button>
      </div>
      {!dashboardOpen && (
        <div className="quick-action-row" aria-label="AI quick actions">
          {quickActions.map((action) => (
            <button
              className="quick-action-chip"
              key={action.id}
              onClick={() => onQuickAction(action)}
              type="button"
            >
              {action.label}
            </button>
          ))}
          <div className="browser-capture-dock">
            <select
              aria-label="Capture collection"
              value={selectedCollectionId}
              onChange={(event) => onSelectCollection(event.target.value)}
            >
              <option value="" disabled>
                Collection
              </option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
            {/* <button type="button" onClick={onCreateCollection}>
            New
          </button> */}
            <button
              className="capture-page-button"
              disabled={Boolean(busy) || capturesBlocked}
              onClick={onCapture}
              title={lastCapture ? `Last saved to ${lastCapture.collectionName}` : 'Capture page'}
              type="button"
            >
              Capture
            </button>
            {/* <span>{selectedCollection?.name ?? 'No hub'}</span> */}
          </div>
        </div>
      )}
    </div>
  )
}

function getTabStyle(tab: BrowserTabSummary): CSSProperties {
  return {
    '--tab-tint': getBrandTint(tab.host) || tab.themeColor || getHostTint(tab.host)
  } as CSSProperties
}

function PageFavicon({ icon }: { icon?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)

  if (!icon || failed) return <GlobeIcon />

  return (
    <img
      src={icon}
      alt=""
      onError={() => {
        setFailed(true)
      }}
    />
  )
}

function getBrandTint(host: string): string {
  const normalized = host.replace(/^www\./, '')

  if (normalized === 'reddit.com' || normalized.endsWith('.reddit.com')) return '#ff4500'
  if (
    normalized === 'youtube.com' ||
    normalized === 'youtu.be' ||
    normalized.endsWith('.youtube.com')
  ) {
    return '#ff0033'
  }
  if (normalized === 'google.com' || normalized.endsWith('.google.com')) return '#4285f4'
  if (normalized === 'github.com' || normalized.endsWith('.github.com')) return '#6e7681'
  if (normalized === 'x.com' || normalized === 'twitter.com') return '#111827'

  return ''
}

function getHostTint(host: string): string {
  const palette = ['#4f8fd6', '#3aaea1', '#c07f43', '#7772d6', '#4e9a62', '#b95f79', '#547aa5']
  const key = host || 'aether'
  let hash = 0

  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }

  return palette[hash % palette.length]
}
