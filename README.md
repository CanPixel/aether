# Æther Browser

Æther is an Electron-native research browser that combines app-style browsing with local retrieval-augmented generation. Instead of treating browsing history as a flat stream of pages, Æther captures readable page content into persistent user-defined knowledge hubs, embeds those captures locally through Ollama, stores vectors on disk with LanceDB, and lets you search or ask questions across the resulting knowledge base.

The project goal is a private "contextual research engine": browse the web, capture useful pages, organize them into knowledge hubs, and query those hubs without sending page content or prompts to a cloud inference service.

## Current MVP

The current vertical slice includes:

- Electron shell with a light, spacious Æther dashboard.
- Left rail with dashboard and browser controls.
- Native app container powered by Electron `WebContentsView`.
- Browser tabs, URL entry, back, and forward controls.
- Internal dashboard opened as the app home view.
- Persistent knowledge hubs stored in a local JSON manifest.
- Dashboard hub accordions with draggable captured source cards.
- Portal shortcuts for quickly launching saved pages.
- Capture pipeline for the active browser page.
- Readability-based extraction with a text fallback.
- Chunking through LangChain's recursive character splitter.
- Local embeddings through Ollama's REST API.
- Disk-persistent LanceDB chunk table.
- Semantic search scoped to the selected knowledge hub.
- Ask mode with selectable knowledge hub context and optional current-page context.
- Local chat answers grounded in retrieved chunks with clickable citations.
- Typed preload API between renderer and Electron main.

## Local-Only Design

Æther is intentionally built around a zero-cloud data path for capture and retrieval.

- Page HTML is read from the active Electron `WebContentsView`.
- Extraction, chunking, metadata handling, embedding, storage, search, and chat orchestration run in the Electron main process.
- The renderer never talks directly to LanceDB or raw Electron IPC.
- Ollama is treated as an external local runtime at `http://127.0.0.1:11434`.
- Captured text and vectors are stored under Electron's `app.getPath('userData')`.

The browser may load normal websites, so web traffic still goes wherever the user navigates. The local intelligence pipeline does not send captured content to cloud model APIs.

## Architecture

```text
Renderer React UI
  |
  | typed window.aether preload API
  v
Electron Preload
  |
  | validated IPC channels
  v
Electron Main Process
  |
  |-- AppContainerManager
  |     WebContentsView browser, dashboard visibility, resize, history
  |
  |-- Capture pipeline
  |     page HTML -> jsdom -> Readability -> fallback body text -> chunks
  |
  |-- OllamaClient
  |     GET /api/tags, POST /api/embed, POST /api/chat
  |
  |-- LibraryStore
  |     knowledge hub and capture manifest JSON
  |
  |-- LanceDB Chunk Store
        vectors and scalar metadata in the `chunks` table
```

## Storage Model

Æther stores user data in two local locations under Electron's user data directory.

```text
<userData>/aether-library/library.json
<userData>/aether-realms/chunks.lance
```

`library.json` tracks knowledge hub and capture summaries:

- hub id
- hub name
- description
- created and updated timestamps
- capture count
- chunk count
- migrated legacy realm tables

The LanceDB `chunks` table stores one row per embedded chunk:

- `id`
- `vector`
- `text`
- `collectionId`
- `captureId`
- `title`
- `url`
- `appId`
- `capturedAt`
- `chunkIndex`

Knowledge hubs are the user-facing organization model. A hub can contain one or more page captures, and search/chat are scoped to a hub. Moving a captured source card between hub accordions updates both `library.json` and the LanceDB chunk metadata so retrieval follows the moved source.

## Capture Pipeline

When the user captures the current page:

1. Æther verifies a knowledge hub is selected.
2. The main process reads the active browser page using isolated JavaScript execution.
3. It extracts:
   - `document.documentElement.outerHTML`
   - page URL
   - page title
   - basic metadata
4. The HTML is parsed with `jsdom`.
5. Scripts, styles, forms, and noisy document regions are stripped.
6. `@mozilla/readability` distills the page into article-like text.
7. If Readability returns too little content, Æther falls back to `document.body.innerText`.
8. Captures below the minimum text threshold are rejected with a clear error.
9. Text is split into overlapping chunks.
10. Each chunk receives source metadata.
11. Chunks are embedded locally through Ollama.
12. Chunk rows are inserted into LanceDB.
13. Capture and hub summaries are persisted to `library.json`.

