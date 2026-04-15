# Development Notes

Project overview and conventions for contributors. For build and dev-loop instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project Overview

Goop is a cross-platform desktop app that downloads video and audio from pasted URLs using a bundled `yt-dlp` sidecar, with a live queue, cancel, reveal-in-OS, persistent settings, and no network telemetry. v0.1 targets Windows, macOS, and Linux via Tauri 2 with a React + TypeScript frontend and a Cargo workspace of domain crates.

## Tech Stack

- **Shell:** Tauri 2 (Rust 1.80+) — thin command surface, auto-updater off in v0.1
- **Backend crates:** `goop-core`, `goop-sidecar`, `goop-extractor`, `goop-queue`, `goop-config` (Cargo workspace)
- **Persistence:** SQLite via `rusqlite` (bundled feature) — download history + settings
- **Sidecars:** `yt-dlp` (single-binary) and `ffmpeg` (static build), fetched at setup time by `scripts/fetch-sidecars.sh` and shipped under `src-tauri/bin/`
- **Frontend:** TypeScript 5.4 strict, React 18, Vite, Tailwind 3, Zustand for state, `ts-rs`-generated types from Rust
- **Quality checks:** `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test`, `tsc --noEmit`

## Architecture Overview

- Tauri invokes Rust commands → `goop-core` orchestrates → `goop-queue` schedules downloads → `goop-sidecar` spawns `yt-dlp`/`ffmpeg` → progress streams via Tauri events back to React.
- `goop-config` owns typed settings; `goop-extractor` owns URL normalization and format selection.
- Frontend never talks to sidecars directly. All side effects go through typed commands.

Read the crate docstrings before changing architecture, adding crates, or touching release pipeline code.

## Pre-Push Quality Gate (Mandatory)

Before any `git push`, the pre-push hook (`scripts/pre-push.sh`, symlinked into `.git/hooks/pre-push`) runs:

1. `cargo fmt --all --check` — formatting must be clean.
2. `cargo clippy --workspace --all-targets -- -D warnings` — no lint warnings tolerated.
3. `cargo test --workspace` — all tests green.
4. `npm run typecheck` — TypeScript strict mode must pass.
5. `npm run test` — Vitest suite green.

Any failure blocks the push. Fix locally, re-run, re-push.

## Commit Message Conventions

Format:

```
<type>: <short imperative description>

<optional body>
```

Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `security`.

Keep the subject under 72 chars. Put rationale in the body, not the subject.

## Branching

- `main` is the integration branch. It must build, test green, and pass the quality gate at every commit.
- Feature work happens on topic branches named `feat/<slug>`, `fix/<slug>`, `refactor/<slug>`.
- PRs are required for anything that touches release, security, sidecars, or shared types.
- Scaffolding commits during the v0.1 bootstrap may land directly on `main` by explicit owner authorization only.

## Coding Standards

### Rust
- **No `unwrap()` / `expect()` on user input, sidecar output, or IO.** Use `anyhow::Result` at boundaries and `thiserror` for domain errors.
- **No panics in library crates.** The Tauri shell may surface errors as commands returning `Result<T, String>` (typed via `ts-rs`).
- **Immutable by default.** Prefer returning new values over mutating through `&mut`. Reach for `&mut` only when the type semantics require it.
- **No blocking IO inside async contexts.** Use `tokio::process::Command`, `tokio::fs`, and channels for sidecar IO.
- **No secrets, tokens, or user paths in logs.** `tracing` fields must be explicit; never log whole `serde_json::Value` payloads that could include user URLs with credentials.
- Run `cargo fmt`, `cargo clippy -- -D warnings`, and `cargo test` before every commit.

### TypeScript / React
- **Strict TS only.** No `any`, no `@ts-ignore`, no `as unknown as T` to silence the checker.
- **Types come from Rust.** Do not hand-write types that mirror a Rust struct — regenerate via `ts-rs`.
- **Pure components, single source of truth.** Derive state; don't duplicate it. Zustand stores own mutation; components render.
- **No inline fetches to external URLs.** All network activity goes through a Tauri command.
- Run `tsc --noEmit` before every commit.

### Cross-cutting
- **Many small files over few large files.** Target 200–400 lines per module; 800 is a smell.
- **Error messages are user-facing text.** They must be specific, actionable, and free of Rust jargon by the time they reach the UI.
- **No hardcoded secrets, keys, or URLs.** Sidecar URLs live in `scripts/fetch-sidecars.sh`; settings live in the user's config directory.
- **Every new Rust crate, Tauri command, or TypeScript module gets a test.** Shell scripts are exempt. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist.
