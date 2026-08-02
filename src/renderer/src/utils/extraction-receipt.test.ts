/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { CaptureSummary } from '../../../shared/aether'
import { buildExtractionReceipt } from './extraction-receipt'

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
      fallbackReason: 'Live DOM unavailable.'
    }
  }

  const receipt = buildExtractionReceipt(capture)
  expect(receipt).toContain('Receipt version: 1')
  expect(receipt).toContain('Requested URL: https://example.com/start')
  expect(receipt).toContain('Canonical URL: https://example.com/article')
  expect(receipt).toContain('SHA-256: abc123')
  expect(receipt).toContain('Fallback: Live DOM unavailable.')
})
