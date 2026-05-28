# 🌥️ ÆTHER Browser

Æther is an Electron-native research browser for local knowledge work. It combines normal web browsing, persistent knowledge hubs, local page capture, semantic retrieval, AiON question answering, and the iCE Information Complexity Explorer in one desktop shell.

The core idea is simple: browse the web, save useful pages into local knowledge hubs, embed those captures on your machine, and ask questions against that private local context without sending captured page content to a cloud model API.

## What It Does

Current major capabilities:

- Electron desktop shell using native `WebContentsView` browser surfaces.
- Browser tabs with dynamic sizing, favicons, page-theme tinting, back/forward history, and dashboard/browser switching.
- Æther dashboard with saved portals, recent captures, and knowledge hub accordions.
- Saved portals can be reordered by dragging and reopened as browser tabs.
- Knowledge hubs can be created, edited, deleted, reordered, assigned icons, and expanded as accordions.
- Captured source cards can be dragged between knowledge hubs.
- Capture pipeline extracts readable page text, chunks it, embeds it locally, stores vectors on disk, and persists capture metadata.
- AiON sidepanel provides local search and Ask mode over selected knowledge context.
- AiON Ask supports populated knowledge hubs, current-page context, or both.
- AI answers render as selectable markdown with copy support and clickable citations.
- iCE, the Information Complexity Explorer, generates iceberg-style complexity maps for a topic using the local chat model.
- Settings modal currently supports default search engine selection.
- Ollama model menu supports local model status and model selection.

## Privacy Boundary

Æther's capture, retrieval, and local AI path is designed to stay on the machine.

Local-only pieces:

- Extracted page text
- Capture metadata
- Knowledge hub metadata
- Embeddings
- LanceDB vector storage
- Retrieval queries
- RAG prompts sent to Ollama
- AiON answers generated through local Ollama models
- iCE topic maps generated through local Ollama models

Normal browsing is still normal browsing. Websites loaded in the browser can make their own network requests, track sessions, run JavaScript, and communicate with their own servers. The privacy boundary applies to Æther's indexing and intelligence pipeline, not to websites themselves.

## Prerequisites

Required:

- Bun for dependency management and scripts.
- Electron-supported OS: macOS, Windows, or Linux.
- Ollama running locally at `http://127.0.0.1:11434` for embeddings, AiON, and iCE.

Recommended Ollama models:

```bash
ollama pull nomic-embed-text
ollama pull llama3.1:8b
ollama pull gemma3
ollama pull gemma4
```

Check that Ollama is reachable:

```bash
curl http://127.0.0.1:11434/api/tags
```

Default model behavior:

- Embeddings default to `nomic-embed-text`.
- Chat model preference is `llama3.1:8b`, then `gemma3:latest`, then `gemma3`, then the first available local model.
- The model menu can update the selected embedding and chat models.

## Quick Start

Install dependencies:

```bash
bun install
```

Run the app in development:

```bash
bun run dev
```

Run checks:

```bash
bun run typecheck
bun run lint
```

Build compiled app bundles:

```bash
bun run build
```

Create a local unpacked desktop app:

```bash
bun run build:unpack
```

Open the local Apple silicon app after an unpacked macOS build:

```bash
open dist/mac-arm64/Æther.app
```

## Project Scripts

