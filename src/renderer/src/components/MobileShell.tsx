import { FormEvent, MutableRefObject, ReactNode, useEffect, useRef, useState } from 'react'
import {
  BrowserTabSummary,
  ChatResult,
  CollectionSummary,
  MOBILE_TAB_SCROLL_EVENT,
  NativeTabEvent,
  SearchResult
} from '../../../shared/aether'
import { QuickAction } from '../types/ui'
import { countLabel, formatVisibleModelName, getTabTint } from '../utils/aether-ui'
import { useSiteFavicon } from '../utils/site-favicon'
import { renderAnswerMarkdown } from './answer-markdown'
import { buildEvidenceBundle } from '../utils/evidence-bundle'
import {
  AetherSigilIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  GearIcon,
  GlobeIcon,
  GridIcon,
  PlusIcon,
  SpinnerIcon
} from './icons'
import {
  ArrowUpRight,
  BookmarkPlus,
  Copy,
  Download,
  RefreshCw,
  Search,
  Snowflake,
  TextSelect,
  X
} from 'lucide-react'

// ÆTHER's dedicated Android shell: Samsung-style bottom chrome (mini tab strip
// + compact address row) that auto-hides on page scroll, an Opera-style
// 2-column card-grid tab switcher fed by native WebView thumbnails, and bottom
// sheets for browser actions (capture into hubs, portals, find) and AiON.
// App.tsx keeps owning every piece of state; this component is presentation
// plus the small amount of overlay/auto-hide state that only exists on mobile.

const CREATE_COLLECTION_VALUE = '__create_collection__'

// Fold-7-inner / tablet threshold: the cover screen is ~410 CSS px wide, the
// unfolded inner display ~840, so anything past 700 is "unfolded" territory.
const WIDE_SCREEN_QUERY = '(min-width: 700px)'

type MobileAskProps = {
  askCollectionId: string
  askCurrentPageOnly: boolean
  askPhase: string | null
  canUseCurrentPage: boolean
  chatBlocked: boolean
  chatPrompt: string
  chatResult: ChatResult | null
  currentPageTitle: string
  streamingAnswer: string
  streamingCitations: SearchResult[]
  usableCollections: CollectionSummary[]
  onAskCollectionChange: (collectionId: string) => void
  onAskCurrentPageOnlyChange: (value: boolean) => void
  onAskPrompt: (prompt: string) => Promise<void>
  onCancel: () => void
  onChatPromptChange: (value: string) => void
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
  onOpenModelSetup: () => Promise<void>
}

type MobileShellProps = {
  activeTab?: BrowserTabSummary
  addressValue: string
  appModalOpen: boolean
  ask: MobileAskProps
  backInterceptorRef: MutableRefObject<(() => boolean) | null>
  openAionRef: MutableRefObject<(() => void) | null>
  busy: string | null
  capturesBlocked: boolean
  children: ReactNode
  collections: CollectionSummary[]
  crystallizerOpen: boolean
  dashboardOpen: boolean
  findBar: ReactNode
  isWebPage: boolean
  portalSaveBlocked: boolean
  portalSaveTitle: string
  quickActions: QuickAction[]
  selectedCollectionId: string
  tabs: BrowserTabSummary[]
  onCapture: () => Promise<void>
  onCaptureSelection: () => Promise<void>
  onCaptureIntent: () => Promise<void>
  onCloseTab: (tabId: string) => Promise<void>
  onCreateCollection: () => void
  onCreateTab: () => void
  onGoForward: () => Promise<void>
  onNavigateAddress: (value: string) => Promise<void>
  onOpenCrystallizer: () => Promise<void>
  onOpenDashboard: () => Promise<void>
  onOpenFind: () => void
  onOpenSettings: () => Promise<void>
  onSavePortal: () => Promise<void>
  onSelectCollection: (collectionId: string) => Promise<void>
  onSelectTab: (tabId: string) => Promise<void>
}

