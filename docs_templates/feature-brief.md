# Feature Design Brief — <name>

> Template for scoping a Goop feature before implementation. Copy, rename (e.g. `feature-brief-queue.md`), and fill it in. A brief is complete when an engineer can implement without guessing at shape, state, or copy.

## Feature Summary
What this feature is in two or three sentences. Why it exists in Goop. What user problem it solves.

## Primary User Action
The single most important thing the user does with this feature. If the feature does this one thing well, it succeeds.

## Design Direction
Tone, density, and personality. How this feature fits Goop's overall character (utilitarian, fast, respectful of the user's disk and attention). Reference any shared design tokens.

## Layout
Zones of the UI this feature touches. Where it lives in the window. How it behaves on resize. What collapses, what stays pinned.

## Key States
Table of states the user can observe, what they see in each, and the tone.

| State | What user sees | Tone |
|-------|----------------|------|
| Empty | | |
| Loading | | |
| Active / in progress | | |
| Success | | |
| Error | | |

## Interaction Model
- Pointer behavior (click, double-click, right-click, drag)
- Keyboard behavior (shortcuts, tab order, Enter/Escape semantics)
- System integration (OS notifications, tray, reveal-in-OS, clipboard)
- Cancelation and recovery paths

## Content Requirements
- Labels, button copy, empty-state copy
- Placeholder text, tooltips, error messages (specific and actionable — never "something went wrong")
- Dynamic ranges the UI must handle (queue sizes, filename lengths, file sizes, durations)

## Implementation References
- Relevant crates (`goop-core`, `goop-queue`, `goop-sidecar`, `goop-extractor`, `goop-config`)
- Relevant Tauri commands and events
- `ts-rs`-generated types the UI will consume
- Relevant source files that cover this feature

## Open Decisions
Questions that must be answered before code ships. Assign an owner to each.
