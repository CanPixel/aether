# ÆTHER Browser

ÆTHER is a Tauri-native research browser for local knowledge work. It combines normal web browsing, persistent knowledge hubs, local page capture, semantic retrieval, AiON question answering, Flow semantic mapping, AiR Markdown dossier rendering, and the iCE Information Complexity Explorer in one desktop shell, with an Android build path under active migration.

The core idea is simple: browse the web, save useful pages into local knowledge hubs, embed those captures on your machine, and ask questions against that private local context without sending captured page content to a cloud model API.

## What It Does

Current major capabilities:

- Tauri desktop shell using Rust commands and native child webview browser surfaces.
- Browser tabs with dynamic sizing, favicons, page-theme tinting, back/forward history, and dashboard/browser switching.
- ÆTHER dashboard with saved portals, saved iCE atlases, and knowledge hub accordions.
- Saved portals can be reordered by dragging and reopened as browser tabs.
- Knowledge hubs can be created, edited, deleted, reordered, assigned icons, and expanded as accordions.
- Captured source cards appear as compact scrollable lists inside hubs and can be dragged between knowledge hubs.
- Capture pipeline extracts readable page text, chunks it, embeds it locally, stores vectors on disk, and persists capture metadata.
- AiON sidepanel provides local search and Ask mode over selected knowledge context.
- AiON Ask supports populated knowledge hubs, current-page context, or both.
- Browser quick actions can prompt AiON against the current page with one click.
- AI answers render as selectable markdown with copy support, compact generation metrics, and clickable citations.
- Flow maps captured hubs and sources into a semantic relation graph with query lenses, node inspection, and source/hub actions.
- AiR renders selected research context into one local Obsidian-friendly Markdown dossier.
- iCE, the Information Complexity Explorer, generates iceberg-style complexity maps for a topic using the local chat model.
- Settings supports default search engine selection, Developer Mode, update checks, and shortcut reference.
- Local model setup can download recommended ungated model files, and the local model menu supports runtime status and model selection for GGUF chat and embedding models.

## Privacy Boundary

ÆTHER's capture, retrieval, and local AI path is designed to stay on the machine.

Local-only pieces:

- Extracted page text
- Capture metadata
- Knowledge hub metadata
- Embeddings
- Local vector chunk storage
- Retrieval queries
- RAG prompts evaluated inside the app process
- AiON answers generated through in-process local models
- Flow graph queries and local semantic relationships
- AiR dossier context, previews, and generated Markdown files
- iCE topic maps generated through in-process local models

Normal browsing is still normal browsing. Websites loaded in the browser can make their own network requests, track sessions, run JavaScript, and communicate with their own servers. The privacy boundary applies to ÆTHER's indexing and intelligence pipeline, not to websites themselves.

## Prerequisites

Required:

- Bun for dependency management and scripts.
- Rust and the Tauri platform prerequisites for your target OS.
- CMake, required for building the bundled llama.cpp Rust binding.
- macOS, Windows, or Linux for desktop development.
- Android Studio, Android SDK/NDK, and Rust Android targets for Android builds.
- GGUF model files for local chat generation and local embeddings.

Recommended first-stage model setup:

- Embeddings: official `Qwen/Qwen3-Embedding-0.6B-GGUF` Q8 GGUF by default.
- Chat/iCE: a Gemma chat GGUF. Official Google Gemma 4 QAT GGUF releases are available for the Gemma 4 family; use an instruction-tuned file such as `gemma-4-E4B-it-qat-q4_0-gguf` or a larger variant if the machine has enough memory.

Chosen models:

Mobile / Z Fold 7:
  Gemma 4 E2B official GGUF
  Optional: E4B only if user chooses a “large mobile model” download

Raspberry Pi 5 16GB:
  E4B official GGUF as the upper practical default
  E2B as fallback / fast mode

Desktop MacBook Pro M5:
  Gemma 4 12B official QAT GGUF

- desktop default: 12B or E4B
- desktop light: E4B
- Pi: E4B
- mobile: E2B default, E4B optional download/import


