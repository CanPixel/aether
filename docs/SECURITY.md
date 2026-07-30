# Security Notes

Not a policy document — a record of the decisions that are easy to undo by accident.

## Two kinds of webview

ÆTHER runs visited pages in **child webviews**, separate from the window that hosts
the app's own UI. That split is the main boundary:

|            | Privileged window (`main`) | Child webviews (tabs) |
| ---------- | -------------------------- | --------------------- |
| Content    | ÆTHER's own bundled UI     | arbitrary web pages   |
| IPC bridge | yes — all Tauri commands   | no                    |
| CSP        | `app.security.csp` (below) | the site's own        |

A page cannot reach the command bridge, because it is not in the context that has
one. This is why an aggressive CSP on the privileged window costs page
compatibility nothing: the policy never applies to page content.

## Content Security Policy

Lives in `src-tauri/tauri.conf.json` under `app.security.csp`, with a looser
`devCsp` for Vite's HMR (inline scripts, `eval`, and a WebSocket to
`127.0.0.1:1420`). Tauri injects it at load.

**Deliberately not also a `<meta>` tag in `index.html`.** It used to be. Two
policies are _intersected_ by the engine, so with both in place a tightening in
either silently overrides the other and the pair drifts apart. One source of truth.

Why each directive is what it is:

| Directive         | Value                              | Reason                                                                                           |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `default-src`     | `'self'`                           | Nothing loads from anywhere else unless listed below.                                            |
| `script-src`      | `'self'`                           | One bundled module script. No inline, no `eval`.                                                 |
| `style-src`       | `'self' 'unsafe-inline'`           | The UI uses React `style` attributes throughout. This permits inline _style_, not inline script. |
| `img-src`         | `'self' data: blob:`               | Favicons arrive as `data:` URIs from Rust; `blob:` is tab thumbnails. See below.                 |
| `connect-src`     | `'self' ipc: http://ipc.localhost` | Tauri's IPC transport. Removing these breaks every command.                                      |
| `object-src`      | `'none'`                           | No plugins, ever.                                                                                |
| `base-uri`        | `'self'`                           | Stops injected markup repointing relative URLs.                                                  |
| `form-action`     | `'none'`                           | The UI has no server to post to.                                                                 |
| `frame-ancestors` | `'none'`                           | Nothing may embed the privileged window.                                                         |

**`img-src` was open to any host; it is now `'self' data: blob:`.** Tab favicons
used to be fetched straight from `https://<host>/favicon.ico` by an `<img>` in the
privileged window, which is what forced `https:`/`http:` into the policy. They now
go through `aether_browser_favicon` (`src-tauri/src/favicon.rs`), which fetches on
the shared reqwest client and hands back a `data:` URI.

The privileged window therefore makes **no outbound request at all**. The favicon
URL is still stored on tabs and hub shortcuts, but only as a cache key — never as
an `<img src>`. The cache is in memory for the session and deliberately not on
disk: a favicon cache is a list of visited hosts under another name.

## What the app sends anywhere

Outbound requests, all from Rust:

- **Hugging Face** — only while downloading a model the user chose.
- **GitHub Releases API** — the update check, if enabled in Settings.
- **The update endpoint** — only when the user presses Install Update.
- **Pages the user visits** — in child webviews, as any browser.
- **Favicons** — one request per host per session, from `favicon.rs`.

No analytics, no crash reporting, no phone-home. Captured text, embeddings,
answers, and iCE atlases never leave the machine.

## What visited sites can see

The honest boundary, because "local AI" and "anonymous browsing" are different
claims and only the first is ours.

Tabs are ordinary system webviews (WKWebView, WebView2, WebKitGTK). Sites see the
real IP address, the real TLS fingerprint, cookies, and the usual canvas, WebGL,
font and timezone fingerprinting surface. **ÆTHER does not defend against any of
that, and cannot without patching an engine it does not ship.** Anyone who needs
anonymity wants Tor Browser, not this.

What is defended:

