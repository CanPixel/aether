import { FormEvent, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AetherState,
  AetherShortcutId,
  AirDossierInput,
  AirLensKind,
  AirPreparedDossier,
  AirRecentFile,
  AirRenderResult,
  AppSettings,
  AppSummary,
  CaptureProgress,
  BrowserTabSummary,
  CaptureResult,
  CaptureSummary,
  ChatResult,
  CollectionSummary,
  FindAction,
  FlowGraphNode,
  FlowGraphResult,
  HubShortcutSummary,
  IcebergItem,
  IcebergResult,
  ModelDownloadChoice,
  ModelDownloadProgress,
  SearchEngineId,
  SearchResult,
  SemanticTrailItem,
  SemanticTrailResult,
  SaveIcebergInput,
  SavedIceberg,
  SavedIcebergSummary,
  StatusToastInput,
  SystemStatus
} from '../../shared/aether'
import { BrowserChrome } from './components/BrowserChrome'
import { StartPage } from './components/StartPage'
import { CollectionDialog, CollectionDialogState } from './components/CollectionDialog'
import { Crystallizer } from './components/Crystallizer'
import { Dashboard } from './components/Dashboard'
import { FlowView } from './components/FlowView'
import { AirView } from './components/AirView'
import { GlobeIcon, CloudIcon, GearIcon } from './components/icons'
import { IntelligencePanel } from './components/IntelligencePanel'
import { QuickAction } from './types/ui'
import { formatVisibleModelName, getQuickActions, normalizeComparableUrl } from './utils/aether-ui'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CloudDownload,
  Cpu,
  LoaderCircle,
  SearchIcon,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Waves,
  Wind,
  Zap
} from 'lucide-react'

// Sentinel URL for a blank tab that shows the ÆTHER start page instead of loading a
// page. Must match START_PAGE_URL in src-tauri/src/lib.rs.
const START_PAGE_URL = 'aether://start'

const SHORTCUT_HELP: Array<{ keys: string; action: string; scope: string }> = [
  { keys: 'Cmd/Ctrl + L', action: 'Focus address bar', scope: 'Browser' },
  { keys: 'Cmd/Ctrl + T', action: 'Open new tab', scope: 'Global' },
  { keys: 'Cmd/Ctrl + F', action: 'Find on page', scope: 'Browser' },
  { keys: 'Cmd/Ctrl + 1', action: 'Open Dashboard', scope: 'Global' },
  { keys: 'Cmd/Ctrl + 2', action: 'Open iCE', scope: 'Global' },
  { keys: 'Cmd/Ctrl + 3', action: 'Open Browser', scope: 'Global' },
  { keys: 'Cmd/Ctrl + Shift + A', action: 'Toggle AiON', scope: 'Global' },
  { keys: 'Cmd/Ctrl + Shift + C', action: 'Capture current page', scope: 'Browser' }
]

function getShortcutFromKeyboardEvent(event: KeyboardEvent): AetherShortcutId | null {
  const key = event.key.toLowerCase()
  const code = event.code.toLowerCase()
  const primary = event.metaKey || event.ctrlKey
  if (!primary) return null

  if (!event.altKey && !event.shiftKey && key === 'l') return 'focus-address'
  if (!event.altKey && !event.shiftKey && key === 't') return 'new-tab'
  if (!event.altKey && !event.shiftKey && key === 'f') return 'find-page'

  if (!event.altKey && !event.shiftKey && (key === '1' || code === 'digit1')) {
    return 'open-dashboard'
  }
  if (!event.altKey && !event.shiftKey && (key === '2' || code === 'digit2')) return 'open-ice'
  if (!event.altKey && !event.shiftKey && (key === '3' || code === 'digit3')) {
    return 'open-browser'
  }

  if (!event.altKey && event.shiftKey && key === 'a') return 'toggle-aion'
  if (!event.altKey && event.shiftKey && key === 'c') return 'capture-page'

  return null
}

function isBlockedShellShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'w'
}

const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url'
])

function getEditableShortcutTarget(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null

  const editable = target.closest(
    'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'
  )
  if (!editable) return null
  if (editable instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(editable.type) && !editable.readOnly && !editable.disabled
      ? editable
      : null
  }
  if (editable instanceof HTMLTextAreaElement) {
    return !editable.readOnly && !editable.disabled ? editable : null
  }
  return editable instanceof HTMLElement && editable.isContentEditable ? editable : null
}

// Stopwords are ignored when locating the cited span: they appear everywhere and
// would pull the anchor toward dense prose rather than the distinctive claim.
const CLAIM_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'are',
  'was',
  'that',
  'this',
  'from',
  'have',
  'has',
  'between',
  'different',
  'available',
  'options',
  'option',
  'using',
  'their',
  'which',
  'into',
  'onto',
  'than',
  'then',
  'also',
  'each',
  'per',
  'its',
  'about',
  'over',
  'under',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'at',
  'is',
  'it',
  'as',
  'or',
  'by',
  'be',
  'but'
])

