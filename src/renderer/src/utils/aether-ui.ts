import {
  AiFreeSearchStatus,
  BrowserTabSummary,
  ContentBlockingStatus,
  IcebergItem,
  ModelDownloadChoice,
  ProxyStatus,
  SavedIcebergSummary,
  TimezonePinStatus,
  UpdateInstallProgress
} from '../../../shared/aether'
import { QuickAction } from '../types/ui'

export function getCaptureHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url || 'local'
  }
}

// "1 source" / "2 sources". English-only, matching the rest of the UI — if ÆTHER is
// ever localized this becomes Intl.PluralRules, but a bespoke rule per call site is
// what produced "1 local citations" in the first place.
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`)
}

// The common case: a count and its noun together.
export function countLabel(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${plural(count, singular, pluralForm)}`
}

// Decimal units, matching what an OS file listing and a release page both report,
// so an export or download size here can be compared with what the user sees there.
export function formatByteSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

// The updater reports a total only when the release host sends a Content-Length,
// so the "of N" half has to be optional rather than showing a fabricated total or
// a progress bar stuck at 0%.
export function formatUpdateProgress(progress: UpdateInstallProgress | null): string {
  if (!progress) return 'Contacting the update server'
  const downloaded = formatByteSize(progress.downloadedBytes)
  if (!progress.totalBytes) return `Downloaded ${downloaded}`
  return `${downloaded} of ${formatByteSize(progress.totalBytes)}`
}

export function cleanTitle(title: string): string {
  if (!title) return ''

  const suffixRegex =
    /[\s\-_|—]+(Wikipedia|YouTube|Reddit.*|GitHub|Twitter|X|Medium|Stack Overflow|LinkedIn|The heart of the internet)$/i

  return title.replace(suffixRegex, '').trim()
}

export function getRootDomainLetter(hostString: string): string {
  if (!hostString) return 'Æ'

  let hostname = hostString.toLowerCase().trim()
  if (hostname.includes('://')) {
    try {
      hostname = new URL(hostname).hostname
    } catch {
      /* empty */
    }
  }

  const cleanHost = hostname.replace(/^(www\.|en\.|m\.|beta\.)/, '')

  // Grab the very first character of the remaining root domain
  return cleanHost.charAt(0).toUpperCase()
}

export function getPortalTint(host: string, themeColor?: string): string {
  const normalized = host.replace(/^www\./, '')
  const brandColors: Record<string, string> = {
    'reddit.com': '#ff8800',
    'youtube.com': '#ff0000',
    'youtu.be': '#ff0000',
    'google.com': '#4285f4',
    'github.com': '#6e7681',
    'duckduckgo.com': '#de5833',
    'ecosia.org': '#39a96b',
    'wikipedia.org': '#727b86'
  }
  const matchedBrand = Object.entries(brandColors).find(
    ([domain]) => normalized === domain || normalized.endsWith(`.${domain}`)
  )
  if (matchedBrand) return matchedBrand[1]
  if (themeColor) return themeColor

  const palette = ['#4f8fd6', '#3aaea1', '#c07f43', '#7772d6', '#4e9a62', '#b95f79', '#547aa5']
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0
  }

  return palette[hash % palette.length]
}

// Tab tint, matched 1:1 with the browser tab strip (see BrowserChrome getTabStyle):
// a hand-tuned brand color, then the page's own theme color, then a stable
// per-host fallback hue.
function getTabBrandTint(host: string): string {
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

function getTabHostTint(host: string): string {
  const palette = ['#4f8fd6', '#3aaea1', '#c07f43', '#7772d6', '#4e9a62', '#b95f79', '#547aa5']
  const key = host || 'aether'
  let hash = 0

  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }

  return palette[hash % palette.length]
}

export function getTabTint(host: string, themeColor?: string): string {
  return getTabBrandTint(host) || themeColor || getTabHostTint(host)
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname === '/') url.pathname = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.trim().replace(/\/$/, '')
  }
}

