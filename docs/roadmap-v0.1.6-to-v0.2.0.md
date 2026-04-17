# Goop Feature Roadmap: v0.1.6 → v0.2.0

> Load this file at the start of any new session working toward v0.2.0.
> It is the source of truth for scope, priorities, and release boundaries.
>
> Last updated: 2026-04-17
> Current version: v0.1.8 (local, not yet published)

---

## Vision

By v0.2.0, Goop should feel like a **complete, polished personal media toolkit** — not
just a converter. Every release balances a meaningful new feature, a major improvement to
existing features, and UI/UX polish. The goal is gradual widening: each release makes the
app broader, deeper, AND more delightful simultaneously.

### Design identity (from CLAUDE.md)

- **Users**: Content creators who value speed but notice good design
- **Personality**: Playful, friendly, approachable — warm, not cold
- **Aesthetic**: Linear/Vercel polish with Figma/Things warmth
- **Principles**: Warmth over sterility, delightful efficiency, breathing room, personality in details

### Hard constraints (all releases)

- No AI evidence in anything public (commits, release notes, files)
- macOS arm64 + x64, Windows x64 only — no Linux
- All commits through pre-push quality gate: cargo fmt, clippy, cargo test, tsc, vitest
- Every release ships with working CI installer/app via `release.yml`
- Follow existing patterns: OKLCH design tokens, Zustand store, ConversionBackend trait

---

## Current state (v0.1.8, local)

### What exists

| Feature | Status |
|---|---|
| **Extract** | Paste URL → probe → pick format → download via yt-dlp |
| **Convert** | Drag-drop → probe → pick target → format swap. 18 targets (video/audio/image). Compat matrix with auto remux-vs-reencode. |
| **Compress** | Dedicated tab (v0.1.6) with Quality slider + Target-size mode for video, audio, image |
| **PDF** | (v0.1.8) Merge (lopdf) / Split (lopdf) / Compress (Ghostscript sidecar) |
| **Queue** | Sidebar with live progress, speed, ETA, cancel, reveal. Shared by extract + convert + pdf jobs |
| **History** | (v0.1.8) Search / filter chips / sort / List-or-Grid / batch select / slide-out preview / Quick View modal |
| **Settings** | Grouped sections (v0.1.7): General, Updates, Presets, About |
| **Toasts** | (v0.1.6) Per-job and batch summary notifications |
| **Auto-update** | (v0.1.7) GitHub-backed check on launch, streaming download, auto-open installer |
| **Presets** | (v0.1.7) Named format+quality combinations with 4 built-ins, chip picker on Convert+Compress |
| **Thumbnails** | (v0.1.8) Lazy on-demand; cached at `data_dir/thumbs/<job-id>.png`; 500 MB LRU budget |
| **Trash** | (v0.1.8) OS-native via `trash` crate; two-step delete UX (remove vs trash) |
| **Design system** | OKLCH tokens, custom typography, motion primitives, light/dark/system theme, ErrorBoundary |

### What's missing (post-v0.1.8)

- No keyboard shortcuts (useHotkeys is a placeholder)
- No onboarding
- Queue has no reorder, pause/resume, or priority
- No hardware-accelerated encoding
- No audio waveform thumbnails
- No preset import/export or sharing
- No PDF password/encryption handling
- No SHA verification of downloaded update assets

---

## Release plan

### v0.1.6 — Compress Tab + Toast Notifications

**Theme**: Separate compression into its own first-class experience; add the feedback system every desktop app needs.

#### New features

**1. Dedicated Compress tab (5th sidebar entry)**

A focused UI for "make this file smaller." Separate from Convert's format-swap purpose.

- **Input**: drag-drop + browse (reuses DropZone + FileRow infrastructure)
- **Supported files**: video, audio, image (media compression only — archives are out of scope)
- **Compression mode toggle**:
  - *Target quality* — slider 1–100, maps to CRF/quality internally
  - *Target file size* — enter "under 25 MB", the backend calculates bitrate from duration
- **Before/after comparison**: show original size vs estimated output size before starting
- **Output**: same source-folder-default + Save-As pattern as Convert
- **Backend**: reuses ffmpeg (video/audio) and image crate (images) — no new sidecars
- **ConvertRequest changes**: add `compress_mode: Option<CompressMode>` enum with `Quality(u8)` and `TargetSizeMb(f32)` variants; compat.rs gets a new `decide_compression()` path

