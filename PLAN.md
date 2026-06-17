# Semantic Trail for Aether

## Summary
Add an on-demand, local-first **Semantic Trail** inside the existing AiON side panel. It will use the current Tauri + llama.cpp embedding pipeline to rank the active page against all captured knowledge hubs, then show scored source cards and a compact relation graph. No Electron, Ollama, cloud API, external web search, or persistent trail storage in v1.

## Key Changes
- Add a new AiON “Trail” section below/alongside Ask:
  - Button: `Build Semantic Trail`, disabled when no usable active page or embedding model is available.
  - Optional query field defaults to the active page title/readable text seed.
  - Results show a current-page root card, scored source cards, score explanations, and a small graph of relationships.
- Search all captured hub chunks, not only the selected hub.
  - Current page is extracted live but not stored.
  - Captured sources are ranked from `chunks.json` using existing embeddings and cosine distance.
  - Deduplicate results by URL/capture, merge top excerpts, and limit v1 to 12 source cards.
- Use transparent heuristic scoring:
  - Normalize cosine distance to a 0-100 semantic score.
  - Combine semantic similarity, recency, and same-host affinity into a total score.
  - Show deterministic reasons such as “semantic match”, “recent capture”, “same host”, “same collection”.
- Clicking a Trail source reuses the existing citation-opening behavior, including text-fragment scrolling when possible.

## Public API / Types
- Extend `src/shared/aether.ts` and `tauri-aether.ts` with:
  - `window.aether.semanticTrail.generate(input)`
  - `SemanticTrailInput`: `{ query?: string; limit?: number }`
  - `SemanticTrailResult`: `{ query, generatedAt, root, items, edges }`
  - `SemanticTrailItem`: source metadata, excerpt, hub/capture IDs where present, and score breakdown.
  - `SemanticTrailEdge`: simple graph links like `semantic-match`, `same-host`, `same-collection`.
- Add a Tauri command in `src-tauri/src/lib.rs`:
  - `aether_semantic_trail_generate`
  - Reuse existing page extraction, chunk splitting, `local_embed`, vector read helpers, URL normalization, and tab/source opening primitives.
- Do not alter `SearchResult.score`; keep existing Ask/citation behavior stable.

## Test Plan
- Automated:
  - `bun run typecheck:web`
  - `bun run lint`
  - `bun run typecheck`
  - `bun run build:vite`
  - Add Rust unit tests for score normalization, URL dedupe, and reason generation helpers.
- Manual Tauri verification:
  - Capture several pages across at least two hubs, open a related active page, generate a Trail.
  - Confirm all-hub sources appear, scores are sorted high-to-low, and duplicate URLs collapse.
  - Confirm source clicks open the correct page and attempt text-fragment scroll.
  - Confirm empty states for no captures, no embedding model, and unreadable active page.
  - Confirm no automatic model work happens on page load.

## Assumptions
- Chosen defaults: AiON panel, on-demand generation, all captured hubs, ephemeral results, transparent heuristic scoring.
- V1 does not fetch outbound links, query search engines, crawl pages, or save trail sessions.
- No new dependencies are required.
- Keep the existing visual language and font stack; do not introduce Space Grotesk.
