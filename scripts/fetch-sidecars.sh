#!/usr/bin/env bash
# Usage: fetch-sidecars.sh <TARGET_TRIPLE>
# Writes binaries to src-tauri/bin/{ffmpeg,ffprobe,yt-dlp,gs,gallery-dl}-<triple>[.exe]
# and the shared Ghostscript Resource tree to src-tauri/bin/gs-resources/Resource/
#
# Supported targets:
#   x86_64-pc-windows-msvc      (release)
#   aarch64-apple-darwin        (release — Apple Silicon only; Intel Mac dropped)
#   x86_64-unknown-linux-gnu    (audit only — never shipped)
set -euo pipefail
TARGET="${1:?target triple required}"
OUT_DIR="$(git rev-parse --show-toplevel)/src-tauri/bin"
mkdir -p "$OUT_DIR"

# bundle_macos_dylibs lives in scripts/macos-dylib-bundle.sh as a
# sourceable helper. Used here for sidecar dylib bundling (gs + tesseract):
# it copies each sidecar's transitive Homebrew dylib graph next to the
# binary and rewrites every load command to @loader_path/<name>. Those
# dylibs reach the packaged .app via bundle.macOS.files in the GENERATED
# src-tauri/tauri.macos.conf.json overlay, which Tauri auto-merges over
# tauri.conf.json for macOS builds — externalBin packaging copies only the
# named binary, not its siblings. See the overlay generator and the
# load-command sweep after the tesseract fetch below. Sourcing
# fetch-sidecars.sh directly is unsafe because of its main body below.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/macos-dylib-bundle.sh"

# fetch_url <url> <dest> — the only way this script downloads anything.
# Retries transient network failures and fails on an HTTP error status
# instead of writing the error page to the destination. See the helper
# for the flag set and the CI break that motivated it.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/fetch-with-retry.sh"

# Pinned gallery-dl release on Codeberg. gallery-dl publishes no macOS
# binary and its own `--update` targets GitHub (which no longer hosts the
# release assets — they moved to Codeberg), so the bundled gallery-dl can't
# self-update; it ships with Goop and is refreshed by bumping this pin. Keep
# in sync with build-gallery-dl-macos.sh (which PyInstaller-builds the same
# version for macOS).
GALLERY_DL_VERSION="v1.32.4"
GALLERY_DL_BASE="https://codeberg.org/mikf/gallery-dl/releases/download/${GALLERY_DL_VERSION}"

# Pinned MuPDF release. Artifex publishes Windows binaries on
# ArtifexSoftware/mupdf-downloads only for select tags (some .x patch
# releases ship source-only) — pin to a known-good tag that has the
# Windows zip published. macOS uses Homebrew's mupdf-tools which may
# track ahead of this pin; mutool's CLI surface is stable across point
# releases, so a brew-installed 1.27.x talking to a frontend that
# expects pinned 1.27.0 argv is fine.
MUPDF_VER="1.27.0"
MUPDF_BASE="https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/${MUPDF_VER}"

# Pinned Tesseract release. The canonical upstream publishes Windows
# NSIS installers on the tesseract-ocr/tesseract GitHub release (the
# UB-Mannheim wiki points to the same artifact). The installer extracts
# cleanly with 7z — same pattern we use for Ghostscript and mutool, and
# the resulting tesseract.exe is MSVC-built so it composes with our
# other Windows sidecars without runtime mismatch. macOS uses Homebrew's
# tesseract formula. mutool ships without HAVE_TESSERACT, so v0.2.4 OCR
# runs through a separate tesseract subprocess.
TESSERACT_VER="5.5.0"
TESSERACT_BUILD="5.5.0.20241111"
TESSERACT_URL="https://github.com/tesseract-ocr/tesseract/releases/download/${TESSERACT_VER}/tesseract-ocr-w64-setup-${TESSERACT_BUILD}.exe"

# Pinned tessdata_fast release tag. The trained-data file under this tag
# is compatible with tesseract 5.x; only `eng` is bundled — other
# languages download on demand into the app's data dir (Settings → OCR
# Languages). Bumping requires a regression sweep against the OCR
# fixture corpus.
TESSDATA_VER="4.1.0"
TESSDATA_BASE="https://github.com/tesseract-ocr/tessdata_fast/raw/${TESSDATA_VER}"