The compression presets (Fast/Balanced/Small + resolution cap) currently in Convert's FileRow move to the Compress tab. Convert returns to being purely about format changes.

**2. Toast notification system**

Slide-in notifications for job lifecycle events.

- **Trigger**: job completes (success), job fails (error), job cancelled
- **Content**: "✓ video.mp4 converted to MP3" with a "Reveal" action button
- **Position**: bottom-right, stackable (max 3 visible), auto-dismiss 5s
- **Implementation**: React context + portal, no external library. Zustand slice for the notification queue.
- **Scope**: all job kinds (extract, convert, compress)
- **Persistence**: notifications are ephemeral (not stored in DB)

#### Improvements

- **Queue sidebar**: completion count badge on the "Queue" text when jobs finish while user is on another page
- **Convert page**: simplified without compression presets (cleaner, faster flow)
- **Settings page**: add "Compress concurrency" field (reuses existing `convert_concurrency` setting or adds a new one)

#### Release notes template

```
## Goop v0.1.6 — Compress + Notifications

### New
- **Compress tab** — dedicated page for reducing file sizes. Drop a video, audio, or 
  image file and pick a target quality or file size. Shows before/after size comparison.
- **Toast notifications** — slide-in alerts when downloads, conversions, and compressions 
  finish. Click "Reveal" to jump to the file.

### Improved
- Convert page no longer shows compression presets (moved to Compress tab for a cleaner flow)
- Queue sidebar shows a completion badge when jobs finish on other pages

### Requirements
- macOS 13+ (Intel or Apple Silicon) / Windows 10+ (x64)
```

---

### v0.1.7 — Auto-Update + Saved Presets

**Theme**: Make the app self-maintaining and remember user preferences.

#### New features

**1. In-app update checker**

Check GitHub Releases for newer versions, download the installer, prompt to open it.

- **Mechanism**: on launch (if auto-check enabled), ping `https://api.github.com/repos/thrtn70/goop/releases/latest` for the tag name. Compare semver with current app version.
- **Banner**: if newer version exists, show a non-blocking top banner: "Goop v0.X.Y is available" with a "Download" button. Dismissible.
- **Settings**: "Check for updates" button (manual trigger), "Auto-check on launch" toggle (default: on), current version display.
- **Download flow**: clicking "Download" fetches the correct asset for the platform (`.dmg` or `.msi`/`.exe`) into a temp dir with progress, then opens the file (macOS: opens DMG, Windows: runs installer). No code-signing / tauri-plugin-updater — uses GitHub API + native download.
- **IPC**: new Rust commands `check_for_update() -> Option<UpdateInfo>` and `download_update(url: String) -> DownloadProgress` with progress events.

**2. Saved presets / profiles**

Named combinations of format + quality + resolution that persist across sessions.

- **Create**: after picking settings in Convert or Compress, click "Save as preset" → name it (e.g., "YouTube Upload", "Instagram Story", "Podcast MP3")
- **Storage**: JSON file in the OS config dir (`presets.json`), loaded at startup into Zustand
- **Apply**: preset chips appear at the top of Convert and Compress pages. Click one to auto-fill all options.
- **Manage**: Settings → Presets section with rename/delete
- **Built-in presets**: ship with 3-5 defaults (YouTube 1080p, Twitter/X Video, Podcast MP3, Web Image)
- **Data model**: `Preset { id, name, target, quality_preset?, resolution_cap?, compress_mode?, created_at }`
- **IPC**: new commands `preset_list`, `preset_save`, `preset_delete`; stored via a new `goop-config` presets module

#### Improvements

- **Settings page redesign**: grouped sections (General, Updates, Presets, About) with collapsible cards instead of a flat form
- **yt-dlp self-update**: wire the existing `sidecar_update_yt_dlp` command to a visible "Update yt-dlp" button in Settings → General, showing current version + "Check for update"
- **Version display**: Settings → About shows Goop version, yt-dlp version, ffmpeg version, OS info

#### Release notes template

```
## Goop v0.1.7 — Auto-Update + Saved Presets

### New
- **Update checker** — Goop now checks for new versions on launch and shows a banner 
  when an update is available. Download the installer directly from the app.
- **Saved presets** — save your favorite format + quality combinations as named presets 
  (e.g., "YouTube Upload"). Quick-pick chips appear at the top of Convert and Compress.

### Improved
- Settings redesigned with grouped sections (General, Updates, Presets, About)
- yt-dlp can now be updated from Settings with one click
- Version info visible in Settings → About
```