function formatLocalModelName(model?: string | null): string | null {
  if (!model) return null

  const filename = model.split(/[\\/]/).pop() ?? model
  const normalized = filename.replace(/\.gguf$/i, '').toLowerCase()
  const fullModel = model.toLowerCase()
  const isCommunity = /q4_k_m|lmstudio|community/.test(fullModel)

  if (normalized.includes('qwen3-embedding')) return 'Qwen3 Embedding 0.6B'
  if (normalized.includes('gemma-4-e4b')) return 'Gemma 4 Balanced'
  if (normalized.includes('gemma-4-e2b')) {
    return isCommunity ? 'Gemma 4 E2B - Compact (community)' : 'Gemma 4 Lite'
  }
  if (normalized.includes('gemma-4-12b')) return 'Gemma 4 12B - Desktop'

  return filename
    .replace(/\.gguf$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(qat|gguf|q4 0|it)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
function formatBrandedModelName(
  model?: string | null,
  role: 'chat' | 'embedding' = 'chat'
): string | null {
  if (!model) return null

  const filename = model.split(/[\\/]/).pop() ?? model
  const normalized = filename.replace(/\.gguf$/i, '').toLowerCase()
  const fullModel = model.toLowerCase()
  const isCommunity = /q4_k_m|lmstudio|community/.test(fullModel)

  if (role === 'embedding' || normalized.includes('qwen3-embedding')) {
    return 'AiON MiST' //AiON - FRiDGE - GLACiER - FROSTBiTE - LiQUID - RiFT - MiST - MiNT
  }
  if (normalized.includes('gemma-4-e2b')) return isCommunity ? 'AiON TiNY' : 'AiON LiTE'
  if (normalized.includes('gemma-4-e4b')) return 'AiON WiSE'
  if (normalized.includes('gemma-4-12b')) return 'AiON PRiME'

  return 'AiON'
}

/// One position on the chat-model slider.
export interface ChatModelRung {
  // Stable React key: the ladder id for a known model, the path for anything else.
  key: string
  name: string
  // One short phrase on what picking this costs or buys.
  detail: string
  // The installed model's path. Undefined means this rung is a gap — the model is
  // known to the app but not on disk, so the rung is shown greyed as an install
  // affordance rather than hidden. Hiding it is what sent people hunting for the
  // onboarding modal.
  model?: string
  // Set when the app can fetch this rung itself. A model the user placed by hand
  // has no download to offer, so a gap for it would be unactionable — those only
  // ever appear as rungs when already installed.
  installChoice?: ModelDownloadChoice
}

// Ordered by capability, cheapest first, because that is what makes the control a
// slider rather than a list: moving right always means "more model, more time".
//
// `canonical` marks the two the app can download. Those always get a rung, present
// or not. Anything else appears only when it is actually installed.
const CHAT_MODEL_LADDER: Array<{
  id: string
  name: string
  detail: string
  installChoice?: ModelDownloadChoice
  matches: (normalized: string, isCommunity: boolean) => boolean
}> = [
  {
    id: 'tiny',
    name: 'AiON TiNY',
    detail: 'Community build',
    matches: (normalized, isCommunity) => normalized.includes('gemma-4-e2b') && isCommunity
  },
  {
    id: 'lite',
    name: 'AiON LiTE',
    detail: 'Faster, everyday answers',
    installChoice: 'lite',
    matches: (normalized, isCommunity) => normalized.includes('gemma-4-e2b') && !isCommunity
  },
  {
    id: 'wise',
    name: 'AiON WiSE',
    detail: 'Deeper synthesis and iCE maps',
    installChoice: 'wise',
    matches: (normalized) => normalized.includes('gemma-4-e4b')
  },
  {
    id: 'prime',
    name: 'AiON PRiME',
    detail: 'Largest, slowest',
    matches: (normalized) => normalized.includes('gemma-4-12b')
  }
]

function modelMatchesRung(model: string, rung: (typeof CHAT_MODEL_LADDER)[number]): boolean {
  const filename = model.split(/[\\/]/).pop() ?? model
  const normalized = filename.replace(/\.gguf$/i, '').toLowerCase()
  return rung.matches(normalized, /q4_k_m|lmstudio|community/.test(model.toLowerCase()))
}

/**
 * The slider's positions, given what is installed.
 *
 * Returns the two downloadable rungs plus any other installed chat model, so a
 * hand-placed model is still selectable and is never silently dropped from the UI.
 * Empty only when nothing is installed *and* nothing is installable, which is not a
 * state this app reaches — the caller shows its own "Install Models" button when
 * every rung is a gap.
 */
export function chatModelRungs(installed: string[]): ChatModelRung[] {
  const claimed = new Set<string>()

  const rungs: ChatModelRung[] = CHAT_MODEL_LADDER.flatMap((rung) => {
    const model = installed.find((candidate) => modelMatchesRung(candidate, rung))
    if (model) claimed.add(model)
    // A gap is only worth showing when the app can act on it.
    if (!model && !rung.installChoice) return []
    return [
      {
        key: rung.id,
        name: rung.name,
        detail: rung.detail,
        model,
        installChoice: rung.installChoice
      }
    ]
  })

  // Anything the ladder does not recognise, appended so it stays reachable.
  const extras = installed
    .filter((model) => !claimed.has(model))
    .map((model) => ({
      key: model,
      name: formatBrandedModelName(model, 'chat') ?? model,
      detail: 'Installed locally',
      model
    }))

  return [...rungs, ...extras]
}

export function formatVisibleModelName(
  model?: string | null,
  options: { developerMode?: boolean; role?: 'chat' | 'embedding' } = {}
): string | null {
  return options.developerMode
    ? formatLocalModelName(model)
    : formatBrandedModelName(model, options.role ?? 'chat')
}

export function inferIcebergIcon(
  source: Pick<SavedIcebergSummary, 'keyword'> & { title?: string; items?: IcebergItem[] }
): string {
  const text = `${source.keyword} ${source.title} ${
    source.items?.map((item) => `${item.name} ${item.description}`).join(' ') ?? ''
  }`.toLowerCase()

  const matches: Array<[string, RegExp]> = [
    [
      'code',
      /\b(code|software|programming|developer|javascript|typescript|python|api|github|compiler)\b/
    ],
    ['cpu', /\b(ai|machine learning|llm|neural|computer|hardware|semiconductor|chip|robotics)\b/],
    ['brain', /\b(brain|mind|psychology|cognition|learning|intelligence|memory|behavior)\b/],
    ['flask', /\b(chemistry|experiment|lab|molecule|material|polymer|reaction)\b/],
    ['atom', /\b(physics|quantum|particle|nuclear|energy|thermodynamics)\b/],
    ['dna', /\b(biology|genetic|dna|evolution|organism|cell|protein|ecology)\b/],
    ['heart', /\b(health|medicine|medical|doctor|clinical|disease|therapy|nutrition)\b/],
    ['landmark', /\b(history|politics|government|law|civilization|empire|war|policy|economics)\b/],
    ['briefcase', /\b(business|startup|finance|market|strategy|management|company|product)\b/],
    ['palette', /\b(art|design|visual|painting|typography|fashion|architecture|aesthetic)\b/],
    ['music', /\b(music|song|audio|sound|album|composer|genre)\b/],
    ['film', /\b(film|movie|cinema|television|storytelling|animation|screenplay)\b/],
    ['gamepad', /\b(game|gaming|esport|rpg|simulation|play)\b/],
    ['sprout', /\b(climate|nature|plant|agriculture|sustainability|forest|ocean|environment)\b/],
    ['shield', /\b(security|privacy|cryptography|threat|malware|safety|defense)\b/],
    ['telescope', /\b(space|astronomy|cosmos|planet|star|galaxy|telescope)\b/],
    ['book', /\b(literature|philosophy|book|education|language|writing|research)\b/],
    ['globe', /\b(world|global|culture|geography|travel|internet|web)\b/]
  ]

  return matches.find(([, pattern]) => pattern.test(text))?.[0] ?? 'snowflake'
}

export function getQuickActions(activeTab?: BrowserTabSummary): QuickAction[] {
  if (!activeTab) {
    return [{ id: 'ask-chat', label: 'Ask Chat' }]
  }

  const baseActions: QuickAction[] = [
    { id: 'ask-chat', label: 'Ask Chat' },
    {
      id: 'summarize',
      label: 'Summarize',
      prompt: 'Summarize the current page clearly, using concise sections and local citations.'
    },
    {
      id: 'key-points',
      label: 'Key points',
      prompt: 'Extract the key points from the current page and explain what matters most.'
    }
  ]

  if (activeTab.host.includes('wikipedia.org')) {
    return [
      { id: 'ask-chat', label: 'Ask Chat' },
      {
        id: 'wiki-overview',
        label: 'Wikipedia overview',
        prompt:
          'Give me a clean overview of this Wikipedia article, including the topic, why it matters, and the most important sections.'
      },
      {
        id: 'wiki-timeline',
        label: 'Timeline',
        prompt:
          'Create a brief timeline from this Wikipedia article if dates or historical events appear.'
      },
      {
        id: 'wiki-related',
        label: 'Related concepts',
        prompt:
          'Identify related concepts, people, places, and terms from this Wikipedia article that are worth exploring next.'
      }
    ]
  }

  if (activeTab.host.includes('github.com')) {
    return [
      { id: 'ask-chat', label: 'Ask Chat' },
      {
        id: 'repo-summary',
        label: 'Repo summary',
        prompt:
          'Summarize this GitHub page and explain the project purpose, setup, and important files or issues.'
      },
      {
        id: 'risk-scan',
        label: 'Risks',
        prompt:
          'Review this GitHub page for risks, open questions, missing setup details, or maintenance concerns.'
      }
    ]
  }

  return baseActions
}

// One sentence describing the protection this build actually has, built from what
// the backend reports rather than from the user agent.
//
// The Windows wording is the point of the whole thing. Blocking there is per
// request against a host list, and WebView2 has no equivalent of the rule that
// stops third-party cookies — so a tracker that is not on the list still sets
// them. Saying "tracker blocking is on" and stopping there would be true and
// misleading at the same time.
export function describeContentBlocking(status: ContentBlockingStatus): string {
  if (!status.available) {
    return 'Not available on this platform. Requests are not filtered.'
  }

  const blocked = `Blocks ${countLabel(status.blockedHostCount, 'known tracker domain')} using ${status.engine}.`

  return status.blocksThirdPartyCookies
    ? `${blocked} Third-party cookies are blocked too.`
    : `${blocked} Third-party cookies are not blocked on this platform, so a tracker that is not on the list can still set them.`
}

// Same contract as describeContentBlocking: say what is actually happening for the
// engine in use, including when the answer is "nothing". A toggle that reads as on
// while the selected engine ignores it is the failure this exists to prevent.
export function describeAiFreeSearch(status: AiFreeSearchStatus, engineName: string): string {
  if (!status.available) {
    return `${engineName} has no way to turn AI answers off from a search link, so this setting does nothing while it is selected. Google, Bing and DuckDuckGo all do.`
  }
  return status.enabled
    ? `Searches ask ${engineName} for results without AI-generated answers, using its ${status.mechanism}.`
    : `Off. ${engineName} can suppress AI-generated answers via its ${status.mechanism} when enabled.`
}

// Deliberately never says "anonymous". A proxy hides the IP address and nothing
// else: the browser still presents the same fingerprint to every site, so two
// visits are still joinable to each other even when neither is joinable to a
// location. Overstating that here is how someone ends up trusting this with
// something it was never built to carry. See docs/PRINCIPLES.md.
export function describeProxy(status: ProxyStatus): string {
  if (!status.available) {
    return status.unsupportedReason ?? 'Proxy support is unavailable on this platform.'
  }
  if (!status.enabled) {
    return 'Off. Web traffic goes directly from your own IP address.'
  }
  if (!status.active) {
    return 'On, but the address is not usable — traffic is not being proxied. Check the endpoint below.'
  }
  return `Web traffic and the app's own fetches both route through ${status.url}. This hides your IP address from sites; it does not hide your browser fingerprint.`
}

// Says what it removes and what it does not, because the gap is where someone
// would otherwise assume too much: two bits of entropy is a real improvement and
// nothing like anonymity. See docs/SECURITY.md.
export function describeTimezonePin(status: TimezonePinStatus): string {
  if (!status.available) {
    return status.unsupportedReason ?? 'Timezone pinning is unavailable on this platform.'
  }
  return status.active
    ? 'Pages are told UTC and en-US instead of your own timezone and language, removing two of the bits sites use to recognise a browser. Local times on sites will read wrong.'
    : 'Off. Pages can read your exact timezone and language, which together narrow down who you are. Turning this on reports UTC instead — at the cost of wrong local times.'
}

export function timezonePinChangeNotice(enabled: boolean): string {
  return enabled
    ? 'Timezone pinning enabled. Tabs opened from now on report UTC; reload existing tabs to apply it.'
    : 'Timezone pinning disabled. Tabs opened from now on report your real timezone.'
}

// Open tabs keep whatever routing they were created with, because a webview's
// proxy is fixed when it is built. Worth saying plainly at the moment of change:
// a user who flips this on and watches an already-open tab keep loading has been
// told something true, rather than left to assume the switch failed.
export function proxyChangeNotice(enabled: boolean): string {
  return enabled
    ? 'Proxy enabled. Tabs opened from now on will use it; reload existing tabs to move them across.'
    : 'Proxy disabled. Tabs opened from now on will connect directly.'
}
