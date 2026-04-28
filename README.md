<p align="center">
  <img src="assets/goop-mark.svg" width="120" alt="Goop logo">
</p>

<h1 align="center">Goop</h1>

<p align="center">
  Take control of your files. Goop is a lightweight desktop downloader and converter.
  Grab video, audio, and images from URLs; convert and compress media + PDFs; all local, all polished.
</p>

<p align="center">
  <a href="https://thrtn70.github.io/goop/"><img alt="Website" src="https://img.shields.io/badge/Website-thrtn70.github.io%2Fgoop-006B5E?style=flat-square"></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square">
  <img alt="Rust 2021" src="https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square">
  <img alt="TypeScript 5" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Latest release" src="https://img.shields.io/github/v/release/thrtn70/goop?style=flat-square">
</p>

* * *

## What is Goop?

Goop is a desktop app for grabbing media off the internet and shaping it on disk. Paste a URL — video, audio, image gallery, or full image-host album — and Goop figures out the right tool, downloads the result locally, and shows it in a queue you can pause, reorder, or cancel. Drop a file onto Convert and pick a target format; drop a PDF and Merge / Split / Compress it. No accounts, no telemetry, no remote config. The bundled binaries (yt-dlp, gallery-dl, ffmpeg, Ghostscript) only reach out for what you asked them to.

*Think of it as **yt-dlp + gallery-dl + ffmpeg + Ghostscript with a UI that doesn't make you read a man page first**.*

