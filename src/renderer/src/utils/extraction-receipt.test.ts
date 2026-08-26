/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CaptureSummary } from '../../../shared/aether'
// Node's ESM resolver needs the real extension; there is no bundler in the loop
// when these run under `node --test`.
import { buildExtractionReceipt } from './extraction-receipt.ts'

// node:assert has no `expect(...).toContain(...)`. Asserting on `.includes()`
// alone would report a bare "expected true to be true", so carry the needle and
// the full output into the failure message.
const contains = (haystack: string, needle: string): void => {
  assert.ok(
    haystack.includes(needle),
    `expected output to contain ${JSON.stringify(needle)}\n--- actual output ---\n${haystack}`,
  )
}

test('serializes the complete persistent extraction receipt', () => {
  const capture: CaptureSummary = {
    id: 'capture-1',
    collectionId: 'hub-1',
    title: 'Article',
    url: 'https://example.com/final',
    appId: 'browser',
    capturedAt: '2026-08-02T10:00:00Z',
    chunkCount: 2,
    fromPrivateTab: false,
    provenance: {
      receiptVersion: 1,
      extractorVersion: 'aether-extract/2',
      requestedUrl: 'https://example.com/start',
      canonicalUrl: 'https://example.com/article',
      author: 'Ada Example',
      siteName: 'Example',
      language: 'en',
      contentHash: 'abc123',
      extractionMethod: 'http-fetch',
      contentScope: 'page',
      contentSelector: 'article',
      wordCount: 320,
      fallbackReason: 'Live DOM unavailable.',
    },
  }

  const receipt = buildExtractionReceipt(capture)
  contains(receipt, 'Receipt version: 1')
  contains(receipt, 'Requested URL: https://example.com/start')
  contains(receipt, 'Canonical URL: https://example.com/article')
  contains(receipt, 'SHA-256: abc123')
  contains(receipt, 'Fallback: Live DOM unavailable.')
})
