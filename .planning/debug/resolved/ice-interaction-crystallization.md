---
status: resolved
trigger: 'iCE card clicks teleport cards to the top-left instead of centering with a slight zoom; Ordered Topics centers without zoom; crystallization intermittently fails for Quantum; percentage labels and Open in Library should be removed.'
created: 2026-07-25T20:55:39+0200
updated: 2026-07-25T21:38:00+0200
---

## Symptoms

- expected: Clicking a canvas card or Ordered Topics entry centers that card and slightly zooms the canvas.
- actual: Canvas-card clicks teleport the raised card to the top-left. Ordered Topics centers without zoom.
- errors: The app reports "Crystallization failed." Intermittently reproducible with "Quantum".
- timeline: These behaviors worked on the main branch and regressed during the overhaul.
- reproduction: Generate an iCE map, click canvas cards and Ordered Topics entries, then repeatedly crystallize "Quantum".
- requested cleanup: Remove floating percentage labels and the "Open in Library" action.

## Current Focus

- hypothesis: confirmed
- test: complete
- expecting: fixed
- next_action: user verification in the native app
- reasoning_checkpoint: The first fix moved handlers onto the foreignObject content but left the unsupported transform path in place. It addressed neither the WebKit relocation trigger nor native SVG hit testing.
- tdd_checkpoint: Added a regression test for recovering complete iceberg items from truncated model output.

## Evidence

- Both canvas cards and the canvas pan handler received events through an SVG `foreignObject`. WebKit did not reliably resolve the previous ancestor guard across that namespace boundary.
- Ordered Topics already used the correct `selectItem` and `focusItem` path. Canvas cards now call the same path directly from their native HTML button.
- The normalizer required a closing array bracket. A model response cut off during its final item discarded every complete item generated before it.
- Generation had a single attempt and a 4200-token output ceiling despite requesting up to 45 richly annotated items.
- The first interaction fix left selected, hover, and focus transforms on the `foreignObject`. That is the WebKit operation responsible for relocating cards to SVG origin.
- Direct pointer handling inside the embedded HTML remained dependent on events crossing the HTML/SVG namespace boundary.

## Eliminated

- The pan/zoom centering formula was not the source of the top-left card jump.
- Topic coverage lookup was not involved in canvas selection.

## Resolution

- root_cause: Canvas presses crossed an unreliable HTML-in-SVG event boundary, while selected and focused states transformed the `foreignObject` and triggered WebKit's top-left relocation bug. The 172% focus target was also too weak to communicate focus consistently. Truncated local-model JSON had no recovery or retry path.
- fix: Made embedded HTML presentation-only, added a native SVG hit rectangle, restored SVG-native click and keyboard handling, removed every local transform from the `foreignObject`, and raised the shared canvas/sidebar focus target to 190%. Also added balanced-object recovery for truncated arrays, one compact low-temperature retry, a 5200-token generation allowance, concrete backend errors, and the requested UI removals.
- verification: `bun run typecheck:web`, `bun run lint`, `bun run build:vite`, and `cargo test --lib` all pass. Rust result: 64 passed, 0 failed, 2 ignored. The new truncated-output regression test passes.
- files_changed: src/renderer/src/components/Crystallizer.tsx, src/renderer/src/assets/styles/crystallizer.css, src/renderer/src/App.tsx, src-tauri/src/iceberg.rs, src-tauri/src/inference.rs, src-tauri/src/lib.rs
