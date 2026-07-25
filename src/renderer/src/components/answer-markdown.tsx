import { SearchResult } from '../../../shared/aether'
import { getCaptureHost } from '../utils/aether-ui'

// AiON answer rendering, shared by the desktop intelligence panel and the
// mobile shell: the model's lightweight markdown (headings, lists, bold,
// dividers, inline math) plus clickable [n] citation markers that carry the
// claim sentence they support.

export function renderAnswerMarkdown(
  markdown: string,
  citations: SearchResult[],
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>
): React.ReactNode[] {
  const blocks: React.ReactNode[] = []
  const lines = markdown.split(/\r?\n/)
  let listItems: React.ReactNode[] = []
  let orderedItems: React.ReactNode[] = []

  function flushLists(): void {
    if (listItems.length > 0) {
      blocks.push(<ul key={`ul-${blocks.length}`}>{listItems}</ul>)
      listItems = []
    }
    if (orderedItems.length > 0) {
      blocks.push(<ol key={`ol-${blocks.length}`}>{orderedItems}</ol>)
      orderedItems = []
    }
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      flushLists()
      return
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushLists()
      blocks.push(
        <h3 key={`h-${index}`} className={`answer-heading level-${heading[1].length}`}>
          {renderInlineMarkdown(heading[2], citations, onOpenCitation)}
        </h3>
      )
      return
    }

    // A line of 3+ repeated *, -, or _ (optionally spaced) is a thematic break.
    // Checked before bullets so "* * *" becomes a divider rather than a list item.
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) {
      flushLists()
      blocks.push(<hr key={`hr-${index}`} className="answer-divider" />)
      return
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    if (bullet) {
      orderedItems = []
      listItems.push(
        <li key={`li-${index}`}>{renderInlineMarkdown(bullet[1], citations, onOpenCitation)}</li>
      )
      return
    }

    const numbered = /^\d+\.\s+(.+)$/.exec(trimmed)
    if (numbered) {
      listItems = []
      orderedItems.push(
        <li key={`oli-${index}`}>{renderInlineMarkdown(numbered[1], citations, onOpenCitation)}</li>
      )
      return
    }

    flushLists()
    blocks.push(
      <p key={`p-${index}`}>{renderInlineMarkdown(trimmed, citations, onOpenCitation)}</p>
    )
  })

  flushLists()
  return blocks
}

function markerContainsCitation(marker: string, citationNumber: number): boolean {
  return marker
    .slice(1, -1)
    .split(',')
    .some((value) => Number(value.trim()) === citationNumber)
}

export function claimTextForCitation(answer: string, citationNumber: number): string | undefined {
  const normalized = answer.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized]

  for (const sentence of sentences) {
    const markers = sentence.match(/\[(?:\d+\s*,\s*)*\d+\]/g) ?? []
    if (markers.some((marker) => markerContainsCitation(marker, citationNumber))) {
      return stripInlineMarkup(sentence)
    }
  }

  return undefined
}

// Strip inline markup so the remaining text reads as a plain claim sentence, which
// is what we hand to the citation anchor to locate the exact span in the source.
function stripInlineMarkup(text: string): string {
  return text
    .replace(/\*+/g, '')
    .replace(/\[(?:\d+\s*,\s*)*\d+\]/g, ' ')
    .replace(/\\\(|\\\)|\$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function renderInlineMarkdown(
  text: string,
  citations: SearchResult[],
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>,
  claimText?: string
): React.ReactNode[] {
  // The first (block-level) call establishes the claim; nested calls (e.g. inside
  // bold spans) inherit it so a citation always carries its full sentence.
  const claim = claimText ?? stripInlineMarkup(text)
  const nodes: React.ReactNode[] = []
  // Bold is matched before italic so ** wins over a single *. The italic arm forbids
  // a leading space (`*x*`, not `a * b`) to avoid italicising stray multiplication.
  const pattern =
    /(\*\*[^*]+\*\*|\*(?!\s)[^*\n]+?\*|\$[^$]+\$|\\\([^)]*\\\)|\[(?:\d+\s*,\s*)*\d+\])/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index))
    }

    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={nodes.length}>
          {renderInlineMarkdown(token.slice(2, -2), citations, onOpenCitation, claim)}
        </strong>
      )
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={nodes.length}>
          {renderInlineMarkdown(token.slice(1, -1), citations, onOpenCitation, claim)}
        </em>
      )
    } else if (/^\[(?:\d+\s*,\s*)*\d+\]$/.test(token)) {
      const citationNodes = renderCitationToken(
        token,
        citations,
        onOpenCitation,
        nodes.length,
        claim
      )
      nodes.push(...citationNodes)
    } else {
      nodes.push(
        <span className="answer-inline-math" key={nodes.length}>
          {formatInlineMath(token)}
        </span>
      )
    }

    cursor = match.index + token.length
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}

function renderCitationToken(
  token: string,
  citations: SearchResult[],
  onOpenCitation: (citation: SearchResult, claimText?: string) => Promise<void>,
  keyOffset: number,
  claimText?: string
): React.ReactNode[] {
  const indexes = token
    .slice(1, -1)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)

  if (indexes.length === 0) return [token]

  const nodes: React.ReactNode[] = []
  indexes.forEach((citationNumber, index) => {
    const citation = citations[citationNumber - 1]
    if (!citation) {
      return
    }

    if (index > 0) nodes.push(' ')
    nodes.push(
      <button
        className="answer-citation-link"
        key={`citation-${keyOffset}-${citationNumber}-${index}`}
        onClick={() => {
          void onOpenCitation(citation, claimText)
        }}
        title={`${citation.title} - ${getCaptureHost(citation.url)}`}
        type="button"
      >
        [{citationNumber}]
      </button>
    )
  })

  return nodes
}

function formatInlineMath(token: string): string {
  const inner = token.startsWith('$')
    ? token.slice(1, -1)
    : token.startsWith('\\(')
      ? token.slice(2, -2)
      : token

  return inner
    .replace(/\\text\{([^}]+)\}/g, '$1')
    .replace(/\\mathrm\{([^}]+)\}/g, '$1')
    .replace(/\\mathbf\{([^}]+)\}/g, '$1')
    .replace(/\\,/g, ' ')
    .replace(/\\/g, '')
}