Model discovery:

- Put chat models in `./aether-models/chat/`.
- Put embedding GGUF files in `./aether-models/embeddings/`.
- Or set `AETHER_CHAT_MODEL=/absolute/path/to/chat.gguf`.
- Or set `AETHER_EMBEDDING_MODEL=/absolute/path/to/embedding.gguf`.
- Or set `AETHER_MODEL_DIR=/absolute/path/to/a/model/folder`.

Default model behavior:

- Embeddings prefer filenames containing `qwen3-embedding`, `embedding`, or `embed`.
- Chat model preference is filenames containing `gemma4`, `gemma-4`, `gemma3`, `gemma-3`, `gemma-2b`, `2b`, `gemma`, or `qwen`, then the first non-embedding GGUF.
- The model menu can update the selected embedding and chat models.
- Chat generation uses the GGUF's embedded chat template when present, preserving Gemma 4 system/user message formatting instead of flattening everything into one prompt. Sampling keeps conservative temperatures while aligning top-k/top-p with the Gemma 4 Ollama defaults.

Fresh installs can use the in-app setup flow to download recommended ungated model files into the app-data model directory. The setup flow is also available from Settings for manual repair or model installation. For manual development installs, place `Qwen3-Embedding-0.6B-Q8_0.gguf` under `aether-models/embeddings/Qwen3-Embedding-0.6B-GGUF/`.

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
bun run build:vite
```

Build compiled app bundles:

```bash
bun run build
```

## Android Build

ÆTHER now has Tauri Android scripts, but the local Android SDK/NDK must be installed before Tauri can initialize or build the Android project.

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

Current mobile limitation: the React shell can be packaged for Android, but ÆTHER's current live browser tab surface uses Tauri desktop child webviews. That desktop-only browser surface must be replaced with an Android-compatible browser path before the Android app behaves like the macOS Tauri app.

## Linux Build

Use the Docker-based Linux build script (`scripts/build-linux.sh`) to build a Linux package from macOS or another non-Linux host. Arch is parametrized, defaulting to arm64:

```bash
bun run linux:arm64:build   # aarch64 .deb
bun run linux:x64:build     # x86_64 .deb
```

This runs an `ubuntu:24.04` container, installs the Linux Tauri + llama.cpp build dependencies (including `cmake`/`clang`), installs Bun and Rust inside Docker volumes, and builds a `.deb`.

The default export is a Debian package for Ubuntu:

```bash
bun run linux:arm64:deb
bun run linux:x64:deb
```

Artifacts are generated under (slug is `arm64` or `x64`):

```text
src-tauri/target-linux-<slug>/<target-triple>/release/bundle/
```

The script keeps Linux-specific dependencies out of the host project by mounting per-arch Docker volumes for `/work/node_modules`, `/root/.cargo`, `/root/.rustup`, and `/root/.bun`.

Note: building x86_64 on an arm64 Mac (or vice-versa) runs under QEMU emulation, which is very slow for the llama.cpp C++ compile. For the non-native arch, prefer CI (see below).

Optional overrides:

```bash
LINUX_IMAGE=ubuntu:24.04 bun run linux:arm64:build
LINUX_BUNDLES=deb,appimage bun run linux:arm64:build
LINUX_DOCKER_PLATFORM=linux/amd64 LINUX_TARGET=x86_64-unknown-linux-gnu LINUX_ARCH_SLUG=x64 bun run linux:arm64:build
```

## Windows, Linux, and Android via CI

Because Tauri cannot cross-compile desktop targets, and llama.cpp builds natively per-OS, the cross-platform installers are produced by `.github/workflows/build.yml`:

- `windows-latest` → NSIS `.exe` / MSI installer.
- `ubuntu-latest` → x86_64 `.deb` and AppImage.
- Android job → APK (best-effort; see the Android limitation note above — and release signing needs a keystore).

Trigger it from the GitHub Actions tab (workflow_dispatch) or by pushing a `v*` tag. Off macOS, llama.cpp runs CPU-only (the `metal` feature is gated to macOS in `src-tauri/Cargo.toml`).

On a `v*` tag push, a final `release` job collects every job's installers and publishes them to a GitHub Release for that tag (Windows `.exe`, Linux `.deb`/AppImage, and the APK if it built). On a manual `workflow_dispatch` run, the installers are uploaded as workflow artifacts instead of a release.

Build the current desktop app with Tauri:

```bash
bun run build
```

## Project Scripts

| Script                 | Purpose                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`          | Start the Tauri desktop app in development.                                                                                                  |
| `bun run start`        | Alias for the Tauri desktop development app.                                                                                                 |
| `bun run dev:vite`     | Start only the Vite renderer dev server on `127.0.0.1:1420`.                                                                                 |
| `bun run format`       | Format the project with Prettier.                                                                                                            |
| `bun run typecheck:web` | Run renderer TypeScript checks.                                                                                                             |
| `bun run typecheck:tauri` | Run Rust `cargo check` for the Tauri backend.                                                                                             |
| `bun run typecheck`    | Run renderer TypeScript checks and Rust `cargo check` for the Tauri backend.                                                                 |
| `bun run lint`         | Run ESLint.                                                                                                                                  |
| `bun run build:vite`   | Build only the Vite renderer assets into `dist/`.                                                                                            |
| `bun run build`        | Typecheck and build the Tauri desktop app.                                                                                                   |
| `bun run build:desktop-local` | Build local desktop packages for the current Tauri target plus Docker Linux arm64/x64 packages.                                      |
| `bun run android:dev`  | Run the Tauri Android app on a connected device or emulator.                                                                                 |
| `bun run android:build:apk` | Build an Android APK.                                                                                                                   |
| `bun run android:build:aab` | Build an Android App Bundle.                                                                                                           |
| `bun run linux:arm64:build` | Build an Ubuntu arm64 Tauri package in Docker.                                                                                          |
| `bun run linux:x64:build` | Build an Ubuntu x86_64 Tauri package in Docker.                                                                                             |
| `bun run linux:arm64:deb` | Build an Ubuntu arm64 `.deb` package in Docker.                                                                                             |
| `bun run linux:x64:deb` | Build an Ubuntu x86_64 `.deb` package in Docker.                                                                                              |

