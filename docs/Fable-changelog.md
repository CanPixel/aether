## What the app is
ÆTHER is a Tauri-native research browser: you browse, capture pages into "knowledge hubs," embed them locally (in-process llama.cpp / candle — no Ollama daemon), then ask grounded questions via the AiON sidepanel or generate iCE topic maps. The architecture is sound; the problem was that the AI loop *felt* slow compared to the Electron-Ollama build.

## Root causes I found
1. **No token streaming.** [lib.rs](aether/src-tauri/src/lib.rs) generated the entire answer before returning anything — you stared at a spinner for the whole generation. Ollama streams by default, which is why the Electron build felt faster even when raw speed was similar.
2. **The vector store was re-read from disk on every operation.** `chunks.json` was pretty-printed JSON with one float per line — 53,000 lines / 1.2 MB for just 68 chunks — fully re-parsed on every search, ask, capture, move, and delete, and growing with every capture.
3. Only the chat model was prewarmed at startup — first capture/search also paid the embedding-model load.

## What I changed
- **Live token streaming**: Rust now emits `aether:chat-stream` events (phase → citations → token deltas). The AiON panel shows the phase ("Searching your knowledge hub", "Reading current page"), then renders the answer markdown live with a caret, auto-scrolls, and swaps in the final cleaned text when done. A guard holds back partial stop-markers (`<end_of_turn>`…) so they never flash on screen.
- **Stop button** during both the loading and streaming states, backed by a cancel flag checked in the prefill and generation loops (also wired into iCE). Cancelling mid-answer keeps the partial text.
- **In-memory vector store cache** (`RwLock` in `Backend`) — loaded once, mutated in memory, persisted as compact JSON. Search now scores under a read lock and clones only the top-k results.
- **Both models prewarm at startup**, so the first ask/capture has zero model-load latency.
- Bug fixes found along the way: `SearchCollectionInput` was missing camelCase deserialization (latent breakage), Crystallizer's saved-iceberg cards nested a `<button>` inside a `<button>` (React hydration error — un-nested to match the CSS that already expected siblings), and removed the dead search-UI plumbing in App/IntelligencePanel.

## Verified live
I couldn't click through the UI (Screen Recording isn't granted to Claude in macOS settings), so I verified with temporary instrumented smoke tests inside the running app (since removed):
- **Hub ask ("What do ferrets eat?", Animals hub): search + query embedding took 50 ms, first token at 1.4 s, 169 deltas streamed at ~65 tok/s, grounded answer with correct citation in 6.9 s total** — previously all of that was a blank spinner.
- Current-page ask: streamed text matched the final cleaned answer byte-for-byte.
- `cargo check` clean, 5/5 Rust tests pass (3 new), `tsc` clean, ESLint 0 errors. 7 files changed, +558/−156. The dev app is still running if you want to try it.

Two notes: the `GGML_ASSERT` in the terminal on quit is a known llama.cpp Metal teardown quirk — shutdown-only, harmless. And I flagged a follow-up chip to restore the AiON local search UI, which the README promises but a past revision dropped (the backend for it works).