| Script                 | Purpose                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`          | Start Electron through `electron-vite` for development.                                                                                      |
| `bun run typecheck`    | Run TypeScript checks for main/preload and renderer projects.                                                                                |
| `bun run lint`         | Run ESLint.                                                                                                                                  |
| `bun run build`        | Typecheck and build main, preload, and renderer bundles into `out/`.                                                                         |
| `bun run start`        | Preview the built Electron app through `electron-vite preview`.                                                                              |
| `bun run postinstall`  | Rebuild/install Electron app dependencies through `electron-builder install-app-deps`.                                                       |
| `bun run build:unpack` | Run `bun run build`, then create an unpacked app directory in `dist/`.                                                                       |
| `bun run build:mac`    | Build bundles and create macOS artifacts in `dist/`. This script currently skips `bun run typecheck`, so run checks manually before release. |
| `bun run build:win`    | Build bundles and create Windows artifacts in `dist/`.                                                                                       |
| `bun run build:linux`  | Build bundles and create Linux artifacts in `dist/`.                                                                                         |

## Build Outputs

There are three important output/resource directories:

| Path     | Owner              | Purpose                                                                                           |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `out/`   | `electron-vite`    | Compiled Electron main, preload, and renderer bundles. This is not a distributable app by itself. |
| `dist/`  | `electron-builder` | Packaged apps and installers. This is where `.app`, `.dmg`, `.AppImage`, `.deb`, etc. appear.     |
| `build/` | project resources  | Packaging resources such as icons and macOS entitlements. This is input to packaging, not output. |

Common macOS outputs:

```text
out/main/index.js
out/preload/index.js
out/renderer/

