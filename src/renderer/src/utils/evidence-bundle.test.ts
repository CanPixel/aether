/// <reference types="node" />
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ChatResult } from '../../../shared/aether'
// Node's ESM resolver needs the real extension; there is no bundler in the loop
// when these run under `node --test`.
import { buildEvidenceBundle } from './evidence-bundle.ts'

// node:assert has no `expect(...).toContain(...)`. Asserting on `.includes()`
// alone would report a bare "expected true to be true", so carry the needle and
// the full output into the failure message.
const contains = (haystack: string, needle: string): void => {
  assert.ok(
    haystack.includes(needle),
    `expected output to contain ${JSON.stringify(needle)}\n--- actual output ---\n${haystack}`,
  )
}

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
      score: 0.92,
    },
  ],
  metrics: {
    generatedTokens: 14,
    tokensPerSecond: 8,
    elapsedSeconds: 2,
    chunks: 1,
  },
}

describe('buildEvidenceBundle', () => {
  test('preserves claim markers and includes exact passage provenance', () => {
    const bundle = buildEvidenceBundle(result)

    contains(bundle, 'captured passage [1]')
    contains(bundle, '### [1] Research Article')
    contains(bundle, '> Exact retrieved text.\n> Second line.')
    contains(bundle, 'Capture ID: capture-1')
    contains(bundle, 'Passage: chunk 3')
    contains(bundle, 'Generated locally with local-model.')
  })

  test('states when an answer has no evidence', () => {
    const bundle = buildEvidenceBundle({ ...result, citations: [] })
    contains(bundle, 'No retrieved passages were attached to this answer.')
  })
})