| Defence                                                 | Where                                              |
| ------------------------------------------------------- | -------------------------------------------------- |
| Tracker and ad requests blocked before they are sent    | macOS, Linux, Windows — `src/content_blocking/`    |
| Third-party cookies blocked                             | macOS, Linux, Android — **not Windows**, see below |
| Private tabs (ephemeral store, no capture, no session)  | `.incognito()`, `src-tauri/src/webview.rs`         |
| Container tabs (isolated persistent storage)            | macOS 14+ only — `data_store_identifier`           |
| Clear cookies, caches and site storage                  | macOS, Linux, Windows — `src/browsing_data/`       |
| One User-Agent per platform, consistent with the engine | `BROWSER_USER_AGENT`, `src-tauri/src/lib.rs`       |
| Click identifiers stripped on navigation and on capture | `strip_tracking_params`, `src-tauri/src/util.rs`   |
| Favicons never fetched from the privileged window       | `src-tauri/src/favicon.rs`                         |
| Default search engine that does not build a profile     | `search_engine_prefix`, `src-tauri/src/util.rs`    |
| AI-generated answers declined where the engine allows   | `search_url`, `src-tauri/src/util.rs`              |

### AI-free search

On by default, one toggle in Settings to turn off. Every search the app builds —
the address bar, a bare query typed into it, and an iCE card's "Explore in Web" —
goes through `search_url`, so none of them can disagree about it.

This is a veracity and consent measure rather than a privacy one. AI answers are
inserted above the results the user asked for, by a mechanism they did not opt into,
and they are the part of a results page least likely to be checkable against a
source ÆTHER could capture.

Four unrelated mechanisms, because the engines share nothing here:

| Engine     | Mechanism                                                     | Kind           |
| ---------- | ------------------------------------------------------------- | -------------- |
| Google     | `&udm=14` — the "Web" vertical, plain links, no AI Overview    | URL parameter  |
| Bing       | `-ai` appended to the query — a real operator, added June 2026 | query operator |
| DuckDuckGo | `noai.duckduckgo.com`, DDG's own AI-free host                 | alternate host |
| Yahoo      | none                                                          | —              |
| Ecosia     | none reachable from a URL                                     | —              |

**Google does not get `-ai`, and this is the trap worth stating plainly.** `-ai` is
Microsoft's operator; on Google it is an ordinary negative keyword, so it would drop
every result containing "ai" — precisely the results an iCE concept like "neural
network" or "transformer" needs. Google's mechanism is `udm=14`, which changes the
result vertical and not the query's meaning. There is a unit test asserting that
`-ai` never reaches a Google URL.

**Two engines can't honour the setting at all.** Yahoo serves Bing's results with no
control of its own, and Ecosia's opt-out is an account setting that is also gated by
region — neither can be asked for from a URL. Nothing is appended for them, because
an invented parameter can change how an engine parses the rest of the query. The
Settings screen says so for the selected engine rather than implying the toggle did
something: see `ai_free_search_status`, which derives its wording from the same
table `search_url` uses, so the two cannot drift apart.

### Content blocking

Three implementations, one rule file
(`src-tauri/resources/content-blocking-rules.json`):

| Platform | Mechanism                       | Equivalent?                          |
| -------- | ------------------------------- | ------------------------------------ |
| macOS    | `WKContentRuleList`             | reference implementation             |
| Linux    | `WebKitUserContentFilterStore`  | yes — **same JSON**, shared verbatim |
| Windows  | `WebResourceRequested` callback | no — see below                       |

On WebKit the rules are evaluated inside the network path, so a blocked request
is never made: a tracker learns nothing, not even that something was attempted.

**Windows is not equivalent, and the gap is not cosmetic.** WebView2 has no
rule-list concept, so blocking there is a per-request callback matching the
request host against `blocked_hosts()`, derived from the same file so the domains
cannot drift. Two consequences: every request crosses the COM boundary, and
**third-party cookies are not blocked** — `block-cookies` has no WebView2
equivalent, so a tracker not on the host list still sets them. Windows also only
approximates "third-party" by comparing against the top-level document's host.

**Linux must go through `webkit2gtk`'s re-exports** (`webkit2gtk::glib`, `::gio`,
`::ffi`), never separate `glib`/`gio` dependencies. Declaring those directly
resolves a second copy of each into the graph, and a `GBytes` built from one then
fails to satisfy `ToGlibPtr` for the other — same name, different type. This cost
a build; the Cargo.toml comment is there to stop it happening twice.

**Two traps, both of which cost a debugging session:**

1. **`url-filter` does not support alternation.** `(com|net)` fails with
   "Disjunctions are not supported yet" — and one bad filter rejects the _entire_
   list, so a single careless rule silently disables all blocking at runtime. A
   unit test guards against `|`; split the domains into separate rules instead.
