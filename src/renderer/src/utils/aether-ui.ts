import { BrowserTabSummary, IcebergItem, SavedIcebergSummary } from '../../../shared/aether'
import { QuickAction } from '../types/ui'

export function getCaptureHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url || 'local'
  }
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