## Build Outputs

Important output/resource directories:

| Path     | Owner              | Purpose                                                                                           |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `dist/`  | Vite/Tauri frontend | Compiled renderer assets consumed by Tauri. This is not a distributable app by itself.           |
| `src-tauri/target/` | Tauri/Cargo | Desktop app binaries and bundles generated by `tauri build`.                                      |
| `src-tauri/target-linux-<slug>/` | Tauri/Cargo in Docker | Ubuntu Linux build cache and bundle output (`arm64` or `x64`).                |
| `src-tauri/gen/android/app/build/outputs/` | Tauri Android/Gradle | Android APK/AAB outputs.                                                     |
| `build/` | project resources  | Packaging resources such as icons. This is input to packaging, not output. |

Common Tauri outputs:

```text
src-tauri/target/release/bundle/
src-tauri/target-linux-arm64/aarch64-unknown-linux-gnu/release/bundle/deb/ÆTHER_1.0.0_arm64.deb
src-tauri/target-linux-x64/x86_64-unknown-linux-gnu/release/bundle/deb/ÆTHER_1.0.0_amd64.deb
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

- ÆTHER opens the dashboard.
- iCE opens the Information Complexity Explorer.
- Flow opens the semantic relation graph for captured knowledge. This rail button is shown in Developer Mode.
- AiR opens the Automatic Information Renderer for Markdown dossier exports. This rail button is shown in Developer Mode.
- Web View switches back to browser content.
- Settings opens the global settings modal.
- AiON can be opened from the right-side panel control.

### Settings

Settings controls app-level preferences:

- Default search engine.
- Developer Mode, which exposes Flow and AiR in the left rail and reveals advanced local-model controls in AiON.
- Keyboard shortcut reference.

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

- Compact saved portals for fast page reopening.
- Compact saved iCE atlases for reopening generated complexity maps.
- Knowledge hub accordions.
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

Saved iCE behavior:

- Saved atlases appear on the dashboard as compact cards.
- Opening an atlas restores its topic, model metadata, and generated depth map in iCE.
- Saved atlases can be deleted from the dashboard.

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
- Completed answers include a small metrics subtitle with token rate, chunk count, and elapsed time.
- Duplicate citation URLs are deduplicated before display.
- Citation clicks open the source in a browser tab.
- The embedded Flow panel auto-updates a semantic trail from the active page or an optional Focus topic.
- Developer Mode exposes expanded local chat and embedding model controls.

### Flow

Flow is a semantic relationship surface for the local knowledge library.

It includes:

- Query input for building a semantic lens across captured sources.
- Automatic embedded AiON trails that refresh from the active page or a typed Focus topic.
- A force-directed relation map with hub, source, and query nodes.
- Calmer graph styling with spacious node placement and lightweight animated water-current treatment.
- An inspector for selected nodes, related matches, and confidence scores.
- Actions to open source URLs, open hub context, or use a selected Flow node as an AiR lens.

Flow uses local embeddings and captured chunk metadata. It is most useful after pages have been captured into knowledge hubs. The dedicated rail view is currently shown only when Developer Mode is enabled.

### AiR Automatic Information Renderer

AiR is the final Markdown export funnel for ÆTHER research. It prepares local context, previews coverage, renders one dossier, and lets the user open or reveal the file immediately.

AiR supports these lens types:

- Topic: search local captured knowledge by typed topic.
- Flow: use the selected Flow node, hub, source, or current Flow query as scoped context.
- Hub: choose a knowledge hub from a dropdown.
- AiON: seed the dossier from the latest AiON answer and citations.
- iCE: render the active saved iceberg as a structured conceptual map.

AiR behavior:

- Preview before writing shows matched sources, citations, proposed sections, confidence, and coverage.
- Rendered files are normal `.md` files with YAML frontmatter and numbered source footnotes.
- File titles and filenames follow `AiR Dossier: <lens>`.
- Preferred export directory is `~/Documents/ÆTHER/AiR/`.
- If Documents cannot be created or written, AiR falls back to the app-data export folder and reports the actual path.
- Recent renders show title, timestamp, lens, source count, and quick open/reveal actions.

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
- In-process local model generation.
- Depth scoring that encourages all five layers to be represented when the topic has enough usable material.
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

ÆTHER stores app data under Tauri's app data directory.

Current storage paths:

```text
<appData>/aether-library/library.json
<appData>/aether-realms/chunks.json
<appData>/aether-settings/settings.json
<appData>/aether-icebergs/icebergs.json
<appData>/aether-air/
~/Documents/ÆTHER/AiR/
./aether-models/
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

