#!/usr/bin/env bash
# Usage: fetch-sidecars.sh <TARGET_TRIPLE>
# Writes binaries to src-tauri/bin/{ffmpeg,ffprobe,magick,yt-dlp}-<triple>[.exe]
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
    # ImageMagick 7 — portable zip
    IM_VER="7.1.1-47"
    curl -L -o /tmp/magick.zip "https://imagemagick.org/archive/binaries/ImageMagick-${IM_VER}-portable-Q16-HDRI-x64.zip"
    unzip -p /tmp/magick.zip 'magick.exe' > "$OUT_DIR/magick-$TARGET.exe"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
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
    # ImageMagick 7 — Homebrew bottle binary
    if command -v brew &>/dev/null; then
      MAGICK_BIN="$(brew --prefix imagemagick 2>/dev/null)/bin/magick" || true
    fi
    if [[ -x "${MAGICK_BIN:-}" ]]; then
      cp "$MAGICK_BIN" "$OUT_DIR/magick-$TARGET"
    else
      curl -L -o /tmp/magick.tar.gz "https://imagemagick.org/archive/binaries/magick"
      cp /tmp/magick.tar.gz "$OUT_DIR/magick-$TARGET"
    fi
    chmod +x "$OUT_DIR/magick-$TARGET"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    ;;
  x86_64-unknown-linux-gnu)
    # ffmpeg — BtbN static
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
