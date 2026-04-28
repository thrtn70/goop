#!/usr/bin/env bash
# Usage: build-gallery-dl-macos.sh <TARGET_TRIPLE>
# Builds a single-file gallery-dl binary via PyInstaller and writes it
# to src-tauri/bin/gallery-dl-<triple>.
#
# Why: Codeberg ships gallery-dl binaries for Windows + Linux but not
# macOS. The CI macos-14 runner has Python 3 preinstalled; we install
# gallery-dl + pyinstaller into an isolated venv and freeze.
#
# Pinned to the same gallery-dl version as fetch-sidecars.sh so all
# platforms ship the same baseline. The in-app updater lets users move
# past it after install.
set -euo pipefail
TARGET="${1:?target triple required}"

if [ "$TARGET" != "aarch64-apple-darwin" ]; then
  echo "build-gallery-dl-macos.sh only supports aarch64-apple-darwin (got $TARGET)" >&2
  exit 1
fi

GALLERY_DL_VERSION="${GALLERY_DL_VERSION:-1.32.0}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
OUT_DIR="$REPO_ROOT/src-tauri/bin"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUT_DIR"

PYTHON="${PYTHON:-python3}"
"$PYTHON" -m venv "$WORK_DIR/venv"
# shellcheck disable=SC1091
source "$WORK_DIR/venv/bin/activate"

pip install --quiet --upgrade pip
pip install --quiet "gallery-dl==${GALLERY_DL_VERSION}" pyinstaller

# Locate the gallery_dl __main__ module so PyInstaller has a real entry
# point. `python -c` resolves the import path inside the venv.
ENTRY="$(python -c 'import gallery_dl, os; print(os.path.join(os.path.dirname(gallery_dl.__file__), "__main__.py"))')"

cd "$WORK_DIR"
# --collect-submodules grabs the per-site extractor modules
# (gallery_dl.extractor.bunkr, .imgur, .gofile, ...) which gallery-dl
# loads dynamically via importlib at runtime. Without this flag the
# frozen binary has no extractors — every URL falls through to the
# "no suitable extractor" error.
pyinstaller \
  --onefile \
  --name gallery-dl \
  --collect-submodules gallery_dl \
  --collect-data gallery_dl \
  "$ENTRY"

cp "$WORK_DIR/dist/gallery-dl" "$OUT_DIR/gallery-dl-$TARGET"
chmod +x "$OUT_DIR/gallery-dl-$TARGET"
echo "Built gallery-dl-$TARGET ($("$OUT_DIR/gallery-dl-$TARGET" --version 2>&1 | head -1))"
