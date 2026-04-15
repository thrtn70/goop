#!/usr/bin/env bash
# Usage: fetch-sidecars.sh <TARGET_TRIPLE>
# Writes binaries to src-tauri/bin/{ffmpeg,yt-dlp}-<triple>[.exe]
set -euo pipefail
TARGET="${1:?target triple required}"
OUT_DIR="$(git rev-parse --show-toplevel)/src-tauri/bin"
mkdir -p "$OUT_DIR"

case "$TARGET" in
  x86_64-pc-windows-msvc)
    # ffmpeg — Gyan essentials (LGPL)
    curl -L -o /tmp/ffmpeg.zip "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffmpeg.exe' > "$OUT_DIR/ffmpeg-$TARGET.exe"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    ;;
  x86_64-apple-darwin|aarch64-apple-darwin)
    # ffmpeg — evermeet.cx
    curl -L -o /tmp/ffmpeg.zip "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
    unzip -o /tmp/ffmpeg.zip -d /tmp/
    mv /tmp/ffmpeg "$OUT_DIR/ffmpeg-$TARGET"
    chmod +x "$OUT_DIR/ffmpeg-$TARGET"
    # yt-dlp
    curl -L -o "$OUT_DIR/yt-dlp-$TARGET" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    ;;
  x86_64-unknown-linux-gnu)
    # ffmpeg — BtbN static
    curl -L -o /tmp/ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz"
    tar -xf /tmp/ffmpeg.tar.xz -C /tmp/
    find /tmp/ -name 'ffmpeg' -type f -perm -u+x | head -1 | xargs -I{} cp {} "$OUT_DIR/ffmpeg-$TARGET"
    chmod +x "$OUT_DIR/ffmpeg-$TARGET"
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