dist/mac-arm64/Æther.app
dist/aether-browser-1.0.0.dmg
```

For quick local testing on Apple silicon, prefer:

```bash
bun run build:unpack
open dist/mac-arm64/Æther.app
```

`build:unpack` creates a real `.app` directory without creating the full installer flow, which makes it useful for checking launch behavior, packaged assets, native dependencies, and the app icon.

## macOS Packaging Notes

Current macOS packaging config in `electron-builder.yml`:

- `appId`: `com.canur.aether`
- `productName`: `Æther`
- `identity: null`
- `notarize: false`
- `entitlementsInherit: build/entitlements.mac.plist`

That means local macOS builds are unsigned/ad-hoc test builds. They are suitable for development on your own machine. For external distribution, configure Apple Developer ID signing and notarization before shipping.

If a packaged app crashes with missing Electron framework or Team ID mismatch, delete stale packaged output and rebuild from a clean package state:

```bash
bun run postinstall
bun run build:unpack
```

## Application Surfaces

### Left Rail

The left rail is the main app switcher:

- Æther opens the dashboard.
- iCE opens the Information Complexity Explorer.
- Web View switches back to browser content.
- Settings opens the global settings modal.
- AiON can be opened from the right-side panel control.

### Browser Chrome

The browser chrome includes:

- Back and forward controls.
- Address/search field.
- Tabs with favicon fallback and dynamic theme tinting.
- New tab creation.
- Capture controls in browser mode.
- Selected knowledge hub dropdown.

Address behavior:

- Full URLs navigate directly.
- Search-like text is sent to the selected default search engine.
- Default search engines currently include Google, Bing, Yahoo, Ecosia, and DuckDuckGo.

### Dashboard

The dashboard is the internal home surface. It shows:

- Saved portals for fast page reopening.
- Knowledge hub accordions.
- Recent captures.
- Capture source cards with hub indicators.

Portal behavior:

- Save the current page as a portal from the browser controls.
- Reorder portals by dragging.
- Open portals into browser tabs.
- Delete portals from the dashboard.

Knowledge hub behavior:

- Create hubs with a name, description, and searchable icon.
- Reorder hubs by dragging.
- Expand a hub to show its captured sources.
- Drag captured source cards between hub accordions.
- Click captured source links to open them in a new browser tab.
- Edit/delete hub controls live in the accordion header.

### AiON

AiON is the local intelligence sidepanel.

**Ask mode**:

- Pressing Enter submits a non-empty prompt.
- Empty hubs with `0 captures` or `0 chunks` are hidden because they cannot contribute context.
- If no populated hubs exist, AiON defaults to current-page-only context.
- If populated hubs exist, rows show icon, hub name, and capture count.
- Current page context can be toggled with a larger button-style control.
- Answers are markdown-rendered, selectable, copyable, and citation-backed.
- Duplicate citation URLs are deduplicated before display.
- Citation clicks open the source in a browser tab.

### iCE Information Complexity Explorer

The iCE view maps a topic into an iceberg-style complexity atlas.

It generates five depth layers:

1. Surface: common language
2. Formation: adjacent concepts
3. Cold Current: methods and mechanisms
4. Black Ice: specialist patterns
5. Abyssal Lattice: hidden edge knowledge

The iCE canvas includes:

- Topic search input.
- Local Ollama generation.
- Manual saving and reopening of generated atlases.
- Zoom in/out/reset controls.
- Smooth view reset and zoom transitions.
- Layer zone tinting and labels.
- Layer filter buttons with counts.
- Disabled filter controls before results exist.
- Ordered topic list with selected fragment details.
- Loading state with glassmorphic canvas blur and icy particle effects.
- Staggered reveal after results arrive.

## Local Data Storage

Æther stores app data under Electron's `app.getPath('userData')`.

Current storage paths:

```text
<userData>/aether-library/library.json
<userData>/aether-realms/chunks.lance
<userData>/aether-settings/settings.json
<userData>/aether-icebergs/icebergs.json
```

`library.json` stores:

- Knowledge hub summaries.
- Saved portal shortcuts.
- Capture summaries.
- Capture counts.
- Chunk counts.
- Legacy migration flags.

`chunks.lance` stores the LanceDB chunk table:

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

`settings.json` stores app preferences such as the default search engine.

`icebergs.json` stores manually saved iCE generations:

- Saved iceberg metadata.
- Original keyword, model, and generation timestamp.
- Full iceberg item lists for reopening in iCE.

## Capture Pipeline

When the current browser page is captured:

1. Renderer calls `window.aether.capture.currentPage({ collectionId })`.
2. Main process validates the selected knowledge hub.
3. Main process reads the active `WebContentsView` page through isolated execution.
4. It collects page URL, title, document HTML, body text fallback, and metadata.
5. `jsdom` parses the HTML.
6. Noisy tags and regions are removed.
7. `@mozilla/readability` extracts article-like content.
8. If Readability returns too little content, body text fallback is used.
9. Pages below the minimum readable text threshold are rejected.
10. LangChain's recursive character splitter creates overlapping chunks.
11. Chunks are embedded through Ollama's local REST API.
12. Chunk rows are inserted into LanceDB.
13. Capture metadata is persisted to `library.json`.
14. Renderer refreshes collection and capture summaries.

Moving a capture between hubs updates both:

- The capture's `collectionId` in `library.json`.
- Matching LanceDB chunk rows so future search and Ask retrieval follow the moved source.

Deleting a capture removes both:

- The manifest capture summary.
- Matching LanceDB chunk rows.

## Retrieval And Chat Flow

Search flow:

1. User enters a query.
2. Query is embedded with the configured embedding model.
3. LanceDB returns nearest chunks scoped to the selected hub.
4. Renderer receives typed `SearchResult` objects.

Ask flow:

1. User chooses current page, a populated hub, or both.
2. If a hub is selected, top chunks are retrieved from LanceDB.
3. If current page is included, the active page is extracted and added as context.
4. Duplicate source citations are merged.
5. The local chat model receives a grounded prompt.
6. AiON renders the markdown answer and citation badges.

The intended answer behavior is grounded: when hub context is used, the model should answer from supplied context rather than inventing unsupported facts.

## Architecture

```text
Renderer React UI
  |
  | window.aether typed preload API
  v
Electron Preload
  |
  | validated IPC channels
  v
Electron Main Process
  |
  |-- AppContainerManager
  |     WebContentsView browser tabs, dashboard visibility, resize, popups, history
  |
  |-- LibraryStore
  |     knowledge hubs, captures, saved portals, migration metadata
  |
  |-- SettingsStore
  |     default search engine and app settings
  |
  |-- Capture pipeline
  |     active page -> jsdom -> Readability -> fallback text -> chunks
  |
  |-- OllamaClient
  |     /api/tags, /api/embed, /api/chat
  |
  |-- LanceDB Chunk Store
  |     vector search and chunk metadata
  |
  |-- iCE generator
        local chat prompt -> parsed iceberg JSON -> typed renderer result