2. **The rule objects take exactly `trigger` and `action`.** An unknown key —
   including a `_comment` — rejects the list. That is why the rules are
   documented here rather than inline.

Neither failure is visible without looking, so after touching the rules run:

    cargo run --example verify_content_rules

which compiles them through WebKit itself and exits non-zero if WebKit disagrees.
The unit tests only check the shape against what the documentation claims.

Every blocking rule is scoped to `third-party` loads. A first-party block would
break the site the user actually asked for.

### Private tabs

`WebviewBuilder::incognito(true)`, which wry maps to a non-persistent
`WKWebsiteDataStore` on macOS and an ephemeral `WebContext` on Linux. Windows
needs WebView2 runtime 101+ and silently does nothing on older ones.

Because that last case fails open, the engine is not the only defence. A private
tab is also:

- **never written to the session file** (`persist_session_tabs`), and
- **barred from capture**, both directly and through AiON's "current page"
  context — answers and citations are persisted to the conversation store, which
  would otherwise be a second route onto disk.

That second point is the one to keep in mind when adding any new feature that
reads the active tab: ÆTHER's entire purpose is a durable local index of what you
read, and a private tab is a promise not to build one.

### Verifying the platform code

`src/content_blocking/` and `src/browsing_data/` are three implementations
against three unrelated native APIs, and only one of them compiles on whatever
machine you are sitting at. Two safety nets:

- **`bun run check:platforms`** builds and tests all three locally. Linux goes
  through the same Docker image as `scripts/build-linux.sh`. Windows is a cross
  _type-check_: the whole crate cannot cross-compile (llama.cpp needs a C++
  toolchain) but `cargo check` never links, so the script assembles a scratch
  crate containing only the Windows modules and their real dependencies.
- **`.github/workflows/checks.yml`** does the same on real runners for every push
  and PR, dev-profile, without waiting on `build.yml`'s installer builds.

This is not ceremony. The Windows cross-check caught `Uri()` and `Source()` being
**out-parameters** (`*mut PWSTR`, COM-allocated, caller frees) rather than
returning the string, and `ClearBrowsingDataAll` living on `ICoreWebView2Profile2`
rather than `ICoreWebView2Profile`. None of that compiles, and none of it was
visible from a Mac. The Linux check caught the duplicate-`glib` problem above.

### Container tabs

Opt-in storage partitioning: a tab opened in a container gets its own persistent
`WKWebsiteDataStore`, keyed by a UUIDv5 of the container name so it resolves to
the same store on every launch. **macOS 14+ only** — wry's availability check is
at runtime and falls back to the default store below that, and on every other
platform, where the tab shares the default jar and the isolation is nominal.

**Why opt-in rather than always-on per-site isolation.** `navigate_native_webview`
reuses the webview, and the data store is fixed when the webview is built. A tab
created on `example.com` that follows a link to `other.com` would file the second
site's cookies under the first, while a fresh tab on `other.com` would get a
different store — same site, two jars, depending on how you arrived. Logins would
break unpredictably. True per-site isolation needs the webview torn down and
rebuilt on every cross-site navigation, which costs that tab's history.

A private tab never keeps a container: it is already in a non-persistent store,
and a persistent partition on top would defeat the point.

**The User-Agent must stay consistent with the engine it is compiled for.** A
single macOS Safari string on every desktop target — which is what this was —
contradicts `navigator.platform`, the WebGL renderer and the font list on Windows
and Linux, and a UA that disagrees with its own engine is a _stronger_ fingerprint
than an honest one. Linux is the deliberate exception: WebKitGTK has no crowd to
hide in, so it presents the Chrome/Linux string for site compatibility and accepts
that a probe can tell WebKit from Blink.

**Tracking-parameter stripping is kept narrow on purpose.** An over-greedy prefix
breaks real navigation, and it breaks it invisibly — the user sees a broken page,
not a stripped parameter. Prefer leaking a campaign id to guessing.

## What gets captured

Not a privacy control, but it shares the same plumbing and the same failure mode:
something ends up in the local index that nobody meant to put there.

`extract.rs` has two paths — a snapshot from the live webview, and an HTTP
re-fetch when there is no webview. Both now strip the same set of elements
(`NON_CONTENT_ELEMENTS`), so one URL yields the same text either way. Getting
that wrong means the same page produces different embeddings depending on how it
was captured.

Two bugs worth not reintroducing:

1. **The snapshot script's cleaning used to have no effect.** It strips nav,
   footer, script and friends from a _clone_ and sends that as `html` — but
   `body_text` was `document.body.innerText` from the untouched live DOM, and
   `body_text` won. Every capture carried the site's navigation and footer into
   the index. The cleaned clone is now preferred, with `innerText` as the
   fallback for pages whose clone yields essentially nothing.
2. **Inline JavaScript was indexed as prose.** `scraper`'s `.text()` walks every
   descendant text node and a `<script>` body _is_ a text node, so the HTTP path
   embedded minified JS. `select_body_text` now skips those subtrees.

Consent banners are handled by removing named CMP containers (OneTrust,
Cookiebot, Google FC, Usercentrics, Sourcepoint) — **named roots only, never
`[class*="cookie"]` substring guesswork.** A wrong match silently deletes real
content from a capture, which is much worse than a leftover banner. Content
blocking does not help here: these are first-party, visible DOM.

## Diagnostics log

`src-tauri/src/diagnostics.rs`. Replaces 25 `eprintln!` calls that went to a stderr
nobody reads — which mattered because the Windows and Linux builds ship without ever
being run, and there is no telemetry to notice a failure.

- Written only to the app data directory, capped at 512 KiB, rolling over to the
  newest half rather than emptying.
- Visible in Settings → Diagnostics (most recent first).
- Leaves the machine only via **Export Log**, which writes a copy and reveals it.

**Deliberately never recorded:** page text, captured content, search queries, chat
prompts, and answers. Entries are operational — what failed, and where. That is the
constraint that lets the log be exportable at all; an exported log must not be able
to become a transcript of what someone was reading.

Paths _are_ recorded, including model and store paths under the user's home
directory. Worth knowing before attaching a log to a public issue.

## Capabilities

`src-tauri/capabilities/default.json` grants `core:default` and `opener:default` to
the `main` window only. The opener permission is what `reveal_item_in_dir` and
external-link opening need. Nothing else is granted, and child webviews appear in no
capability.

## Known gaps

- Releases are unsigned; see [SIGNING.md](SIGNING.md).
- `style-src` needs `'unsafe-inline'` until the UI stops using `style` attributes.
- **The Windows implementation compiles but has never been run.** It is
  type-checked against the real `webview2-com` bindings (see below), and CI
  builds it on every push, but nobody has watched it block a request on an actual
  Windows machine. Treat its runtime behaviour as unconfirmed.
- **Third-party cookies are not blocked on Windows.** See the content blocking
  section: `block-cookies` has no WebView2 equivalent.
- **Storage partitioning is opt-in and macOS 14+ only.** Outside a container tab,
  every ordinary tab shares one data store, so a tracker present on two sites can
  still correlate them through first-party storage even with third-party cookies
  blocked. Containers are also a fixed set of four presets rather than a managed
  list.
- **The blocklist is curated and small** (~50 domains), not EasyPrivacy. It covers
  the large ad and analytics networks; it will miss a long tail that a real filter
  list catches. Regenerating from EasyPrivacy needs a converter that respects the
  two constraints above.
- **AI-free search does nothing on Yahoo or Ecosia**, and these mechanisms are
  undocumented conveniences that the engines can withdraw without notice. A change
  fails open: the search still works, it just quietly carries AI answers again.
  Nothing detects that, so the table above is worth rechecking periodically.
- **No HTTPS-only mode.** Bare hostnames typed into the address bar resolve to
  `https://`, but an explicit `http://` URL is left alone. Upgrading it needs an
  interstitial with a way back down, or http-only sites break with no explanation.
- **No encrypted DNS.** Hostnames go to the OS resolver, so the network operator
  sees every site visited regardless of anything above. This is not fixable at the
  app level on macOS or Windows — it wants a system DNS profile or a proxy that
  carries DNS, which is a different project (routing traffic through Tor or a VPN)
  rather than a setting we can flip.
- **No referrer trimming.** Neither wry nor WebKit's rule engine can rewrite
  request headers; content rules can block or upgrade a request, not modify it.
  WebView2's `WebResourceRequested` could on Windows, which would make this the
  one defence that exists there and not on macOS.
- **None of this is fingerprinting resistance.** Canvas, WebGL, fonts, timezone
  and the TLS handshake are all untouched and all still identify the machine. See
  the boundary note above: blocking trackers is not anonymity.
