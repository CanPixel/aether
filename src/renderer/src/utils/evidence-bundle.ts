import { ChatResult } from '../../../shared/aether'

function quoteMarkdown(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function buildEvidenceBundle(result: ChatResult): string {
  const sections = ['# AiON evidence bundle', '', '## Answer', '', result.answer.trim()]

  if (result.citations.length > 0) {
    sections.push('', '## Evidence')
    result.citations.forEach((citation, index) => {
      sections.push(
        '',
        `### [${index + 1}] ${singleLine(citation.title || citation.url)}`,
        '',
        quoteMarkdown(citation.text),
        '',
        `Source: ${citation.url}`,
        `Captured: ${citation.capturedAt}`,
        `Capture ID: ${citation.captureId}`,
        `Passage: chunk ${citation.chunkIndex + 1}`,
      )
    })
  } else {
    sections.push('', '## Evidence', '', 'No retrieved passages were attached to this answer.')
  }

  sections.push('', '## Generation', '', `Generated locally with ${result.model}.`)
  return sections.join('\n').trim()
}