`settings.json` stores app preferences such as the default search engine, Developer Mode, and selected local model paths.

`icebergs.json` stores manually saved iCE generations:

- Saved iceberg metadata.
- Original keyword, model, and generation timestamp.
- Full iceberg item lists for reopening in iCE.

AiR dossier exports are written to `~/Documents/ÆTHER/AiR/` when available. `<appData>/aether-air/` is the fallback export directory and is also scanned for recent renders.

## Capture Pipeline

When the current browser page is captured:

1. Renderer calls `window.aether.capture.currentPage({ collectionId })`.
2. The Tauri command validates the selected knowledge hub.
3. The Rust backend reads the active desktop child webview snapshot when available, then falls back to fetching the active URL over HTTP.
4. It collects page URL, title, description, body text, and metadata.
5. Rust parsing normalizes readable text and rejects pages below the minimum readable text threshold.
6. The backend creates overlapping chunks.
7. Chunks are embedded through the in-process llama.cpp runtime.
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

Flow graph flow:

1. User opens Flow, or the embedded AiON Flow trail refreshes automatically from the active page or Focus topic.
2. Optional query text is embedded as a semantic lens.
3. Captured sources and hubs are deduplicated from the local library and chunk store.
4. The backend returns typed graph nodes, semantic edges, containment edges, query-match edges, and scored matches.
5. The renderer lays out and animates the graph locally.

