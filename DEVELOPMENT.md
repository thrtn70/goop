# Development Notes

Project overview and conventions for contributors. For build and dev-loop instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project Overview

Goop is a Tauri 2 desktop app for downloading URLs and converting media, images, and PDFs locally. The shipped targets are macOS arm64 and Windows x64; Linux and Intel macOS are not release targets. The repository has eight Tauri-independent engine crates, a thin Rust desktop shell, and a React + TypeScript client.

## Tech Stack

- **Shell:** Tauri 2 on stable Rust — thin IPC, lifecycle, updater, and OS integration
- **Engine crates:** `goop-core`, `goop-sidecar`, `goop-extractor`, `goop-queue`, `goop-config`, `goop-converter`, `goop-pdf`, and `goop-metadata`
- **Persistence:** SQLite via `rusqlite` for queue/history; JSON for settings and presets
- **Sidecars:** ffmpeg/ffprobe, yt-dlp, gallery-dl, Ghostscript, mutool, and Tesseract, fetched by `scripts/fetch-sidecars.sh` and shipped under `src-tauri/bin/`
- **Frontend:** strict TypeScript, React 18, React Router 7, Vite 8, Tailwind 3, Zustand, and `ts-rs`-generated Rust types
- **Quality checks:** Rust format/clippy/tests, TypeScript project checks, ESLint for `src/` and `site/`, and Vitest

## Architecture Overview

- Tauri commands validate desktop input and enqueue typed jobs. `goop-queue` schedules them against the extractor, converter, PDF, image, and metadata engines; progress returns through Tauri events.
- `goop-extractor` routes between yt-dlp, gallery-dl, direct HTTP, and optional TorBox debrid downloads. `goop-sidecar` resolves and updates external tools.
- The eight crates under `crates/` contain no Tauri dependency. `src-tauri/` adapts that engine to the desktop client; `site/` is a separate static landing page.
- Frontend never talks to sidecars directly. All side effects go through typed commands.

Read the crate docstrings before changing architecture, adding crates, or touching release pipeline code.

## Pre-Push Quality Gate (Mandatory)

Before any `git push`, run `./scripts/pre-push.sh`. A fresh clone does not install Git hooks automatically. The gate runs:

1. `cargo fmt --all --check` — formatting must be clean.
2. `cargo clippy --workspace --all-targets -- -D warnings` — no lint warnings tolerated.
3. `cargo test --workspace` — all tests green.
4. `npm run typecheck` — both TypeScript project configs must pass without emitting JavaScript.
5. `npm run lint` — app and landing-page lint must pass with zero warnings.
6. `npm run test` — Vitest suite green.

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

## Coding Standards

### Rust
- **No `unwrap()` / `expect()` on user input, sidecar output, or IO.** Use `anyhow::Result` at boundaries and `thiserror` for domain errors.
- **No panics in library crates.** The Tauri shell surfaces command failures through `Result<T, IpcError>`.
- **Immutable by default.** Prefer returning new values over mutating through `&mut`. Reach for `&mut` only when the type semantics require it.
- **No blocking IO inside async contexts.** Use `tokio::process::Command`, `tokio::fs`, and channels for sidecar IO.
- **No secrets, tokens, or user URLs in logs.** `tracing` fields must be explicit; include local paths only when they are necessary to diagnose a filesystem failure, and never log whole `serde_json::Value` payloads.
- Use focused checks while iterating; run the full pre-push gate before pushing.

### TypeScript / React
- **Strict TS only.** No `any`, no `@ts-ignore`, no `as unknown as T` to silence the checker.
- **Types come from Rust.** Do not hand-write types that mirror a Rust struct — regenerate via `ts-rs`.
- **Pure components, single source of truth.** Derive state; don't duplicate it. Zustand stores own mutation; components render.
- **No inline fetches to external URLs.** All network activity goes through a Tauri command.
- Use the project typecheck while iterating; run the full pre-push gate before pushing.

### Cross-cutting
- **Many small files over few large files.** Target 200–400 lines per module; 800 is a smell.
- **Error messages are user-facing text.** They must be specific, actionable, and free of Rust jargon by the time they reach the UI.
- **No hardcoded secrets or keys.** Fixed, reviewed service and sidecar URLs belong at their trust boundary; user-selected configuration belongs in the config directory.
- **Every new behavior gets a test at its owning layer.** Shell and workflow guards need tests too when they enforce release or supply-chain behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist.