```

Main process responsibilities:

- Owns browser views and tabs.
- Owns file-system writes.
- Owns LanceDB access.
- Owns Ollama REST calls.
- Owns capture extraction from the active page.
- Exposes only typed IPC results to the renderer.

Renderer responsibilities:

- App shell and UI state.
- Dashboard, browser chrome, AiON, iCE, modals, and interactions.
- Drag/drop interactions for portals, hubs, and captured source cards.
- Calls typed `window.aether` APIs instead of direct Electron or database access.

## Typed Renderer API

Renderer code accesses privileged functionality through `window.aether`. The source of truth is `src/shared/aether.ts`.

Representative API surface:

```ts
window.aether.apps.list()
window.aether.apps.activate(appId)
window.aether.apps.navigate(appId, url)
window.aether.apps.goBack(appId)
window.aether.apps.goForward(appId)

window.aether.tabs.list()
window.aether.tabs.create({ url })
window.aether.tabs.activate(tabId)
window.aether.tabs.close(tabId)
window.aether.tabs.navigate(tabId, url)
window.aether.tabs.goBack(tabId)
window.aether.tabs.goForward(tabId)

window.aether.dashboard.open()

window.aether.hub.list()
window.aether.hub.create({ title, url })
window.aether.hub.reorder(ids)
window.aether.hub.delete(id)

window.aether.collections.list()
window.aether.collections.create({ name, description, icon })
window.aether.collections.update({ id, name, description, icon })
window.aether.collections.reorder(ids)
window.aether.collections.delete(id)
window.aether.collections.captures(collectionId)

window.aether.capture.currentPage({ collectionId })
window.aether.capture.move({ captureId, collectionId })
window.aether.capture.delete(captureId)

window.aether.search.collection({ collectionId, query, limit })
window.aether.chat.ask({ collectionId, prompt, includeCurrentPage })

window.aether.crystallizer.generate({ keyword })
window.aether.crystallizer.listSaved()
window.aether.crystallizer.getSaved(id)
window.aether.crystallizer.save({ title, keyword, model, generatedAt, items })
window.aether.crystallizer.deleteSaved(id)

window.aether.system.status()
window.aether.system.settings()
window.aether.system.updateSettings({ browser: { defaultSearchEngine } })
window.aether.system.updateModels({ embeddingModel, chatModel })

window.aether.layout.setIntelligencePanelCollapsed(collapsed)
window.aether.layout.setModalOverlayOpen(open)

window.aether.events.onState(listener)
```

## Source Layout

```text
src/
  main/
    index.ts                      Electron main process, browser views, stores, IPC, RAG, iCE
  preload/
    index.ts                      Typed bridge exposed as window.aether
    index.d.ts                    Renderer global typing
  shared/
    aether.ts                     Shared API, state, settings, capture, chat, and iCE types
  renderer/
    index.html                    Renderer HTML entry
    src/
      App.tsx                     Main shell, app switching, settings, task orchestration
      main.tsx                    React mount
      assets/
        base.css                  Base styling
        main.css                  Main UI system and animations
      components/
        BrowserChrome.tsx         Tabs, address bar, capture controls, favicon/theme tinting
        CaptureDetailCard.tsx     Capture card variant for detail/recent views
        CollectionDialog.tsx      Knowledge hub create/edit/delete modal
        Crystallizer.tsx          iCE Information Complexity Explorer
        Dashboard.tsx             Portals, knowledge hubs, recent captures
        IntelligencePanel.tsx     AiON search/ask sidepanel and model controls
        OllamaStatusMenu.tsx      Ollama status/model popover
        SourceTray.tsx            Search/citation source display
        icons.tsx                 Local icon components
      utils/
        aether-ui.ts              UI formatting helpers
        collection-icon-data.ts   Knowledge hub icon option data
        collection-icons.tsx      Knowledge hub icon renderer
