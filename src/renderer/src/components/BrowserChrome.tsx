import { CSSProperties, DragEvent, MouseEvent, useEffect, useState } from 'react'
import { BrowserTabSummary, CaptureResult, CollectionSummary } from '../../../shared/aether'
import { QuickAction } from '../types/ui'
import { countLabel, getTabTint } from '../utils/aether-ui'
import { useSiteFavicon } from '../utils/site-favicon'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  GlobeIcon,
  IncognitoIcon,
  PlusIcon,
  SpinnerIcon,
} from './icons'

const CREATE_COLLECTION_VALUE = '__create_collection__'

// Fixed set on purpose. Container tabs are worth having for the isolation; a
// rename/create/delete surface for them is a settings feature in its own right,
// and these four cover the cases people actually separate.
const TAB_CONTAINERS = ['Personal', 'Work', 'Shopping', 'Banking'] as const
const DASHBOARD_ADDRESSES = new Set([
  'æther://dashboard',
  'ice://crystallizer',
  'flow://semantic-graph',
  'air://renderer',
])

type BrowserChromeProps = {
  activeTab?: BrowserTabSummary
  // What the address bar shows when it is not being edited. The text the user
  // is typing lives in this component, not in App: it changes on every keystroke,
  // and holding it up there made each one re-render the whole application.
  displayAddress: string
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
  onBack: () => Promise<void>
  onCloseAllTabs: () => Promise<void>
  onCloseOtherTabs: (tabId: string) => Promise<void>
  onCloseTab: (tabId: string) => Promise<void>
  onCreateTab: () => void
  onCreatePrivateTab: () => void
  onCreateContainerTab: (url: string, container: string) => void
  onCapture: () => Promise<void>
  onCaptureSelection: () => Promise<void>
  onCaptureIntent?: () => void | Promise<void>
  onCaptureSelectBlur?: () => void
  onCreateCollection: () => void
  onForward: () => Promise<void>
  // Takes the typed string rather than the submit event, because App no longer
  // holds the draft and has nothing to read it from.
  onNavigate: (target: string) => Promise<void>
  onQuickAction: (action: QuickAction) => Promise<void>
  onReorderTabs: (ids: string[]) => Promise<void>
  onSavePortal: () => Promise<void>
  onSelectTab: (tabId: string) => Promise<void>
  onSelectCollection: (value: string) => Promise<void>
  onTabMenuClose: () => void
  onTabMenuOpen: () => void
}

