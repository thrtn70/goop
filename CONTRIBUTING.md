# Contributing to Goop

Thanks for your interest. Goop is a focused desktop utility with shipped macOS arm64 and Windows x64 releases. Read this once before submitting a change.

## Project Layout

Goop is a Cargo workspace with a Tauri 2 shell. The Rust backend lives in `crates/`:

| Crate | What it owns |
|---|---|
| `goop-core` | Shared types (`Job`, `JobState`, `JobKind`, `ConvertRequest`, `Preset`, …), `EventSink` / `PidRegistry` traits, errors, `ts-rs` exports to `shared/types/`. |
| `goop-config` | `Settings`, `SettingsPatch`, `apply_patch`. JSON file in your OS config dir. |
| `goop-queue` | SQLite job store, `Scheduler`, `process_control` (cross-platform pause / resume primitives). |
| `goop-extractor` | URL probe and download routing across yt-dlp, gallery-dl, direct HTTP, and optional TorBox debrid. |
| `goop-converter` | Media conversion, hardware-encoder detection/fallback, and in-process image conversion/editing. |
| `goop-pdf` | PDF inspection and operations via `lopdf`, Ghostscript, mutool, and Tesseract. |
| `goop-metadata` | Typed metadata read/write operations and policy enforcement. |
| `goop-sidecar` | `BinaryResolver`, status reporting, and verified runtime updates for supported tools. |
| `src-tauri` | Tauri shell, `AppState`, IPC commands (`commands/*.rs`), `ThumbnailService` (video first frame, image decode, PDF page 1, audio waveform). |

Frontend (`src/`) is React 18 + Tailwind + Zustand 4 + React Router 7 + Vite 8. State lives in `src/store/appStore.ts`. IPC commands are wrapped in `src/ipc/commands.ts` (`api.queue.*`, `api.preset.*`, …). Rust types reach TS via `ts-rs` — when a struct on the Rust side changes, run `scripts/generate-bindings.sh` to refresh `shared/types/`.

## Build Prerequisites

- **Rust:** the stable toolchain selected by `rust-toolchain.toml`, including rustfmt and Clippy.
- **Node.js:** 22.12+ with `npm`. Tauri 2's CLI and the Vite dev server need it.
- **Git:** recent.
- **macOS arm64:** Xcode Command Line Tools, Homebrew at `/opt/homebrew`, CMake 3.23+, pkgconf, and Python 3.14.6 (the version used to lock the gallery-dl build inputs; `brew install cmake pkgconf`).
- **Windows x64:** Git Bash, 7-Zip at `C:\Program Files\7-Zip`, vcpkg at `C:\vcpkg`, WebView2, and MSVC Build Tools 2022 with the "Desktop development with C++" workload.

## Dev Loop

From the repo root:

```bash
npm ci
```

On macOS arm64, make sure `/path/to/python3.14 --version` reports 3.14.6, then run:

```bash
./scripts/build-static-heif-deps.sh
PYTHON=/path/to/python3.14 ./scripts/fetch-sidecars.sh aarch64-apple-darwin
npm run tauri dev
```

On Windows x64, use Git Bash:

```bash
/c/vcpkg/vcpkg.exe install "libheif[core]:x64-windows-static"
export VCPKG_ROOT=C:/vcpkg
export VCPKGRS_TRIPLET=x64-windows-static
./scripts/fetch-sidecars.sh x86_64-pc-windows-msvc
npm run tauri dev
```

`npm run tauri dev` launches the Rust backend with hot-reload and the Vite frontend together. Rust changes trigger a recompile; React changes hot-reload in place.

Before every push:

```bash
./scripts/pre-push.sh
```

If you changed any `#[derive(TS)]` struct or enum on the Rust side, regenerate the TypeScript bindings:

```bash
scripts/generate-bindings.sh
```

This rewrites `shared/types/*.ts` from the Rust definitions. Commit the regenerated files alongside the Rust change.

## Sidecar Binary Sources & Provenance

Goop does not commit third-party binaries. `scripts/fetch-sidecars.sh` places reviewed artifacts under `src-tauri/bin/` from these upstream trust roots:

- Gyan.dev for Windows ffmpeg/ffprobe and osxexperts.net for macOS arm64 ffmpeg/ffprobe.
- GitHub releases for yt-dlp, Ghostscript, MuPDF tools, and Windows Tesseract; Codeberg releases for gallery-dl binaries.
- Homebrew/core for the macOS Ghostscript, MuPDF tools, Tesseract, and their dynamic-library closures.
- A hash-locked PyPI dependency set for the macOS gallery-dl PyInstaller build.

Every direct download is pinned to reviewed SHA-256 bytes. Runtime updater payloads are checked against the checksum manifest published with the same upstream release. That detects corruption or payload-only replacement; the upstream release account remains the trust root. Do not commit sidecar binaries or switch sources casually. Any source, version, or digest change requires a PR with the upstream rationale and passing sidecar smoke jobs on both release platforms.

## Pre-Push Quality Gate (Mandatory)

Run `./scripts/pre-push.sh` before every push. It runs formatting, lints, tests, and typechecks; any failure blocks the change from being mergeable. A fresh clone does not install Git hooks automatically. See [DEVELOPMENT.md](DEVELOPMENT.md) for the full gate contract.

## Dependencies and Licensing

Goop is MIT. We bundle two AGPL-3.0 sidecars from Artifex (Ghostscript, mutool) as separate executables, spawned via `Command::spawn`. **Do not add MuPDF-family code into goop's own binary.** Specifically:

- No `mupdf-*` Rust crate in any workspace `Cargo.toml`.
- No `mupdf.js` / `mupdf.wasm` / `@mupdf/*` import in `src/` or `shared/`.

The CI `legal` job in `.github/workflows/audit.yml` rejects either pattern. Full rationale: [LICENSING.md](LICENSING.md).

## PR Checklist

A PR is mergeable when:

- [ ] Commit messages follow `feat|fix|refactor|docs|test|chore|perf|ci|security: <desc>` (see [DEVELOPMENT.md](DEVELOPMENT.md)).
- [ ] `cargo fmt`, `cargo clippy -- -D warnings`, and `cargo test` pass.
- [ ] `npm run typecheck`, `npm run lint`, and `npm run test` pass.
- [ ] Tests accompany new behavior (Rust unit/integration tests and, for UI flows, a React test).
- [ ] The pre-push quality gate ran clean.
- [ ] No new `unwrap()`/`expect()` on user input, sidecar output, or IO; no `any` in TypeScript.
- [ ] No secrets, tokens, or user URLs committed or logged.
- [ ] If the change touches sidecars, release workflows, network input, or shared types (`ts-rs`), the appropriate maintainer/security review is requested.

## Reporting Issues

Open a GitHub issue with:
- Commit SHA (or release tag if published).
- OS and version.
- Steps to reproduce.
- What you expected vs. what happened.
- Relevant log excerpts (`RUST_LOG=goop=debug`) with any URLs or paths redacted.
