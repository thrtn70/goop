# Contributing to Goop

Thanks for your interest. Goop is early — v0.1 MVP is still landing. Read this once before submitting a change.

## Project Layout

Goop is a Cargo workspace with a Tauri 2 shell. The Rust backend lives in `crates/`:

| Crate | What it owns |
|---|---|
| `goop-core` | Shared types (`Job`, `JobState`, `JobKind`, `ConvertRequest`, `Preset`, …), `EventSink` / `PidRegistry` traits, errors, `ts-rs` exports to `shared/types/`. |
| `goop-config` | `Settings`, `SettingsPatch`, `apply_patch`. JSON file in your OS config dir. |
| `goop-queue` | SQLite job store, `Scheduler`, `process_control` (cross-platform pause / resume primitives). |
| `goop-extractor` | `yt-dlp` wrapper — URL probe + download, `--cookies-from-browser` support, friendly error mapping. |
| `goop-converter` | `ConversionBackend` trait, `FfmpegBackend` (with hardware-encoder detection + software fallback) and `ImageMagickBackend` (in-process via the `image` crate). |
| `goop-pdf` | Merge / split / compress via `lopdf` and a bundled Ghostscript sidecar. |
| `goop-sidecar` | `BinaryResolver` — sidecar dir → `$PATH` fallback. |
| `src-tauri` | Tauri shell, `AppState`, IPC commands (`commands/*.rs`), `ThumbnailService` (video first frame, image decode, PDF page 1, audio waveform). |

Frontend (`src/`) is React 18 + Tailwind + Zustand 4 + react-router 6 + Vite 5. State lives in `src/store/appStore.ts`. IPC commands are wrapped in `src/ipc/commands.ts` (`api.queue.*`, `api.preset.*`, …). Rust types reach TS via `ts-rs` — when a struct on the Rust side changes, run `scripts/generate-bindings.sh` to refresh `shared/types/`.

## Build Prerequisites

- **Rust:** stable 1.80+. Use `rustup` and the pinned toolchain in `rust-toolchain.toml`.
- **Node.js:** 20+ with `npm`. Tauri 2's CLI and the Vite dev server need it.
- **Git:** recent.
- **Platform system libraries for Tauri 2:**
  - **Windows:** MSVC Build Tools 2022 and WebView2 Runtime (usually pre-installed on Windows 11).
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).

## Dev Loop

From the repo root:

```bash
npm install
./scripts/fetch-sidecars.sh   # one-time, pulls yt-dlp + ffmpeg for your OS into src-tauri/bin/
npm run tauri dev
```

`npm run tauri dev` launches the Rust backend with hot-reload and the Vite frontend together. Rust changes trigger a recompile; React changes hot-reload in place.

Before every commit:

```bash
cargo fmt
cargo clippy -- -D warnings
cargo test
npm run typecheck
npm run test
```

If you changed any `#[derive(TS)]` struct or enum on the Rust side, regenerate the TypeScript bindings:

```bash
scripts/generate-bindings.sh
```

This rewrites `shared/types/*.ts` from the Rust definitions. Commit the regenerated files alongside the Rust change.

## Sidecar Binary Sources & Provenance

Goop does not bundle third-party binaries in the repo. `scripts/fetch-sidecars.sh` downloads them at setup time and places them under `src-tauri/bin/`. The script pins upstream URLs from reputable primary sources:

- **Windows `ffmpeg`:** `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip` (Gyan.dev — the ffmpeg project's own recommended Windows build host).
- **macOS `ffmpeg`:** `https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip` (evermeet.cx — signed static builds maintained by Helmut K. C. Tessarek).
- **`yt-dlp` (per OS):** `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos` (macOS), `yt-dlp.exe` (Windows) — selected per platform by the script.

Do not commit sidecar binaries. Do not point the script at mirrors or personal forks. Any change to these URLs requires a PR that includes the upstream rationale.

## Pre-Push Quality Gate (Mandatory)

Goop's pre-push hook (`scripts/pre-push.sh`, symlinked into `.git/hooks/pre-push`) runs formatter, lints, tests, and typecheck. Any failure blocks the push. Fix locally, re-run, re-push. See [DEVELOPMENT.md](DEVELOPMENT.md) for the full gate contract.

## PR Checklist

A PR is mergeable when:

- [ ] Commit messages follow `feat|fix|refactor|docs|test|chore|perf|ci|security: <desc>` (see [DEVELOPMENT.md](DEVELOPMENT.md)).
- [ ] `cargo fmt`, `cargo clippy -- -D warnings`, and `cargo test` pass.
- [ ] `npm run typecheck` and `npm run test` pass.
- [ ] Tests accompany new behavior (Rust unit/integration tests and, for UI flows, a React test).
- [ ] The pre-push quality gate ran clean.
- [ ] No new `unwrap()`/`expect()` on user input, sidecar output, or IO; no `any` in TypeScript.
- [ ] No secrets, tokens, or user URLs committed or logged.
- [ ] If the change touches sidecars, release workflows, or shared types (`ts-rs`), a maintainer review is requested.

## Reporting Issues

Open a GitHub issue with:
- Commit SHA (or release tag if published).
- OS and version.
- Steps to reproduce.
- What you expected vs. what happened.
- Relevant log excerpts (`RUST_LOG=goop=debug`) with any URLs or paths redacted.