## Retrieval And Chat

Search and chat both start with local embeddings:

1. The query is embedded with the configured embedding model.
2. Æther searches LanceDB for nearest chunks.
3. Search results include citation metadata and distance score.
4. Chat builds a context block from top retrieved chunks.
5. The local chat model is instructed to answer only from supplied context when querying a knowledge hub.

Ask mode supports three practical context shapes:

- current page only, used automatically when no populated knowledge hubs exist
- one populated knowledge hub
- one populated knowledge hub plus the current browser page

Empty hubs with `0 captures` or `0 chunks` are hidden from Ask mode because they cannot contribute retrieval context.

Default models:

- Embeddings: `nomic-embed-text`
- Chat preference order: `llama3.1:8b`, `gemma3:latest`, `gemma3`, then the first available local model

## Prerequisites

- macOS, Linux, or Windows supported by Electron.
- [Bun](https://bun.sh/) for package management and scripts.
- [Ollama](https://ollama.com/) running locally.
- Recommended Ollama models:

```bash
ollama pull nomic-embed-text
ollama pull llama3.1:8b
ollama pull gemma3
```

Confirm Ollama is reachable:

```bash
curl http://127.0.0.1:11434/api/tags
```

## Development

Install dependencies:

```bash
bun install
```

Run the Electron app in development:

```bash
bun run dev
```

Run static checks:

```bash
bun run typecheck
bun run lint
```

Build the app:

```bash
bun run build
```

`bun run build` creates Vite/Electron bundles in `out/` only. It does not create a `.app`, `.dmg`, installer, or unpacked app directory.

Package targets:

```bash
bun run build:unpack
bun run build:mac
bun run build:win
bun run build:linux
```

Packaging is handled by `electron-builder` and writes artifacts to `dist/`.

Common local macOS outputs:

```text
out/main/index.js
out/preload/index.js
out/renderer/

dist/mac-arm64/Æther.app
dist/aether-browser-1.0.0.dmg
```

`out/` is the compiled Electron/Vite application code. `dist/` is the packaged distribution output. `build/` contains packaging resources such as icons and macOS entitlements.

For a local Apple silicon test build, use:

```bash
bun run build:unpack
open dist/mac-arm64/Æther.app
```

The current macOS config uses `identity: null` and `notarize: false`, so local builds are unsigned ad-hoc test builds. For distribution outside your own machine, configure Developer ID signing and notarization before shipping.

## Project Scripts

| Script                 | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `bun run dev`          | Start Electron through `electron-vite` for development.       |
| `bun run typecheck`    | Run TypeScript checks for main/preload and renderer projects. |
| `bun run lint`         | Run ESLint.                                                   |
| `bun run build`        | Typecheck and build main, preload, and renderer bundles.      |
| `bun run start`        | Preview the built Electron app.                               |
| `bun run build:unpack` | Build and create an unpacked Electron app directory.          |
| `bun run build:mac`    | Build renderer/main bundles and a macOS package in `dist/`.   |
| `bun run build:win`    | Build renderer/main bundles and a Windows package in `dist/`. |
| `bun run build:linux`  | Build renderer/main bundles and a Linux package in `dist/`.   |

## Typed Renderer API

Renderer code accesses privileged functionality through `window.aether`.

```ts
window.aether.apps.list()
window.aether.apps.activate(appId)
window.aether.apps.navigate(appId, url)
window.aether.apps.goBack(appId)
window.aether.apps.goForward(appId)

window.aether.dashboard.open()

window.aether.collections.list()
window.aether.collections.create({ name, description })
window.aether.collections.update({ id, name, description })
window.aether.collections.delete(id)
window.aether.collections.captures(collectionId)

window.aether.capture.currentPage({ collectionId })
window.aether.capture.move({ captureId, collectionId })
window.aether.capture.delete(captureId)

window.aether.search.collection({ collectionId, query, limit })
window.aether.chat.ask({ collectionId, prompt, includeCurrentPage })

window.aether.system.status()
window.aether.layout.setIntelligencePanelCollapsed(collapsed)
window.aether.events.onState(listener)
```

The source of truth for API types is `src/shared/aether.ts`.

## Source Layout

```text
src/
  main/
    index.ts          Electron main process, app containers, RAG services, IPC
  preload/
    index.ts          Typed bridge exposed as window.aether
  renderer/
    src/
      App.tsx         Æther shell, dashboard, intelligence panel
      assets/
        main.css      Light mythic UI system
  shared/
    aether.ts         Shared TypeScript API and result types
```

## UI Model

Æther currently uses a restrained, light-mode desktop shell:

- a left rail for home/dashboard and browser
- a top titlebar and browser address bar
- a central dashboard or native web content region
- a right intelligence panel for search and Ask mode

The dashboard is the internal home surface. It shows portal shortcuts and knowledge hubs. Each knowledge hub is an accordion; expanding it shows captured source cards. Source cards can be dragged from one hub accordion to another, while source links remain clickable and open in a new browser tab.

The browser view keeps quick actions, capture controls, the selected hub dropdown, and the address bar. The dashboard view keeps the tab row for fast navigation but hides browser-only quick actions.

The Ask panel lists only populated knowledge hubs. Each row shows the hub icon, name, and capture count. If there are no populated hubs, Ask defaults to current-page-only context.

## Troubleshooting

### `Ollama is not reachable`

Start Ollama and confirm the local API is reachable:

```bash
ollama serve
curl http://127.0.0.1:11434/api/tags
```

### Missing embedding model

Install the default embedding model:

```bash
ollama pull nomic-embed-text
```

### Chat model unavailable

Install one of the preferred chat models:

```bash
ollama pull llama3.1:8b
ollama pull gemma3
```

### Capture says the page has too little readable text

Some pages are login screens, app shells, canvases, or script-heavy views with little static text. Try navigating to a content page first, then capture again.

### Native dependency issues after installing packages

Electron native modules may need rebuilds after dependency changes:

```bash
bun run postinstall
```

### Packaged app cannot find a module

Make sure runtime dependencies are listed in `dependencies`, not only `devDependencies`. For example, LanceDB requires `apache-arrow` at runtime, so it must be packaged with the app.

### Packaged app has missing images or dashboard assets

Renderer assets referenced by the dashboard should live in the renderer asset pipeline and be resolved through Vite-compatible URLs. Avoid hard-coded absolute web paths for packaged-only assets.

### macOS says Electron Framework has a Team ID mismatch

Delete the old packaged output and rebuild. If the issue persists, rebuild app dependencies and create a fresh package:

```bash
bun run postinstall
bun run build:unpack
```

## Implementation Notes

- Æther uses `WebContentsView`, not deprecated `BrowserView`.
- Browser app state is currently managed in the main process.
- The MVP app registry currently exposes a single browser app pointed at `https://www.google.com`.
- Popups are blocked or opened externally depending on flow.
- Legacy realm table migration is handled once and recorded in `library.json`.
- LanceDB stays in the Electron main process; the renderer receives only typed summaries and results.
- The Ollama integration uses direct REST calls instead of the `ollama` npm wrapper to avoid module-shape issues in Electron.
- Capture moves are implemented as a main-process operation that updates the manifest and the LanceDB `collectionId` field for matching chunks.

## Roadmap

Likely next steps:

- Knowledge hub detail editing without prompts.
- Full capture list view with filtering and bulk deletion.
- Import and export for knowledge hubs.
- Better handling for app-like authenticated services.
- Capture selected text or a specific page region.
- WebGPU or local transformer fallback for embeddings.
- More precise token-based chunking.
- Per-hub model and retrieval settings.
- Production packaging polish.

## Privacy Boundary

Æther is designed so local intelligence work stays on the machine. Captured page text, embeddings, knowledge hub metadata, semantic search, and RAG prompts are handled locally through LanceDB and Ollama.

This does not anonymize normal browsing. Websites loaded in the browser can still make their usual network requests, track sessions, and execute their own JavaScript. The privacy guarantee applies to Æther's indexing and inference pipeline.
