---
created: 2026-08-02T07:57:35.007Z
title: Add manual source-change checking
area: general
files:
  - src-tauri/src/extract.rs
  - src-tauri/src/commands.rs
  - src/renderer/src/components/Dashboard.tsx
---

## Problem

Capture fingerprints can distinguish changed extracted text, but AETHER does not
offer an explicit user-triggered check against the current live source. Automatic
checking or refresh would violate the product's opt-in and immutable-record
principles.

## Solution

Later, reconsider an explicit Check Live Source action. It must never run in the
background, overwrite an existing extraction, or weaken the saved record. Report
only unchanged, changed, unavailable, or authentication-required status.
