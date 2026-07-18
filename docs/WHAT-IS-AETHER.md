# What is ÆTHER?

**ÆTHER is a web browser with a memory.**

A normal browser forgets. You read twenty pages while researching something, close the tabs, and a week later all that's left is a vague bookmark folder and the hope that you'll find the right page again. ÆTHER is built around a different idea: the pages you find valuable should become _your_ knowledge — saved, organized, searchable by meaning, and ready to answer questions — without any of it ever leaving your computer.

Think of it as three things merged into one app:

1. **A browser** - tabs, address bar, search. Nothing to relearn.
2. **A filing cabinet that organizes itself** — one click saves the page you're reading into a topic collection.
3. **A research assistant who has actually read your files** — ask a question, get an answer built from the pages you saved, with citations pointing back to them.

And the key twist: the "assistant" is an AI that runs entirely **on your own machine**. No cloud, no account, no subscription, no telemetry. Once the models are downloaded, the intelligence works with the network cable unplugged.

---

## The core loop

Everything in ÆTHER revolves around one simple cycle:

```
  Browse  →  Capture  →  Organize  →  Ask  →  (discover something new)  →  Browse …
```

**Browse.** Use ÆTHER like any browser. Open tabs, search, read.

**Capture.** Found something worth keeping? Hit capture. ÆTHER extracts the readable text of the page (the article, not the ads), stores it locally, and quietly indexes it by _meaning_ — so later you can find it even if you don't remember any exact words from it.

**Organize.** Captures live in **Knowledge Hubs** — collections you create per topic ("Thesis sources", "Kitchen renovation", "Rust learning"). ÆTHER can even suggest which hub a page belongs in, based on what it's about.

**Ask.** This is where it pays off. Open the **AiON** panel and ask a question in plain language. Instead of guessing from generic internet knowledge, AiON answers _from the pages you captured_ and cites them, so every claim is one click away from its source. You can ask about a whole hub, or just about the page you're currently reading.

**Discover.** Answers, related-capture trails, and topic maps surface connections you forgot you had — which usually kicks off the next round of browsing.

---

## A tour of the rooms

ÆTHER is organized as a few distinct "surfaces", each with one job:

### 🏠 The Dashboard

The calm home screen. Your saved **Portals** (favorite sites, one tap away), your Knowledge Hubs with everything captured in them, and your saved iCE maps. This is where you browse _your own_ collection instead of the web.

### 🌐 The Browser

Ordinary web browsing with tabs — plus a capture button and page-aware AI actions always within reach. A new tab opens on a start page with your portals and a search box, not a wall of noise.

### 💬 AiON — the sidekick panel

A sidebar that follows you everywhere. It answers questions grounded in your captures, shows a **semantic trail** of saved pages related to what you're currently reading, and helps route new captures to the right hub. Answers render as clean text with citations and can be copied out.

### 🧊 iCE — the depth explorer

The **Information Complexity Explorer** is ÆTHER's most unusual tool. Give it a topic, and the local AI generates an "iceberg" map of it: the widely-known basics at the surface, and progressively deeper, more specialized layers as you descend. It's a way to _see the shape of a subject_ — and to find research hooks you didn't know existed. Maps can be saved and revisited from the dashboard.

_(For the curious, there are also experimental surfaces — Flow, which draws a graph of how your captures relate to a query, and AiR, an automatic document renderer — tucked behind a developer-mode switch.)_

---

## What does "local AI" actually mean here?

Two small AI models live inside the app, running on your own processor:

- an **embedding model** (the "librarian") that converts every captured page — and every question you ask — into a mathematical fingerprint of its meaning, so search works by _what things are about_, not just keywords;
- a **chat model** (the "writer") that reads the most relevant captured passages and composes the answer you see, with citations.

On first launch, ÆTHER offers to download a recommended model pack (a couple of gigabytes, from official sources). That's the only big download; after that, everything runs offline. You can pick a lighter, faster writer or a heavier, smarter one depending on your hardware.

**The honest privacy picture:** everything ÆTHER _itself_ produces — captured text, hubs, indexes, questions, answers, topic maps — stays on your machine, full stop. But normal browsing is still normal browsing: the websites you visit see your requests and run their scripts just like in any browser. ÆTHER's privacy promise is about its intelligence pipeline, not a cloak of invisibility for the web.

---

## What it is — and isn't

**ÆTHER is good at:**

- Being your everyday browser while quietly building a private research library
- Answering "where did I read that…?" — by meaning, not keywords
- Grounded Q&A over your own sources, with citations you can verify
- Mapping how deep a topic goes before you dive in (iCE)
- Working offline, on your hardware, with zero recurring costs

**ÆTHER is not:**

- A cloud chatbot — it won't answer from the whole internet, and that's the point: answers come from _your_ captured sources
- A privacy shield for browsing itself — websites behave as they do in any browser
- A lightweight app for very old machines — the local AI wants a reasonably modern computer (8 GB of RAM is the practical floor; see the README for specifics)

---

## Where it runs

macOS (Apple Silicon and Intel), Windows, Linux (including ARM devices like the Raspberry Pi 5), and an Android build with native browser tabs. One codebase, no server component, nothing to host.

---

## Try it in five minutes

1. Install ÆTHER and let **AiON Launch** download the recommended models.
2. Browse to any article you find interesting and hit **capture**.
3. Make a hub for the topic and drop the capture in (or accept the suggested hub).
4. Capture two or three more related pages.
5. Open **AiON** and ask a question about the topic.

The answer you get will be built from those pages — cited, private, and generated entirely on your machine. That's ÆTHER in a nutshell: **browse the web, keep the good parts, and let your own library talk back to you.**
