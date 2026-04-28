#!/usr/bin/env bash
# Rasterise assets/goop-icon.svg → assets/goop-icon-1024.png and run
# `npx tauri icon` to regenerate every src-tauri/icons/* file from it.
#
# Why this exists: the brand mark is a hand-tuned SVG, but Tauri's
# icon CLI takes a 1024×1024 PNG. Putting the conversion behind a
# committed script keeps the icon pipeline reproducible — anyone who
# tweaks `goop-icon.svg` can re-run this to refresh the bundled icons
# without remembering the qlmanage incantation.
#
# macOS-only (uses qlmanage, which ships with Quick Look). On other
# hosts, swap in `rsvg-convert -w 1024 -h 1024 -o ...` (Homebrew) or
# a Node `sharp` script.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
ASSETS_DIR="$REPO_ROOT/assets"
SVG="$ASSETS_DIR/goop-icon.svg"
PNG="$ASSETS_DIR/goop-icon-1024.png"

if [ ! -f "$SVG" ]; then
  echo "missing $SVG" >&2
  exit 1
fi

if ! command -v qlmanage >/dev/null 2>&1; then
  echo "qlmanage not on PATH (this script is macOS-only)" >&2
  exit 1
fi

# qlmanage writes <input>.png next to where -o points; clean stale
# output first so a failed render doesn't leave us with an old PNG.
rm -f "$PNG" "$ASSETS_DIR/goop-icon.svg.png"

qlmanage -t -s 1024 -o "$ASSETS_DIR" "$SVG" >/dev/null

# qlmanage names the output `<basename>.png`, e.g. `goop-icon.svg.png`.
# Rename to the canonical `goop-icon-1024.png`.
mv "$ASSETS_DIR/goop-icon.svg.png" "$PNG"

echo "Wrote $PNG ($(file --brief "$PNG"))"

# Tauri's icon CLI overwrites every file under src-tauri/icons/ with
# the corresponding rasterisation of the input PNG.
cd "$REPO_ROOT"
npx tauri icon "$PNG"

echo "Regenerated src-tauri/icons/* from $PNG"
