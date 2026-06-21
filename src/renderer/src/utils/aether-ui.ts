import { BrowserTabSummary, IcebergItem, SavedIcebergSummary } from '../../../shared/aether'
import { QuickAction } from '../types/ui'

export function getCaptureHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url || 'local'
  }
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
  if (normalized.includes('embeddinggemma')) return 'EmbeddingGemma 300M'
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

  if (
    role === 'embedding' ||
    normalized.includes('qwen3-embedding') ||
    normalized.includes('embeddinggemma')
  ) {
    return 'AiON MiST' //AiON - FRiDGE - GLACiER - FROSTBiTE - LiQUID - RiFT - MiST - MiNT
  }
  if (normalized.includes('gemma-4-e2b')) return isCommunity ? 'AiON TiNY' : 'AiON LiTE'
  if (normalized.includes('gemma-4-e4b')) return 'AiON WiSE'
  if (normalized.includes('gemma-4-12b')) return 'AiON PRiME'

  return 'AiON'
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
