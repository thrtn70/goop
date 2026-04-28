# Goop

**A no-frills desktop app for downloading video and audio from URLs.**

Paste a link, pick a format, and Goop handles the rest through bundled `yt-dlp` (videos and audio) and `gallery-dl` (image hosts) with a live queue, progress, and cancel. No accounts, no telemetry, no remote config — it only reaches out to download what you asked for.

**Website:** [thrtn70.github.io/goop](https://thrtn70.github.io/goop/) · **Releases:** [github.com/thrtn70/goop/releases](https://github.com/thrtn70/goop/releases)

![Screenshot placeholder](docs/screenshot.png)

*Screenshot coming in v0.1.1.*

---

## Features

### Extract (v0.1)

- Paste a video or audio URL, probe it, pick a format, and download.
- Queue sidebar with live progress, speed, and ETA; per-row cancel.
- Reveal finished downloads in the OS file manager.
- Persistent settings (download folder, theme, concurrency) in your OS config dir.
- Light / dark / system theme.
- Supported sites include YouTube, SoundCloud, TikTok, Instagram, Vimeo, Reddit (yt-dlp); Bunkr, Gofile, Pixeldrain, Kemono, Coomer, Cyberdrop, Imgur, Twitter/X, RedGifs (gallery-dl); and any generic HTTP(S) media URL either tool can reach. Goop routes URLs to the right extractor automatically and falls back to the other one if the first doesn't recognize it.

### Convert (v0.1.3+)

- Drag and drop files (or browse) onto the Convert page — video, audio, or images.
- Per-file metadata probe with smart default target selection.
- **Media formats**: MP4, MKV, WebM, GIF, AVI, MOV, MP3, M4A, Opus, WAV, FLAC, OGG, AAC, or extract audio with the original codec.
- **Image formats** (v0.1.4): PNG, JPEG, WebP, BMP — built-in, no external tools needed.
- **Video-to-GIF** (v0.1.4): three size presets (320/480/720px) with optional duration trim.
- Automatic remux-vs-re-encode based on a built-in compatibility matrix.
- Single file: Save-As dialog for full control. Batch: outputs land next to each source file, or pick an override folder.
- Live progress, speed, ETA, and per-job cancel in the shared queue sidebar.

### Compress (v0.1.6)

- Dedicated Compress tab with two modes: **Quality** (1–100 slider) or **Target size** (KB / MB).
- Works on video (CRF or bitrate math), audio (bitrate), and images (JPEG/WebP quality, PNG lossless re-optimize).
- Shows source file size and warns when the target would yield unacceptable quality.
- Re-uses the same queue sidebar and progress events as Extract and Convert.

### Notifications (v0.1.6)

- Toast notifications fire when jobs finish, fail, or cancel. Single-file jobs get per-file toasts; batch jobs get one summary toast when the batch settles.
- Queue badge shows a count of completed jobs finished while you were on a different page. Click the queue header to clear.

### Auto-update + saved presets (v0.1.7)

- Checks GitHub for newer releases on launch (toggle in Settings). When an update is available, a banner lets you download and open the installer in one click — no separate browser trip.
- Named presets remember your favourite target + quality + size combinations. Ships with four built-ins (YouTube Upload, Twitter/X Video, Podcast MP3, Web Image); save your own from the Convert or Compress page and apply them as chips.
- Settings page regrouped into General, Updates, Presets, and About sections. About shows the current Goop / yt-dlp / ffmpeg versions.
- One-click "Update yt-dlp" moved into Settings → Updates.

### PDF tools (v0.1.8)

- Drop PDFs on the Convert page to switch into PDF mode — **Merge**, **Split**, or **Compress**. Merge supports drag-to-reorder; Split takes a range string like `1-3, 7-10`; Compress runs the file through a bundled Ghostscript sidecar with three quality presets (Screen / Ebook / Printer).
- Everything is local — no cloud calls, no file uploads.

### Output preview + Quick View (v0.1.8)

- Click a completed job in **History** to open a slide-out preview panel with a thumbnail, metadata, and quick actions: **Reveal in Finder**, **Convert again** (pre-fills the Convert page with the output), and a **Delete ▾** menu that separates "Remove from history" (DB only) from "Move to Trash" (OS trash + DB).
- Focus a row and press **Space** for Quick View — a larger centered overlay. ← and → cycle through the filtered list; Space, Escape, or clicking outside closes.

### History redesign (v0.1.8)

- Search by filename (150ms debounce), filter chips for Extract / Convert / PDF with live counts, sortable column headers for date / size / name.
- List view or grid view (persists across restarts). Grid lazy-loads thumbnails as cards scroll into view.
- Multi-select rows with checkboxes → batch **Reveal all**, **Remove from history**, or **Move to Trash**.

### Hardware-accelerated encoding (v0.1.9)

- Auto-detects your GPU encoder at startup — **VideoToolbox** on macOS, **NVENC** / **QSV** / **AMF** on Windows. 2–5× faster re-encodes when available; transparently falls back to software if the GPU encode fails.
- Toggle it in **Settings → General → Hardware acceleration**. Queue rows show a small **HW** pill while a GPU encoder is active.

### Queue management (v0.1.9)

- **Drag to reorder** queued jobs in the sidebar. Running jobs stay pinned.
- **Batch cancel**: shift-click rows to multi-select, then cancel them as a group.
- **Resizable + collapsible sidebar**: drag the left edge to resize (persists across restarts), or hit `⌘⇧Q` / `Ctrl+Shift+Q` to collapse it to a tab — handy when the History preview panel needs the room.
- Header now shows total ETA for in-flight jobs and a "done today" count.

### Cookies from browser (v0.1.9)

- New **Settings → General → Cookies from browser** dropdown. Pick Chrome / Firefox / Safari / Edge / etc., and Goop passes your existing browser session to yt-dlp via `--cookies-from-browser` for sites that require login (Twitter/X, Instagram, members-only YouTube). Cookies are read locally and never leave your machine.
- Common yt-dlp errors now resolve to one-sentence hints instead of dumping the raw stderr — "This tweet's video may require login. Try enabling Cookies from browser…" rather than a Python traceback.

### Polish (v0.1.9)

- "Apply preset to all" in Convert + Compress when multiple files are staged.
- Settings → About loads instantly (versions cached at app boot, not spawned per visit).
- Preview thumbnails regenerate automatically when the on-disk cache is stale instead of showing a broken-image icon.
- "Clear" in the queue's Done section now soft-hides finished jobs from the queue tab only — they remain in History.

### Pause / resume running jobs (v0.2.0)

- A **Pause** button on running ffmpeg conversions and Ghostscript PDF compress jobs freezes the work in place — CPU drops to ~0, partial output stays on disk untouched. Click **Resume** to continue from exactly where you stopped.
- Cancel still works on a paused job — the underlying process is killed cleanly and the partial file is removed.
- If the app exits (or crashes) while a job is paused, the job silently re-queues from scratch on next launch.
- Cross-platform: SIGSTOP / SIGCONT on macOS, NtSuspendProcess / NtResumeProcess on Windows. Image conversions and yt-dlp downloads are intentionally out of scope.

### Command palette + keyboard shortcuts (v0.2.0)

- **`⌘K` / `Ctrl+K`** opens a fuzzy-searchable command palette. Navigate to any page, paste a URL, open the file picker, toggle the queue sidebar, or check for updates without leaving the keyboard.
- **`⌘1`–`⌘5`** jump to Extract / Convert / Compress / History / Settings. The left nav shows the matching `⌘` badge so the shortcuts are discoverable.
- **`⌘N`** focuses the URL input on Extract from anywhere. **`⌘O`** opens the file picker on Convert / Compress. **`⌘,`** lands on Settings. **`⌘⇧Q`** still toggles the queue sidebar; **Space** still opens Quick View on a focused History row.

### First-run onboarding (v0.2.0)

- On first launch, a three-step welcome walks new users through the pitch, the default download folder, and a quick tips card. Each step is skippable.
- Re-accessible anytime from **Settings → About → Show welcome screen**.

### Audio waveform thumbnails (v0.2.0)

- Audio files in **History** now show an RMS waveform instead of a generic ♫ badge. ffmpeg's `showwavespic` filter renders them once per job into the same on-disk cache the rest of the thumbnails use.
- The ♫ badge is the graceful fallback if waveform generation fails (e.g., a corrupted source).

### Preset import / export (v0.2.0)

- **Settings → Presets → Import…** / **Export…** moves your saved configurations between machines as a JSON bundle (`goop-presets-<date>.json`).
- Built-in presets are excluded from export (re-created on every fresh install). Name collisions on import use `(imported)` first, then `(imported 2)` / `(imported 3)` so re-importing the same file stays readable.
- The bundle format is versioned, so future preset shape changes won't break older files.

### Accessibility polish (v0.2.0)

- WCAG 2.1 AA audit: visible focus rings on every interactive element, full keyboard navigation, screen-reader announcements for job state changes (Done / Cancelled / Error), variant-aware ARIA roles on toasts (errors are assertive), focus trap inside modals, `prefers-reduced-motion` respected on every animation.
- A "Skip to main content" anchor appears on the first Tab press for keyboard-only users.

### Performance (v0.2.0)

- Lazy-loaded route chunks: cold-start payload dropped ~16 % gzipped. Each non-default page (Convert / Compress / History / Settings) streams in on demand.
- Thumbnail generation is now bounded — at most four ffmpeg / Ghostscript / image-decode workers run at once, so scrolling a History grid of hundreds of files no longer burst-spawns processes.

---

## Requirements

- **Windows 10+** (x64) with WebView2 Runtime (ships with Windows 11; auto-installed on Windows 10 if missing).
- **macOS 13+** on Apple Silicon (M-series). Intel Macs are no longer a release target.
- ~180 MB disk for the app + bundled sidecars (ffmpeg, ffprobe, yt-dlp, gallery-dl).
- A working network connection *only* when downloading.

---

## Installation

Grab the build for your OS from the [Releases page](https://github.com/thrtn70/goop/releases/latest):

### Windows
1. Download `Goop_<version>_x64_en-US.msi`.
2. Double-click to install.
3. Launch from the Start menu.

### macOS
1. Download `Goop_<version>_aarch64.dmg` (Apple Silicon).
2. Open the DMG and drag **Goop.app** into `/Applications`.
3. **Run once in Terminal** to clear the Gatekeeper quarantine flag:
   ```bash
   sudo xattr -cr /Applications/Goop.app
   ```
   `sudo` is required because some bundled binaries have restricted permissions. Goop is not signed with an Apple Developer ID, so macOS will otherwise refuse to launch it.
4. Open Goop from Launchpad or Spotlight.

---

## Tips & Troubleshooting

- **"Goop.app can't be opened because Apple cannot check it for malicious software" (macOS).** Run the `sudo xattr -cr` command in the installation section above.
- **"Permission denied" when running `xattr -cr` (macOS).** Use `sudo xattr -cr /Applications/Goop.app` instead — some bundled binaries require elevated permissions to clear the quarantine flag.
- **First download is slow or fails immediately.** Goop bundles `yt-dlp` but some sites change their internal APIs frequently. Open **Settings → Check for updates** to self-update the bundled `yt-dlp` to the latest release.
- **Downloads stall or fail with "HTTP 403".** Usually means `yt-dlp` needs an update — same fix as above. If that doesn't help, the host may be blocking data-center IPs or require sign-in (Goop doesn't support authenticated sessions in v0.1).
- **The audio-only checkbox produces video anyway.** Make sure the selected format row has `audio only` in the dropdown, or toggle the "audio only" checkbox and pick "Best (auto)".
- **Progress bar stays at 99% for a while.** Normal for large files — `yt-dlp` is muxing/finalizing. Don't cancel.
- **Windows Defender flags the installer.** The installer is not yet code-signed. Verify the SHA-256 of the `.msi` against the hash on the Releases page, then allow it through SmartScreen.
- **Where does Goop store files?** The default download folder is your OS's standard Downloads directory. Change it in Settings. The queue database and settings file live in your OS config directory under `goop/`.
- **Reporting bugs.** Open a [GitHub issue](https://github.com/thrtn70/goop/issues) with your OS, the exact URL pattern (redact personal info), and a snippet from the log (launch with `RUST_LOG=goop=debug` to get verbose output).

---

## Build from source

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites (Rust 1.80+, Node 20+, platform toolchains), the dev loop, and the contribution process. Built with Tauri 2, Rust, React, TypeScript, and Tailwind.

---

## Roadmap

Planned after v0.2.0:
- **Cobalt fallback extractor** for Twitter / Instagram / TikTok URLs that yt-dlp can't reach.
- **Signed macOS builds and a code-signed Windows installer** — eliminates the `sudo xattr -cr` step on macOS and the SmartScreen warning on Windows.

## License

[MIT](LICENSE).
