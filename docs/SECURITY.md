# Security Notes

Not a policy document — a record of the decisions that are easy to undo by accident.
For _why_ these are the decisions, see [PRINCIPLES.md](PRINCIPLES.md); this file is
the mechanism, that one is the position.

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

When the proxy is on, **every one of those requests goes through it**, model
downloads included. See [Proxy](#proxy) for why nothing is exempted.

## What visited sites can see

The honest boundary, because "local AI" and "anonymous browsing" are different
claims and only the first is ours.

Tabs are ordinary system webviews (WKWebView, WebView2, WebKitGTK). Sites see the
real TLS fingerprint, cookies, and the usual canvas, WebGL and font
fingerprinting surface. **ÆTHER does not defend against any of that, and cannot
without patching an engine it does not ship.** Anyone who needs anonymity wants
Tor Browser, not this.

There are exactly two exceptions, both opt-in and both off by default. The
[proxy](#proxy) hides the IP address, and [timezone pinning](#timezone-and-locale-pinning)
reports UTC and a fixed locale in place of the machine's own.

Neither buys anonymity, and the reason is worth stating plainly: they change
_where_ a site thinks you are, not how recognisable you are once you get there.
Those are independent. A proxy without fingerprint defences still leaves every
visit joinable to every other — and two removed bits of entropy, against a
canvas and WebGL surface left untouched, does not change that answer.

What is defended:

| Defence                                                  | Where                                              |
| -------------------------------------------------------- | -------------------------------------------------- |
| Tracker and ad requests blocked before they are sent     | macOS, Linux, Windows — `src/content_blocking/`    |
| Third-party cookies blocked                              | macOS, Linux, Android — **not Windows**, see below |
| Private tabs (ephemeral store, never written to session) | `.incognito()`, `src-tauri/src/webview.rs`         |
| Container tabs (isolated persistent storage)             | macOS 14+ only — `data_store_identifier`           |
| Clear cookies, caches and site storage                   | macOS, Linux, Windows — `src/browsing_data/`       |
| One User-Agent per platform, consistent with the engine  | `BROWSER_USER_AGENT`, `src-tauri/src/lib.rs`       |
| Click identifiers stripped on navigation and on capture  | `strip_tracking_params`, `src-tauri/src/util.rs`   |
| Favicons never fetched from the privileged window        | `src-tauri/src/favicon.rs`                         |
| Default search engine that does not build a profile      | `search_engine_prefix`, `src-tauri/src/util.rs`    |
| AI-generated answers declined where the engine allows    | `search_url`, `src-tauri/src/util.rs`              |
| IP address hidden behind a SOCKS5/HTTP proxy, opt-in     | macOS 14+, Linux, Windows — **not Android**        |
| Timezone and locale reported as UTC/en-US, opt-in        | desktop only — `TIMEZONE_PIN_SCRIPT`               |

### AI-free search

On by default, one toggle in Settings to turn off. Every search the app builds —
the address bar, a bare query typed into it, and an iCE card's "Explore in Web" —
goes through `search_url`, so none of them can disagree about it.

This is a veracity and consent measure rather than a privacy one. AI answers are
inserted above the results the user asked for, by a mechanism they did not opt into,
and they are the part of a results page least likely to be checkable against a
source ÆTHER could capture.

Four unrelated mechanisms, because the engines share nothing here:

| Engine     | Mechanism                                                      | Kind           |
| ---------- | -------------------------------------------------------------- | -------------- |
| Google     | `&udm=14` — the "Web" vertical, plain links, no AI Overview    | URL parameter  |
| Bing       | `-ai` appended to the query — a real operator, added June 2026 | query operator |
| DuckDuckGo | `noai.duckduckgo.com`, DDG's own AI-free host                  | alternate host |
| Yahoo      | none                                                           | —              |
| Ecosia     | none reachable from a URL                                      | —              |

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

### Proxy

Off by default. When on, tabs and the app's own fetches both route through one
SOCKS5 or HTTP CONNECT endpoint, prefilled with Tor's `socks5://127.0.0.1:9050`.

**It covers everything, deliberately.** Sending multi-gigabyte model downloads
over Tor is slow and a poor use of the network, and exempting them was the
obvious alternative. It was rejected: a silent exemption is the same class of bug
as a leaking favicon fetch — traffic the user believes is proxied that quietly
is not. A slow or refused download is a failure the user can see and act on.

Two details do real work:

- **One source of routing.** `util::active_proxy_url` decides, `Backend::network`
  holds the answer, and both the webview builder and the reqwest client read it
  from there. Tabs and favicon fetches cannot diverge, and a divergence is exactly
  the correlation leak the feature exists to close: one favicon request per
  visited origin, from the real IP, would undo the whole thing.
- **`socks5` becomes `socks5h` for reqwest.** Under plain `socks5`, reqwest
  resolves hostnames locally and the network operator still sees a DNS query for
  every host — the address hidden, the destination not. `socks5h` hands the name
  to the proxy. The rewrite is internal because Tauri's proxy parser accepts only
  `socks5` and would reject `socks5h` when a tab is created.

Accepted schemes are exactly `http` and `socks5`, matching Tauri's own parser.
`https` and `socks5h` are refused at the Settings screen rather than at the first
tab, which is where the failure would otherwise land.

Limits worth stating:

- **macOS 14+.** wry sets `proxyConfigurations` on the data store through KVC with
  no version check of its own; the key does not exist on macOS 13, and
  `setValue:forKey:` against a missing key raises rather than degrades. ÆTHER
  supports back to 10.15, so `util::proxy_platform_support` gates it and Settings
  reports the reason. **Not available on Android at all** — wry has no support.
- **Open tabs keep their old routing.** A webview's proxy is fixed when it is
  built, so toggling this affects tabs opened afterwards. The UI says so.
- **It is not anonymity.** Same fingerprint, same TLS handshake, same cookies. A
  proxy changes where a site thinks you are, not whether it recognises you — and
  using Tor with a unique fingerprint can be worse than not using it, because the
  fingerprint links sessions the exit node was supposed to separate.

### Private tabs

`WebviewBuilder::incognito(true)`, which wry maps to a non-persistent
`WKWebsiteDataStore` on macOS and an ephemeral `WebContext` on Linux. Windows
needs WebView2 runtime 101+ and silently does nothing on older ones.

Because that last case fails open, the engine is not the only defence: a private
tab is **never written to the session file** (`persist_session_tabs`).

**Capture is not gated, and the reasoning matters.** It used to be refused
outright, on the argument that a private tab promises to leave no trace and a
capture is the most durable trace the app makes. That conflates the two halves of
browser privacy. One is _outward_ — the IP, fingerprint, cookies and referrers a
site can read, which is where being recognised actually happens. The other is
_inward_ — what persists on your own disk. Capture is purely inward: on desktop it
reads the DOM already in memory (`extract_readable_page_from_webview`, with a
re-fetch only as fallback), so in the normal path it makes no network request at
all. Nothing is emitted, nothing is asserted, nobody is told anything.

What remains is a local write, and a local index of what you read is what this
app is for. Pressing Capture is the decision — the same way saving a bookmark or
a download from a private window is the decision, neither of which any browser
prompts about. A confirmation step there was ceremony over a choice already made,
and confirmation dialogs people click through reflexively devalue the ones that
carry information.

The stored record still carries `fromPrivateTab`, shown as a badge in the
library. That is **library hygiene, not protection**: it keeps a private session's
sources findable so they can be purged as a group, instead of blending into every
other source the moment they land.

**AiON's "current page" context reads private tabs too**, for the same reason.
Answers and citations do land in the conversation store, but that is another
local write on the user's own disk, not something leaving the machine. It used to
be refused, which meant asking about the page in front of you and getting an
answer that silently pretended not to see it — a worse outcome than the one the
refusal was avoiding.

The thing to keep in mind when adding any feature that reads the active tab is
the outward/inward split, not a blanket ban: a private tab is a promise about
what leaves the machine and what survives on it _by default_, not a prohibition
on the user deliberately keeping something.

### Timezone and locale pinning

Off by default. When on, every tab is built with a document-start script
(`TIMEZONE_PIN_SCRIPT`, injected via `initialization_script_for_all_frames`) that
reports UTC and `en-US` in place of the machine's own timezone and language.

**Why this and not canvas noise.** Timezone is among the highest-entropy bits a
page reads for free, and pinning it is _uniformity_ rather than randomisation:
UTC is a large crowd that already exists, so the user becomes commoner. Randomised
canvas or audio fingerprints do the opposite — "the browser whose canvas hash
changes every read" is a very small set, and the shim is detectable besides. ÆTHER
does not have the user base to hide a randomiser in. It does not ship one.

Both halves of the injection are load-bearing. On page load is too late: a
fingerprinting script has read the real values long before then, which is why the
existing `NATIVE_WEBVIEW_SCROLLBAR_SCRIPT` hook was not reusable. Main-frame-only
would leave any embedded tracker iframe reading the true values anyway.

Coverage is `Date.prototype.getTimezoneOffset`, the `Date` string and
`toLocale*` methods — the engine formats those from its own internal zone, not
from `getTimezoneOffset`, so patching the offset alone leaves the real zone in
`String(new Date())` — `resolvedOptions().timeZone` on the `Intl` constructors,
which is where a modern script actually looks because it yields the IANA name
rather than an offset, and `navigator.language` / `languages`.

Limits, and they are real:

- **It is a JavaScript shim.** The overrides report `[native code]` from
  `toString`, but a page that creates a blank same-origin iframe can read pristine
  copies out of the fresh realm before the script runs there.
- **`Accept-Language` on the wire is not covered.** The engine sets it, below
  where any injected script can reach. A UTC clock next to a `nl-NL` request
  header is itself a signal.
- **Off by default on purpose.** Tracker blocking defaults on because it costs
  nothing visible. This makes every web calendar, booking form and "posted 2 hours
  ago" read wrong, in ordinary use, for a benefit the user cannot see. That is a
  trade to offer, not one to make on someone's behalf.
- **Desktop only.** The Android shell drives its WebViews through `android_tabs`,
  which has no document-start hook; `timezone_pin_platform_support` says so and
  Settings reports it rather than showing a toggle that does nothing.

It removes two easy bits from casual fingerprinting. It is not anonymity, and
pairing it with the proxy is where it earns its keep — a hidden IP next to a
precise local timezone gives most of the location back.

### Verifying the platform code

`src/content_blocking/` and `src/browsing_data/` are three implementations
against three unrelated native APIs, and only one of them compiles on whatever
machine you are sitting at. Two safety nets:

- **`pnpm run check:platforms`** builds and tests all three locally. Linux goes
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
- **No encrypted DNS by default.** Hostnames go to the OS resolver, so the network
  operator sees every site visited regardless of anything above. Turning the
  [proxy](#proxy) on covers this for the app's own fetches, which use `socks5h`
  and let the proxy resolve. Whether the _webviews_ resolve locally or at the
  proxy is the engine's decision and is not something ÆTHER can force — so with
  the proxy on, assume tab DNS may still be visible until measured per platform.
  Encrypted DNS without a proxy still wants a system DNS profile and is not
  fixable at the app level on macOS or Windows.
- **No referrer trimming.** Neither wry nor WebKit's rule engine can rewrite
  request headers; content rules can block or upgrade a request, not modify it.
  WebView2's `WebResourceRequested` could on Windows, which would make this the
  one defence that exists there and not on macOS.
- **None of this is fingerprinting resistance.** Canvas, WebGL, fonts, timezone
  and the TLS handshake are all untouched and all still identify the machine. See
  the boundary note above: blocking trackers is not anonymity, and neither is
  hiding an IP address.
- **The proxy has never been exercised against a live Tor daemon.** The routing,
  validation and platform gating are unit-tested and the whole path compiles, but
  nobody has yet watched a page load through `127.0.0.1:9050` and confirmed the
  exit IP. Treat the end-to-end behaviour as unverified until someone does.