---

### v0.1.8 — PDF Tools + Preview + Quick View

**Theme**: Expand beyond media into documents; make completed work visible and satisfying.

#### New features

**1. PDF tools (merge, split, compress)**

Basic PDF operations via a compiled-in Rust crate — no cloud, no LibreOffice.

- **Rust crate**: `lopdf` for merge/split, `pdf` crate for reading metadata. Evaluate which handles compression (rewrite streams with deflate). If neither does compression well, use Ghostscript CLI as a fallback sidecar.
- **Source kind**: `SourceKind::Pdf` added to probe. PDF files dropped on the Convert page are detected and offered PDF-specific operations.
- **Operations**:
  - *Merge*: drop 2+ PDFs → combine in order → output single PDF. Drag-to-reorder.
  - *Split*: drop 1 PDF → enter page range (e.g., "1-3, 7-10") → output new PDF.
  - *Compress*: reduce PDF size by recompressing images + stripping metadata.
- **UI**: operations appear as a radio group when source_kind is PDF, replacing the format picker. Merge shows a reorderable file list.
- **Backend**: new `PdfBackend` implementing `ConversionBackend` trait (or a separate module if the trait doesn't fit merge/split semantics).

**2. Output preview panel**

After a job completes, show a preview of the result.

- **Video**: thumbnail frame (extracted via ffmpeg `-ss 1 -frames:v 1`)
- **Audio**: duration + format badge (waveform deferred — complex to render)
- **Image**: inline thumbnail
- **PDF**: first-page thumbnail (rendered via the PDF crate or a small canvas)
- **Location**: expands inline in the History row on click, or in a slide-out panel
- **Action buttons**: "Reveal in Finder", "Convert again", "Delete"

**3. Space-bar Quick View**

Select a file in History or Queue → press Space → inline preview. Like macOS Quick Look.

- **Implementation**: listen for Space key when a History/Queue row is focused. Show a modal overlay with the preview (reuses the preview infrastructure from #2).
- **Dismiss**: press Space again, Escape, or click outside.
- **Keyboard nav**: arrow keys move between rows while Quick View is open (preview updates).

#### Improvements

- **History page redesign**:
  - Search bar (filter by filename)
  - Sort by date / size / name (toggleable column headers)
  - Filter chips: All / Extract / Convert / Compress
  - Grid view option (thumbnails) vs list view (table)
  - Batch reveal / batch delete (checkbox selection)
- **Drag-drop enhancements**: file type icon overlay during hover (video/audio/image/PDF badge)

#### Release notes template

```
## Goop v0.1.8 — PDF Tools + Preview

### New
- **PDF merge, split, and compress** — drop PDF files to combine, split by page range, 
  or reduce file size. All processing happens locally.
- **Output preview** — click a completed job in History to see a thumbnail preview 
  with quick actions (Reveal, Convert again, Delete).
- **Quick View** — select a History row and press Space for an instant preview overlay.

### Improved
- History page redesigned with search, sort, filter, and grid/list view toggle
- File type icons during drag-drop hover
```

---

### v0.1.9 — Hardware Accel + Queue Management

**Theme**: Make everything faster; give power users control over their job pipeline.

#### New features

**1. Hardware-accelerated encoding**

Auto-detect and use GPU encoders for dramatically faster re-encodes.

- **macOS**: VideoToolbox (`h264_videotoolbox`, `hevc_videotoolbox`)
- **Windows**: NVENC (NVIDIA, `h264_nvenc`), AMF (AMD, `h264_amf`), QSV (Intel, `h264_qsv`)
- **Detection**: at startup, run `ffmpeg -encoders` and parse for available HW encoders. Cache the result.
- **Compat matrix**: when re-encoding, prefer HW encoder if available. Fall back to software transparently.
- **UI indicator**: queue rows using HW accel show a small "HW" badge next to the progress bar.
- **Settings**: "Hardware acceleration" toggle in Settings → General (default: on). If HW encoding fails, auto-retry with software.
- **Expected speedup**: 2-5x for video re-encodes on supported hardware.

**2. Queue management**

Transform the queue sidebar from a status display into a proper job manager.

- **Drag-to-reorder**: drag queued (not yet running) jobs to change priority order
- **Pause / resume**: right-click or button to pause a running job (SIGSTOP the ffmpeg child) and resume later
- **Move to top**: right-click context menu "Move to top of queue"
- **Batch cancel**: select multiple queued jobs → cancel all
- **Queue statistics**: total estimated time remaining, jobs completed today

#### Improvements

- **Batch operations in Convert/Compress**: "Apply preset to all" button when multiple files are dropped. Select-all / deselect.
- **Conversion speed**: HW accel makes all re-encode operations faster (no user action needed if toggle is on)
- **Queue sidebar width**: allow resizing the sidebar by dragging the border (currently fixed at w-72)

#### Release notes template

```
## Goop v0.1.9 — Faster Encoding + Queue Control

### New
- **Hardware acceleration** — Goop automatically uses your GPU for encoding when 
  available (VideoToolbox on macOS, NVENC/AMF/QSV on Windows). 2-5x faster re-encodes.
- **Queue management** — drag to reorder, pause/resume jobs, right-click for priority, 
  batch cancel. Queue sidebar is now a proper job manager.

### Improved
- "Apply preset to all" for batch conversions
- Queue sidebar is now resizable
- Total estimated time remaining shown in queue header
```

---

### v0.2.0 — Keyboard Shortcuts + Onboarding + Final Polish

**Theme**: The "1.0 of the 0.x series." Everything that exists should feel complete and considered.

#### New features

**1. Keyboard shortcuts + command palette**

Full keyboard-driven workflow for power users.

- **Command palette**: `Cmd+K` / `Ctrl+K` opens a fuzzy-search overlay. Actions include: "Convert to MP4", "Open Settings", "Paste URL and download", "Apply preset: YouTube Upload", "Check for updates".
- **Global shortcuts**:
  - `Cmd+1/2/3/4/5` → navigate to Extract/Convert/Compress/History/Settings
  - `Cmd+N` → focus URL input
  - `Cmd+O` → open file picker (Convert/Compress context)
  - `Escape` → close modals, dismiss Quick View
  - `Space` → Quick View (when History/Queue row focused)
  - `Cmd+,` → Settings
- **Implementation**: wire up the existing `useHotkeys` placeholder hook. Use a lightweight hotkey library or raw `keydown` listener.
- **Discoverability**: show shortcut hints in tooltips (e.g., hover over nav items shows `⌘1`)

**2. First-run onboarding flow**

Welcome new users and capture initial preferences.

- **Trigger**: shown on first launch (checked via a `has_seen_onboarding` flag in settings)
- **Steps** (3 screens, skippable):
  1. "Welcome to Goop" — one-sentence pitch + brand illustration
  2. "Where should downloads go?" — folder picker, defaults to ~/Downloads
  3. "You're all set" — quick tips (paste URL to download, drop files to convert) + "Get started" button
- **Re-accessible**: Settings → About → "Show welcome screen"
- **Implementation**: modal overlay with step indicator, stored preference via `settings_set`

#### Improvements

- **Accessibility audit (WCAG AA)**:
  - `focus-visible` ring on all interactive elements (buttons, inputs, nav links, target picker chips)
  - ARIA `role="status"` + `aria-live="polite"` on queue progress and toast notifications
  - Skip-nav link (visually hidden, shown on focus)
  - Screen reader announcements for job state changes ("Download complete", "Conversion started")
  - Color contrast verification for all token combinations (OKLCH values checked against AA thresholds)
- **Performance audit**:
  - Measure startup time (target: <2s to interactive on mid-range hardware)
  - Lazy-load Convert, Compress, History pages (only Extract loads eagerly since it's the landing page)
  - Review Zustand store for unnecessary re-renders (selector optimization)
  - Bundle size check: ensure Vite tree-shakes unused lucide icons
- **Documentation refresh**: README feature list updated for v0.2.0, CONTRIBUTING.md updated with new crate structure (goop-converter backends, presets config), in-app About page with credits + license + links

#### Release notes template

```
## Goop v0.2.0 — Keyboard Power + Polish

### New
- **Command palette** — press Cmd+K (Ctrl+K on Windows) to search and run any action. 
  Navigate, convert, apply presets, all from the keyboard.
- **Keyboard shortcuts** — Cmd+1-5 for navigation, Cmd+N to paste a URL, Cmd+O to 
  browse files, Space for Quick View, and more.
- **Welcome screen** — first-run onboarding picks your download folder and shows you 
  around. Re-accessible from Settings.

### Improved
- Accessibility: focus indicators, screen reader support, ARIA live regions, skip navigation
- Performance: faster startup, lazy-loaded pages, smaller bundle
- Updated README and CONTRIBUTING docs for the v0.2 codebase
```

---

## Cross-cutting concerns

### Each release must include

1. Version bump: `Cargo.toml` workspace, `tauri.conf.json`, `package.json`
2. README.md update (features section + roadmap section)
3. `cargo fmt --all --check && cargo clippy -- -D warnings && cargo test --workspace`
4. `npm run typecheck && npm test`
5. Pre-push quality gate passes
6. Tag `vX.Y.Z` → release CI → all 3 targets build → draft release → notes → publish

### Testing strategy

| Layer | Tool | Target |
|---|---|---|
| Rust unit tests | `#[cfg(test)]` + rstest | All pure logic: compat matrix, preset storage, update checker, PDF operations |
| Rust integration | `#[ignore]` gated | ffmpeg round-trips, HW encoder detection |
| Frontend unit | Vitest + testing-library | Component rendering, mock IPC, state transitions |
| Frontend integration | Vitest | Page-level flows (drop → probe → convert → toast) |
| Manual QA | `npm run tauri dev` | Full flow per release, all platforms |

### Crate evolution

```
v0.1.5 (current):
  goop-core, goop-sidecar, goop-extractor, goop-converter, goop-queue, goop-config

v0.1.6:
  + CompressMode enum in goop-core
  + decide_compression() in goop-converter/compat.rs

v0.1.7:
  + goop-config/presets.rs (preset storage)
  + update_checker module in src-tauri (GitHub API client)

v0.1.8:
  + goop-pdf (new crate — merge, split, compress via lopdf)
  + PdfBackend or standalone module
  + preview infrastructure in src-tauri (thumbnail extraction commands)

v0.1.9:
  + hw_detect module in goop-converter (ffmpeg -encoders parser)
  + queue reorder/pause IPC in goop-queue

v0.2.0:
  + hotkeys + command palette (frontend only)
  + onboarding (frontend + settings flag)
```

### Frontend component evolution

```
v0.1.6:
  + src/pages/CompressPage.tsx
  + src/features/compress/ (CompressOptions, SizeEstimate, etc.)
  + src/components/Toast.tsx + ToastProvider context
  + src/features/queue/QueueBadge.tsx

v0.1.7:
  + src/components/UpdateBanner.tsx
  + src/features/presets/ (PresetChips, PresetEditor, PresetManager)
  + src/pages/SettingsPage.tsx redesign (grouped sections)

v0.1.8:
  + src/features/pdf/ (PdfMergeList, PdfSplitRange, PdfCompressOptions)
  + src/features/preview/ (PreviewPanel, QuickViewModal, Thumbnail)
  + src/pages/HistoryPage.tsx redesign (search, sort, filter, grid/list)

v0.1.9:
  + src/features/queue/ enhancements (DragReorder, PauseButton, ContextMenu)
  + src/components/HwBadge.tsx
  + Resizable sidebar (drag handle)

v0.2.0:
  + src/components/CommandPalette.tsx
  + src/components/Onboarding.tsx (modal stepper)
  + src/hooks/useHotkeys.ts (wired)
  + Accessibility: focus-visible, skip-nav, aria-live regions
```

---

## Research references

Competing apps studied for this roadmap:

| App | Key takeaways for Goop |
|---|---|
| **HandBrake** | Preset system (built-in + user-saved), queue reorder, summary panel, HW accel auto-detect |
| **Sigma File Manager** | Command palette, Space-bar Quick View, toast-based progress, custom GitHub auto-updater (same Tauri stack) |
| **iLovePDF** | Operation-first UX, batch progress with individual status — but repos are cloud API wrappers only |
| **Amaze File Manager** | Archive support, multi-tab, cloud integration, encrypt/decrypt |
| **Material Files** | Breadcrumb nav, clean Material Design, night mode with true-black |
| **How to Convert** | Widest format coverage locally, no uploads — validates Goop's privacy-first approach |

---

## How to use this document

1. **Start of session**: paste or reference this file for context
2. **Before each release**: re-read the release section for scope boundaries
3. **Scope creep check**: if a feature isn't listed here, it's post-v0.2.0 unless explicitly discussed
4. **After each release**: update the "Current state" section and check off completed items
5. **Deprecation**: once v0.2.0 ships, this document becomes historical record — create a new roadmap for v0.2.x+
