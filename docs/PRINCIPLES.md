# Principles

ÆTHER is a research browser that runs its intelligence on your own machine.

This document is the position behind that sentence. Every principle below names the
mechanism that makes it true, because a principle you cannot point at in the source
is a slogan. The last section names what ÆTHER does **not** do — that section is
load-bearing, not a disclaimer.

---

## 1. Nothing happens until you ask

Capture is a button. Answering is a button. Model downloads are a choice with the
size printed on it. There is no background indexing, no silent sync, no
"improving your experience".

Opt-in is not a settings page here — it is the shape of the app. The only work that
happens is work you started.

## 2. Your machine is the whole stack

Embeddings and answers run locally through llama.cpp on weights sitting in your own
filesystem. Once the models are on disk, the intelligence works with the network
cable unplugged.

Not "private cloud". Not "we don't train on your data". **There is no server.**

## 3. The AI serves your reading — it does not replace it

AiON answers from pages _you_ chose to keep, and cites them. Every claim is one
click from the source you already judged worth saving.

An assistant that reads for you makes you dependent. An assistant that reads _with
you_ makes you faster. We build the second one.

## 4. It only ever reads what you opened

No crawler. No link-following. No frontier queue. No prefetching pages you might
want. ÆTHER fetches exactly the URLs you point it at, and stops.

Your library grows by your judgement, not by a scraper's appetite.

## 5. The web survives if people visit it

AI summaries take an author's work and return nothing — no visit, no reader, no
reason to keep publishing. That trade ends with an empty web, and then with empty
summaries.

So ÆTHER asks search engines for results without AI answers, on by default, using
each engine's own documented opt-out. It sends you **to** the source rather than
around it. Every principle here that helps a researcher also pays the person who
wrote the page.

## 6. Depth is a feature, not a delay

The iCE explorer maps a subject from its surface to its specialist layers — not to
answer your question, but to show you which questions exist.

Instant answers flatten a topic into one paragraph. Research is the part where you
find out how much you didn't know. ÆTHER is built to make that part rewarding
instead of tedious.

## 7. Memory, never surveillance

The index exists to serve the person who built it. That is the whole test, and it
decides real design details: favicons are cached in memory only and thrown away when
you quit, because a favicon cache written to disk is a list of every site you
visited under another name.

## 8. Your data is yours in the boring, literal sense

The web remains the source. ÆTHER keeps only the local research layer it derives
from sources you chose: extracted text, provenance, embeddings, connections, notes,
maps, and answers. Those local stores can be backed up and exported whole. No
account, no sign-in, no proprietary document vault. Nothing is held hostage to a
subscription, because there is no subscription.

You can leave and take everything. That is the only version of data ownership that
means anything.

## 9. A capture is a record, not a cache

Once captured, extracted text and its fingerprint remain stable. A later change to
the live page may be detected, but it never silently rewrites the research record
you originally saved. There is no refresh-in-place pipeline and no background
recapture. Persistence means the evidence you used yesterday is still the evidence
you can retrieve tomorrow.

## 10. There is nothing pointed at you to degrade

Enshittification needs a mechanism: ads to insert, engagement to farm, a free tier
to squeeze, telemetry to justify it. ÆTHER has none of them and never sends
analytics, crash reports, or usage data anywhere.

**It cannot get worse for you to make it better for someone else. There is no
someone else.**

## 11. Trackers die before the request leaves

On WebKit, blocked requests are refused inside the network path — a tracker learns
nothing, not even that something was attempted. Third-party cookies are blocked
there too — on Windows they are not, and the app says so rather than implying
otherwise. Click identifiers are stripped from URLs on navigation _and_ on capture, so an ad
attribution never gets a permanent home in your library.

## 12. The leak you don't think about is the one that gets you

Point ÆTHER at a proxy — Tor's port comes prefilled — and the app routes its _own_
traffic the same way: favicons, capture re-fetches, model downloads included.
Nothing is exempted for speed, because traffic you believe is proxied and quietly
isn't is worse than a slow download you can see.

When the route cannot be honoured it fails closed, refusing to resolve any host
rather than quietly going direct. Hostnames are handed to the proxy rather than
resolved locally, because a hidden IP address paired with a visible DNS query for
every site is most of the leak back again.

Off until you turn it on — as is pinning your timezone to UTC, which patches
`Intl.resolvedOptions`, where fingerprinting scripts actually look.

## 13. We say what we don't do

The app reports its own coverage per platform rather than claiming a uniform story:
where third-party cookie blocking is unavailable, the Settings screen says so; where
a search engine offers no AI opt-out, it says that too, naming the engine.

A privacy claim that quietly stops being true is worse than one never made. Honesty
here is a feature with tests behind it.

---

## Lines you can lift

> There is no server.

> No cloud. No account. No subscription. No telemetry. Nothing to enshittify.

> The AI reads what you chose. Nothing else.

> Every claim is one click from its source.

> We send you to the source, not around it.

> The web survives if people visit it.

> Opt-in by architecture, not by checkbox.

> A browser with a memory — and the memory is yours.

> It cannot degrade. There's nothing pointed at you.

> Research is the part where you find out how much you didn't know.

---

## What ÆTHER does not claim

Every item here is deliberate. A document about integrity that overstates its case
refutes itself.

- **It is not anonymity.** Tabs are ordinary system webviews. Sites see your TLS
  fingerprint and the usual canvas, WebGL and font fingerprinting surface, and
  ÆTHER cannot defend against those without shipping its own engine. Two of the
  easy bits can be taken off the table — a proxy such as Tor hides your IP
  address, and timezone pinning reports UTC and a fixed locale — and both are off
  until you turn them on. Neither is anonymity. An unchanged fingerprint still
  links your sessions to each other, and a hidden IP does not fix that. If you
  need anonymity, you want Tor Browser.
- **Protection is not uniform across platforms.** Third-party cookie blocking is
  unavailable on Windows. Storage partitioning is opt-in and macOS 14+ only.
  Proxying needs macOS 14+ and is unavailable on Android; timezone pinning is
  desktop-only. The app tells you which you have.
- **The blocklist is curated and small**, not a full filter list. It covers the large
  ad and analytics networks and will miss a long tail.
- **A local model is not a better model.** It is a model that cannot leak. Answers
  can still be wrong — which is exactly why they are built from sources you can open
  and check.
- **AI-free search depends on the engines.** These are documented opt-outs, not
  guarantees; an engine can withdraw one without notice, and that failure is silent.
- **It is not open source.** The source is public and auditable, and ÆTHER ships
  under PolyForm Strict 1.0.0: noncommercial _use_ is permitted, redistribution is
  not. A standing grant in [CONTRIBUTING.md](../CONTRIBUTING.md) lets anyone fork
  and modify it to contribute, and patch their own copy — but passing it on to
  someone else, paid or free, is the line. See [LICENSING.md](LICENSING.md).
- **Releases are unsigned.** See [SIGNING.md](SIGNING.md).

For the full technical account, including the complete list of known gaps, see
[SECURITY.md](SECURITY.md).
