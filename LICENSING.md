# Licensing

Goop is MIT-licensed. The Rust workspace, the React frontend, and everything in `src/`, `src-tauri/`, `crates/`, and `shared/` ship under MIT.

Goop bundles several third-party binaries as **sidecars** — separate executables that goop spawns as child processes via `Command::spawn`. Sidecars carry their own licenses; their license terms cover their own binaries, not goop's source or goop's compiled binary. The licensing wall between goop and a sidecar is the `Command::spawn` boundary.

## Sidecars bundled today

| Sidecar | License | Path |
|---|---|---|
| FFmpeg + ffprobe | LGPL-2.1+ | `src-tauri/bin/ffmpeg-<triple>[.exe]` |
| yt-dlp | Unlicense | `src-tauri/bin/yt-dlp-<triple>[.exe]` |
| gallery-dl | GPL-2.0 | `src-tauri/bin/gallery-dl-<triple>[.exe]` |
| Ghostscript (Artifex) | AGPL-3.0 | `src-tauri/bin/gs-<triple>[.exe]` |
| mutool (Artifex MuPDF) | AGPL-3.0 | `src-tauri/bin/mutool-<triple>[.exe]` |
| tesseract OCR | Apache-2.0 | `src-tauri/bin/tesseract-<triple>[.exe]` |

## Dynamically-linked third-party libraries (v0.2.5+)

Pure-Rust permissive crates added for the v0.2.5 "Image Workshop" image-op surface. None require system libraries at runtime; everything links statically into goop's binary at compile time.

| Library | License | Used for | Notes |
|---|---|---|---|
| Roboto Regular (font file) | Apache-2.0 | Watermark text rasterization (`crates/goop-converter/assets/Roboto-Regular.ttf`, bundled via `include_bytes!`) | Permissive. Embedded font, not linked code — Apache-2.0 allows redistribution as-is. |
| imageproc | MIT | Watermark glyph compositing (`draw_text_mut` on top of the `image` crate's RgbaImage). | Permissive. |
| ab_glyph | Apache-2.0 OR MIT | Font loader for `imageproc`. Reads the bundled Roboto TTF. | Permissive. |
| img-parts | MIT OR Apache-2.0 | JPEG segment + PNG chunk walker for EXIF / ICC preserve / strip (`crates/goop-converter/src/metadata.rs`). | Permissive. |
| icns | MIT | Apple icon container writer for App Icon export (`crates/goop-converter/src/image_app_icon.rs`). | Permissive. |
| ico | MIT | Windows icon container writer for App Icon export. | Permissive. |
| react-easy-crop | MIT | Frontend crop editor (`src/features/image/CropEditor.tsx`). | Permissive. |

> **HEIC + JPEG-XL deferred to v0.2.5.1.** The `libheif-rs` / `jpegxl-rs` Phase 3 work was reverted in the v0.2.5 final commit because the per-platform CI bundling (`apt-get install libheif-dev libjxl-dev` on Ubuntu, `brew install` on macOS, vcpkg on Windows) and post-build dylib/DLL rewriting needed more iteration than fit in this release window. v0.2.5.1 brings them back with the LGPL/GPL linkage notes restored to this table.

**Why this isn't a violation of the MuPDF firewall.** The AGPL firewall is specifically about Artifex / MuPDF-derived code (`gs`, `mutool`). LGPL and GPL libraries unrelated to MuPDF can be dynamically linked under their own terms. The CI check still greps for `mupdf-*` only.

The AGPL-licensed sidecars (Ghostscript and mutool from Artifex) are the strictest. **They are bundled and spawned only as subprocess executables.** The text below documents the rule that keeps the AGPL on their side of the spawn boundary.

## The subprocess-only rule (AGPL sidecars)

For Ghostscript and mutool — and for any future Artifex / MuPDF-derived tool we ship:

1. **No `mupdf-*` Rust crates** in `Cargo.toml` of any workspace member. This includes `mupdf`, `mupdf-rs`, `mupdf-sys`, and any wrapper crate that links the MuPDF library into goop's binary.
2. **No `mupdf.js`** (or any MuPDF / WebAssembly build) loaded into the Tauri WebView. The WebView is goop's app process; loading AGPL code into it pulls AGPL across the boundary.
3. **Sidecars are spawned with `Command::spawn`** through the existing `BinaryResolver` + `PidGuard` plumbing. They communicate via stdin / stdout / stderr / files / exit codes. No IPC mechanism that requires linking (e.g., a Rust FFI binding or a shared-library load) is permitted.

This is the same legal pattern used by everyone who ships Ghostscript or MuPDF inside a non-(A)GPL application. Subprocess invocation is "use", not "linking" — the user can replace the sidecar binary on disk and goop continues to work.

## CI enforcement

Two checks in `.github/workflows/audit.yml` (also mirrored into `release.yml`) fail the build if either rule is broken:

```
# Rust side — fails if any in-process MuPDF crate appears in the workspace dep graph
cargo tree --workspace --prefix none | grep -i mupdf  && exit 1 || true

# Frontend side — fails if MuPDF JS/WASM is imported anywhere user code runs
grep -rE "from ['\"]mupdf|require\\(['\"]mupdf|@mupdf|mupdf\\.js|mupdf\\.wasm" src/ shared/ && exit 1 || true
```

Both checks run on every pull request, every push to main, and every tag build. A PR that introduces a violation cannot be merged.

## What is *not* covered by the AGPL

- Goop's source code (MIT).
- Goop's compiled binary, minus the bundled sidecars (MIT).
- The TypeScript bindings generated by `ts-rs` (MIT, derived from goop's MIT-licensed Rust types).
- Anything in `crates/`, `src/`, `src-tauri/src/`, `shared/`.

## What *is* covered by the AGPL

- The bundled `gs-<triple>[.exe]` binary and any Ghostscript-derived files (its `Resource/`, `lib/`, and `iccprofiles/` trees).
- The bundled `mutool-<triple>[.exe]` binary and any MuPDF-derived files it ships with.
- If a user redistributes goop's installer, they must also offer the corresponding Ghostscript / MuPDF source under AGPL-3.0 terms. This is satisfied today by linking to the Artifex source repositories from the GitHub Release page.

## If you are adding a new sidecar

1. Check its license.
2. If GPL / AGPL / LGPL family, confirm subprocess-only usage is allowed by that license. (It generally is for GPL / AGPL; LGPL allows dynamic linking too, but goop's pattern is uniformly subprocess.)
3. Update this document with the new row.
4. If the new sidecar comes from the MuPDF family, add it to the `cargo tree | grep -i mupdf` check explicitly.
5. Update the Sidecars section in Settings to surface the new binary's version.

## Reporting a licensing concern

Open a GitHub issue tagged `licensing` or email the maintainers. Include the file path, the suspected violation, and what license you believe applies.