function normalizeAnchorWord(word: string): string {
  return word.toLowerCase().replace(/^[.,;:!?'"()[\]–-]+|[.,;:!?'"()[\]–-]+$/g, '')
}

// Distinctive tokens from the cited claim, weighted so numbers/dimensions (e.g.
// "264×176", "3.6") and longer words dominate the match score.
function claimTokenWeights(claimText: string): Map<string, number> {
  const weights = new Map<string, number>()
  const tokens = claimText.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.×'"–-]*/gu) ?? []
  for (const raw of tokens) {
    const token = raw.replace(/^[.'"–-]+|[.'"–-]+$/g, '')
    if (token.length < 2 || CLAIM_STOPWORDS.has(token)) continue
    const weight = (/\d/.test(token) ? 4 : 1) + Math.min(token.length, 8) / 4
    const existing = weights.get(token)
    if (existing === undefined || existing < weight) weights.set(token, weight)
  }
  return weights
}

// Shortest sub-span of words[lo..hi) that still contains one of every distinct
// matched claim token in that range. Drops repeated keywords and filler so the
// anchor is just the supporting phrase. Returns null when the range has no matches.
function minimalCoveringSpan(
  words: string[],
  lo: number,
  hi: number,
  weights: Map<string, number>
): { start: number; end: number; length: number } | null {
  const targets = new Set<string>()
  for (let index = lo; index < hi; index += 1) {
    const word = normalizeAnchorWord(words[index])
    if (weights.has(word)) targets.add(word)
  }
  if (targets.size === 0) return null

  const have = new Map<string, number>()
  let satisfied = 0
  let left = lo
  let best = { start: lo, end: hi, length: hi - lo }
  for (let right = lo; right < hi; right += 1) {
    const rightWord = normalizeAnchorWord(words[right])
    if (targets.has(rightWord)) {
      const next = (have.get(rightWord) ?? 0) + 1
      have.set(rightWord, next)
      if (next === 1) satisfied += 1
    }
    while (satisfied === targets.size) {
      if (right - left + 1 < best.length) {
        best = { start: left, end: right + 1, length: right - left + 1 }
      }
      const leftWord = normalizeAnchorWord(words[left])
      if (targets.has(leftWord)) {
        const next = (have.get(leftWord) ?? 0) - 1
        have.set(leftWord, next)
        if (next === 0) satisfied -= 1
      }
      left += 1
    }
  }
  return best
}

// A citation points at a whole chunk, which can span several page sections. Given
// the specific claim sentence the badge was attached to, find the tightest span
// inside the chunk where that claim's keywords cluster, so the anchor lands on the
// supporting fact rather than the chunk's opening words.
function resolveCitationAnchorText(chunkText: string, claimText: string): string {
  const chunk = chunkText.replace(/\s+/g, ' ').trim()
  const claim = claimText.replace(/\s+/g, ' ').trim()
  if (!chunk || !claim) return chunkText

  const weights = claimTokenWeights(claim)
  if (weights.size === 0) return chunkText

  const words = chunk.split(' ')
  const windowSize = 16
  // Pick the window with the most distinct-token weight, then — for equal weight —
  // the one whose keywords sit closest together, so we don't latch onto an earlier
  // section that merely shares a common word (e.g. "display") with the claim.
  let best: { score: number; coverLength: number; start: number; end: number } | null = null

  for (let start = 0; start < words.length; start += 1) {
    const end = Math.min(words.length, start + windowSize)
    const seen = new Set<string>()
    let score = 0
    for (let index = start; index < end; index += 1) {
      const word = normalizeAnchorWord(words[index])
      const weight = weights.get(word)
      if (weight !== undefined && !seen.has(word)) {
        seen.add(word)
        score += weight
      }
    }
    if (score <= 0) continue

    const cover = minimalCoveringSpan(words, start, end, weights)
    if (!cover) continue

    if (
      best === null ||
      score > best.score ||
      (score === best.score && cover.length < best.coverLength)
    ) {
      best = { score, coverLength: cover.length, start: cover.start, end: cover.end }
    }
  }

  if (best === null) return chunkText

  const span = words.slice(best.start, best.end).join(' ').trim()
  return span || chunkText
}

function buildCitationTargetUrl(citation: SearchResult, anchorText: string): string {
  let url: URL
  try {
    url = new URL(citation.url)
  } catch {
    return citation.url
  }

  if (url.hash) return url.toString()

  const fragmentText = anchorText.replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, 14).join(' ')

  if (!fragmentText) return url.toString()

  url.hash = `:~:text=${encodeURIComponent(fragmentText)}`
  return url.toString()
}

function scheduleCitationSourceScroll(tabId: string, sourceText: string): void {
  const text = sourceText.trim()
  if (!tabId || !text) return

  for (const delay of [650, 1600, 3000]) {
    window.setTimeout(() => {
      void window.aether.tabs.scrollToText(tabId, text).catch(() => undefined)
    }, delay)
  }
}

function getNoticeTone(message: string): StatusToastInput['tone'] {
  const errorPattern =
    /\b(failed|could not|unexpected|error|select|open a page|create a collection|already captured|already in)\b/i
  return errorPattern.test(message) ? 'error' : 'success'
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (!(error instanceof Error)) return 'ÆTHER hit an unexpected error.'

  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

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
    title: 'Fast local reasoning',
    description: 'Compact Gemma 4 E2B QAT for everyday capture, search, and grounded answers.',
    size: '3.35 GB',
    source: 'google/gemma-4-E2B-it-qat-q4_0-gguf'
  },
  {
    id: 'wise',
    name: 'AiON WiSE',
    title: 'Deeper local synthesis',
    description: 'Larger Gemma 4 E4B QAT for richer iCE maps and longer-form synthesis.',
    size: '5.15 GB',
    source: 'google/gemma-4-E4B-it-qat-q4_0-gguf'
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

function upsertModelProgress(
  current: ModelDownloadProgress[],
  progress: ModelDownloadProgress
): ModelDownloadProgress[] {
  const index = current.findIndex((item) => item.id === progress.id)
  if (index === -1) return [...current, progress]
  const next = [...current]
  next[index] = { ...next[index], ...progress }
  return next
}

function App(): React.JSX.Element {
  const [apps, setApps] = useState<AppSummary[]>([])
  const [tabs, setTabs] = useState<BrowserTabSummary[]>([])
  const [shortcuts, setShortcuts] = useState<HubShortcutSummary[]>([])
  const [savedIcebergs, setSavedIcebergs] = useState<SavedIcebergSummary[]>([])
  const [activeSavedIceberg, setActiveSavedIceberg] = useState<SavedIceberg | null>(null)
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [capturesByCollection, setCapturesByCollection] = useState<
    Record<string, CaptureSummary[]>
  >({})
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings>({
    browser: { defaultSearchEngine: 'google' },
    developerMode: false
  })
  const [dashboardOpen, setDashboardOpen] = useState(true)
  const [workspaceMode, setWorkspaceMode] = useState<'dashboard' | 'crystallizer' | 'flow' | 'air'>(
    'dashboard'
  )
  const [activeTabId, setActiveTabId] = useState('')
  const [selectedCollectionId, setSelectedCollectionId] = useState('')
  const [addressDraft, setAddressDraft] = useState('aether://dashboard')
  const [addressFocused, setAddressFocused] = useState(false)
  const [chatPrompt, setChatPrompt] = useState('')
  const [askCollectionId, setAskCollectionId] = useState('')
  const [askIncludeCurrentPage, setAskIncludeCurrentPage] = useState(false)
  const [askCurrentPageOnly, setAskCurrentPageOnly] = useState(false)
  // Tracks the context (web page vs hub) the ask defaults were last applied for, so a
  // new context resets to one sensible default while manual picks persist within it.
  const appliedAskContextRef = useRef<string | null>(null)
  const [askPanelOpen, setAskPanelOpen] = useState(true)
  const [chatResult, setChatResult] = useState<ChatResult | null>(null)
  const [streamingAnswer, setStreamingAnswer] = useState('')
  const [streamingCitations, setStreamingCitations] = useState<SearchResult[]>([])
  const [semanticTrailQuery, setSemanticTrailQuery] = useState('')
  const [semanticTrailResult, setSemanticTrailResult] = useState<SemanticTrailResult | null>(null)
  const [flowGraphQuery, setFlowGraphQuery] = useState('')
  const [flowGraphResult, setFlowGraphResult] = useState<FlowGraphResult | null>(null)
  const [flowSelectedNodeId, setFlowSelectedNodeId] = useState<string | null>(null)
  const [airLens, setAirLens] = useState('')
  const [airLensKind, setAirLensKind] = useState<AirLensKind>('topic')
  const [airHubId, setAirHubId] = useState('')
  const [airFlowNodeId, setAirFlowNodeId] = useState<string | null>(null)
  const [airPrepared, setAirPrepared] = useState<AirPreparedDossier | null>(null)
  const [airRecent, setAirRecent] = useState<AirRecentFile[]>([])
  const [airResult, setAirResult] = useState<AirRenderResult | null>(null)
  const [askPhase, setAskPhase] = useState<string | null>(null)
  const askRequestIdRef = useRef<string | null>(null)
  const streamBufferRef = useRef('')
  const streamFlushRef = useRef<number | null>(null)
  const [lastCapture, setLastCapture] = useState<CaptureResult | null>(null)
  // Capture auto-routing state. suggestedHubUrlRef: page URLs we have already asked the
  // backend to route (so repeated intent does not re-embed). manualHubUrlRef: URLs where the
  // user picked a hub by hand (never silently overwrite those). activeTabUrlRef mirrors the
  // live URL so an in-flight suggestion can tell whether the user navigated away mid-request.
  const suggestedHubUrlRef = useRef<string | null>(null)
  const manualHubUrlRef = useRef<string | null>(null)
  const activeTabUrlRef = useRef('')
  // Holds a suggestion that resolved while the hub <select> was open, to apply on close so
  // the dropdown's highlighted option never jumps out from under the user mid-interaction.
  const pendingHubSuggestionRef = useRef<{ url: string; collectionId: string } | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  const [busy, setBusy] = useState<string | null>('')
  const [notice, setNotice] = useState<string | null>(null)
  const [toast, setToast] = useState<(StatusToastInput & { id: number }) | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCurrent, setFindCurrent] = useState(0)
  const [findTotal, setFindTotal] = useState(0)
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelSetupDismissed, setModelSetupDismissed] = useState(false)
  const [selectedSetupModels, setSelectedSetupModels] = useState<ModelDownloadChoice[]>(['lite'])
  const [modelDownloadProgress, setModelDownloadProgress] = useState<ModelDownloadProgress[]>([])
  const [modelSetupError, setModelSetupError] = useState<string | null>(null)
  const [modelSetupComplete, setModelSetupComplete] = useState(false)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const toastIdRef = useRef(0)

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs.find((tab) => tab.isActive) ?? tabs[0],
    [activeTabId, tabs]
  )
  const activeApp = useMemo(() => apps.find((app) => app.isActive) ?? apps[0], [apps])
  const selectedCollection = useMemo(
    () =>
      collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0],
    [collections, selectedCollectionId]
  )
  const selectedAirHub = useMemo(
    () => collections.find((collection) => collection.id === airHubId) ?? selectedCollection,
    [airHubId, collections, selectedCollection]
  )
  const selectedFlowNode = useMemo(
    () => flowGraphResult?.nodes.find((node) => node.id === flowSelectedNodeId) ?? null,
    [flowGraphResult, flowSelectedNodeId]
  )
  const selectedAirFlowNode = useMemo(
    () =>
      flowGraphResult?.nodes.find((node) => node.id === airFlowNodeId) ??
      selectedFlowNode ??
      flowGraphResult?.nodes.find((node) => node.kind === 'query') ??
      flowGraphResult?.nodes.find((node) => node.kind === 'hub') ??
      flowGraphResult?.nodes[0] ??
      null,
    [airFlowNodeId, flowGraphResult, selectedFlowNode]
  )
  const askCollection = useMemo(
    () => collections.find((collection) => collection.id === askCollectionId),
    [askCollectionId, collections]
  )
  const usableAskCollections = useMemo(
    () =>
      collections.filter((collection) => collection.captureCount > 0 && collection.chunkCount > 0),
    [collections]
  )
  const isStartPage = activeTab?.url === START_PAGE_URL
  const canUseCurrentPage = Boolean(activeTab?.url) && !isStartPage
  const chatBlocked = status ? !status.runtimeReady || !status.chatModel : false
  const modelSetupNeeded = Boolean(status && (!status.chatModel || !status.embeddingModel))
  const modelSetupBusy = Boolean(
    busy === 'Installing local models' ||
      modelDownloadProgress.some(
        (progress) => progress.status === 'queued' || progress.status === 'downloading'
      )
  )
  const modelSetupVisible = modelSetupNeeded && !modelSetupDismissed
  const quickActions = useMemo<QuickAction[]>(() => getQuickActions(activeTab), [activeTab])
  const activeTabUrl = activeTab?.url ?? ''
  useEffect(() => {
    activeTabUrlRef.current = activeTabUrl
  }, [activeTabUrl])
  const mostRecentHubId = useMemo(
    () =>
      usableAskCollections.some((collection) => collection.id === selectedCollectionId)
        ? selectedCollectionId
        : (usableAskCollections[0]?.id ?? ''),
    [usableAskCollections, selectedCollectionId]
  )
  const addressValue = addressFocused
    ? addressDraft
    : dashboardOpen
      ? workspaceMode === 'crystallizer'
        ? 'ice://crystallizer'
        : workspaceMode === 'flow'
          ? 'flow://semantic-graph'
          : workspaceMode === 'air'
            ? 'air://renderer'
            : 'æther://dashboard'
      : isStartPage
        ? ''
        : activeTabUrl
  const activeTabHubShortcut = useMemo(() => {
    if (!activeTabUrl) return undefined
    const activeUrl = normalizeComparableUrl(activeTabUrl)
    return shortcuts.find((shortcut) => normalizeComparableUrl(shortcut.url) === activeUrl)
  }, [activeTabUrl, shortcuts])
  const activeTabSavedToHub = Boolean(activeTabHubShortcut)
  const activeTabHubNeedsMetadata = Boolean(
    activeTabHubShortcut &&
    ((!activeTabHubShortcut.themeColor && activeTab?.themeColor) ||
      (!activeTabHubShortcut.favicon && activeTab?.favicon))
  )
  const activeSemanticTrailResult = useMemo(() => {
    if (!semanticTrailResult || !activeTabUrl) return null
    return normalizeComparableUrl(semanticTrailResult.root.url) === normalizeComparableUrl(activeTabUrl)
      ? semanticTrailResult
      : null
  }, [activeTabUrl, semanticTrailResult])

  const openFindBar = useCallback((): void => {
    if (dashboardOpen || isStartPage || !activeTab?.id) {
      setNotice('Open a web page before using find.')
      return
    }
    setFindOpen(true)
  }, [activeTab?.id, dashboardOpen, isStartPage])

  const findHighlight = useCallback(
    (query: string, action: FindAction): void => {
      if (!activeTab?.id) return
      const trimmed = query.trim()
      if (!trimmed) {
        setFindCurrent(0)
        setFindTotal(0)
        void window.aether.tabs.find(activeTab.id, '', 'clear').catch(() => undefined)
        return
      }
      void window.aether.tabs
        .find(activeTab.id, trimmed, action)
        .catch((error) => setNotice(getErrorMessage(error)))
    },
    [activeTab?.id]
  )

  const closeFindBar = useCallback((): void => {
    setFindOpen(false)
    setFindCurrent(0)
    setFindTotal(0)
    if (activeTab?.id) {
      void window.aether.tabs.find(activeTab.id, '', 'clear').catch(() => undefined)
    }
  }, [activeTab?.id])

  const refreshCollections = useCallback(
    async (preferredCollectionId?: string): Promise<void> => {
      const nextCollections = await window.aether.collections.list()
      setCollections(nextCollections)
      const captureEntries = await Promise.all(
        nextCollections.map(async (collection) => [
          collection.id,
          await window.aether.collections.captures(collection.id)
        ])
      )
      const nextCapturesByCollection = Object.fromEntries(captureEntries) as Record<
        string,
        CaptureSummary[]
      >
      setCapturesByCollection(nextCapturesByCollection)

      const nextSelected =
        preferredCollectionId &&
        nextCollections.some((collection) => collection.id === preferredCollectionId)
          ? preferredCollectionId
          : selectedCollectionId &&
              nextCollections.some((collection) => collection.id === selectedCollectionId)
            ? selectedCollectionId
            : (nextCollections[0]?.id ?? '')

      setSelectedCollectionId(nextSelected)
      setAskCollectionId((current) =>
        current && nextCollections.some((collection) => collection.id === current)
          ? current
          : nextSelected
      )
    },
    [selectedCollectionId]
  )

  const refreshShell = useCallback(async (): Promise<void> => {
    const [nextApps, nextTabs, nextStatus, nextSettings] = await Promise.all([
      window.aether.apps.list(),
      window.aether.tabs.list(),
      window.aether.system.status(),
      window.aether.system.settings()
    ])
    setApps(nextApps)
    setTabs(nextTabs)
    setStatus(nextStatus)
    setSettings(nextSettings)
    setActiveTabId(nextTabs.find((tab) => tab.isActive)?.id ?? nextTabs[0]?.id ?? '')
  }, [])

  const refreshShortcuts = useCallback(async (): Promise<void> => {
    setShortcuts(await window.aether.hub.list())
  }, [])

  const refreshSavedIcebergs = useCallback(async (): Promise<void> => {
    setSavedIcebergs(await window.aether.crystallizer.listSaved())
  }, [])

  const refreshAirRecent = useCallback(async (): Promise<void> => {
    setAirRecent(await window.aether.air.listRecent())
  }, [])

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshShell(),
      refreshCollections(),
      refreshShortcuts(),
      refreshSavedIcebergs(),
      refreshAirRecent()
    ])
  }, [refreshAirRecent, refreshCollections, refreshSavedIcebergs, refreshShell, refreshShortcuts])

  const createTab = useCallback(
    async (input?: { url?: string }): Promise<BrowserTabSummary | null> => {
      setNotice(null)

      try {
        const tab = await window.aether.tabs.create(input)
        setActiveTabId(tab.id)
        setDashboardOpen(false)
        setWorkspaceMode('dashboard')
        await refreshShell()
        return tab
      } catch (error) {
        setNotice(getErrorMessage(error))
        return null
      }
    },
    [refreshShell]
  )

  useEffect(() => {
    const unsubscribe = window.aether.events.onState((state: AetherState) => {
      setApps(state.apps)
      setTabs(state.tabs)
      setActiveTabId(state.activeTabId)
      setDashboardOpen(state.dashboardOpen)
      setPanelCollapsed(state.panelCollapsed)
    })

    const refreshTimer = window.setTimeout(() => {
      refreshAll().finally(() => setBusy(null))
    }, 0)

    return () => {
      window.clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [refreshAll])

  // Context-aware ask defaults: viewing a web page defaults to current-page-only; the
  // dashboard (or no open page) defaults to the most-recent hub only. Applied during
  // render (React's "adjust state when context changes" pattern) and guarded by a ref
  // so it runs once per context — within a context, the user's manual toggles stick.
  {
    const onWebPage = !dashboardOpen && Boolean(activeTabUrl) && activeTabUrl !== START_PAGE_URL
    const hubsReady = usableAskCollections.length > 0
    const askContextSignature = onWebPage
      ? `page:${activeTabUrl}`
      : `hub|${hubsReady ? 'hubs' : 'nohubs'}`
    if (appliedAskContextRef.current !== askContextSignature) {
      appliedAskContextRef.current = askContextSignature
      if (onWebPage || !hubsReady) {
        setAskCurrentPageOnly(true)
        setAskIncludeCurrentPage(true)
        setAskCollectionId('')
      } else {
        setAskCurrentPageOnly(false)
        setAskIncludeCurrentPage(false)
        setAskCollectionId(mostRecentHubId)
      }
    }
  }

  useEffect(() => window.aether.events.onFindRequested(openFindBar), [openFindBar])

  useEffect(
    () =>
      window.aether.events.onFindResult((result) => {
        if (result.tabId && activeTab?.id && result.tabId !== activeTab.id) return
        setFindCurrent(result.current)
        setFindTotal(result.total)
      }),
    [activeTab?.id]
  )

  useEffect(() => {
    const unsubscribe = window.aether.events.onChatStream((event) => {
      if (!askRequestIdRef.current || event.requestId !== askRequestIdRef.current) return
      if (event.status) setAskPhase(event.status)
      if (event.citations) setStreamingCitations(event.citations)
      if (event.delta) {
        streamBufferRef.current += event.delta
        if (streamFlushRef.current === null) {
          streamFlushRef.current = window.requestAnimationFrame(() => {
            streamFlushRef.current = null
            setStreamingAnswer(streamBufferRef.current)
          })
        }
      }
    })

    return unsubscribe
  }, [])

  const findQueryRef = useRef(findQuery)
  findQueryRef.current = findQuery

  useEffect(() => {
    if (!findOpen) return
    const timer = window.setTimeout(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
      const query = findQueryRef.current.trim()
      if (query) findHighlight(query, 'find')
    }, 0)
    return () => window.clearTimeout(timer)
  }, [findOpen, findHighlight])

  async function runShortcut(shortcut: AetherShortcutId): Promise<void> {
    switch (shortcut) {
      case 'focus-address':
        if (!dashboardOpen) {
          addressInputRef.current?.focus()
          addressInputRef.current?.select()
        }
        return
      case 'new-tab':
        await createTab()
        return
      case 'open-dashboard':
        await openDashboard()
        return
      case 'open-ice':
        await openCrystallizer()
        return
      case 'open-browser':
        await openBrowser()
        return
      case 'toggle-aion':
        await togglePanel()
        return
      case 'capture-page':
        if (dashboardOpen || startPageActive) {
          setNotice('Open a web page before capturing.')
          return
        }
        await capturePage()
        return
      case 'find-page':
        openFindBar()
        return
      default:
        return
    }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (isBlockedShellShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const shortcut = getShortcutFromKeyboardEvent(event)
      if (shortcut) {
        event.preventDefault()
        event.stopPropagation()
        void runShortcut(shortcut)
        return
      }

      if (getEditableShortcutTarget(event.target)) return
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  useEffect(() => {
    return window.aether.events.onShortcut((shortcut) => {
      void runShortcut(shortcut)
    })
  })

  const showToast = useCallback((input: StatusToastInput): void => {
    if (!input.message || /^starting\s+æ?ther$/i.test(input.message)) return

    const id = toastIdRef.current + 1
    toastIdRef.current = id
    setToast({ ...input, id })
    if (input.durationMs !== 0) {
      window.setTimeout(() => {
        setToast((current) => (current?.id === id ? null : current))
      }, input.durationMs ?? 3600)
    }
    window.aether.layout.showStatusToast(input).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!notice) return
    showToast({
      message: notice,
      tone: getNoticeTone(notice)
    })
  }, [notice, showToast])

  useEffect(() => {
    const unsubscribe = window.aether.events.onCaptureProgress((progress: CaptureProgress) => {
      const suffix =
        progress.total && progress.current !== undefined
          ? ` (${progress.current}/${progress.total})`
          : ''
      const message = `${progress.message}${suffix}`
      setBusy(message)
      showToast({
        message,
        tone: 'info',
        durationMs: 0
      })
    })

    return unsubscribe
  }, [showToast])

  useEffect(() => {
    const unsubscribe = window.aether.events.onModelDownloadProgress((progress) => {
      setModelDownloadProgress((current) => upsertModelProgress(current, progress))
      if (progress.status === 'error') {
        setModelSetupError(progress.message ?? 'Model download failed.')
      }
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (!modelSetupVisible) return
    void window.aether.layout.setModalOverlayOpen(true).catch(() => undefined)
  }, [modelSetupVisible])

  function toggleSetupModel(model: ModelDownloadChoice): void {
    if (modelSetupBusy) return
    setSelectedSetupModels((current) =>
      current.includes(model)
        ? current.filter((item) => item !== model)
        : [...current, model].sort((first, second) =>
            first === second ? 0 : first === 'lite' ? -1 : second === 'lite' ? 1 : 0
          )
    )
  }

  async function closeModelSetup(): Promise<void> {
    if (modelSetupBusy) return
    setModelSetupDismissed(true)
    await window.aether.layout.setModalOverlayOpen(Boolean(settingsOpen || collectionDialog))
  }

  async function startModelSetup(): Promise<void> {
    if (selectedSetupModels.length === 0) {
      setModelSetupError('Choose AiON LiTE, AiON WiSE, or both.')
      return
    }

    setBusy('Installing local models')
    setNotice(null)
    setModelSetupError(null)
    setModelSetupComplete(false)
    setModelDownloadProgress([])
    showToast({ message: 'Installing local models', tone: 'info', durationMs: 0 })

    try {
      const nextStatus = await window.aether.system.downloadModels({
        chatModels: selectedSetupModels
      })
      setStatus(nextStatus)
      setModelSetupComplete(true)
      setNotice('AiON local models installed.')
      window.setTimeout(() => {
        void closeModelSetup()
      }, 900)
    } catch (error) {
      const message = getErrorMessage(error)
      setModelSetupError(message)
      setNotice(message)
    } finally {
      setBusy(null)
    }
  }

  async function openDashboard(): Promise<void> {
    await window.aether.dashboard.open()
    setWorkspaceMode('dashboard')
    setDashboardOpen(true)
  }

  async function openCrystallizer(): Promise<void> {
    await window.aether.dashboard.open()
    setWorkspaceMode('crystallizer')
    setDashboardOpen(true)
  }

  async function openFlow(): Promise<void> {
    await window.aether.dashboard.open()
    setWorkspaceMode('flow')
    setDashboardOpen(true)
    if (!flowGraphResult) {
      void buildFlowGraph()
    }
  }

  async function openAir(): Promise<void> {
    await window.aether.dashboard.open()
    setWorkspaceMode('air')
    setDashboardOpen(true)
    await refreshAirRecent()
  }

  async function openBrowser(): Promise<void> {
    if (activeTab) {
      await window.aether.tabs.activate(activeTab.id)
      setWorkspaceMode('dashboard')
      setDashboardOpen(false)
      return
    }
    await createTab()
  }

  async function activateTab(tabId: string): Promise<void> {
    await window.aether.tabs.activate(tabId)
    setActiveTabId(tabId)
    setWorkspaceMode('dashboard')
    setDashboardOpen(false)
  }

  async function closeTab(tabId: string): Promise<void> {
    try {
      await window.aether.tabs.close(tabId)
      await refreshShell()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  async function closeOtherTabs(tabId: string): Promise<void> {
    setNotice(null)

    try {
      await window.aether.tabs.activate(tabId)
      for (const tab of tabs) {
        if (tab.id !== tabId) {
          await window.aether.tabs.close(tab.id)
        }
      }
      setActiveTabId(tabId)
      setWorkspaceMode('dashboard')
      setDashboardOpen(false)
      await refreshShell()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  async function closeAllTabs(): Promise<void> {
    setNotice(null)

    try {
      const tabIds = tabs.map((tab) => tab.id)
      const blankTab = await window.aether.tabs.create()
      for (const tabId of tabIds) {
        await window.aether.tabs.close(tabId)
      }
      setActiveTabId(blankTab.id)
      setWorkspaceMode('dashboard')
      setDashboardOpen(false)
      await refreshShell()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  function openTabMenuOverlay(): void {
    void window.aether.layout.setModalOverlayOpen(true).catch(() => undefined)
  }

  function closeTabMenuOverlay(): void {
    void window.aether.layout.setModalOverlayOpen(false).catch(() => undefined)
  }

  async function navigate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!activeTab) return

    try {
      await window.aether.tabs.navigate(activeTab.id, addressValue)
      setDashboardOpen(false)
      addressInputRef.current?.blur()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  // Navigate the active (start-page) tab to a destination. The backend normalizes a
  // bare query into a search and lazily creates the tab's webview at the target.
  async function navigateActiveTab(input: string): Promise<void> {
    if (!activeTab) return
    const target = input.trim()
    if (!target) return

    try {
      await window.aether.tabs.navigate(activeTab.id, target)
      setDashboardOpen(false)
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  async function goBack(): Promise<void> {
    if (!activeTab) return

    setNotice(null)
    try {
      await window.aether.tabs.goBack(activeTab.id)
      await refreshShell()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  async function goForward(): Promise<void> {
    if (!activeTab) return

    setNotice(null)
    try {
      await window.aether.tabs.goForward(activeTab.id)
      await refreshShell()
    } catch (error) {
      setNotice(getErrorMessage(error))
    }
  }

  async function saveCollectionDialog(input: {
    name: string
    description: string
    icon: string
  }): Promise<void> {
    if (!collectionDialog || collectionDialog.mode === 'delete') return

    await runTask(
      collectionDialog.mode === 'create' ? 'Creating collection' : 'Updating collection',
      async () => {
        const collection =
          collectionDialog.mode === 'create'
            ? await window.aether.collections.create(input)
            : await window.aether.collections.update({
                id: collectionDialog.collection.id,
                name: input.name,
                description: input.description,
                icon: input.icon
              })
        await closeCollectionDialog()
        await refreshCollections(collection.id)
        setFlowGraphResult(null)
        setNotice(`${collection.name} is ready.`)
      }
    )
  }

  async function confirmDeleteCollection(): Promise<void> {
    if (!collectionDialog || collectionDialog.mode !== 'delete') return

    await runTask('Deleting collection', async () => {
      await window.aether.collections.delete(collectionDialog.collection.id)
      await closeCollectionDialog()
      setChatResult(null)
      setSemanticTrailResult(null)
      setFlowGraphResult(null)
      await refreshCollections()
      setStatus(await window.aether.system.status())
      setNotice('Collection deleted.')
    })
  }

  async function selectCollection(collectionId: string): Promise<void> {
    setSelectedCollectionId(collectionId)
    setAskCollectionId(collectionId)
    setChatResult(null)
  }

  // Record a manual hub pick for the current page so capture auto-routing leaves it alone.
  async function handleCaptureHubSelect(collectionId: string): Promise<void> {
    if (activeTabUrl) manualHubUrlRef.current = activeTabUrl
    await selectCollection(collectionId)
  }

  // Quietly pre-select the hub that best matches the current page. Best-effort and silent:
  // triggered by capture intent (never on page load), never throws, never overrides a manual
  // pick, and discards its own result if the user navigated away while it was running.
  async function maybeSuggestCaptureHub(): Promise<void> {
    if (dashboardOpen || !canUseCurrentPage) return
    const url = activeTabUrl
    if (!url || suggestedHubUrlRef.current === url || manualHubUrlRef.current === url) return
    suggestedHubUrlRef.current = url
    try {
      const suggestion = await window.aether.capture.suggestHub()
      if (!suggestion || activeTabUrlRef.current !== url || manualHubUrlRef.current === url) return
      // If the user is interacting with the hub <select> right now, applying would jump the
      // open dropdown. Stash it and let the select's blur apply it once the popup closes.
      const select = document.getElementById('capture-collection-select')
      if (select && document.activeElement === select) {
        pendingHubSuggestionRef.current = { url, collectionId: suggestion.collectionId }
        return
      }
      setSelectedCollectionId(suggestion.collectionId)
    } catch {
      suggestedHubUrlRef.current = null
    }
  }

  // Apply a suggestion that arrived while the hub <select> was open, now that it has closed.
  function applyPendingHubSuggestion(): void {
    const pending = pendingHubSuggestionRef.current
    pendingHubSuggestionRef.current = null
    if (!pending || pending.url !== activeTabUrlRef.current) return
    if (manualHubUrlRef.current === pending.url) return
    setSelectedCollectionId(pending.collectionId)
  }

  // Open AiON focused on a single hub (from the dashboard "Ask" buttons).
  async function askCollectionHub(collectionId: string): Promise<void> {
    setSelectedCollectionId(collectionId)
    setAskCollectionId(collectionId)
    setAskCurrentPageOnly(false)
    setAskIncludeCurrentPage(false)
    setChatResult(null)
    setAskPanelOpen(true)
    setPanelCollapsed(false)
    await window.aether.layout.setIntelligencePanelCollapsed(false)
  }

  async function capturePage(): Promise<void> {
    if (!selectedCollection) {
      await openCollectionDialog({ mode: 'create' })
      setNotice('Create a collection before capturing.')
      return
    }

    await runTask('Capturing page', async () => {
      const result = await window.aether.capture.currentPage({
        collectionId: selectedCollection.id
      })
      setLastCapture(result)
      await refreshCollections(result.collectionId)
      setStatus(await window.aether.system.status())
      // The page now lives in the hub, so default the ask to that hub and drop the
      // (now duplicate) current-page context.
      setAskCurrentPageOnly(false)
      setAskIncludeCurrentPage(false)
      setAskCollectionId(result.collectionId)
      setSemanticTrailResult(null)
      setFlowGraphResult(null)
      setNotice(`Saved ${result.chunkCount} chunks into ${result.collectionName}.`)
    })
  }

  async function deleteCapture(captureId: string): Promise<void> {
    await runTask('Deleting capture', async () => {
      await window.aether.capture.delete(captureId)
      await refreshCollections(selectedCollection?.id)
      setSemanticTrailResult(null)
      setFlowGraphResult(null)
      setNotice('Capture deleted.')
    })
  }

  async function moveCapture(captureId: string, collectionId: string): Promise<void> {
    await runTask('Moving capture', async () => {
      const capture = await window.aether.capture.move({ captureId, collectionId })
      await refreshCollections(collectionId)
      setChatResult(null)
      setSemanticTrailResult(null)
      setFlowGraphResult(null)
      setNotice(`Moved ${capture.title}.`)
    })
  }

  async function ask(event: FormEvent): Promise<void> {
    event.preventDefault()
    await askPrompt(chatPrompt)
  }

  async function askPrompt(
    prompt: string,
    contextOverride?: { collectionId?: string; includeCurrentPage?: boolean }
  ): Promise<void> {
    const hasKnowledgeHubs = usableAskCollections.length > 0
    const selectedAskCollection =
      askCollection && askCollection.captureCount > 0 && askCollection.chunkCount > 0
        ? askCollection
        : undefined
    const collectionId = contextOverride
      ? contextOverride.collectionId
      : hasKnowledgeHubs && !askCurrentPageOnly
        ? selectedAskCollection?.id
        : undefined
    const includeCurrentPage =
      contextOverride?.includeCurrentPage ??
      (!hasKnowledgeHubs || askCurrentPageOnly || askIncludeCurrentPage)

    if (!collectionId && !includeCurrentPage) {
      setPanelCollapsed(false)
      await window.aether.layout.setIntelligencePanelCollapsed(false)
      setChatPrompt(prompt)
      setNotice('Select a knowledge hub or include the current page before asking ÆTHER.')
      return
    }

    if (includeCurrentPage && !canUseCurrentPage) {
      setNotice('Open a page before asking with current-page context.')
      return
    }

    const requestId = crypto.randomUUID()
    askRequestIdRef.current = requestId
    streamBufferRef.current = ''
    setStreamingAnswer('')
    setStreamingCitations([])
    setAskPhase('Preparing local context')
    setChatResult(null)

    await runTask('Asking ÆTHER', async () => {
      try {
        const result = await window.aether.chat.ask({
          prompt,
          collectionId,
          includeCurrentPage,
          requestId
        })

        setChatResult(result)
        setAskPanelOpen(false)
      } finally {
        askRequestIdRef.current = null
        if (streamFlushRef.current !== null) {
          window.cancelAnimationFrame(streamFlushRef.current)
          streamFlushRef.current = null
        }
        streamBufferRef.current = ''
        setStreamingAnswer('')
        setStreamingCitations([])
        setAskPhase(null)
      }
    })
  }

  function cancelAsk(): void {
    void window.aether.chat.cancel().catch(() => undefined)
  }

  async function handleQuickAction(action: QuickAction): Promise<void> {
    setPanelCollapsed(false)
    await window.aether.layout.setIntelligencePanelCollapsed(false)

    if (action.capture) {
      await capturePage()
      return
    }

    if (!action.prompt) return
    setAskCollectionId('')
    setAskCurrentPageOnly(true)
    setAskIncludeCurrentPage(true)
    setChatPrompt(action.prompt)
    await askPrompt(action.prompt, { collectionId: undefined, includeCurrentPage: true })
  }

  async function saveActiveTabToHub(): Promise<void> {
    if (!activeTab?.url) {
      setNotice('Open a page before saving it to the Hub.')
      return
    }
    if (activeTabSavedToHub && !activeTabHubNeedsMetadata) {
      setNotice('This page is already saved as a portal.')
      return
    }

    const updatingPortal = activeTabSavedToHub
    await runTask('Saving to Hub', async () => {
      await window.aether.hub.create({
        title: activeTab.title || activeTab.host || activeTab.url,
        url: activeTab.url,
        favicon: activeTab.favicon,
        themeColor: activeTab.themeColor
      })
      await refreshShortcuts()
      setNotice(updatingPortal ? 'Updated portal appearance.' : 'Saved to Hub.')
    })
  }

  async function openShortcut(shortcut: HubShortcutSummary): Promise<void> {
    await createTab({ url: shortcut.url })
    setDashboardOpen(false)
  }

  async function openCapture(capture: CaptureSummary): Promise<void> {
    await createTab({ url: capture.url })
    setDashboardOpen(false)
  }

  async function openFlowSource(node: FlowGraphNode): Promise<void> {
    if (!node.url) return
    await createTab({ url: node.url })
    setDashboardOpen(false)
    setWorkspaceMode('dashboard')
  }

  async function openFlowHub(collectionId: string): Promise<void> {
    await selectCollection(collectionId)
    setWorkspaceMode('dashboard')
    setDashboardOpen(true)
  }

  async function openCitation(citation: SearchResult, claimText?: string): Promise<void> {
    const anchorText = resolveCitationAnchorText(citation.text, claimText ?? '')
    const targetUrl = buildCitationTargetUrl(citation, anchorText)
    const activeComparableUrl = activeTab?.url ? normalizeComparableUrl(activeTab.url) : ''
    const citationComparableUrl = normalizeComparableUrl(citation.url)

    if (activeTab?.id && activeComparableUrl === citationComparableUrl) {
      await window.aether.tabs.navigate(activeTab.id, targetUrl)
      setDashboardOpen(false)
      setWorkspaceMode('dashboard')
      scheduleCitationSourceScroll(activeTab.id, anchorText)
      return
    }

    const tab = await createTab({ url: targetUrl })
    if (tab) scheduleCitationSourceScroll(tab.id, anchorText)
    setDashboardOpen(false)
  }

  async function buildSemanticTrail(): Promise<void> {
    if (dashboardOpen || !canUseCurrentPage) {
      setNotice('Open a web page before building Flow.')
      return
    }
    if (!status?.embeddingModel) {
      setNotice('Select a local embedding model before building Flow.')
      return
    }

    await runTask('Building Flow', async () => {
      const result = await window.aether.semanticTrail.generate({
        query: semanticTrailQuery.trim() || undefined,
        limit: 12
      })
      setSemanticTrailResult(result)
      setNotice(
        result.items.length > 0
          ? `Mapped ${result.items.length} sources into Flow.`
          : 'No captured sources matched this page yet.'
      )
    })
  }

  async function buildFlowGraph(query = flowGraphQuery): Promise<void> {
    await runTask('Mapping Flow', async () => {
      const result = await window.aether.flow.graph({
        query: query.trim() || undefined
      })
      setFlowGraphResult(result)
      const fallbackNodeId =
        result.nodes.find((node) => node.kind === 'query')?.id ??
        result.nodes.find((node) => node.kind === 'hub')?.id ??
        result.nodes[0]?.id ??
        null
      setFlowSelectedNodeId((current) =>
        current && result.nodes.some((node) => node.id === current) ? current : fallbackNodeId
      )
      setAirFlowNodeId((current) =>
        current && result.nodes.some((node) => node.id === current) ? current : null
      )
    })
  }

  function buildAirInput(): AirDossierInput {
    const flowNode = selectedAirFlowNode
    const lens =
      airLens.trim() ||
      (airLensKind === 'flow'
        ? flowNode?.title || flowGraphResult?.query || 'Current Flow map'
        : airLensKind === 'hub'
          ? selectedAirHub?.name || 'Selected knowledge hub'
          : airLensKind === 'answer'
            ? 'Latest AiON answer'
            : airLensKind === 'iceberg'
              ? activeSavedIceberg?.title || 'Saved iCE map'
              : '')
    return {
      lens,
      lensKind: airLensKind,
      collectionId:
        airLensKind === 'hub'
          ? selectedAirHub?.id
          : airLensKind === 'flow' && flowNode?.kind === 'hub'
            ? flowNode.collectionId
            : undefined,
      captureId: airLensKind === 'flow' && flowNode?.kind === 'source' ? flowNode.captureId : undefined,
      savedIcebergId: airLensKind === 'iceberg' ? activeSavedIceberg?.id : undefined,
      answer: airLensKind === 'answer' ? chatResult ?? undefined : undefined,
      limit: 12
    }
  }

  function handleAirLensChange(value: string): void {
    setAirLens(value)
    setAirPrepared(null)
    setAirResult(null)
  }

  function handleAirLensKindChange(value: AirLensKind): void {
    setAirLensKind(value)
    if (value === 'hub' && !airHubId && selectedAirHub?.id) {
      setAirHubId(selectedAirHub.id)
      setAirLens(selectedAirHub.name)
    }
    if (value === 'flow' && !airFlowNodeId && selectedAirFlowNode?.id) {
      setAirFlowNodeId(selectedAirFlowNode.id)
      setAirLens(selectedAirFlowNode.title)
    }
    setAirPrepared(null)
    setAirResult(null)
  }

  function useAirLens(kind: AirLensKind, lens: string): void {
    setAirLensKind(kind)
    setAirLens(lens)
    if (kind === 'hub' && selectedAirHub?.id) {
      setAirHubId(selectedAirHub.id)
    }
    if (kind === 'flow' && selectedAirFlowNode?.id) {
      setAirFlowNodeId(selectedAirFlowNode.id)
    }
    setAirPrepared(null)
    setAirResult(null)
  }

  function selectAirHub(collectionId: string): void {
    const collection = collections.find((item) => item.id === collectionId)
    setAirHubId(collectionId)
    setAirLensKind('hub')
    setAirLens(collection?.name ?? '')
    setAirPrepared(null)
    setAirResult(null)
  }

  function selectAirFlowNode(nodeId: string): void {
    const node = flowGraphResult?.nodes.find((item) => item.id === nodeId)
    setAirFlowNodeId(nodeId)
    setAirLensKind('flow')
    setAirLens(node?.title ?? flowGraphResult?.query ?? '')
    setAirPrepared(null)
    setAirResult(null)
  }

  async function prepareAir(): Promise<void> {
    await runTask('Preparing AiR', async () => {
      const prepared = await window.aether.air.prepare(buildAirInput())
      setAirPrepared(prepared)
      setAirResult(null)
    })
  }

  async function renderAir(): Promise<void> {
    await runTask('Rendering AiR', async () => {
      const result = await window.aether.air.render(buildAirInput())
      setAirResult(result)
      await refreshAirRecent()
      setNotice(`Rendered ${result.filename}.`)
    })
  }

  async function openAirFile(path: string): Promise<void> {
    await window.aether.air.open(path)
  }

  async function revealAirFile(path: string): Promise<void> {
    await window.aether.air.reveal(path)
  }

  async function openSemanticTrailItem(item: SemanticTrailItem): Promise<void> {
    await openCitation(
      {
        id: item.id,
        collectionId: item.collectionId,
        captureId: item.captureId,
        appId: item.appId,
        title: item.title,
        url: item.url,
        capturedAt: item.capturedAt,
        chunkIndex: item.chunkIndex,
        text: item.excerpt,
        score: item.score.total
      },
      item.excerpt
    )
  }

  async function generateIceberg(keyword: string): Promise<IcebergResult> {
    setBusy('Crystallizing topic')
    setNotice(null)

    try {
      const result = await window.aether.crystallizer.generate({ keyword })
      setNotice(
        `Mapped ${result.items.length} fragments with ${
          formatVisibleModelName(result.model) ?? result.model
        }.`
      )
      return result
    } catch (error) {
      const message = error instanceof Error ? getErrorMessage(error) : 'Crystallization failed.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function saveIceberg(input: SaveIcebergInput): Promise<SavedIceberg> {
    setBusy('Saving iceberg')
    setNotice(null)

    try {
      const saved = await window.aether.crystallizer.save(input)
      setActiveSavedIceberg(saved)
      await refreshSavedIcebergs()
      setNotice(`Crystallized ${saved.title}.`)
      return saved
    } catch (error) {
      const message = error instanceof Error ? getErrorMessage(error) : 'Saving iceberg failed.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function openSavedIceberg(id: string): Promise<SavedIceberg> {
    setBusy('Opening saved iceberg')
    setNotice(null)

    try {
      const saved = await window.aether.crystallizer.getSaved(id)
      await window.aether.dashboard.open()
      setActiveSavedIceberg(saved)
      setWorkspaceMode('crystallizer')
      setDashboardOpen(true)
      setNotice(`Opened ${saved.title}.`)
      return saved
    } catch (error) {
      const message =
        error instanceof Error ? getErrorMessage(error) : 'Could not open saved iceberg.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function deleteSavedIceberg(id: string): Promise<void> {
    setBusy('Deleting iceberg')
    setNotice(null)

    try {
      await window.aether.crystallizer.deleteSaved(id)
      if (activeSavedIceberg?.id === id) {
        setActiveSavedIceberg(null)
      }
      await refreshSavedIcebergs()
      setNotice('Saved iceberg deleted.')
    } catch (error) {
      const message =
        error instanceof Error ? getErrorMessage(error) : 'Could not delete saved iceberg.'
      setNotice(message)
      throw error
    } finally {
      setBusy(null)
    }
  }

  async function openCrystallizedTopic(_keyword: string, item: IcebergItem): Promise<void> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(`${item.name}`)}`
    await createTab({ url })
    setWorkspaceMode('dashboard')
    setDashboardOpen(false)
  }

  async function deleteShortcut(shortcutId: string): Promise<void> {
    await runTask('Removed shortcut', async () => {
      await window.aether.hub.delete(shortcutId)
      await refreshShortcuts()
    })
  }

  async function reorderShortcuts(ids: string[]): Promise<void> {
    const nextShortcuts = await window.aether.hub.reorder(ids)
    setShortcuts(nextShortcuts)
  }

  async function reorderCollections(ids: string[]): Promise<void> {
    const nextCollections = await window.aether.collections.reorder(ids)
    setCollections(nextCollections)
  }

  async function reorderSavedIcebergs(ids: string[]): Promise<void> {
    const nextIcebergs = await window.aether.crystallizer.reorderSaved(ids)
    setSavedIcebergs(nextIcebergs)
  }

  async function openCollectionDialog(state: NonNullable<CollectionDialogState>): Promise<void> {
    setCollectionDialog(state)
    await window.aether.layout.setModalOverlayOpen(true)
  }

  async function closeCollectionDialog(): Promise<void> {
    setCollectionDialog(null)
    await window.aether.layout.setModalOverlayOpen(false)
  }

  async function openSettings(): Promise<void> {
    setSettingsOpen(true)
    await window.aether.layout.setModalOverlayOpen(true)
  }

  async function closeSettings(): Promise<void> {
    setSettingsOpen(false)
    await window.aether.layout.setModalOverlayOpen(false)
  }

  async function updateDefaultSearchEngine(defaultSearchEngine: SearchEngineId): Promise<void> {
    await runTask('Updating settings', async () => {
      const nextSettings = await window.aether.system.updateSettings({
        browser: { defaultSearchEngine }
      })
      setSettings(nextSettings)
      setNotice('Default search engine updated.')
    })
  }

  async function updateDeveloperMode(developerMode: boolean): Promise<void> {
    await runTask('Updating settings', async () => {
      const nextSettings = await window.aether.system.updateSettings({ developerMode })
      setSettings(nextSettings)
      setNotice(developerMode ? 'Developer Mode enabled.' : 'Developer Mode disabled.')
    })
  }

  async function updateLocalModels(input: {
    embeddingModel?: string
    chatModel?: string
  }): Promise<void> {
    await runTask('Updating local models', async () => {
      const nextStatus = await window.aether.system.updateModels(input)
      setStatus(nextStatus)
      setNotice('Local model selection updated.')
    })
  }

  async function togglePanel(): Promise<void> {
    const next = !panelCollapsed
    setPanelCollapsed(next)
    await window.aether.layout.setIntelligencePanelCollapsed(next)
  }

  async function runTask(label: string, task: () => Promise<void>): Promise<void> {
    setBusy(label)
    setNotice(null)
    // Skip the toast when asking ÆTHER — the user just triggered it themselves,
    // and the intelligence panel already shows the in-progress state.
    if (label !== 'Asking ÆTHER') {
      showToast({
        message: label,
        tone: 'info',
        durationMs: label === 'Capturing page' ? 0 : 2600
      })
    }

    try {
      await task()
    } catch (error) {
      setNotice(getErrorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const crystallizerOpen = dashboardOpen && workspaceMode === 'crystallizer'
  const flowOpen = dashboardOpen && workspaceMode === 'flow'
  const airOpen = dashboardOpen && workspaceMode === 'air'
  const dashboardHomeOpen = dashboardOpen && workspaceMode === 'dashboard'
  const startPageActive = !dashboardOpen && isStartPage

  return (
    <main className={`aether-shell ${panelCollapsed ? 'panel-collapsed' : ''}`}>
      {toast && <StatusToast toast={toast} />}
      {findOpen && !dashboardOpen && !isStartPage && activeTab?.id && (
        <FindBar
          inputRef={findInputRef}
          query={findQuery}
          current={findCurrent}
          total={findTotal}
          onChange={setFindQuery}
          onSearch={(value) => findHighlight(value, 'find')}
          onNext={() => findHighlight(findQuery, 'next')}
          onPrev={() => findHighlight(findQuery, 'prev')}
          onClose={closeFindBar}
        />
      )}
      <div className="window-titlebar" aria-hidden="true">
        <strong>ÆTHER</strong>
      </div>

      <aside className="app-rail">
        <button
          className={`brand-mark tooltip-host ${dashboardHomeOpen ? 'active' : ''}`}
          aria-label="Open ÆTHER dashboard"
          data-tooltip="ÆTHER"
          data-tooltip-side="right"
          onClick={openDashboard}
          title="ÆTHER"
          type="button"
        >
          {/* <img className="brand-mark-image" src="/aether-mark.svg" alt="Aether logo" /> */}
          <CloudIcon />
        </button>
        <nav className="app-list" aria-label="Apps">
          <button
            className={`app-button ice-button tooltip-host ${crystallizerOpen ? 'active' : ''}`}
            data-tooltip='iCE'
            data-tooltip-side='right'
            onClick={openCrystallizer}
            title='iCE'
            type="button"
          >
            {/* <SnowflakeIcon /> */}
            <Snowflake />
            <span className="app-dot" aria-hidden="true" />
          </button>
          <button
            className={`app-button tooltip-host ${!dashboardOpen ? 'active' : ''}`}
            data-tooltip='Discover'
            data-tooltip-side='right'
            onClick={openBrowser}
            title={activeApp ? `${activeApp.name} view` : 'Discover'}
            type="button"
          >
            <GlobeIcon />
            <span className="app-dot" aria-hidden="true" />
          </button>

          {(settings.developerMode ? (
          <div>
            <button
              className={`app-button flow-button tooltip-host ${flowOpen ? 'active' : ''}`}
              data-tooltip="Flow"
              data-tooltip-side="right"
              onClick={openFlow}
              title="Flow"
              type="button"
            >
              <Waves />
              <span className="app-dot" aria-hidden="true" />
            </button>
            <button
              className={`app-button air-button tooltip-host ${airOpen ? 'active' : ''}`}
              data-tooltip="AiR"
              data-tooltip-side="right"
              onClick={openAir}
              title="AiR"
              type="button"
            >
              <Wind />
              <span className="app-dot" aria-hidden="true" />
            </button>
          </div>
        ) : <></>)}
        </nav>
        <button
          className="app-button settings-button"
          aria-label="Open ÆTHER settings"
          onClick={openSettings}
          title='Settings'
          type="button"
        >
          <GearIcon />
        </button>
      </aside>

      <section className={`workspace ${dashboardOpen ? 'dashboard-open' : ''}`}>
        <BrowserChrome
          activeTab={activeTab}
          addressDraft={addressValue}
          addressInputRef={addressInputRef}
          busy={busy}
          capturesBlocked={dashboardOpen || startPageActive}
          collections={collections}
          dashboardOpen={dashboardOpen}
          dashboardSubtitle={
            crystallizerOpen
              ? 'Info Crystallizer Engine'
              : flowOpen
                ? 'Semantic Relation Flow'
                : airOpen
                  ? 'Automated Info Renderer'
                  : 'Knowledge Gatherer'
          }
          dashboardTitle={crystallizerOpen ? 'iCE' : flowOpen ? 'Flow' : airOpen ? 'AiR' : 'ÆTHER'}
          lastCapture={lastCapture}
          portalSaveBlocked={
            dashboardOpen ||
            startPageActive ||
            !activeTab?.url ||
            (activeTabSavedToHub && !activeTabHubNeedsMetadata)
          }
          portalSaveTitle={
            activeTabSavedToHub
              ? activeTabHubNeedsMetadata
                ? 'Refresh portal appearance'
                : 'Already saved as a portal'
              : 'Save current page as portal'
          }
          quickActions={dashboardOpen || startPageActive ? [] : quickActions}
          selectedCollection={selectedCollection}
          selectedCollectionId={selectedCollectionId}
          tabs={tabs}
          onAddressBlur={() => setAddressFocused(false)}
          onAddressChange={setAddressDraft}
          onAddressFocus={() => {
            setAddressDraft(addressValue)
            setAddressFocused(true)
          }}
          onBack={goBack}
          onCloseAllTabs={closeAllTabs}
          onCloseOtherTabs={closeOtherTabs}
          onCloseTab={closeTab}
          onCreateTab={() => createTab()}
          onCapture={capturePage}
          onCreateCollection={() => {
            void openCollectionDialog({ mode: 'create' })
          }}
          onForward={goForward}
          onNavigate={navigate}
          onQuickAction={handleQuickAction}
          onSavePortal={saveActiveTabToHub}
          onSelectTab={activateTab}
          onCaptureIntent={maybeSuggestCaptureHub}
          onCaptureSelectBlur={applyPendingHubSuggestion}
          onSelectCollection={handleCaptureHubSelect}
          onTabMenuClose={closeTabMenuOverlay}
          onTabMenuOpen={openTabMenuOverlay}
        />

        {crystallizerOpen ? (
          <Crystallizer
            busy={busy}
            key={activeSavedIceberg?.id ?? 'new-iceberg'}
            openedIceberg={activeSavedIceberg}
            savedIcebergs={savedIcebergs}
            onDeleteSaved={deleteSavedIceberg}
            onGenerate={generateIceberg}
            onOpenSaved={openSavedIceberg}
            onOpenTopic={openCrystallizedTopic}
            onSave={saveIceberg}
          />
        ) : flowOpen ? (
          <FlowView
            busy={busy}
            collections={collections}
            query={flowGraphQuery}
            result={flowGraphResult}
            selectedNodeId={flowSelectedNodeId}
            status={status}
            onBuildGraph={buildFlowGraph}
            onOpenHub={openFlowHub}
            onOpenSource={openFlowSource}
            onQueryChange={setFlowGraphQuery}
            onSelectedNodeChange={setFlowSelectedNodeId}
          />
        ) : airOpen ? (
          <AirView
            activeSavedIceberg={activeSavedIceberg}
            busy={busy}
            chatResult={chatResult}
            collections={collections}
            flowGraphResult={flowGraphResult}
            lens={airLens}
            lensKind={airLensKind}
            prepared={airPrepared}
            recent={airRecent}
            result={airResult}
            selectedFlowNode={selectedAirFlowNode}
            selectedFlowNodeId={selectedAirFlowNode?.id ?? null}
            selectedCollection={selectedCollection}
            selectedHub={selectedAirHub}
            selectedHubId={selectedAirHub?.id ?? ''}
            status={status}
            onLensChange={handleAirLensChange}
            onLensKindChange={handleAirLensKindChange}
            onOpenFile={openAirFile}
            onPrepare={prepareAir}
            onRender={renderAir}
            onRevealFile={revealAirFile}
            onSelectFlowNode={selectAirFlowNode}
            onSelectHub={selectAirHub}
            onUseLens={useAirLens}
          />
        ) : startPageActive ? (
          <StartPage shortcuts={shortcuts} onNavigate={navigateActiveTab} />
        ) : dashboardOpen ? (
          <Dashboard
            busy={busy}
            capturesByCollection={capturesByCollection}
            collections={collections}
            deleteCapture={deleteCapture}
            deleteSavedIceberg={deleteSavedIceberg}
            deleteShortcut={deleteShortcut}
            moveCapture={moveCapture}
            openCapture={openCapture}
            openSavedIceberg={openSavedIceberg}
            openShortcut={openShortcut}
            openCollectionDialog={(state) => {
              void openCollectionDialog(state)
            }}
            askCollection={(collectionId) => {
              void askCollectionHub(collectionId)
            }}
            reorderCollections={reorderCollections}
            reorderSavedIcebergs={reorderSavedIcebergs}
            reorderShortcuts={reorderShortcuts}
            selectedCollectionId={selectedCollectionId}
            savedIcebergs={savedIcebergs}
            shortcuts={shortcuts}
            selectCollection={selectCollection}
          />
        ) : (
          <div className="webview-underlay" aria-hidden="true" />
        )}
      </section>

      <IntelligencePanel
        busy={busy}
        chatBlocked={chatBlocked}
        chatPrompt={chatPrompt}
        askCollectionId={askCollectionId}
        askCurrentPageOnly={askCurrentPageOnly}
        askIncludeCurrentPage={askIncludeCurrentPage}
        askPanelOpen={askPanelOpen}
        canUseCurrentPage={canUseCurrentPage}
        collections={collections}
        dashboardOpen={dashboardOpen}
        chatResult={chatResult}
        notice={notice}
        panelCollapsed={panelCollapsed}
        askPhase={askPhase}
        streamingAnswer={streamingAnswer}
        streamingCitations={streamingCitations}
        semanticTrailQuery={semanticTrailQuery}
        semanticTrailResult={activeSemanticTrailResult}
        developerMode={settings.developerMode}
        status={status}
        onAsk={ask}
        onAskPanelOpenChange={setAskPanelOpen}
        onBuildSemanticTrail={buildSemanticTrail}
        onCancelAsk={cancelAsk}
        onTogglePanel={togglePanel}
        onChatPromptChange={setChatPrompt}
        onSemanticTrailQueryChange={setSemanticTrailQuery}
        onAskCollectionChange={setAskCollectionId}
        onAskCurrentPageOnlyChange={setAskCurrentPageOnly}
        onAskIncludeCurrentPageChange={setAskIncludeCurrentPage}
        onUpdateModels={updateLocalModels}
        onOpenCitation={openCitation}
        onOpenSemanticTrailItem={openSemanticTrailItem}
      />

      {collectionDialog && (
        <CollectionDialog
          busy={busy}
          state={collectionDialog}
          onClose={() => {
            void closeCollectionDialog()
          }}
          onDelete={confirmDeleteCollection}
          onSave={saveCollectionDialog}
        />
      )}

      {modelSetupVisible && (
        <ModelSetupModal
          busy={modelSetupBusy}
          complete={modelSetupComplete}
          error={modelSetupError}
          modelDir={status?.modelDir ?? ''}
          progress={modelDownloadProgress}
          selectedModels={selectedSetupModels}
          onClose={() => {
            void closeModelSetup()
          }}
          onStart={() => {
            void startModelSetup()
          }}
          onToggleModel={toggleSetupModel}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          busy={busy}
          settings={settings}
          onClose={closeSettings}
          onDefaultSearchEngineChange={updateDefaultSearchEngine}
          onDeveloperModeChange={updateDeveloperMode}
        />
      )}
    </main>
  )
}

function StatusToast({ toast }: { toast: StatusToastInput & { id: number } }): React.JSX.Element {
  return (
    <div className={`status-toast ${toast.tone}`} role="status" aria-live="polite">
      <span aria-hidden="true" />
      <strong>{toast.message}</strong>
    </div>
  )
}

function FindBar({
  inputRef,
  query,
  current,
  total,
  onChange,
  onSearch,
  onNext,
  onPrev,
  onClose
}: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  current: number
  total: number
  onChange: (query: string) => void
  onSearch: (query: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}): React.JSX.Element {
  const debounceRef = useRef<number | null>(null)
  const scheduleSearch = (value: string): void => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      onSearch(value)
    }, 140)
  }
  const flushPending = (): void => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }
  const hasQuery = query.trim().length > 0
  const hasMatches = total > 0
  return (
    <div className="find-bar" role="search">
      <SearchIcon aria-hidden="true" />
      <input
        aria-label="Find in page"
        onChange={(event) => {
          onChange(event.target.value)
          scheduleSearch(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            flushPending()
            if (event.shiftKey) onPrev()
            else onNext()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        placeholder="Find in page"
        ref={inputRef}
        type="search"
        value={query}
      />
      <span
        className={`find-count ${hasQuery && !hasMatches ? 'is-empty' : ''}`}
        aria-live="polite"
      >
        {hasQuery ? `${current}/${total}` : ''}
      </span>
      <div className="find-nav" role="group" aria-label="Match navigation">
        <button
          aria-label="Previous match"
          className="find-nav-button"
          disabled={!hasMatches}
          onClick={() => {
            flushPending()
            onPrev()
          }}
          type="button"
        >
          <ChevronUp aria-hidden="true" />
        </button>
        <button
          aria-label="Next match"
          className="find-nav-button"
          disabled={!hasMatches}
          onClick={() => {
            flushPending()
            onNext()
          }}
          type="button"
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
      <button aria-label="Close find" className="find-close-button" onClick={onClose} type="button">
        ×
      </button>
    </div>
  )
}

function ModelSetupModal({
  busy,
  complete,
  error,
  modelDir,
  progress,
  selectedModels,
  onClose,
  onStart,
  onToggleModel
}: {
  busy: boolean
  complete: boolean
  error: string | null
  modelDir: string
  progress: ModelDownloadProgress[]
  selectedModels: ModelDownloadChoice[]
  onClose: () => void
  onStart: () => void
  onToggleModel: (model: ModelDownloadChoice) => void
}): React.JSX.Element {
  const progressTotal = [...progress]
    .reverse()
    .find((item) => item.overallTotalBytes)?.overallTotalBytes
  const progressDownloaded = progress.reduce(
    (max, item) => Math.max(max, item.overallDownloadedBytes),
    0
  )
  const overallPercent = complete ? 100 : progressPercent(progressDownloaded, progressTotal)
  const canStart = selectedModels.length > 0 && !busy && !complete

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
              <Sparkles aria-hidden="true" />
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
              const selected = selectedModels.includes(option.id)
              return (
                <label className={`model-choice ${selected ? 'selected' : ''}`} key={option.id}>
                  <input
                    checked={selected}
                    disabled={busy}
                    onChange={() => onToggleModel(option.id)}
                    type="checkbox"
                  />
                  <span className="model-choice-check" aria-hidden="true">
                    <Check />
                  </span>
                  <span className="model-choice-icon" aria-hidden="true">
                    {option.id === 'lite' ? <Zap /> : <Cpu />}
                  </span>
                  <span className="model-choice-copy">
                    <strong>{option.name}</strong>
                    <em>{option.title}</em>
                    <small>{option.description}</small>
                    <code>{option.source}</code>
                  </span>
                  <span className="model-choice-size">{option.size}</span>
                </label>
              )
            })}
          </div>

          <aside className="model-setup-side">
            <div className="model-core-card">
              <span>
                <ShieldCheck aria-hidden="true" />
                Required core
              </span>
              <strong>AiON MiST</strong>
              <small>EmbeddingGemma 300M Q8 · 318 MB</small>
              <code>google/embeddinggemma-300m-gguf</code>
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
                  : 'Select a pack'}
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
                        <LoaderCircle />
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
            {busy ? 'Installing' : complete ? 'Installed' : 'Begin Install'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function SettingsModal({
  busy,
  settings,
  onClose,
  onDefaultSearchEngineChange,
  onDeveloperModeChange
}: {
  busy: string | null
  settings: AppSettings
  onClose: () => Promise<void>
  onDefaultSearchEngineChange: (value: SearchEngineId) => Promise<void>
  onDeveloperModeChange: (value: boolean) => Promise<void>
}): React.JSX.Element {
  const searchEngines: Array<{ id: SearchEngineId; name: string; description: string }> = [
    { id: 'google', name: 'Google', description: 'Broad default web search.' },
    { id: 'bing', name: 'Bing', description: 'Microsoft web search.' },
    { id: 'yahoo', name: 'Yahoo!', description: 'Classic portal search.' },
    { id: 'ecosia', name: 'Ecosia', description: 'Privacy-aware search that funds trees.' },
    { id: 'duckduckgo', name: 'DuckDuckGo', description: 'Private search by default.' }
  ]

  return (
    <div
      className="settings-overlay"
      onClick={() => {
        void onClose()
      }}
      role="presentation"
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-body">
        <header>
          <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '18px' }}>
            <GearIcon
              style={{ width: '25px', color: 'var(--accent-strong)', marginBottom: '2px' }}
            />
            <p
              id="settings-title"
              style={{ textAlign: 'center', margin: 'auto', fontSize: '18px' }}
            >
              <span
                style={{
                  fontWeight: 'bold',
                  marginRight: '-1px',
                  color: 'var(--accent-strong)',
                  fontSize: '23px'
                }}
              >
                Æ
              </span>
              ther Settings
            </p>
          </div>
          <button
            className="button"
            onClick={() => {
              void onClose()
            }}
            type="button"
          >
            Close
          </button>
        </header>

        <div className="settings-field">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SearchIcon height={30} width={30} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ margin: 0 }} htmlFor="default-search-engine">
                Default search engine
              </label>
              <p style={{ margin: 0 }}>
                Used when the address bar receives plain search text instead of a URL.
              </p>
            </div>
          </div>
          <div className="settings-engine-list" aria-label="Available search engines">
            {searchEngines.map((engine) => (
              <button
                className={
                  settings.browser.defaultSearchEngine === engine.id ? 'crystal-button' : ''
                }
                disabled={Boolean(busy)}
                key={engine.id}
                onClick={() => onDefaultSearchEngineChange(engine.id)}
                type="button"
              >
                <strong>{engine.name}</strong>
                <span>{engine.description}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-field developer-mode-field">
          <label className="settings-checkbox-row">
            <input
              checked={settings.developerMode}
              disabled={Boolean(busy)}
              onChange={(event) => {
                void onDeveloperModeChange(event.currentTarget.checked)
              }}
              type="checkbox"
            />
            <span>
              <strong>Developer Mode</strong>
              <small>Show technical model names and implementation details in AiON.</small>
            </span>
          </label>
        </div>

        <div className="settings-shortcuts" aria-label="Keyboard shortcuts">
          <div>
            <h2>Shortcuts</h2>
            <p>Editing shortcuts like select all, copy, and paste stay native.</p>
          </div>
          <div className="settings-shortcut-columns">
            {(['Browser', 'Global'] as const).map((scope) => (
              <div className="settings-shortcut-column" key={scope}>
                <h3>{scope}</h3>
                <div className="settings-shortcut-list">
                  {SHORTCUT_HELP.filter((shortcut) => shortcut.scope === scope).map((shortcut) => (
                    <div
                      className="settings-shortcut-row"
                      key={`${shortcut.keys}-${shortcut.action}`}
                    >
                      <kbd>{shortcut.keys}</kbd>
                      <span>{shortcut.action}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        </div>
      </section>
    </div>
  )
}

export default App
