import { CaptureSummary } from '../../../shared/aether'

export function buildExtractionReceipt(capture: CaptureSummary): string {
  const provenance = capture.provenance
  if (!provenance) {
    return [
      '# AETHER extraction receipt',
      `Captured: ${capture.capturedAt}`,
      `Source: ${capture.url}`,
      'Receipt: legacy capture without extraction provenance',
    ].join('\n')
  }

  const lines = [
    '# AETHER extraction receipt',
    `Receipt version: ${provenance.receiptVersion || 'legacy'}`,
    `Extractor: ${provenance.extractorVersion || 'legacy extractor'}`,
    `Captured: ${capture.capturedAt}`,
    `Record: immutable ${provenance.contentScope}`,
    `Source: ${capture.url}`,
  ]
  if (provenance.requestedUrl && provenance.requestedUrl !== capture.url) {
    lines.push(`Requested URL: ${provenance.requestedUrl}`)
  }
  if (provenance.canonicalUrl) lines.push(`Canonical URL: ${provenance.canonicalUrl}`)
  lines.push(
    `Method: ${provenance.extractionMethod}`,
    `Selector: ${provenance.contentSelector || 'legacy extractor'}`,
    `Words: ${provenance.wordCount}`,
    `SHA-256: ${provenance.contentHash}`,
  )
  if (provenance.author) lines.push(`Author: ${provenance.author}`)
  if (provenance.publishedAt) lines.push(`Published: ${provenance.publishedAt}`)
  if (provenance.siteName) lines.push(`Site: ${provenance.siteName}`)
  if (provenance.language) lines.push(`Language: ${provenance.language}`)
  if (provenance.fallbackReason) lines.push(`Fallback: ${provenance.fallbackReason}`)
  if (provenance.selectionContextBefore) {
    lines.push(`Context before: ${provenance.selectionContextBefore}`)
  }
  if (provenance.selectionContextAfter) {
    lines.push(`Context after: ${provenance.selectionContextAfter}`)
  }
  return lines.join('\n')
}
