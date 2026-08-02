/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { ChatResult } from '../../../shared/aether'
import { buildEvidenceBundle } from './evidence-bundle'

const result: ChatResult = {
  answer: 'The finding is supported by the captured passage [1].',
  model: 'local-model',
  citations: [
    {
      id: 'chunk-1',
      collectionId: 'hub-1',
      captureId: 'capture-1',
      appId: 'browser',
      title: 'Research\nArticle',
      url: 'https://example.com/research',
      capturedAt: '2026-08-02T10:00:00Z',
      chunkIndex: 2,
      text: 'Exact retrieved text.\nSecond line.',
      score: 0.92
    }
  ],
  metrics: {
    generatedTokens: 14,
    tokensPerSecond: 8,
    elapsedSeconds: 2,
    chunks: 1
  }
}

describe('buildEvidenceBundle', () => {
  test('preserves claim markers and includes exact passage provenance', () => {
    const bundle = buildEvidenceBundle(result)

    expect(bundle).toContain('captured passage [1]')
    expect(bundle).toContain('### [1] Research Article')
    expect(bundle).toContain('> Exact retrieved text.\n> Second line.')
    expect(bundle).toContain('Capture ID: capture-1')
    expect(bundle).toContain('Passage: chunk 3')
    expect(bundle).toContain('Generated locally with local-model.')
  })

  test('states when an answer has no evidence', () => {
    const bundle = buildEvidenceBundle({ ...result, citations: [] })
    expect(bundle).toContain('No retrieved passages were attached to this answer.')
  })
})