> **Screenshots and a tour:** the [Goop website](https://thrtn70.github.io/goop/) has the full visual walkthrough with annotated screens.

* * *

## Features

| Category | Details |
|---|---|
| **Extract** | yt-dlp + gallery-dl, ~600 supported sites between them. URL routed automatically; bidirectional fallback if the first extractor misses. |
| **Convert** | ffmpeg-backed video/audio conversion with format probing, smart defaults, and a remux-vs-re-encode compatibility matrix. Image conversion runs in-process via the `image` crate (no extra sidecar). |
| **Compress** | Quality-slider mode (1–100) or target-size mode (KB/MB). Works on video, audio, images, and PDFs. Source-vs-target preview before launch. |
| **PDF** | Merge (drag-to-reorder), Split (range strings like `1-3, 7-10`), Compress (Ghostscript with Screen / Ebook / Printer presets). |
| **Queue** | Pause / resume on running ffmpeg + Ghostscript jobs (CPU drops to ~0; partial output preserved). Drag-to-reorder, batch cancel, resizable + collapsible sidebar, total-ETA in the header. |
| **History** | List or grid view with thumbnails, sort by date / size / name, filter by job kind, full-text search, multi-select for batch reveal / remove / move-to-trash. Slide-out preview panel + Quick View modal. |
| **Hardware acceleration** | Auto-detects VideoToolbox (macOS), NVENC / QSV / AMF (Windows). 2–5× faster re-encodes when available; transparently falls back to software on encoder errors. |
| **Cookies from browser** | Pick Chrome / Firefox / Safari / Edge / Brave / Vivaldi / Opera / Chromium / Whale and Goop forwards your existing browser session via `--cookies-from-browser` for sites that require login. Cookies stay local. |
| **Presets** | Named format + quality combinations applied as chips. Ships with four built-ins (YouTube Upload, Twitter/X Video, Podcast MP3, Web Image). Save your own; export / import as JSON between machines. |
| **Updates** | One-click in-app updates for the bundled yt-dlp and gallery-dl. Goop itself checks GitHub for new releases on launch and offers a one-click installer download. |
| **Accessibility** | WCAG 2.1 AA audit pass: visible focus rings, full keyboard nav, screen-reader job-state announcements, focus trap inside modals, `prefers-reduced-motion` respected on every animation. |
| **Performance** | Lazy-loaded route chunks (~16% smaller cold-start payload). Thumbnail generation bounded to 4 concurrent workers. Spring-settled queue ETA so the seconds counter doesn't jitter. |

* * *

## Installation

### Download (Recommended)

Grab the build for your OS from the [Releases page](https://github.com/thrtn70/goop/releases/latest).

#### macOS arm64

1. Download `Goop_<version>_aarch64.dmg`.
2. Open the DMG and drag **Goop.app** into `/Applications`.
3. Run once in Terminal to clear the Gatekeeper quarantine flag:
   ```bash
   sudo xattr -cr /Applications/Goop.app
   ```
4. Open Goop from Launchpad or Spotlight.

#### Windows x64

1. Download `Goop_<version>_x64_en-US.msi`.
2. Double-click to install.
3. Launch from the Start menu.

### System Requirements

- **macOS 13+** on Apple Silicon (M-series). Intel Macs are not a release target.
- **Windows 10+** (x64) with WebView2 Runtime (ships with Windows 11; auto-installed on Windows 10 if missing).
- ~180 MB disk for the app + bundled sidecars (ffmpeg, ffprobe, yt-dlp, gallery-dl, Ghostscript).
- A network connection only when downloading.

### Auto-Update

> Goop checks GitHub for new releases on launch (toggle in **Settings → Updates**). When an update is available, an in-app banner downloads and opens the installer with one click. The bundled yt-dlp and gallery-dl have their own update buttons in the same section.

> **Portable build** — not currently shipped. The underlying Tauri build supports it; [open an issue](https://github.com/thrtn70/goop/issues/new) if you'd like one.

* * *

## Supported Sites

URL routing is automatic. The classifier sends image-host domains to gallery-dl (Bunkr, Gofile, Pixeldrain, Kemono, Coomer, Cyberdrop, Imgur, Twitter/X, RedGifs, ImageBam, ImgBox, Saint) and everything else to yt-dlp. If the chosen extractor returns *"unsupported URL"*, Goop retries with the other one before surfacing the failure.

- **yt-dlp** — see [`yt-dlp/yt-dlp/supportedsites.md`](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) for the full list (~1700 sites including YouTube, SoundCloud, TikTok, Instagram, Vimeo, Reddit).
- **gallery-dl** — see [`mikf/gallery-dl/supportedsites.md`](https://github.com/mikf/gallery-dl/blob/master/docs/supportedsites.md) for the full list (~300 sites including the image-host shortlist above plus Patreon-via-Kemono, Pixiv, DeviantArt, Tumblr, etc.).

* * *

## Site-Specific Setup

### Sites that require login

For Twitter/X, Instagram reels, members-only YouTube, Patreon-via-Kemono, age-gated content, and similar paywalled URLs, enable **Settings → General → Cookies from browser** and pick the browser you're already logged into. Goop forwards your existing session via `--cookies-from-browser` (works for both yt-dlp and gallery-dl). Cookies are read locally and never leave your machine.

> Cookies must come from a regular (non-private / non-incognito) browser window. Both extractors refuse to read incognito cookies.

* * *

## Hotkeys

| Action | macOS | Windows |
|---|---|---|
| Command palette | `⌘K` | `Ctrl+K` |
| Jump to Extract / Convert / Compress / History / Settings | `⌘1`–`⌘5` | `Ctrl+1`–`Ctrl+5` |
| Focus URL input (Extract) | `⌘N` | `Ctrl+N` |
| Open file picker (Convert / Compress) | `⌘O` | `Ctrl+O` |
| Settings | `⌘,` | `Ctrl+,` |
| Toggle queue sidebar | `⌘⇧Q` | `Ctrl+Shift+Q` |
| Quick View on a focused History row | `Space` | `Space` |
| Cycle previewed History rows | `←` / `→` | `←` / `→` |

* * *

<details>
<summary><strong>Development Setup</strong></summary>

### Prerequisites

- **Rust** 1.75+ (`rustup install stable`)
- **Node** 20+ (`nvm install 20`)
- **npm** 10+ (ships with Node 20)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Microsoft Visual Studio Build Tools 2022 with the "Desktop development with C++" workload

### Build steps

```bash
# 1. Clone the repo
git clone https://github.com/thrtn70/goop.git
cd goop

# 2. Fetch sidecar binaries for your host triple
scripts/fetch-sidecars.sh "$(rustc -vV | awk '/host/ {print $2}')"

# 3. Install JS deps
npm ci

# 4. Generate ts-rs bindings (one-time, after Rust struct edits)
scripts/generate-bindings.sh

# 5. Run the dev loop
npm run tauri dev
```

The pre-push gate (`scripts/pre-push.sh`) runs `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace --all-features`, `tsc --noEmit`, and `vitest run`. It runs automatically on `git push`; never bypass with `--no-verify`.

</details>

* * *

## Project Structure

```
.
├── crates/         # 8 Rust crates (core, queue, extractor, converter, pdf, sidecar, config, tauri)
├── src/            # React + TypeScript frontend
├── src-tauri/      # Tauri shell + IPC commands
├── shared/types/   # ts-rs-generated TypeScript bindings
├── scripts/        # Build helpers (sidecars, bindings, pre-push, icon rasterizer)
└── assets/         # README artwork and brand icon source
```

* * *

## Tech Stack

| Layer | Tech |
|---|---|
| Desktop shell | Tauri 2 (`tauri = { version = "2", features = ["protocol-asset"] }`) |
| Backend | Rust 2021 edition, 8-crate workspace |
| Frontend | React 18 + TypeScript 5 + Tailwind 3 + Vite 5 + Zustand 4 |
| Type bridge | `ts-rs` Rust → TypeScript bindings |
| Sidecars | ffmpeg, ffprobe, yt-dlp, gallery-dl, Ghostscript |
| Drag/drop | `@dnd-kit/core` + `@dnd-kit/sortable` |
| Command palette | `cmdk` |
| Hotkeys | `tinykeys` |
| Icons | `lucide-react` |
| Testing | `cargo test` + Vitest with jsdom + `@testing-library/react` |

* * *

<details>
<summary><strong>Running Tests</strong></summary>

```bash
# Rust workspace (~270 tests across 8 crates)
cargo test --workspace --all-features

# Frontend (~140 tests)
npx vitest run

# Watch mode while editing
npx vitest --watch
cargo watch -x 'test --workspace'  # if cargo-watch installed

# Coverage
cargo llvm-cov --html
```

</details>

* * *

## Troubleshooting

### "Goop.app can't be opened because Apple cannot check it for malicious software" (macOS)

Run the `sudo xattr -cr /Applications/Goop.app` command in the installation section above. Goop is not signed with an Apple Developer ID, so macOS quarantines it on first launch.

### "Permission denied" when running `xattr -cr` (macOS)

Use `sudo xattr -cr /Applications/Goop.app`. Some bundled binaries require elevated permissions to clear the quarantine flag.

### First download is slow or fails immediately

Sites change their internal APIs frequently. Open **Settings → Updates → Update yt-dlp** (or **Update gallery-dl**) to self-update the bundled extractor to its latest release.

### Downloads stall or fail with "HTTP 403"

Usually means the extractor needs an update — same fix as above. If that doesn't help, the host may be blocking data-center IPs or requiring sign-in. Enable **Cookies from browser** in Settings if you have an account.

### The audio-only checkbox produces video anyway

Make sure the selected format row has `audio only` in the dropdown, or toggle the **audio only** checkbox and pick **Best (auto)**.

### Progress bar stays at 99% for a while

Normal for large files — yt-dlp is muxing/finalising. Don't cancel.

### Windows Defender flags the installer

The installer is not yet code-signed. Verify the SHA-256 of the `.msi` against the hash on the Releases page, then allow it through SmartScreen.

### Where does Goop store files?

The default download folder is your OS's standard Downloads directory. Change it in Settings. The queue database and settings file live in your OS config directory under `goop/`.

### Reporting bugs

Open a [GitHub issue](https://github.com/thrtn70/goop/issues) with your OS, the exact URL pattern (redact personal info), and a snippet from the log (launch with `RUST_LOG=goop=debug` to get verbose output).

* * *

## License

[MIT](LICENSE).

* * *

## About

Goop is built and maintained by [@thrtn70](https://github.com/thrtn70). The website at [thrtn70.github.io/goop](https://thrtn70.github.io/goop/) has screenshots, a tour, and the release archive. Source on [GitHub](https://github.com/thrtn70/goop). Bug reports and feature requests welcome via [issues](https://github.com/thrtn70/goop/issues).