case "$TARGET" in
  x86_64-pc-windows-msvc)
    # ffmpeg — Gyan essentials (LGPL)
    fetch_url "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" /tmp/ffmpeg.zip
    unzip -p /tmp/ffmpeg.zip '*/bin/ffmpeg.exe' > "$OUT_DIR/ffmpeg-$TARGET.exe"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffprobe.exe' > "$OUT_DIR/ffprobe-$TARGET.exe"
    # yt-dlp
    fetch_url "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" "$OUT_DIR/yt-dlp-$TARGET.exe"
    # gallery-dl (Codeberg PyInstaller bundle)
    fetch_url "${GALLERY_DL_BASE}/gallery-dl.exe" "$OUT_DIR/gallery-dl-$TARGET.exe"
    # Ghostscript — Artifex official release. The installer is a 7z-
    # compressed self-extractor; 7z is preinstalled on windows-latest.
    GS_VER_NODOT="10040"
    fetch_url \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VER_NODOT}/gs${GS_VER_NODOT}w64.exe" \
      /tmp/gs.exe
    rm -rf /tmp/gs_extract
    # 7z isn't on Git Bash's PATH by default; use the absolute path the
    # windows-latest runner ships with.
    SEVENZIP="/c/Program Files/7-Zip/7z.exe"
    "$SEVENZIP" x /tmp/gs.exe -o/tmp/gs_extract -y > /dev/null
    # Layout inside the extract: bin/gswin64c.exe + Resource/ + lib/ at root.
    cp "/tmp/gs_extract/bin/gswin64c.exe" "$OUT_DIR/gs-$TARGET.exe"
    rm -rf "$OUT_DIR/gs-resources"
    mkdir -p "$OUT_DIR/gs-resources"
    cp -R "/tmp/gs_extract/Resource" "$OUT_DIR/gs-resources/"
    # gs needs its init files (gs_init.ps, gs_type1.ps, ...) from lib/.
    cp -R "/tmp/gs_extract/lib" "$OUT_DIR/gs-resources/"
    if [ -d "/tmp/gs_extract/iccprofiles" ]; then
      cp -R "/tmp/gs_extract/iccprofiles" "$OUT_DIR/gs-resources/"
    fi
    # Ghostscript ships DLLs the exe needs; co-locate them next to the sidecar.
    # On Windows, Tauri puts sidecars in the same dir as the app exe, so
    # sibling DLLs resolve automatically.
    for dll in /tmp/gs_extract/bin/*.dll; do
      [ -f "$dll" ] || continue
      cp "$dll" "$OUT_DIR/"
    done
    rm -rf /tmp/gs.exe /tmp/gs_extract
    # mutool — Artifex MuPDF official release. Statically linked, no
    # DLL co-location needed. Zip layout (as of 1.27.0) is flat at
    # the root: mupdf.exe, mupdf-gl.exe, mutool.exe — we want only
    # mutool.exe; the viewer and the GL viewer are excluded.
    fetch_url "${MUPDF_BASE}/mupdf-${MUPDF_VER}-windows.zip" /tmp/mupdf.zip
    rm -rf /tmp/mupdf_extract
    "$SEVENZIP" x /tmp/mupdf.zip -o/tmp/mupdf_extract -y > /dev/null
    MUTOOL_BIN="$(find /tmp/mupdf_extract -name 'mutool.exe' -type f | head -1)"
    [ -n "$MUTOOL_BIN" ] || { echo "mutool.exe not found in mupdf zip"; exit 1; }
    cp "$MUTOOL_BIN" "$OUT_DIR/mutool-$TARGET.exe"
    rm -rf /tmp/mupdf.zip /tmp/mupdf_extract
    # tesseract — canonical Windows NSIS installer, extracted with 7z.
    # MSVC build composes cleanly with the other Windows sidecars.
    # Harvests tesseract.exe + every co-located DLL into $OUT_DIR so
    # Tauri's loader resolves them as siblings of the sidecar at runtime.
    fetch_url "$TESSERACT_URL" /tmp/tesseract.exe
    rm -rf /tmp/tesseract_extract
    "$SEVENZIP" x /tmp/tesseract.exe -o/tmp/tesseract_extract -y > /dev/null
    TESS_BIN="$(find /tmp/tesseract_extract -name 'tesseract.exe' -type f | head -1)"
    [ -n "$TESS_BIN" ] || { echo "tesseract.exe not found in installer"; exit 1; }
    cp "$TESS_BIN" "$OUT_DIR/tesseract-$TARGET.exe"
    TESS_DIR="$(dirname "$TESS_BIN")"
    for dll in "$TESS_DIR"/*.dll; do
      [ -f "$dll" ] || continue
      cp "$dll" "$OUT_DIR/"
    done
    rm -rf /tmp/tesseract.exe /tmp/tesseract_extract
    ;;
  aarch64-apple-darwin)
    # Start from a clean dylib slate. bundle_macos_dylibs only ever ADDS
    # (it skips a basename that's already present), so a *.dylib left over
    # from an earlier run on a since-upgraded Homebrew would persist: the
    # freshly-copied sidecar gets rewritten to point at a stale sibling, a
    # newly-introduced transitive dep is never walked, and the generated
    # overlay below would list a basename the current closure no longer
    # contains. CI checks out fresh so this is mostly a local-iteration
    # hazard, but clearing here makes every run reproduce the CI closure
    # exactly. (gs/tesseract binaries are rm'd at their own steps; only the
    # dylibs accumulate.)
    rm -f "$OUT_DIR"/*.dylib
    # ffmpeg + ffprobe — osxexperts.net static arm64 builds. evermeet.cx's
    # default getrelease URL served x86_64 binaries which ran under Rosetta
    # and triggered Apple's Intel-deprecation warning. osxexperts.net
    # explicitly publishes arm64 (Apple Silicon) static builds; verified via
    # `lipo -archs` before switching.
    fetch_url "https://osxexperts.net/ffmpeg7arm.zip" /tmp/ffmpeg7arm.zip
    unzip -o /tmp/ffmpeg7arm.zip -d /tmp/ffmpeg7arm/
    mv /tmp/ffmpeg7arm/ffmpeg "$OUT_DIR/ffmpeg-$TARGET"
    chmod +x "$OUT_DIR/ffmpeg-$TARGET"
    rm -rf /tmp/ffmpeg7arm.zip /tmp/ffmpeg7arm/
    fetch_url "https://osxexperts.net/ffprobe7arm.zip" /tmp/ffprobe7arm.zip
    unzip -o /tmp/ffprobe7arm.zip -d /tmp/ffprobe7arm/
    mv /tmp/ffprobe7arm/ffprobe "$OUT_DIR/ffprobe-$TARGET"
    chmod +x "$OUT_DIR/ffprobe-$TARGET"
    rm -rf /tmp/ffprobe7arm.zip /tmp/ffprobe7arm/
    # yt-dlp
    fetch_url "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" "$OUT_DIR/yt-dlp-$TARGET"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    # gallery-dl — built locally via PyInstaller because Codeberg ships
    # no macOS binary. The build script writes directly to OUT_DIR.
    "$(git rev-parse --show-toplevel)/scripts/build-gallery-dl-macos.sh" "$TARGET"
    # Ghostscript — via Homebrew. macos-14 ships with arm64 Homebrew at
    # /opt/homebrew. Apple Silicon only — Intel Mac was dropped in v0.2.0.
    GS_BREW=/opt/homebrew/bin/brew
    "$GS_BREW" install --quiet ghostscript || true
    GS_PREFIX="$("$GS_BREW" --prefix ghostscript)"
    rm -f "$OUT_DIR/gs-$TARGET"
    cp "$GS_PREFIX/bin/gs" "$OUT_DIR/gs-$TARGET"
    # gs links its imaging/font dylibs (libtiff, libpng16, libjpeg, liblcms2,
    # libfreetype, libfontconfig, libjbig2dec, libidn, libintl, libopenjp2 —
    # and, because Homebrew builds ghostscript with OCR, libtesseract /
    # libleptonica and their whole graph) from /opt/homebrew. Same gap as
    # tesseract: externalBin ships only the binary, so bundle the transitive
    # closure next to it and rewrite every load command to @loader_path.
    # bundle_macos_dylibs keys copies by basename, so the dylibs gs shares
    # with the tesseract sidecar bundled below are written once and reused
    # (both binaries end up pointing at the same @loader_path/<name> sibling).
    chmod +wx "$OUT_DIR/gs-$TARGET"
    bundle_macos_dylibs "$OUT_DIR/gs-$TARGET"
    # Stays writable. Homebrew installs 555 and the mode used to be restored
    # here, but `cp` carries it into Contents/MacOS and Tauri's bundler clears
    # extended attributes across the bundle before signing. A read-only
    # sidecar makes that step fail with "failed to run xattr" and no mention
    # of which file, killing the whole build after a full release compile.
    # Copy the full share tree (Resource/, lib/, iccprofiles/) — only once,
    # it's architecture-agnostic. Homebrew's layout varies: newer
    # ghostscript drops the version subdirectory and puts Resource/, lib/,
    # iccprofiles/ directly under share/ghostscript/. Older layouts nest
    # them one level deeper. Handle both.
    if [ ! -d "$OUT_DIR/gs-resources/Resource" ]; then
      GS_SHARE="$GS_PREFIX/share/ghostscript"
      if [ -d "$GS_SHARE/Resource" ]; then
        GS_SHARE_VER="$GS_SHARE/"
      else
        GS_SHARE_VER="$(ls -d "$GS_SHARE"/*/ | head -1)"
      fi
      mkdir -p "$OUT_DIR/gs-resources"
      cp -R "${GS_SHARE_VER}Resource" "$OUT_DIR/gs-resources/"
      [ -d "${GS_SHARE_VER}lib" ] && cp -R "${GS_SHARE_VER}lib" "$OUT_DIR/gs-resources/"
      [ -d "${GS_SHARE_VER}iccprofiles" ] && cp -R "${GS_SHARE_VER}iccprofiles" "$OUT_DIR/gs-resources/"
    fi
    # mutool — via Homebrew's mupdf-tools formula. Conflicts with the
    # `mupdf` formula (same binaries), so we install one or the other.
    # macos-14 runners ship fresh — no pre-existing mupdf to collide.
    "$GS_BREW" install --quiet mupdf-tools || true
    MUPDF_PREFIX="$("$GS_BREW" --prefix mupdf-tools)"
    rm -f "$OUT_DIR/mutool-$TARGET"
    cp "$MUPDF_PREFIX/bin/mutool" "$OUT_DIR/mutool-$TARGET"
    # `u+w` and not just `+x`: the Homebrew copy is already 555, so `+x` alone
    # is a no-op and leaves it read-only — same bundler failure as gs above.
    # mutool needs no dylib bundling, so nothing else here would have caught it.
    chmod u+wx "$OUT_DIR/mutool-$TARGET"
    # tesseract — via Homebrew's tesseract formula. The brew binary loads
    # libtesseract / libleptonica / libarchive / libwebp / libtiff /
    # libopenjp2 / libgif / ... from /opt/homebrew — paths that don't
    # exist on a clean Mac. bundle_macos_dylibs copies that transitive
    # dylib graph next to the sidecar, rewrites every load command to
    # @loader_path/<basename>, and ad-hoc re-signs each file so the bundled
    # tesseract resolves and loads them as siblings at runtime.
    "$GS_BREW" install --quiet tesseract || true
    TESS_PREFIX="$("$GS_BREW" --prefix tesseract)"
    rm -f "$OUT_DIR/tesseract-$TARGET"
    cp "$TESS_PREFIX/bin/tesseract" "$OUT_DIR/tesseract-$TARGET"
    chmod +wx "$OUT_DIR/tesseract-$TARGET"
    bundle_macos_dylibs "$OUT_DIR/tesseract-$TARGET"
    # Writable for the same reason as gs above.

    # Tauri's externalBin packaging copies ONLY the named binary into the
    # .app's Contents/MacOS — not the sibling dylibs we bundled for gs and
    # tesseract above. Each dylib rides in via bundle.macOS.files, mapping
    # MacOS/<name> -> bin/<name> so it lands beside the sidecars where
    # @loader_path resolves.
    #
    # That map is GENERATED here from the dylib set Homebrew actually
    # produced — never hand-maintained. The transitive closure shifts with
    # Homebrew bumps (libtiff.6 -> libtiff.7, a dep added or dropped), and a
    # committed list would hard-fail the release on every such drift. We write
    # the map to src-tauri/tauri.macos.conf.json, which Tauri auto-merges over
    # tauri.conf.json for macOS builds (JSON Merge Patch, RFC 7396). The base
    # tauri.conf.json deliberately carries NO bundle.macOS.files key: a merge
    # unions object keys, so a stale base entry would survive and point at a
    # bin/<name>.dylib that no longer exists. The overlay is gitignored — CI
    # regenerates it each run, a local `tauri build` after fetch-sidecars picks
    # it up the same way, and the tracked working tree stays clean.
    #
    # $OUT_DIR/*.dylib here is the UNION of every sidecar's closure (gs and
    # tesseract share most of it; Homebrew's gs links libtesseract). If a
    # future dylib-emitting sidecar is added, bundle it before this point.
    MACOS_OVERLAY="$(git rev-parse --show-toplevel)/src-tauri/tauri.macos.conf.json"
    TAURI_CONF_BASE="$(git rev-parse --show-toplevel)/src-tauri/tauri.conf.json"
    node -e '
      const fs = require("fs");
      const [outDir, confPath, basePath] = process.argv.slice(1);
      // The base config must NOT carry bundle.macOS.files. RFC 7396 UNIONS
      // object keys, so a base entry would survive the merge with this
      // generated overlay and point at a bin/<name>.dylib the current
      // Homebrew closure no longer produces — resurrecting the drift
      // hard-fail this generator exists to remove. Fail closed if one creeps
      // back in (the JSON itself can carry no comment to warn the editor).
      const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
      if (base.bundle && base.bundle.macOS && base.bundle.macOS.files) {
        console.error("::error::src-tauri/tauri.conf.json must not contain bundle.macOS.files — the macOS dylib map is generated into tauri.macos.conf.json; a base entry would union with it. Remove bundle.macOS.files from the base config.");
        process.exit(1);
      }
      const dylibs = fs.readdirSync(outDir).filter((f) => f.endsWith(".dylib")).sort();
      if (dylibs.length === 0) {
        console.error("::error::no *.dylib were bundled into bin/ — the gs/tesseract dylib closure came back empty");
        process.exit(1);
      }
      const files = Object.fromEntries(dylibs.map((n) => ["MacOS/" + n, "bin/" + n]));
      fs.writeFileSync(confPath, JSON.stringify({ bundle: { macOS: { files } } }, null, 2) + "\n");
      console.log("generated tauri.macos.conf.json mapping " + dylibs.length + " sidecar dylibs into Contents/MacOS:");
      for (const n of dylibs) console.log("  " + n);
    ' "$OUT_DIR" "$MACOS_OVERLAY" "$TAURI_CONF_BASE"

    # Load-command sweep — the generated map proves the right FILES are
    # bundled, not that every load command resolves inside the bundle. An
    # install_name_tool -change that silently failed (it is run with
    # `2>/dev/null || true`) would leave an absolute /opt/homebrew path that
    # loads fine on this Homebrew-equipped runner but dyld-faults on a clean
    # user Mac. An @rpath/<name> is fine only if <name> is a co-located
    # sibling (the @loader_path rpath resolves it); otherwise it dangles.
    # This is the real correctness gate now that the file map is generated.
    for f in "$OUT_DIR/gs-$TARGET" "$OUT_DIR/tesseract-$TARGET" "$OUT_DIR"/*.dylib; do
      [ -f "$f" ] || continue
      while IFS= read -r ref; do
        case "$ref" in
          /opt/homebrew/*)
            echo "::error::$(basename "$f") keeps a Homebrew load command: $ref" >&2
            exit 1 ;;
          @rpath/*)
            [ -f "$OUT_DIR/${ref#@rpath/}" ] || {
              echo "::error::$(basename "$f") has an unresolved load command: $ref (no co-located sibling)" >&2
              exit 1
            } ;;
        esac
      done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
    done
    echo "load-command sweep clean — every bundled Mach-O resolves inside the .app"
    ;;
  x86_64-unknown-linux-gnu)
    # Linux targets are not part of the v0.1 release matrix; kept for
    # local dev / CI clippy + test only. We don't ship Ghostscript on
    # Linux because we don't ship Linux. Tauri's build script still
    # insists every `externalBin` listed in tauri.conf.json exists for
    # the active target, so we drop a stub `gs` placeholder. The audit
    # job never runs the binary — it only needs the file to exist.
    EXTRACT_DIR="$(mktemp -d)"
    trap 'rm -rf "$EXTRACT_DIR"' EXIT
    fetch_url "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz" "$EXTRACT_DIR/ffmpeg.tar.xz"
    tar -xf "$EXTRACT_DIR/ffmpeg.tar.xz" -C "$EXTRACT_DIR/"
    FFMPEG_BIN="$(find "$EXTRACT_DIR" -name 'ffmpeg' -type f -perm -u+x 2>/dev/null | head -1)"
    [[ -n "$FFMPEG_BIN" ]] || { echo "ffmpeg binary not found in archive"; exit 1; }
    cp "$FFMPEG_BIN" "$OUT_DIR/ffmpeg-$TARGET"
    chmod +x "$OUT_DIR/ffmpeg-$TARGET"
    FFPROBE_BIN="$(find "$EXTRACT_DIR" -name 'ffprobe' -type f -perm -u+x 2>/dev/null | head -1)"
    [[ -n "$FFPROBE_BIN" ]] || { echo "ffprobe binary not found in archive"; exit 1; }
    cp "$FFPROBE_BIN" "$OUT_DIR/ffprobe-$TARGET"
    chmod +x "$OUT_DIR/ffprobe-$TARGET"
    # yt-dlp
    fetch_url "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "$OUT_DIR/yt-dlp-$TARGET"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    # gallery-dl (Codeberg PyInstaller bundle for Linux). Used by the
    # audit job's sidecar-smoke `--version` check; never shipped.
    fetch_url "${GALLERY_DL_BASE}/gallery-dl.bin" "$OUT_DIR/gallery-dl-$TARGET"
    chmod +x "$OUT_DIR/gallery-dl-$TARGET"
    # gs stub — empty executable file. Satisfies Tauri's externalBin
    # existence check without shipping Ghostscript on Linux.
    printf '#!/bin/sh\necho "gs is not available on Linux" >&2\nexit 1\n' > "$OUT_DIR/gs-$TARGET"
    chmod +x "$OUT_DIR/gs-$TARGET"
    # mutool stub — same pattern as gs above. Linux is audit-only.
    printf '#!/bin/sh\necho "mutool is not available on Linux" >&2\nexit 1\n' > "$OUT_DIR/mutool-$TARGET"
    chmod +x "$OUT_DIR/mutool-$TARGET"
    # tesseract stub — same pattern. Linux audit job never runs OCR.
    printf '#!/bin/sh\necho "tesseract is not available on Linux" >&2\nexit 1\n' > "$OUT_DIR/tesseract-$TARGET"
    chmod +x "$OUT_DIR/tesseract-$TARGET"
    # gs-resources stubs — Tauri's `resources` config in tauri.conf.json
    # references three subdirectories of the Ghostscript Resource tree.
    # Empty dirs are enough; the Linux build never invokes gs.
    rm -rf "$OUT_DIR/gs-resources"
    mkdir -p "$OUT_DIR/gs-resources/Resource" \
             "$OUT_DIR/gs-resources/lib" \
             "$OUT_DIR/gs-resources/iccprofiles"
    # Tauri's resource glob may reject completely empty dirs on some
    # platforms; drop a placeholder so each path has at least one file.
    touch "$OUT_DIR/gs-resources/Resource/.placeholder" \
          "$OUT_DIR/gs-resources/lib/.placeholder" \
          "$OUT_DIR/gs-resources/iccprofiles/.placeholder"
    ;;
  *)
    echo "unsupported target: $TARGET"
    exit 1
    ;;
esac

# eng.traineddata — bundled Tesseract language pack. Architecture-
# agnostic, so download once per build (skip if already present from a
# prior target's fetch). Other languages download on demand at runtime
# into the app's data dir (Settings → OCR Languages).
if [ ! -f "$OUT_DIR/tesseract-data/eng.traineddata" ]; then
  mkdir -p "$OUT_DIR/tesseract-data"
  fetch_url "${TESSDATA_BASE}/eng.traineddata" \
    "$OUT_DIR/tesseract-data/eng.traineddata"
fi

echo "Sidecars written to $OUT_DIR/"
ls -la "$OUT_DIR/"
