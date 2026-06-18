import { CSSProperties, FormEvent, MouseEvent, useEffect, useState } from 'react'
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

const CREATE_COLLECTION_VALUE = '__create_collection__'

type BrowserChromeProps = {
  activeTab?: BrowserTabSummary
  addressDraft: string
  addressInputRef: React.RefObject<HTMLInputElement | null>
  busy: string | null
  capturesBlocked: boolean
  collections: CollectionSummary[]
  dashboardOpen: boolean
  dashboardSubtitle?: string
  dashboardTitle?: string
  lastCapture: CaptureResult | null
  portalSaveBlocked: boolean
  portalSaveTitle: string
  quickActions: QuickAction[]
  selectedCollection?: CollectionSummary
  selectedCollectionId: string
  tabs: BrowserTabSummary[]
  onAddressBlur: () => void
  onAddressChange: (value: string) => void
  onAddressFocus: () => void
  onBack: () => Promise<void>
  onCloseAllTabs: () => Promise<void>
  onCloseOtherTabs: (tabId: string) => Promise<void>
  onCloseTab: (tabId: string) => Promise<void>
  onCreateTab: () => void
  onCapture: () => Promise<void>
  onCaptureIntent?: () => void | Promise<void>
  onCaptureSelectBlur?: () => void
  onCreateCollection: () => void
  onForward: () => Promise<void>
  onNavigate: (event: FormEvent<HTMLFormElement>) => Promise<void>
  onQuickAction: (action: QuickAction) => Promise<void>
  onSavePortal: () => Promise<void>
  onSelectTab: (tabId: string) => Promise<void>
  onSelectCollection: (value: string) => Promise<void>
  onTabMenuClose: () => void
  onTabMenuOpen: () => void
}

export function BrowserChrome({
  activeTab,
  addressDraft,
  addressInputRef,
  busy,
  capturesBlocked,
  collections,
  dashboardOpen,
  dashboardSubtitle = 'Knowledge Hub',
  dashboardTitle = 'ÆTHER',
  lastCapture,
  portalSaveBlocked,
  portalSaveTitle,
  quickActions,
  /* selectedCollection, */
  selectedCollectionId,
  tabs,
  onAddressBlur,
  onAddressChange,
  onAddressFocus,
  onBack,
  onCloseAllTabs,
  onCloseOtherTabs,
  onCloseTab,
  onCreateTab,
  onCapture,
  onCaptureIntent,
  onCaptureSelectBlur,
  onCreateCollection,
  onForward,
  onNavigate,
  onQuickAction,
  onSavePortal,
  onSelectTab,
  onSelectCollection,
  onTabMenuClose,
  onTabMenuOpen
}: BrowserChromeProps): React.JSX.Element {
  const startPageActive = activeTab?.url === 'aether://start'
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) : undefined

  useEffect(() => {
    if (!tabMenu) return

    function closeMenu(): void {
      setTabMenu(null)
      onTabMenuClose()
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onTabMenuClose, tabMenu])

  function openTabMenu(event: MouseEvent<HTMLButtonElement>, tabId: string): void {
    event.preventDefault()
    event.stopPropagation()

    const width = 172
    const height = 132
    onTabMenuOpen()
    setTabMenu({
      tabId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))
    })
  }

  async function runTabMenuAction(action: () => Promise<void>): Promise<void> {
    setTabMenu(null)
    onTabMenuClose()
    await action()
  }

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
          <span>{dashboardOpen ? dashboardTitle : activeTab?.title || 'Browser'}</span>
          <small>
            {dashboardOpen
              ? dashboardSubtitle
              : activeTab?.isLoading
                ? 'Loading'
                : startPageActive
                  ? 'Discover'
                  : activeTab?.host}
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

      <div
        className={`tab-strip ${tabs.length >= 12 ? 'many-tabs' : ''} ${
          tabs.length >= 24 ? 'overflow-tabs' : ''
        }`}
        aria-label="Browser tabs"
      >
        {tabs.map((tab) => (
          <button
            className={`tab-chip ${tabs.length > 1 ? 'closable' : 'frozen-tab'} ${
              tab.isActive && !dashboardOpen ? 'active' : ''
            }`}
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(event) => openTabMenu(event, tab.id)}
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
        {tabs.length >= 12 && (
          <span className="tab-count" title={`${tabs.length} open tabs`}>
            {tabs.length}
          </span>
        )}
        <button className="new-tab-button" onClick={onCreateTab} title="New tab" type="button">
          <PlusIcon />
        </button>
      </div>
      {tabMenu && menuTab && (
        <div
          className="tab-context-menu"
          role="menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="tab-context-menu-title">{menuTab.title || menuTab.host || 'New tab'}</div>
          <button
            type="button"
            role="menuitem"
            disabled={tabs.length <= 1}
            onClick={() => runTabMenuAction(() => onCloseTab(menuTab.id))}
          >
            Close tab
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={tabs.length <= 1}
            onClick={() => runTabMenuAction(() => onCloseOtherTabs(menuTab.id))}
          >
            Close others
          </button>
          <button type="button" role="menuitem" onClick={() => runTabMenuAction(onCloseAllTabs)}>
            Close all
          </button>
        </div>
      )}
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
          <div
            className="browser-capture-dock"
            style={{ borderRight: '1px solid rgba(133, 158, 193, 0.18)', paddingRight: '10px' }}
          >
            <button
              className="save-page-button browser-save-page-button"
              disabled={Boolean(busy) || portalSaveBlocked}
              onClick={onSavePortal}
              title={portalSaveTitle}
              type="button"
            >
              Save as Portal
            </button>
          </div>
          <div
            className="browser-capture-dock"
            onMouseEnter={() => {
              void onCaptureIntent?.()
            }}
          >
            <select
              id="capture-collection-select"
              aria-label="Capture collection"
              value={selectedCollectionId}
              onFocus={() => {
                void onCaptureIntent?.()
              }}
              onBlur={() => onCaptureSelectBlur?.()}
              onChange={(event) => {
                if (event.target.value === CREATE_COLLECTION_VALUE) {
                  onCreateCollection()
                  return
                }
                onSelectCollection(event.target.value)
              }}
            >
              <option value="" disabled>
                Collection
              </option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
              <option value={CREATE_COLLECTION_VALUE}>+ Create/Add New</option>
            </select>
            <button
              className="capture-page-button"
              disabled={Boolean(busy) || capturesBlocked}
              onClick={onCapture}
              title={lastCapture ? `Last saved to ${lastCapture.collectionName}` : 'Capture page'}
              type="button"
            >
              Capture
            </button>
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
