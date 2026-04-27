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

# Pinned gallery-dl release on Codeberg. The in-app `--update` flow lets
# users move past this baseline once installed; bumping here is mostly
# about keeping the bundled-out-of-the-box version reasonably fresh.
GALLERY_DL_VERSION="v1.32.0"
GALLERY_DL_BASE="https://codeberg.org/mikf/gallery-dl/releases/download/${GALLERY_DL_VERSION}"

case "$TARGET" in
  x86_64-pc-windows-msvc)
    # ffmpeg — Gyan essentials (LGPL)
    curl -L -o /tmp/ffmpeg.zip "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffmpeg.exe' > "$OUT_DIR/ffmpeg-$TARGET.exe"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffprobe.exe' > "$OUT_DIR/ffprobe-$TARGET.exe"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    # gallery-dl (Codeberg PyInstaller bundle)
    curl -L -o "$OUT_DIR/gallery-dl-$TARGET.exe" "${GALLERY_DL_BASE}/gallery-dl.exe"
    # Ghostscript — Artifex official release. The installer is a 7z-
    # compressed self-extractor; 7z is preinstalled on windows-latest.
    GS_VER_NODOT="10040"
    curl -L -o /tmp/gs.exe \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VER_NODOT}/gs${GS_VER_NODOT}w64.exe"
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
    ;;
  aarch64-apple-darwin)
    # ffmpeg — evermeet.cx
    curl -L -o /tmp/ffmpeg.zip "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
    unzip -o /tmp/ffmpeg.zip -d /tmp/
    mv /tmp/ffmpeg "$OUT_DIR/ffmpeg-$TARGET"
    chmod +x "$OUT_DIR/ffmpeg-$TARGET"
    # ffprobe — same source
    curl -L -o /tmp/ffprobe.zip "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
    unzip -o /tmp/ffprobe.zip -d /tmp/
    mv /tmp/ffprobe "$OUT_DIR/ffprobe-$TARGET"
    chmod +x "$OUT_DIR/ffprobe-$TARGET"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    # gallery-dl — built locally via PyInstaller because Codeberg ships
    # no macOS binary. The build script writes directly to OUT_DIR.
    "$(git rev-parse --show-toplevel)/scripts/build-gallery-dl-macos.sh" "$TARGET"
    # Ghostscript — via Homebrew. macos-14 ships with arm64 Homebrew at
    # /opt/homebrew. Apple Silicon only — Intel Mac was dropped in v0.2.0.
    GS_BREW=/opt/homebrew/bin/brew
    "$GS_BREW" install --quiet ghostscript || true
    GS_PREFIX="$("$GS_BREW" --prefix ghostscript)"
    cp "$GS_PREFIX/bin/gs" "$OUT_DIR/gs-$TARGET"
    chmod +x "$OUT_DIR/gs-$TARGET"
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
    curl -L -o "$EXTRACT_DIR/ffmpeg.tar.xz" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz"
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
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    # gallery-dl (Codeberg PyInstaller bundle for Linux). Used by the
    # audit job's sidecar-smoke `--version` check; never shipped.
    curl -L -o "$OUT_DIR/gallery-dl-$TARGET" "${GALLERY_DL_BASE}/gallery-dl.bin"
    chmod +x "$OUT_DIR/gallery-dl-$TARGET"
    # gs stub — empty executable file. Satisfies Tauri's externalBin
    # existence check without shipping Ghostscript on Linux.
    printf '#!/bin/sh\necho "gs is not available on Linux" >&2\nexit 1\n' > "$OUT_DIR/gs-$TARGET"
    chmod +x "$OUT_DIR/gs-$TARGET"
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
echo "Sidecars written to $OUT_DIR/"
ls -la "$OUT_DIR/"