```

## Electron Builder Configuration

Packaging is configured in `electron-builder.yml`.

Important details:

- `directories.buildResources: build`
- `asarUnpack: resources/**`
- Runtime files are packaged from the compiled app and production dependencies.
- `npmRebuild: false` is currently set.
- `publish` is configured as a generic provider pointing at `https://canpixel.com/auto-updates`.

If a module is required at runtime by Electron main, it must be in `dependencies`, not only `devDependencies`. For example, LanceDB requires `apache-arrow`, so `apache-arrow` must be packaged as a runtime dependency.

## Development Guidelines

Prefer:

- Bun scripts over npm scripts.
- Vite/Electron-native development over Next.js-style web app assumptions.
- Main-process ownership for privileged APIs, database work, file writes, and web contents access.
- Typed IPC through `src/shared/aether.ts` and `src/preload/index.ts`.
- Renderer-only components for presentation and interaction logic.
- Local Ollama REST calls rather than cloud model SDKs for app intelligence.

Avoid:

- Direct database access from the renderer.
- Raw Electron IPC from renderer components.
- Hard-coded absolute asset URLs that break in packaged `app.asar` builds.
- Moving capture metadata without also updating LanceDB chunk metadata.
- Adding runtime-only packages to `devDependencies`.

## Troubleshooting

### Ollama is not reachable

Start Ollama and verify the local API:

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

Install a preferred chat model:

```bash
ollama pull llama3.1:8b
ollama pull gemma3
```

Or select an installed model from the AiON model menu.

### Capture says the page has too little readable text

Some pages are login screens, app shells, canvases, PDFs, or script-heavy views with little static readable text. Navigate to a text-heavy page first, then capture again.

### Google SSO or passkey popup does not behave like a normal browser

The app allows browser popups through Electron's window-open handling and routes external flows where appropriate. If a specific provider still fails, check whether the site requires browser APIs Electron does not expose by default, third-party cookies, or platform authenticator behavior that needs additional Electron permissions.

### Packaged app cannot find a module

Move the missing runtime package into `dependencies`, reinstall, and rebuild:

```bash
bun install
bun run postinstall
bun run build:unpack
```

### Packaged app has missing dashboard images or renderer assets

Use Vite-compatible asset imports or renderer-public assets. Avoid assuming `/some-file.svg` will resolve the same way in development and inside packaged `app.asar`.

### Native dependency issues after dependency changes

Rebuild Electron app dependencies:

```bash
bun run postinstall
```

### macOS packaged app fails with Electron Framework Team ID mismatch

Stale package output can preserve mismatched signatures. Rebuild from a fresh package state:

```bash
bun run postinstall
bun run build:unpack
```

If needed, delete stale `dist/` output manually before rebuilding.

### iCE returns invalid or empty results

iCE depends on the local chat model returning parseable JSON. Try:

- Use a stronger chat model.
- Regenerate with a simpler topic.
- Confirm Ollama is reachable.
- Check the model menu for the active chat model.

## Current Limitations

- macOS packages are local unsigned/ad-hoc builds until Developer ID signing and notarization are configured.
- Capture quality depends on page structure and Readability extraction quality.
- App-like authenticated services can still have browser API or popup edge cases.
- iCE generation depends on local model quality and JSON compliance.
- Search and Ask currently use one selected hub plus optional current page, not arbitrary multi-hub selection.
- Settings are intentionally minimal right now.

## Roadmap Ideas

Likely next improvements:

- Production signing and notarization flow.
- Import/export for knowledge hubs.
- Full capture library view with filtering and bulk actions.
- Per-hub retrieval/model settings.
- Better authenticated-app compatibility coverage.
- Capture selected text or a selected DOM region.
- More precise token-aware chunking.
- Local embedding fallback beyond Ollama.
- Richer iCE export/share behavior.
- More complete settings surface.

## License

No license file is currently included. Add one before distributing or accepting external contributions.
