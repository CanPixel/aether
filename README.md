# ÆTHER Browser

Æther is a Tauri-native research browser for local knowledge work. It combines normal web browsing, persistent knowledge hubs, local page capture, semantic retrieval, AiON question answering, and the iCE Information Complexity Explorer in one desktop shell, with an Android build path under active migration.

The core idea is simple: browse the web, save useful pages into local knowledge hubs, embed those captures on your machine, and ask questions against that private local context without sending captured page content to a cloud model API.

## What It Does

Current major capabilities:

- Tauri desktop shell using Rust commands and native child webview browser surfaces.
- Browser tabs with dynamic sizing, favicons, page-theme tinting, back/forward history, and dashboard/browser switching.
- Æther dashboard with saved portals, recent captures, and knowledge hub accordions.
- Saved portals can be reordered by dragging and reopened as browser tabs.
- Knowledge hubs can be created, edited, deleted, reordered, assigned icons, and expanded as accordions.
- Captured source cards appear as compact scrollable lists inside hubs and can be dragged between knowledge hubs.
- Capture pipeline extracts readable page text, chunks it, embeds it locally, stores vectors on disk, and persists capture metadata.
- AiON sidepanel provides local search and Ask mode over selected knowledge context.
- AiON Ask supports populated knowledge hubs, current-page context, or both.
- Browser quick actions can prompt AiON against the current page with one click.
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
- Local vector chunk storage
- Retrieval queries
- RAG prompts sent to Ollama
- AiON answers generated through local Ollama models
- iCE topic maps generated through local Ollama models

Normal browsing is still normal browsing. Websites loaded in the browser can make their own network requests, track sessions, run JavaScript, and communicate with their own servers. The privacy boundary applies to Æther's indexing and intelligence pipeline, not to websites themselves.

## Prerequisites

Required:

- Bun for dependency management and scripts.
- Rust and the Tauri platform prerequisites for your target OS.
- macOS, Windows, or Linux for desktop development.
- Android Studio, Android SDK/NDK, and Rust Android targets for Android builds.
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

## Android Build

Æther now has Tauri Android scripts, but the local Android SDK/NDK must be installed before Tauri can initialize or build the Android project.

Install Android Studio, then install these SDK pieces through Android Studio's SDK Manager:

- Android SDK Platform
- Android SDK Build-Tools
- Android SDK Platform-Tools
- Android NDK
- Android Emulator, if you want emulator testing

Set the Android environment variables in your shell profile:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -n 1)"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Install Rust Android targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Accept the Android SDK licenses after installing or updating SDK packages:

```bash
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
```

Initialize the Android project once:

```bash
bun run android:init
```

Run on a connected device or emulator:

```bash
bun run android:dev
```

If this reports `No available Android Emulator detected`, start an emulator from Android Studio's Device Manager or connect a physical device with USB debugging enabled, then confirm it is visible:

```bash
adb devices
```

Build Android release artifacts:

```bash
bun run android:build
```

Build an APK:

```bash
bun run android:build:apk
```

Build an AAB for Play Store distribution:

```bash
bun run android:build:aab
```

Android outputs are generated under:

```text
src-tauri/gen/android/app/build/outputs/
```

Current mobile limitation: the React shell can be packaged for Android, but Æther's current live browser tab surface uses Tauri desktop child webviews. That desktop-only browser surface must be replaced with an Android-compatible browser path before the Android app behaves like the macOS Tauri app.

## Ubuntu Arm64 Build

Use the Docker-based Linux export script to build an Ubuntu arm64 package from macOS or another non-Linux host:

```bash
bun run linux:arm64:build
```

This runs an `ubuntu:24.04` arm64 container, installs the Linux Tauri build dependencies, installs Bun and Rust inside Docker volumes, and builds a `.deb` package for `aarch64-unknown-linux-gnu`.

The default export is a Debian package for Ubuntu:

```bash
bun run linux:arm64:deb
```

Artifacts are generated under:

```text
src-tauri/target-linux-arm64/aarch64-unknown-linux-gnu/release/bundle/
```

The script keeps Linux-specific dependencies out of the host project by mounting Docker volumes for `/work/node_modules`, `/root/.cargo`, `/root/.rustup`, and `/root/.bun`.

Optional overrides:

```bash
LINUX_ARM64_IMAGE=ubuntu:24.04 bun run linux:arm64:build
LINUX_BUNDLES=deb,appimage bun run linux:arm64:build
LINUX_TARGET=aarch64-unknown-linux-gnu bun run linux:arm64:build
```

Build the current desktop app with Tauri:

```bash
bun run build
```

## Project Scripts

