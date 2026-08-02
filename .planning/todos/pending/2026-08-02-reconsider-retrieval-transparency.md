---
created: 2026-08-02T07:57:35.007Z
title: Reconsider retrieval transparency
area: ui
files:
  - src-tauri/src/retrieval_scoring.rs
  - src-tauri/src/trail.rs
  - src/renderer/src/components/IntelligencePanel.tsx
---

## Problem

Showing semantic scores, ranking contributions, and why a result matched could
improve legibility, but it could also add false precision and visual complexity.
The interaction needs further product consideration before implementation.

## Solution

Later, decide which retrieval explanations are genuinely useful to researchers.
Prefer plain evidence and understandable reasons over raw model scores. Keep all
explanations local and derived only from captures the user deliberately saved.