export function MobileShell({
  activeTab,
  addressValue,
  appModalOpen,
  ask,
  backInterceptorRef,
  openAionRef,
  busy,
  capturesBlocked,
  children,
  collections,
  crystallizerOpen,
  dashboardOpen,
  findBar,
  isWebPage,
  portalSaveBlocked,
  portalSaveTitle,
  quickActions,
  selectedCollectionId,
  tabs,
  onCapture,
  onCaptureSelection,
  onCaptureIntent,
  onCloseTab,
  onCreateCollection,
  onCreateTab,
  onGoForward,
  onNavigateAddress,
  onOpenCrystallizer,
  onOpenDashboard,
  onOpenFind,
  onOpenSettings,
  onSavePortal,
  onSelectCollection,
  onSelectTab
}: MobileShellProps): React.JSX.Element {
  const [chromeHidden, setChromeHidden] = useState(false)
  const [gridOpen, setGridOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [aionOpen, setAionOpen] = useState(false)
  const [addressEditing, setAddressEditing] = useState(false)
  const [addressDraft, setAddressDraft] = useState('')
  const [evidenceCopied, setEvidenceCopied] = useState(false)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  // Unfolded / tablet-width screens (Z Fold inner display): AiON docks as a
  // persistent right-hand panel beside the page instead of a bottom sheet.
  const [wideScreen, setWideScreen] = useState(() => window.matchMedia(WIDE_SCREEN_QUERY).matches)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const chromeRef = useRef<HTMLDivElement | null>(null)
  const activeTabId = activeTab?.id ?? ''
  const aionDocked = aionOpen && wideScreen
  // A docked AiON is not an overlay: the page stays visible (and interactive)
  // beside it, so the native WebView must not be hidden.
  const overlayOpen = gridOpen || actionsOpen || (aionOpen && !wideScreen)

  useEffect(() => {
    const media = window.matchMedia(WIDE_SCREEN_QUERY)
    const onChange = (): void => setWideScreen(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // Edge-to-edge insets: pull once at startup in case the Kotlin inset
  // listener fired before this document loaded; both write the same CSS vars.
  useEffect(() => {
    void window.aether.layout
      .windowInsets()
      .then((insets) => {
        const style = document.documentElement.style
        style.setProperty('--aether-inset-top', `${insets.top}px`)
        style.setProperty('--aether-inset-bottom', `${insets.bottom}px`)
        style.setProperty('--aether-inset-left', `${insets.left}px`)
        style.setProperty('--aether-inset-right', `${insets.right}px`)
      })
      .catch(() => undefined)
  }, [])

  // Publish the chrome's live height as a CSS variable so fixed overlays (the
  // status toast) can sit right above it. The observer fires every frame of
  // the hide/show animation, so followers track the moving edge.
  useEffect(() => {
    const chrome = chromeRef.current
    if (!chrome) return
    const style = document.documentElement.style
    const report = (): void => {
      style.setProperty('--mobile-chrome-height', `${chrome.getBoundingClientRect().height}px`)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(chrome)
    return () => {
      observer.disconnect()
      style.removeProperty('--mobile-chrome-height')
    }
  }, [])

  // Auto-hide: page scroll events stream in from the native WebView. Hide on
  // scroll-down past the top region, reveal on any scroll-up or near-top.
  useEffect(() => {
    if (!isWebPage) return
    const onScroll = (event: Event): void => {
      const detail = (event as CustomEvent<NativeTabEvent>).detail
      if (!detail || detail.tabId !== activeTabId) return
      const delta = detail.deltaY ?? 0
      const scrollY = detail.scrollY ?? 0
      if (scrollY < 120 || delta < 0) {
        setChromeHidden(false)
      } else if (delta > 0) {
        setChromeHidden(true)
      }
    }
    window.addEventListener(MOBILE_TAB_SCROLL_EVENT, onScroll)
    return () => window.removeEventListener(MOBILE_TAB_SCROLL_EVENT, onScroll)
  }, [activeTabId, isWebPage])

  // Reveal the chrome whenever the context under it changes (tab switch,
  // leaving a web page, an overlay opening). Applied during render — React's
  // "adjust state when props change" pattern — instead of an effect.
  const revealSignature = `${activeTabId}|${dashboardOpen}|${isWebPage}|${overlayOpen}|${aionDocked}`
  const [appliedReveal, setAppliedReveal] = useState(revealSignature)
  if (appliedReveal !== revealSignature) {
    setAppliedReveal(revealSignature)
    if (chromeHidden) setChromeHidden(false)
  }

  // The native tab WebViews draw above the app DOM, so every full-screen
  // overlay must hide them through the shared modal-overlay flag. Includes the
  // App-owned modals so closing a sheet into a dialog never re-shows the page.
  useEffect(() => {
    void window.aether.layout
      .setModalOverlayOpen(overlayOpen || appModalOpen)
      .catch(() => undefined)
  }, [overlayOpen, appModalOpen])

  // Hardware back peels mobile overlays before App's own layering logic runs.
  useEffect(() => {
    backInterceptorRef.current = () => {
      if (aionOpen) {
        setAionOpen(false)
        return true
      }
      if (actionsOpen) {
        setActionsOpen(false)
        return true
      }
      if (gridOpen) {
        setGridOpen(false)
        return true
      }
      return false
    }
    return () => {
      backInterceptorRef.current = null
    }
  })

  // App-level triggers (the dashboard hub "Ask" buttons) open the AiON sheet
  // through this ref, since the sheet state lives here rather than in App.
  useEffect(() => {
    openAionRef.current = () => setAionOpen(true)
    return () => {
      openAionRef.current = null
    }
  }, [openAionRef])

  // Tab-grid previews. Delayed slightly so the overlay's visibility sync (which
  // makes Kotlin cache a fresh bitmap of the active tab) lands first.
  useEffect(() => {
    if (!gridOpen) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      for (const tab of tabs) {
        void window.aether.tabs
          .thumbnail(tab.id)
          .then((image) => {
            if (!cancelled && image) {
              setThumbnails((current) => ({ ...current, [tab.id]: image }))
            }
          })
          .catch(() => undefined)
      }
    }, 140)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [gridOpen, tabs])

  function beginAddressEdit(): void {
    setAddressDraft(isWebPage ? addressValue : '')
    setAddressEditing(true)
    setChromeHidden(false)
    window.setTimeout(() => {
      addressRef.current?.focus()
      addressRef.current?.select()
    }, 0)
  }

  async function submitAddress(event: FormEvent): Promise<void> {
    event.preventDefault()
    const target = addressDraft.trim()
    setAddressEditing(false)
    addressRef.current?.blur()
    if (!target) return
    await onNavigateAddress(target)
  }

  async function selectGridTab(tabId: string): Promise<void> {
    setGridOpen(false)
    await onSelectTab(tabId)
  }

  async function runQuickAction(action: QuickAction): Promise<void> {
    if (action.capture) {
      setAionOpen(false)
      await onCapture()
      return
    }
    if (!action.prompt) return
    ask.onChatPromptChange(action.prompt)
    await ask.onAskPrompt(action.prompt)
  }

  async function submitAsk(event: FormEvent): Promise<void> {
    event.preventDefault()
    const prompt = ask.chatPrompt.trim()
    if (!prompt) return
    await ask.onAskPrompt(prompt)
  }

  const asking = busy === 'Asking ÆTHER' || Boolean(ask.askPhase)
  const answerText = asking && ask.streamingAnswer ? ask.streamingAnswer : ask.chatResult?.answer
  const citations = asking ? ask.streamingCitations : (ask.chatResult?.citations ?? [])

  // Inline [n] markers and source cards share this: on the cover screen the
  // sheet gets out of the way of the page it just opened; docked AiON stays.
  function openCitation(citation: SearchResult, claimText?: string): Promise<void> {
    if (!wideScreen) setAionOpen(false)
    return ask.onOpenCitation(citation, claimText)
  }

  // Shared between the bottom sheet (narrow) and the docked panel (unfolded).
  const aionContent = (
    <>
      <header className="mobile-aion-header">
        <AetherSigilIcon size={22} />
        <strong>AiON</strong>
        <button aria-label="Close AiON" onClick={() => setAionOpen(false)} type="button">
          <X />
        </button>
      </header>

      {ask.chatBlocked ? (
        <div className="mobile-aion-setup">
          <p>
            AiON answers locally on this device. Install the local AI models to ask about your pages
            and knowledge hubs.
          </p>
          <button
            onClick={() => {
              setAionOpen(false)
              void ask.onOpenModelSetup()
            }}
            type="button"
          >
            Install Local Models
          </button>
        </div>
      ) : (
        <>
          <div className="mobile-aion-context" aria-label="Ask context">
            {ask.canUseCurrentPage && (
              <button
                className={`mobile-context-chip ${ask.askCurrentPageOnly ? 'active' : ''}`}
                onClick={() => ask.onAskCurrentPageOnlyChange(!ask.askCurrentPageOnly)}
                type="button"
              >
                This page{ask.currentPageTitle ? `: ${ask.currentPageTitle}` : ''}
              </button>
            )}
            {ask.usableCollections.length > 0 && (
              <select
                aria-label="Knowledge hub context"
                value={ask.askCurrentPageOnly ? '' : ask.askCollectionId}
                onChange={(event) => {
                  ask.onAskCurrentPageOnlyChange(false)
                  ask.onAskCollectionChange(event.target.value)
                }}
              >
                <option value="" disabled>
                  Knowledge hub
                </option>
                {ask.usableCollections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {quickActions.length > 0 && (
            <div className="mobile-quick-actions" aria-label="Quick actions">
              {quickActions.map((action) => (
                <button
                  key={action.id}
                  onClick={() => {
                    void runQuickAction(action)
                  }}
                  type="button"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          <form className="mobile-aion-form" onSubmit={submitAsk}>
            <textarea
              aria-label="Ask ÆTHER"
              placeholder="Ask about this page or your knowledge hubs"
              rows={2}
              value={ask.chatPrompt}
              onChange={(event) => ask.onChatPromptChange(event.target.value)}
            />
            {asking ? (
              <button className="mobile-aion-cancel" onClick={ask.onCancel} type="button">
                Stop
              </button>
            ) : (
              <button disabled={!ask.chatPrompt.trim()} type="submit">
                Ask
              </button>
            )}
          </form>

          {asking && ask.askPhase && (
            <div className="mobile-aion-phase">
              <SpinnerIcon /> {ask.askPhase}
            </div>
          )}

          {answerText && (
            <div className="mobile-aion-answer">
              {renderAnswerMarkdown(answerText, citations, openCitation)}
            </div>
          )}

          {!asking && ask.chatResult && (
            <div className="mobile-aion-metrics">
              {ask.chatResult.metrics.tokensPerSecond > 0 && (
                <span>
                  {formatVisibleModelName(ask.chatResult.model) ?? ask.chatResult.model} ·{' '}
                  {ask.chatResult.metrics.tokensPerSecond.toFixed(1)} tok/s
                </span>
              )}
              <button
                onClick={() => {
                  if (!ask.chatResult) return
                  void navigator.clipboard.writeText(buildEvidenceBundle(ask.chatResult))
                  setEvidenceCopied(true)
                  window.setTimeout(() => setEvidenceCopied(false), 1400)
                }}
                type="button"
              >
                <Copy size={13} /> {evidenceCopied ? 'Copied' : 'Copy evidence'}
              </button>
            </div>
          )}

          {citations.length > 0 && (
            <div className="mobile-aion-citations" aria-label="Sources">
              {citations.map((citation, index) => (
                <button
                  key={citation.id}
                  onClick={() => {
                    void openCitation(citation)
                  }}
                  type="button"
                >
                  <span className="mobile-citation-index">{index + 1}</span>
                  <span className="mobile-citation-body">
                    <strong>{citation.title || citation.url}</strong>
                    <small>{citation.text}</small>
                  </span>
                  <ArrowUpRight aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )

  return (
    <div className="mobile-shell">
      {findBar && <div className="mobile-find-slot">{findBar}</div>}

      <div className="mobile-main">
        <div className="mobile-content">{children}</div>
        {aionDocked && (
          <aside className="mobile-aion-dock" aria-label="AiON">
            {aionContent}
          </aside>
        )}
      </div>

      <div className={`mobile-chrome ${chromeHidden ? 'hidden' : ''}`} ref={chromeRef}>
        <div className="mobile-chrome-inner">
          <div className="mobile-tab-strip" aria-label="Open tabs">
            <div className="mobile-tab-strip-scroll">
              {tabs.map((tab) => (
                <button
                  className={`mobile-tab-chip ${tab.isActive && !dashboardOpen ? 'active' : ''}`}
                  key={tab.id}
                  onClick={() => onSelectTab(tab.id)}
                  style={
                    { '--tab-tint': getTabTint(tab.host, tab.themeColor) } as React.CSSProperties
                  }
                  type="button"
                >
                  <span className="mobile-tab-chip-icon" aria-hidden="true">
                    {tab.isLoading ? <SpinnerIcon /> : <TabFavicon icon={tab.favicon} />}
                  </span>
                  <span className="mobile-tab-chip-title">
                    {tab.title || tab.host || 'New Tab'}
                  </span>
                  {tab.isActive && !dashboardOpen && tabs.length > 1 && (
                    <span
                      className="mobile-tab-chip-close"
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation()
                        void onCloseTab(tab.id)
                      }}
                    >
                      <CloseIcon />
                    </span>
                  )}
                </button>
              ))}
              <button
                className="mobile-tab-new"
                aria-label="New tab"
                onClick={onCreateTab}
                type="button"
              >
                <PlusIcon />
              </button>
            </div>
            <button
              className="mobile-tab-grid-button"
              aria-label={`Tab overview (${countLabel(tabs.length, 'tab')})`}
              onClick={() => setGridOpen(true)}
              type="button"
            >
              <GridIcon />
            </button>
          </div>

          <div className="mobile-address-row">
            <button
              className={`mobile-nav-button ${dashboardOpen && !crystallizerOpen ? 'active' : ''}`}
              aria-label="ÆTHER dashboard"
              onClick={onOpenDashboard}
              type="button"
            >
              <CloudIcon />
            </button>
            <form className="mobile-address-pill" onSubmit={submitAddress}>
              {activeTab?.isLoading && isWebPage ? <SpinnerIcon /> : <GlobeIcon />}
              <input
                ref={addressRef}
                aria-label="Address or search"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                value={addressEditing ? addressDraft : addressValue}
                onBlur={() => setAddressEditing(false)}
                onChange={(event) => setAddressDraft(event.target.value)}
                onFocus={beginAddressEdit}
                placeholder="Search or enter website"
              />
            </form>
            <button
              className={`mobile-nav-button aion ${aionOpen ? 'active' : ''}`}
              aria-label="Ask AiON"
              onClick={() => setAionOpen(true)}
              type="button"
            >
              <AetherSigilIcon size={21} />
            </button>
            <button
              className="mobile-nav-button capture"
              aria-label="Capture page into knowledge hub"
              disabled={Boolean(busy) || capturesBlocked}
              onClick={() => {
                void onCapture()
              }}
              type="button"
            >
              <Download />
            </button>
            <button
              className="mobile-nav-button"
              aria-label="More actions"
              onClick={() => {
                void onCaptureIntent()
                setActionsOpen(true)
              }}
              type="button"
            >
              <MoreDotsIcon />
            </button>
          </div>
        </div>
      </div>

      {gridOpen && (
        <div className="mobile-overlay mobile-tab-grid-overlay" role="dialog" aria-label="Tabs">
          <header className="mobile-overlay-header">
            <strong>
              {tabs.length} {tabs.length === 1 ? 'Tab' : 'Tabs'}
            </strong>
            <button
              aria-label="Close tab overview"
              onClick={() => setGridOpen(false)}
              type="button"
            >
              <X />
            </button>
          </header>
          <div className="mobile-tab-grid">
            {tabs.map((tab) => (
              <div
                className={`mobile-tab-card ${tab.isActive && !dashboardOpen ? 'active' : ''}`}
                key={tab.id}
                onClick={() => {
                  void selectGridTab(tab.id)
                }}
                role="button"
                tabIndex={0}
                style={
                  { '--tab-tint': getTabTint(tab.host, tab.themeColor) } as React.CSSProperties
                }
              >
                <header>
                  <span className="mobile-tab-card-icon" aria-hidden="true">
                    <TabFavicon icon={tab.favicon} />
                  </span>
                  <span className="mobile-tab-card-title">
                    {tab.title || tab.host || 'New Tab'}
                  </span>
                  {tabs.length > 1 && (
                    <button
                      aria-label="Close tab"
                      className="mobile-tab-card-close"
                      onClick={(event) => {
                        event.stopPropagation()
                        void onCloseTab(tab.id)
                      }}
                      type="button"
                    >
                      <X />
                    </button>
                  )}
                </header>
                <div className="mobile-tab-card-preview">
                  {thumbnails[tab.id] ? (
                    <img src={thumbnails[tab.id]} alt="" />
                  ) : (
                    <span className="mobile-tab-card-placeholder" aria-hidden="true">
                      <TabFavicon icon={tab.favicon} />
                    </span>
                  )}
                </div>
                <footer>{tab.host || 'Start page'}</footer>
              </div>
            ))}
            <button
              className="mobile-tab-card mobile-tab-card-new"
              onClick={() => {
                setGridOpen(false)
                onCreateTab()
              }}
              type="button"
            >
              <PlusIcon />
              <span>New Tab</span>
            </button>
          </div>
        </div>
      )}

      {actionsOpen && (
        <MobileSheet
          className="mobile-actions-sheet"
          label="Browser actions"
          onClose={() => setActionsOpen(false)}
        >
          <div className="mobile-capture-block">
            <label htmlFor="mobile-capture-collection">Capture into knowledge hub</label>
            <div className="mobile-capture-row">
              <select
                id="mobile-capture-collection"
                aria-label="Capture hub"
                value={selectedCollectionId}
                onChange={(event) => {
                  if (event.target.value === CREATE_COLLECTION_VALUE) {
                    setActionsOpen(false)
                    onCreateCollection()
                    return
                  }
                  void onSelectCollection(event.target.value)
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
                <option value={CREATE_COLLECTION_VALUE}>+ Create new hub</option>
              </select>
              <button
                className="mobile-capture-button"
                disabled={Boolean(busy) || capturesBlocked}
                onClick={() => {
                  setActionsOpen(false)
                  void onCapture()
                }}
                type="button"
              >
                <Download /> Capture
              </button>
            </div>
          </div>

          <div className="mobile-action-list">
            <button
              disabled={!isWebPage || Boolean(busy) || capturesBlocked}
              onClick={() => {
                setActionsOpen(false)
                void onCaptureSelection()
              }}
              type="button"
            >
              <TextSelect /> Capture Selected Passage
            </button>
            <button
              disabled={portalSaveBlocked || Boolean(busy)}
              onClick={() => {
                setActionsOpen(false)
                void onSavePortal()
              }}
              title={portalSaveTitle}
              type="button"
            >
              <BookmarkPlus /> Save as Portal
            </button>
            <button
              disabled={!isWebPage}
              onClick={() => {
                setActionsOpen(false)
                onOpenFind()
              }}
              type="button"
            >
              <Search /> Find on Page
            </button>
            <button
              disabled={!isWebPage || !activeTab}
              onClick={() => {
                setActionsOpen(false)
                if (activeTab) void onNavigateAddress(activeTab.url)
              }}
              type="button"
            >
              <RefreshCw /> Reload Page
            </button>
            <button
              disabled={dashboardOpen || !activeTab?.canGoForward}
              onClick={() => {
                setActionsOpen(false)
                void onGoForward()
              }}
              type="button"
            >
              <ChevronRightIcon /> Forward
            </button>
            <button
              className={crystallizerOpen ? 'active' : ''}
              onClick={() => {
                setActionsOpen(false)
                void onOpenCrystallizer()
              }}
              type="button"
            >
              <Snowflake /> iCE Crystallizer
            </button>
            <button
              onClick={() => {
                setActionsOpen(false)
                void onOpenSettings()
              }}
              type="button"
            >
              <GearIcon /> Settings
            </button>
          </div>
        </MobileSheet>
      )}

      {aionOpen && !wideScreen && (
        <MobileSheet className="mobile-aion-sheet" label="AiON" onClose={() => setAionOpen(false)}>
          {aionContent}
        </MobileSheet>
      )}
    </div>
  )
}

// Bottom sheet with swipe-to-dismiss. The grip drags 1:1 from the first
// pixel; the sheet body also drags, but only engages after a small slop
// (so taps and content scrolling win first) and with extra resistance.
// The finger drives the transform directly (no per-move re-render); release
// either flings the sheet off (past 28% of its height, or a fast downward
// flick) or springs it back with a slight overshoot. A ::after bleed under
// the sheet keeps it visually anchored mid-drag — no gap at the bottom edge.
function MobileSheet({
  children,
  className,
  label,
  onClose
}: {
  children: ReactNode
  className: string
  label: string
  onClose: () => void
}): React.JSX.Element {
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const sheetRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef({
    down: false,
    engaged: false,
    factor: 1,
    startX: 0,
    startY: 0,
    offset: 0,
    lastY: 0,
    lastT: 0,
    velocity: 0
  })
  const suppressClickRef = useRef(false)
  const closingRef = useRef(false)

  const dismiss = (): void => {
    if (closingRef.current) return
    closingRef.current = true
    const sheet = sheetRef.current
    const backdrop = backdropRef.current
    if (!sheet || !backdrop) {
      onClose()
      return
    }
    sheet.style.transition = 'transform 210ms cubic-bezier(0.4, 0, 1, 1)'
    sheet.style.transform = 'translateY(115%)'
    backdrop.style.transition = 'opacity 210ms ease'
    backdrop.style.opacity = '0'
    window.setTimeout(onClose, 200)
  }

  const engage = (event: React.PointerEvent<HTMLElement>, factor: number): void => {
    const drag = dragRef.current
    drag.engaged = true
    drag.factor = factor
    drag.startY = event.clientY
    drag.lastY = event.clientY
    drag.lastT = event.timeStamp
    drag.velocity = 0
    sheetRef.current?.setPointerCapture(event.pointerId)
    const sheet = sheetRef.current
    if (sheet) {
      sheet.style.animation = 'none'
      sheet.style.transition = 'none'
    }
    if (backdropRef.current) backdropRef.current.style.transition = 'none'
  }

  const onSheetPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (closingRef.current) return
    const drag = dragRef.current
    drag.down = true
    drag.engaged = false
    drag.offset = 0
    drag.startX = event.clientX
    drag.startY = event.clientY
    // The grip owns the gesture immediately; the body waits for slop.
    if ((event.target as HTMLElement).closest('.mobile-sheet-drag-zone')) {
      engage(event, 1)
    }
  }

  const onSheetPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag.down || closingRef.current) return
    if (!drag.engaged) {
      // Body drag arms only on a clearly vertical downward pull while the
      // sheet content sits at its scroll top; otherwise scrolling/taps win.
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      const scrolledToTop = (scrollRef.current?.scrollTop ?? 0) <= 0
      if (!scrolledToTop) return
      if (dy < 12 || dy < Math.abs(dx) * 1.2) return
      engage(event, 0.55)
      return
    }
    const dy = event.clientY - drag.startY
    const dt = event.timeStamp - drag.lastT
    if (dt > 0) drag.velocity = (event.clientY - drag.lastY) / dt
    drag.lastY = event.clientY
    drag.lastT = event.timeStamp
    // Downward follows the finger (scaled by the zone's resistance); upward
    // stretches barely at all and stops at a hard cap.
    const offset = dy >= 0 ? dy * drag.factor : Math.max(dy * 0.12, -28)
    drag.offset = offset
    const sheet = sheetRef.current
    if (sheet) sheet.style.transform = `translateY(${offset}px)`
    const backdrop = backdropRef.current
    if (backdrop && sheet) {
      const progress = Math.min(1, Math.max(0, offset / sheet.offsetHeight))
      backdrop.style.opacity = `${1 - progress * 0.85}`
    }
  }

  const onSheetPointerEnd = (): void => {
    const drag = dragRef.current
    if (!drag.down) return
    drag.down = false
    if (!drag.engaged || closingRef.current) return
    drag.engaged = false
    // A real drag happened; swallow the click that follows the release so
    // buttons under the finger don't fire.
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 80)
    const sheet = sheetRef.current
    if (!sheet) return
    const shouldDismiss =
      drag.offset > sheet.offsetHeight * 0.28 || (drag.velocity > 0.55 && drag.offset > 24)
    if (shouldDismiss) {
      dismiss()
      return
    }
    // Spring back with a small overshoot.
    sheet.style.transition = 'transform 340ms cubic-bezier(0.22, 1.36, 0.36, 1)'
    sheet.style.transform = 'translateY(0)'
    const backdrop = backdropRef.current
    if (backdrop) {
      backdrop.style.transition = 'opacity 240ms ease'
      backdrop.style.opacity = '1'
    }
  }

  return (
    <div className="mobile-sheet-backdrop" onClick={dismiss} ref={backdropRef} role="presentation">
      <section
        className={`mobile-sheet ${className}`}
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        onClickCapture={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onPointerCancel={onSheetPointerEnd}
        onPointerDown={onSheetPointerDown}
        onPointerMove={onSheetPointerMove}
        onPointerUp={onSheetPointerEnd}
        ref={sheetRef}
        role="dialog"
      >
        <div className="mobile-sheet-drag-zone">
          <div className="mobile-sheet-grip" aria-hidden="true" />
        </div>
        <div className="mobile-sheet-scroll" ref={scrollRef}>
          {children}
        </div>
      </section>
    </div>
  )
}

function TabFavicon({ icon }: { icon?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  // See PageFavicon in BrowserChrome.tsx: `icon` is a key, the src is a data URI.
  const dataUri = useSiteFavicon(icon)
  if (!dataUri || failed) return <GlobeIcon />
  return <img src={dataUri} alt="" onError={() => setFailed(true)} />
}

function MoreDotsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  )
}
