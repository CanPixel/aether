# Æther Browser

Æther is an Electron-native research browser that combines app-style browsing with local retrieval-augmented generation. Instead of treating browsing history as a flat stream of pages, Æther captures readable page content into persistent user-defined collections, embeds those captures locally through Ollama, stores vectors on disk with LanceDB, and lets you search or ask questions across the resulting knowledge base.

The project goal is a private "contextual research engine": browse the web, capture useful pages, organize them into collections, and query those collections without sending page content or prompts to a cloud inference service.

## Current MVP

The current vertical slice includes:

- Electron shell with a light, spacious Æther dashboard.
- Left rail with dashboard and browser controls.
- Native app container powered by Electron `WebContentsView`.
- Browser navigation controls, including URL entry, back, and forward.
- Internal dashboard opened as the app home view.
- Persistent collections stored in a local JSON manifest.
- Capture pipeline for the active browser page.
- Readability-based extraction with a text fallback.
- Chunking through LangChain's recursive character splitter.
- Local embeddings through Ollama's REST API.
- Disk-persistent LanceDB chunk table.
- Semantic search scoped to the selected collection.
- Local chat answers grounded in retrieved collection chunks.
- Typed preload API between renderer and Electron main.

## Local-Only Design

Æther is intentionally built around a zero-cloud data path for capture and retrieval.

- Page HTML is read from the active Electron `WebContentsView`.
- Extraction, chunking, metadata tagging, embedding, storage, search, and chat orchestration run in the Electron main process.
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
  |     collection and capture manifest JSON
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

`library.json` tracks collection and capture summaries:

- collection id
- collection name
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

Collections are the user-facing organization model. A collection can contain one or more page captures, and search/chat are scoped to a collection.

## Capture Pipeline

When the user captures the current page:

1. Æther verifies a collection is selected.
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
13. Capture and collection summaries are persisted to `library.json`.

## Retrieval And Chat

Search and chat both start with local embeddings:

1. The query is embedded with the configured embedding model.
2. Æther searches LanceDB for nearest chunks.
3. Search results include citation metadata and distance score.
4. Chat builds a context block from top retrieved chunks.
5. The local chat model is instructed to answer only from supplied context when querying a collection.

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

Package targets:

```bash
bun run build:mac
bun run build:win
bun run build:linux
```

## Project Scripts

| Script                 | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `bun run dev`          | Start Electron through `electron-vite` for development.       |
| `bun run typecheck`    | Run TypeScript checks for main/preload and renderer projects. |
| `bun run lint`         | Run ESLint.                                                   |
| `bun run build`        | Typecheck and build main, preload, and renderer bundles.      |
| `bun run start`        | Preview the built Electron app.                               |
| `bun run build:unpack` | Build and create an unpacked Electron app directory.          |
| `bun run build:mac`    | Build a macOS package with electron-builder.                  |
| `bun run build:win`    | Build a Windows package with electron-builder.                |
| `bun run build:linux`  | Build a Linux package with electron-builder.                  |

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
- a right intelligence panel for capture, search, and chat

The dashboard is the internal "new tab" surface. It shows collections, recent captures, and the local model status. Opening the browser loads Google by default.

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

## Implementation Notes

- Æther uses `WebContentsView`, not deprecated `BrowserView`.
- Browser app state is currently managed in the main process.
- The MVP app registry currently exposes a single browser app pointed at `https://www.google.com`.
- Popups are blocked or opened externally depending on flow.
- Legacy realm table migration is handled once and recorded in `library.json`.
- LanceDB stays in the Electron main process; the renderer receives only typed summaries and results.
- The Ollama integration uses direct REST calls instead of the `ollama` npm wrapper to avoid module-shape issues in Electron.

## Roadmap

Likely next steps:

- Collection detail editing without prompts.
- Full capture list view with filtering and bulk deletion.
- Import and export for collections.
- Better handling for app-like authenticated services.
- Capture selected text or a specific page region.
- WebGPU or local transformer fallback for embeddings.
- More precise token-based chunking.
- Per-collection model and retrieval settings.
- Production packaging polish.

## Privacy Boundary

Æther is designed so local intelligence work stays on the machine. Captured page text, embeddings, collection metadata, semantic search, and RAG prompts are handled locally through LanceDB and Ollama.

This does not anonymize normal browsing. Websites loaded in the browser can still make their usual network requests, track sessions, and execute their own JavaScript. The privacy guarantee applies to Æther's indexing and inference pipeline.
