# Security Notes

Not a policy document — a record of the decisions that are easy to undo by accident.

## Two kinds of webview

ÆTHER runs visited pages in **child webviews**, separate from the window that hosts
the app's own UI. That split is the main boundary:

| | Privileged window (`main`) | Child webviews (tabs) |
|---|---|---|
| Content | ÆTHER's own bundled UI | arbitrary web pages |
| IPC bridge | yes — all Tauri commands | no |
| CSP | `app.security.csp` (below) | the site's own |

A page cannot reach the command bridge, because it is not in the context that has
one. This is why an aggressive CSP on the privileged window costs page
compatibility nothing: the policy never applies to page content.

## Content Security Policy

Lives in `src-tauri/tauri.conf.json` under `app.security.csp`, with a looser
`devCsp` for Vite's HMR (inline scripts, `eval`, and a WebSocket to
`127.0.0.1:1420`). Tauri injects it at load.

**Deliberately not also a `<meta>` tag in `index.html`.** It used to be. Two
policies are *intersected* by the engine, so with both in place a tightening in
either silently overrides the other and the pair drifts apart. One source of truth.

Why each directive is what it is:

| Directive | Value | Reason |
|---|---|---|
| `default-src` | `'self'` | Nothing loads from anywhere else unless listed below. |
| `script-src` | `'self'` | One bundled module script. No inline, no `eval`. |
| `style-src` | `'self' 'unsafe-inline'` | The UI uses React `style` attributes throughout. This permits inline *style*, not inline script. |
| `img-src` | `'self' data: blob: https: http:` | See favicons below. `data:`/`blob:` are tab thumbnails. |
| `connect-src` | `'self' ipc: http://ipc.localhost` | Tauri's IPC transport. Removing these breaks every command. |
| `object-src` | `'none'` | No plugins, ever. |
| `base-uri` | `'self'` | Stops injected markup repointing relative URLs. |
| `form-action` | `'none'` | The UI has no server to post to. |
| `frame-ancestors` | `'none'` | Nothing may embed the privileged window. |

**`img-src` allows any host, and that is a real hole.** Tab favicons are fetched
straight from `https://<host>/favicon.ico` by an `<img>` in the privileged window
(`favicon_for_url` in `src-tauri/src/util.rs`). Narrowing this needs favicons
proxied through Rust and cached locally, which would also stop the privileged
window making any outbound request at all. Worth doing; not done.

## What the app sends anywhere

Outbound requests, all from Rust except where noted:

- **Hugging Face** — only while downloading a model the user chose.
- **GitHub Releases API** — the update check, if enabled in Settings.
- **The update endpoint** — only when the user presses Install Update.
- **Pages the user visits** — in child webviews, as any browser.
- **Favicons** — from the privileged window, per the above.

No analytics, no crash reporting, no phone-home. Captured text, embeddings,
answers, and iCE atlases never leave the machine.

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

Paths *are* recorded, including model and store paths under the user's home
directory. Worth knowing before attaching a log to a public issue.

## Capabilities

`src-tauri/capabilities/default.json` grants `core:default` and `opener:default` to
the `main` window only. The opener permission is what `reveal_item_in_dir` and
external-link opening need. Nothing else is granted, and child webviews appear in no
capability.

## Known gaps

- Releases are unsigned; see [SIGNING.md](SIGNING.md).
- `img-src` is open to any host, per above.
- `style-src` needs `'unsafe-inline'` until the UI stops using `style` attributes.
