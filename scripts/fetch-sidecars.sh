#!/usr/bin/env bash
# Usage: fetch-sidecars.sh <TARGET_TRIPLE>
# Writes binaries to src-tauri/bin/{ffmpeg,ffprobe,yt-dlp,gs}-<triple>[.exe]
# and the shared Ghostscript Resource tree to src-tauri/bin/gs-resources/Resource/
set -euo pipefail
TARGET="${1:?target triple required}"
OUT_DIR="$(git rev-parse --show-toplevel)/src-tauri/bin"
mkdir -p "$OUT_DIR"

case "$TARGET" in
  x86_64-pc-windows-msvc)
    # ffmpeg — Gyan essentials (LGPL)
    curl -L -o /tmp/ffmpeg.zip "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffmpeg.exe' > "$OUT_DIR/ffmpeg-$TARGET.exe"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffprobe.exe' > "$OUT_DIR/ffprobe-$TARGET.exe"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    # Ghostscript — Artifex official release. The installer is a 7z-
    # compressed self-extractor; 7z is preinstalled on windows-latest.
    GS_VER_NODOT="10040"
    curl -L -o /tmp/gs.exe \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VER_NODOT}/gs${GS_VER_NODOT}w64.exe"
    rm -rf /tmp/gs_extract
    7z x /tmp/gs.exe -o/tmp/gs_extract > /dev/null
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
  x86_64-apple-darwin|aarch64-apple-darwin)
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
    # Ghostscript — via Homebrew. The macos-14 runner has both arm64
    # Homebrew at /opt/homebrew and Intel Homebrew at /usr/local; pick
    # the one matching the target. Cross-arch installs happen via Rosetta.
    if [ "$TARGET" = "aarch64-apple-darwin" ]; then
      GS_BREW=/opt/homebrew/bin/brew
      GS_ARCH=arm64
    else
      GS_BREW=/usr/local/bin/brew
      GS_ARCH=x86_64
    fi
    if [ ! -x "$GS_BREW" ]; then
      echo "Homebrew not found at $GS_BREW — required for ghostscript on $TARGET" >&2
      exit 1
    fi
    arch -$GS_ARCH "$GS_BREW" install --quiet ghostscript || true
    GS_PREFIX="$(arch -$GS_ARCH "$GS_BREW" --prefix ghostscript)"
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
    # local dev only. No Ghostscript here.
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
    ;;
  *)
    echo "unsupported target: $TARGET"
    exit 1
    ;;
esac
echo "Sidecars written to $OUT_DIR/"
ls -la "$OUT_DIR/"