| Script                 | Purpose                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`          | Start the Tauri desktop app in development.                                                                                                  |
| `bun run typecheck`    | Run renderer TypeScript checks and Rust `cargo check` for the Tauri backend.                                                                 |
| `bun run lint`         | Run ESLint.                                                                                                                                  |
| `bun run build`        | Typecheck and build the Tauri desktop app.                                                                                                   |
| `bun run android:dev`  | Run the Tauri Android app on a connected device or emulator.                                                                                 |
| `bun run android:build:apk` | Build an Android APK.                                                                                                                   |
| `bun run android:build:aab` | Build an Android App Bundle.                                                                                                           |
| `bun run linux:arm64:build` | Build an Ubuntu arm64 Tauri package in Docker.                                                                                          |
| `bun run linux:arm64:deb` | Build an Ubuntu arm64 `.deb` package in Docker.                                                                                             |
| `bun run dev:electron` | Legacy Electron development path retained for reference during migration.                                                                    |
| `bun run build:electron` | Legacy Electron bundle build retained for reference during migration.                                                                      |
| `bun run build:mac`    | Legacy Electron macOS packaging path. Prefer Tauri builds for the rewrite.                                                                   |
| `bun run build:win`    | Legacy Electron Windows packaging path. Prefer Tauri builds for the rewrite.                                                                 |
| `bun run build:linux`  | Legacy Electron Linux packaging path. Prefer Tauri builds for the rewrite.                                                                   |

## Build Outputs

Important output/resource directories:

| Path     | Owner              | Purpose                                                                                           |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `dist/`  | Vite/Tauri frontend | Compiled renderer assets consumed by Tauri. This is not a distributable app by itself.           |
| `src-tauri/target/` | Tauri/Cargo | Desktop app binaries and bundles generated by `tauri build`.                                      |
| `src-tauri/target-linux-arm64/` | Tauri/Cargo in Docker | Ubuntu arm64 build cache and bundle output.                                      |
| `src-tauri/gen/android/app/build/outputs/` | Tauri Android/Gradle | Android APK/AAB outputs.                                                     |
| `build/` | project resources  | Packaging resources such as icons and macOS entitlements. This is input to packaging, not output. |
| `out/`   | legacy Electron    | Compiled Electron output from the old app path. Retained only while the migration is in progress. |

Common Tauri outputs:

```text
src-tauri/target/release/bundle/
src-tauri/target-linux-arm64/aarch64-unknown-linux-gnu/release/bundle/deb/Æther_1.0.0_arm64.deb
src-tauri/gen/android/app/build/outputs/
```

For quick local desktop testing, prefer:

```bash
bun run dev
```

Use `bun run build` when you need packaged Tauri desktop artifacts.

## Desktop Packaging Notes

Desktop packaging is now driven by Tauri config:

- `src-tauri/tauri.conf.json` is the main desktop/mobile Tauri configuration.
- `src-tauri/tauri.linux.conf.json` limits the Docker Linux arm64 export to `.deb` by default.
- `src-tauri/capabilities/default.json` controls the default Tauri permissions surface.

Local desktop builds are suitable for development on your own machine. For external macOS distribution, configure Apple Developer ID signing and notarization in the Tauri packaging flow before shipping.

If a packaged app behaves differently from development, rebuild from a clean package state:

```bash
bun run build
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
- AI quick actions for current-page prompts.
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
- Captured sources are shown as compact scrollable lists inside expanded hubs.
- Drag captured source cards between hub accordions.
- Click captured source links to open them in a new browser tab.
- Edit/delete hub controls live in the accordion header.

### AiON

AiON is the local intelligence sidepanel.

**Ask mode**:

- Pressing Enter submits a non-empty prompt.
- `Cmd+A` / `Ctrl+A` selects all text in the prompt field.
- Empty hubs with `0 captures` or `0 chunks` are hidden because they cannot contribute context.
- Browser quick actions open AiON and ask against current-page-only context.
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
- Ordered topic list with selected fragment details and click-to-focus canvas zoom.
- Loading state with glassmorphic canvas blur and icy particle effects.
- Staggered reveal after results arrive.

## Local Data Storage

Æther stores app data under Tauri's app data directory.

Current storage paths:

```text
<appData>/aether-library/library.json
<appData>/aether-realms/chunks.json
<appData>/aether-settings/settings.json
<appData>/aether-icebergs/icebergs.json
```

`library.json` stores:

- Knowledge hub summaries.
- Saved portal shortcuts.
- Capture summaries.
- Capture counts.
- Chunk counts.
- Legacy migration flags.

`chunks.json` stores embedded chunk rows:

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
2. The Tauri command validates the selected knowledge hub.
3. The Rust backend reads the active desktop child webview snapshot when available, then falls back to fetching the active URL over HTTP.
4. It collects page URL, title, description, body text, and metadata.
5. Rust parsing normalizes readable text and rejects pages below the minimum readable text threshold.
6. The backend creates overlapping chunks.
7. Chunks are embedded through Ollama's local REST API.
8. Chunk rows are stored on disk.
9. Capture metadata is persisted to `library.json`.
10. Renderer refreshes collection and capture summaries.

Moving a capture between hubs updates both:

- The capture's `collectionId` in `library.json`.
- Matching chunk rows so future search and Ask retrieval follow the moved source.

Deleting a capture removes both:

- The manifest capture summary.
- Matching chunk rows.

## Retrieval And Chat Flow

Search flow:

1. User enters a query.
2. Query is embedded with the configured embedding model.
3. The local chunk store returns nearest chunks scoped to the selected hub.
4. Renderer receives typed `SearchResult` objects.

Ask flow:

1. User chooses current page, a populated hub, or both.
2. If a hub is selected, top chunks are retrieved from the local vector chunk store.
3. If current page is included, the active page is extracted and added as context.
4. Duplicate source citations are merged.
5. The local chat model receives a grounded prompt.
6. AiON renders the markdown answer and citation badges.

The intended answer behavior is grounded: when hub context is used, the model should answer from supplied context rather than inventing unsupported facts.

## Architecture

```text
Renderer React UI
  |
  | window.aether typed API
  v
src/renderer/src/tauri-aether.ts
  |
  | Tauri invoke() commands and event listeners
  v
Rust Tauri Backend
  |
  |-- Native browser view manager
  |     desktop child webview tabs, dashboard visibility, resize, popups, history
  |
  |-- Library storage
  |     knowledge hubs, captures, saved portals, migration metadata
  |
  |-- Settings storage
  |     default search engine and app settings
  |
  |-- Capture pipeline
  |     active page snapshot or fetch -> readable text -> chunks
  |
  |-- Ollama REST client
  |     /api/tags, /api/embed, /api/chat
  |
  |-- Local chunk store
  |     vector search and chunk metadata
  |
  |-- iCE generator
        local chat prompt -> parsed iceberg JSON -> typed renderer result
```

Rust backend responsibilities:

- Owns browser views and tabs.
- Owns file-system writes.
- Owns local chunk storage and vector search.
- Owns Ollama REST calls.
- Owns capture extraction from the active page.
- Exposes typed Tauri command results to the renderer.

Renderer responsibilities:

- App shell and UI state.
- Dashboard, browser chrome, AiON, iCE, modals, and interactions.
- Drag/drop interactions for portals, hubs, and captured source cards.
- Calls typed `window.aether` APIs instead of direct Tauri, database, or file-system access.

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
      tauri-aether.ts             Tauri invoke bridge exposed as window.aether
  main/
    index.ts                      Legacy Electron backend retained for migration reference
  preload/
    index.ts                      Legacy Electron preload bridge
    index.d.ts                    Renderer global typing
src-tauri/
  src/
    lib.rs                        Rust Tauri backend, browser views, stores, commands, RAG, iCE
    main.rs                       Tauri entrypoint
  tauri.conf.json                 Main Tauri configuration
  tauri.linux.conf.json           Linux arm64 bundle override
  capabilities/
    default.json                  Tauri permission capability
  gen/android/                    Generated Tauri Android project
```

## Legacy Electron Configuration

The old Electron project files are still present for migration reference. Packaging for that path is configured in `electron-builder.yml`, but the primary app path is now Tauri.

Important details:

- `directories.buildResources: build`
- `asarUnpack: resources/**`
- Runtime files are packaged from the compiled app and production dependencies.
- `npmRebuild: false` is currently set.
- `publish` is configured as a generic provider pointing at `https://canpixel.com/auto-updates`.

Do not add new features to the legacy Electron path unless you are deliberately comparing behavior with the original app.

## Development Guidelines

Prefer:

- Bun scripts over npm scripts.
- Vite/Tauri-native development over Next.js-style web app assumptions.
- Rust backend ownership for privileged APIs, database work, file writes, and web contents access.
- Typed renderer API contracts through `src/shared/aether.ts` and `src/renderer/src/tauri-aether.ts`.
- Renderer-only components for presentation and interaction logic.
- Local Ollama REST calls rather than cloud model SDKs for app intelligence.

Avoid:

- Direct database access from the renderer.
- Raw Tauri `invoke()` calls spread through renderer components.
- Hard-coded absolute asset URLs that break in packaged Tauri builds.
- Moving capture metadata without also updating chunk metadata.
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

The desktop app allows browser popups through Tauri child webview handling and routes external flows where appropriate. If a specific provider still fails, check whether the site requires browser APIs the system webview does not expose by default, third-party cookies, or platform authenticator behavior that needs additional native integration.

### Packaged app cannot find a frontend dependency

Move the missing runtime package into `dependencies`, reinstall, and rebuild:

```bash
bun install
bun run build
```

### Packaged app has missing dashboard images or renderer assets

Use Vite-compatible asset imports or renderer-public assets. Avoid assuming `/some-file.svg` will resolve the same way in development and inside packaged Tauri assets.

### Rust dependency issues after dependency changes

Recheck and rebuild the Tauri backend:

```bash
bun run typecheck:tauri
bun run build
```

### macOS packaged app has stale bundle behavior

Stale package output can preserve old assets or bundle metadata. Rebuild from a fresh package state:

```bash
bun run build
```

If needed, delete stale `dist/` and `src-tauri/target/release/bundle/` output manually before rebuilding.

### iCE returns invalid or empty results

iCE depends on the local chat model returning parseable JSON. Try:

- Use a stronger chat model.
- Regenerate with a simpler topic.
- Confirm Ollama is reachable.
- Check the model menu for the active chat model.

## Current Limitations

- macOS packages are local unsigned/ad-hoc builds until Developer ID signing and notarization are configured.
- Capture quality depends on page structure, active webview snapshots, and fallback HTTP extraction quality.
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