Ask flow:

1. User chooses current page, a populated hub, or both.
2. If a hub is selected, top chunks are retrieved from the local vector chunk store.
3. If current page is included, the active page is extracted and added as context.
4. Duplicate source citations are merged.
5. The local chat model receives a grounded prompt.
6. AiON renders the markdown answer, compact metrics subtitle, and citation badges.

The intended answer behavior is grounded: when hub context is used, the model should answer from supplied context rather than inventing unsupported facts.

AiR render flow:

1. User chooses a lens type and previews the dossier.
2. Backend gathers context from topic search, Flow selection, hub scope, latest AiON answer, or saved iCE atlas.
3. A deterministic Markdown scaffold is built first, including frontmatter and source index.
4. If a chat model is available, concise grounded prose is synthesized into the scaffold.
5. If no chat model is available, AiR exports the deterministic scaffold with excerpts and source notes.
6. The rendered `.md` file is written locally and can be opened or revealed through the opener plugin.

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
  |-- Local model runtime
  |     llama.cpp GGUF loading, Metal offload, embeddings, chat, and iCE generation
  |
  |-- Local chunk store
  |     vector search and chunk metadata
  |
  |-- Flow graph builder
  |     local semantic graph nodes, edges, matches, and hub/source scoping
  |
  |-- iCE generator
  |     local chat prompt -> parsed iceberg JSON -> typed renderer result
  |
  |-- AiR renderer
  |     local context gathering -> Markdown scaffold/synthesis -> .md file export/open/reveal
```

Rust backend responsibilities:

- Owns browser views and tabs.
- Owns file-system writes.
- Owns local chunk storage and vector search.
- Owns in-process local model loading and inference.
- Owns capture extraction from the active page.
- Owns Flow graph construction over captured knowledge.
- Owns AiR Markdown rendering, file writes, and open/reveal actions.
- Exposes typed Tauri command results to the renderer.

Renderer responsibilities:

- App shell and UI state.
- Dashboard, browser chrome, AiON, iCE, Flow, AiR, modals, and interactions.
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
window.aether.capture.suggestHub()

window.aether.search.collection({ collectionId, query, limit })
window.aether.semanticTrail.generate({ query, limit })
window.aether.flow.graph({ query, sourceLimit })
window.aether.chat.ask({ collectionId, prompt, includeCurrentPage, requestId })
window.aether.chat.cancel()

window.aether.air.prepare({ lensKind, lens, collectionId, captureId, savedIcebergId, answer })
window.aether.air.render({ lensKind, lens, collectionId, captureId, savedIcebergId, answer })
window.aether.air.listRecent()
window.aether.air.open(path)
window.aether.air.reveal(path)

window.aether.crystallizer.generate({ keyword })
window.aether.crystallizer.listSaved()
window.aether.crystallizer.getSaved(id)
window.aether.crystallizer.save({ title, keyword, model, generatedAt, items })
window.aether.crystallizer.reorderSaved(ids)
window.aether.crystallizer.deleteSaved(id)

window.aether.system.status()
window.aether.system.settings()
window.aether.system.updateSettings({ browser: { defaultSearchEngine }, developerMode })
window.aether.system.updateModels({ embeddingModel, chatModel })

window.aether.layout.setIntelligencePanelCollapsed(collapsed)
window.aether.layout.setModalOverlayOpen(open)
window.aether.layout.showStatusToast({ kind, message })

window.aether.events.onState(listener)
window.aether.events.onCaptureProgress(listener)
window.aether.events.onChatStream(listener)
window.aether.events.onShortcut(listener)
window.aether.events.onFindRequested(listener)
window.aether.events.onFindResult(listener)
```

## Source Layout

