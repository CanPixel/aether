---
created: 2026-08-02T07:57:35.007Z
title: Add exact-passage citations
area: ui
files:
  - src/renderer/src/components/IntelligencePanel.tsx
  - src/renderer/src/components/answer-markdown.tsx
  - src-tauri/src/chat.rs
---

## Problem

AiON citations open the source but do not yet offer an evidence popover containing
the exact locally preserved passage used for the answer. This is intentionally
deferred while the product direction is reconsidered.

## Solution

Later, evaluate an evidence-first citation interaction that can reveal and copy the
matching immutable passage, its surrounding extracted context, capture time, and
live source URL. Do not turn this into file or document management.