export function BrowserChrome({
  activeTab,
  displayAddress,
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
  onBack,
  onCloseAllTabs,
  onCloseOtherTabs,
  onCloseTab,
  onCreateTab,
  onCreatePrivateTab,
  onCreateContainerTab,
  onCapture,
  onCaptureSelection,
  onCaptureIntent,
  onCaptureSelectBlur,
  onCreateCollection,
  onForward,
  onNavigate,
  onQuickAction,
  onReorderTabs,
  onSavePortal,
  onSelectTab,
  onSelectCollection,
  onTabMenuClose,
  onTabMenuOpen,
}: BrowserChromeProps): React.JSX.Element {
  const startPageActive = activeTab?.url === 'aether://start'

  // The typed text, and whether the user is typing. Local because a keystroke
  // should repaint the address bar and nothing else; when this lived in App every
  // character re-rendered the dashboard, the intelligence panel and the rest.
  //
  // `draft` is only meaningful while focused — the moment focus leaves, the bar
  // goes back to showing `displayAddress`, which App derives from the active tab
  // and the current workspace.
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const addressValue = focused ? draft : displayAddress

  const trimmedAddress = addressValue.trim().toLowerCase()
  const dashboardAddress = dashboardOpen && DASHBOARD_ADDRESSES.has(trimmedAddress)
  const addressSubmittable = Boolean(activeTab && trimmedAddress && !dashboardAddress)
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null)
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
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    })
  }

  async function runTabMenuAction(action: () => Promise<void>): Promise<void> {
    setTabMenu(null)
    onTabMenuClose()
    await action()
  }

  function isTabReorderDrag(event: DragEvent<HTMLButtonElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('application/x-aether-tab-reorder')
  }

  function reorderTabIds(sourceId: string, targetId: string, insertAfter: boolean): string[] {
    if (sourceId === targetId) return tabs.map((tab) => tab.id)
    const source = tabs.find((tab) => tab.id === sourceId)
    const remaining = tabs.filter((tab) => tab.id !== sourceId)
    const targetIndex = remaining.findIndex((tab) => tab.id === targetId)
    if (!source || targetIndex < 0) return tabs.map((tab) => tab.id)

    remaining.splice(targetIndex + (insertAfter ? 1 : 0), 0, source)
    return remaining.map((tab) => tab.id)
  }

  return (
    <div className={`browser-chrome ${dashboardOpen ? 'dashboard-open' : ''}`}>
      <form
        className="address-bar"
        onSubmit={(event) => {
          event.preventDefault()
          void onNavigate(addressValue)
        }}
      >
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
          disabled={!activeTab}
          value={addressValue}
          onBlur={() => setFocused(false)}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => {
            // Focusing on the dashboard starts empty rather than seeding the
            // pseudo-address (aether://dashboard and friends), which is a label
            // rather than something worth editing or navigating to.
            setDraft(dashboardOpen ? '' : displayAddress)
            setFocused(true)
            // After the state lands, so the selection applies to the seeded text
            // rather than to whatever was in the field a moment earlier.
            window.setTimeout(() => addressInputRef.current?.select(), 0)
          }}
          placeholder="Search or enter website"
        />
        <button
          type="submit"
          disabled={!addressSubmittable}
          // Without this, pressing the button blurs the input first: `focused`
          // flips false, the bar reverts to `displayAddress`, and the submit that
          // follows navigates to the current page instead of what was typed.
          // Keeping focus through the press means submit sees the draft.
          onMouseDown={(event) => event.preventDefault()}
        >
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
            } ${tab.isPrivate ? 'private' : ''} ${tab.container ? 'contained' : ''}`}
            key={tab.id}
            draggable={Boolean(tab.url)}
            onDragStart={(event) => {
              if (!tab.url) return
              event.dataTransfer.effectAllowed = 'copyMove'
              event.dataTransfer.setData('application/x-aether-tab-reorder', tab.id)
              // Dragging a tab onto a Knowledge Hub on the dashboard captures it.
              event.dataTransfer.setData('application/x-aether-tab', tab.url)
              event.dataTransfer.setData('text/uri-list', tab.url)
              event.dataTransfer.setData('text/plain', tab.url)
              setDraggedTabId(tab.id)
            }}
            onDragEnd={() => {
              setDraggedTabId(null)
              setTabDropTarget(null)
            }}
            onDragOver={(event) => {
              if (!isTabReorderDrag(event)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              if (draggedTabId !== tab.id) setTabDropTarget(tab.id)
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setTabDropTarget(null)
            }}
            onDrop={(event) => {
              if (!isTabReorderDrag(event)) return
              event.preventDefault()
              event.stopPropagation()
              const sourceId = event.dataTransfer.getData('application/x-aether-tab-reorder')
              const midpoint =
                event.currentTarget.getBoundingClientRect().left +
                event.currentTarget.offsetWidth / 2
              const ids = reorderTabIds(sourceId, tab.id, event.clientX > midpoint)
              setDraggedTabId(null)
              setTabDropTarget(null)
              if (sourceId && sourceId !== tab.id) void onReorderTabs(ids)
            }}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(event) => openTabMenu(event, tab.id)}
            style={getTabStyle(tab)}
            data-tab-dragging={draggedTabId === tab.id || undefined}
            data-tab-drop-target={tabDropTarget === tab.id || undefined}
            title={tab.title}
            type="button"
          >
            <span className="tab-status" aria-hidden="true">
              {tab.isLoading ? (
                <SpinnerIcon />
              ) : tab.isPrivate ? (
                // The favicon would say which site; the point of the marker is
                // that the tab reads as private at a glance instead.
                <IncognitoIcon />
              ) : (
                <PageFavicon key={`${tab.id}-${tab.favicon ?? ''}`} icon={tab.favicon} />
              )}
            </span>
            <span className="tab-title">
              {tab.container && (
                <span className="tab-container-badge" title={`${tab.container} container`}>
                  {tab.container.charAt(0)}
                </span>
              )}
              {tab.title || tab.host || 'New Tab'}
            </span>
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
          <span className="tab-count" title={countLabel(tabs.length, 'open tab')}>
            {tabs.length}
          </span>
        )}
        <button className="new-tab-button" onClick={onCreateTab} title="New Tab" type="button">
          <PlusIcon />
        </button>
        <button
          className="new-tab-button new-private-tab-button"
          onClick={onCreatePrivateTab}
          title="New Private Tab — not saved to your session, and not capturable"
          aria-label="New private tab"
          type="button"
        >
          <IncognitoIcon />
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
          <div className="tab-context-menu-title">{menuTab.title || menuTab.host || 'New Tab'}</div>
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
            Close Others
          </button>
          <button type="button" role="menuitem" onClick={() => runTabMenuAction(onCloseAllTabs)}>
            Close All
          </button>
          <div className="tab-context-menu-separator" role="separator" />
          {/* Presets rather than a container manager: naming and editing
              containers is a whole settings surface, and the value is in the
              isolation, not in the bookkeeping. */}
          <div className="tab-context-menu-title">Open this page in</div>
          {TAB_CONTAINERS.map((container) => (
            <button
              key={container}
              type="button"
              role="menuitem"
              disabled={menuTab.container === container || menuTab.isPrivate}
              title={`Isolated cookies and site storage, kept between restarts`}
              onClick={() =>
                runTabMenuAction(async () => {
                  onCreateContainerTab(menuTab.url, container)
                })
              }
            >
              {container}
              {menuTab.container === container ? ' (current)' : ''}
            </button>
          ))}
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
              aria-label="Capture hub"
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
              onClick={onCaptureSelection}
              title="Capture the passage currently selected on the page"
              type="button"
            >
              Selection
            </button>
            <button
              className="capture-page-button"
              disabled={Boolean(busy) || capturesBlocked}
              onClick={onCapture}
              title={lastCapture ? `Last saved to ${lastCapture.collectionName}` : 'Capture page'}
              type="button"
            >
              Page
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function getTabStyle(tab: BrowserTabSummary): CSSProperties {
  return {
    '--tab-tint': getTabTint(tab.host, tab.themeColor),
  } as CSSProperties
}

function PageFavicon({ icon }: { icon?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  // `icon` is the site's favicon URL, used only as a lookup key; the src below is
  // always a data: URI produced in Rust. See utils/site-favicon.ts.
  const dataUri = useSiteFavicon(icon)

  if (!dataUri || failed) return <GlobeIcon />

  return (
    <img
      src={dataUri}
      alt=""
      onError={() => {
        setFailed(true)
      }}
    />
  )
}