```text
src/
  shared/
    aether.ts                     Shared API, state, settings, capture, chat, Flow, AiR, and iCE types
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
        Dashboard.tsx             Portals, saved iCE atlases, knowledge hubs, captures
        FlowView.tsx              Semantic relation graph for captured knowledge
        AirView.tsx               Markdown dossier preview, render controls, and history
        IntelligencePanel.tsx     AiON search/ask sidepanel and model controls
        SourceTray.tsx            Search/citation source display
        StartPage.tsx             Browser start page surface
        icons.tsx                 Local icon components
      utils/
        aether-ui.ts              UI formatting helpers
        collection-icon-data.ts   Knowledge hub icon option data
        collection-icons.tsx      Knowledge hub icon renderer
      tauri-aether.ts             Tauri invoke bridge exposed as window.aether
src-tauri/
  src/
    lib.rs                        Rust Tauri backend, browser views, stores, commands, RAG, Flow, AiR, iCE
    main.rs                       Tauri entrypoint
  tauri.conf.json                 Main Tauri configuration
  tauri.linux.conf.json           Linux arm64 bundle override
  capabilities/
    default.json                  Tauri permission capability
  gen/android/                    Generated Tauri Android project
```

## Development Guidelines

Prefer:

- Bun scripts over npm scripts.
- Vite/Tauri-native development over Next.js-style web app assumptions.
- Rust backend ownership for privileged APIs, database work, file writes, and web contents access.
- Typed renderer API contracts through `src/shared/aether.ts` and `src/renderer/src/tauri-aether.ts`.
- Renderer-only components for presentation and interaction logic.
- In-process local model inference rather than cloud model SDKs or local REST sidecars for app intelligence.

Avoid:

- Direct database access from the renderer.
- Raw Tauri `invoke()` calls spread through renderer components.
- Hard-coded absolute asset URLs that break in packaged Tauri builds.
- Moving capture metadata without also updating chunk metadata.
- Adding runtime-only packages to `devDependencies`.

## Troubleshooting

### No local model is available

Add local models to the project-local model directory shown in the AiON model settings, or point the app at explicit files:

```bash
export AETHER_CHAT_MODEL=/absolute/path/to/chat.gguf
export AETHER_EMBEDDING_MODEL=/absolute/path/to/embedding.gguf
```

### Missing embedding model

Add `Qwen3-Embedding-0.6B-Q8_0.gguf` to `./aether-models/embeddings/Qwen3-Embedding-0.6B-GGUF/`, or add another embedding GGUF to `./aether-models/embeddings/`.

### Chat model unavailable

Add a chat GGUF, preferably Gemma-family for the current prompt template, to `./aether-models/chat/` or select it from the AiON model menu.

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

### Update check cannot reach GitHub

Settings uses the public GitHub Releases API to check whether a newer ÆTHER release exists. If the check fails, verify general network access to GitHub and that the repository has a published, non-prerelease release.

### iCE returns invalid or empty results

iCE depends on the local chat model returning parseable JSON. Try:

- Use a stronger chat model.
- Regenerate with a simpler topic.
- Check the model menu for the active chat model.

## Current Limitations

- macOS packages are local unsigned/ad-hoc builds until Developer ID signing and notarization are configured.
- Capture quality depends on page structure, active webview snapshots, and fallback HTTP extraction quality.
- App-like authenticated services can still have browser API or popup edge cases.
- iCE generation depends on local model quality and JSON compliance.
- Flow and AiR dedicated app views are currently exposed through Developer Mode.
- Update checks notify about newer app releases, but they do not download or install updates yet.
- AiR exports one local Markdown dossier at a time; it does not sync with Obsidian vaults or manage zip exports.
- Search and Ask currently use one selected hub plus optional current page, not arbitrary multi-hub selection.

## Roadmap Ideas

Likely next improvements:

- Production signing and notarization flow.
- Import/export for knowledge hubs.
- Full capture library view with filtering and bulk actions.
- Per-hub retrieval/model settings.
- Better authenticated-app compatibility coverage.
- Capture selected text or a selected DOM region.
- More precise token-aware chunking.
- Richer iCE export/share behavior.
- More complete settings surface.

## License

No license file is currently included. Add one before distributing or accepting external contributions.
