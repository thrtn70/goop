#!/usr/bin/env bash
# scripts/build-tesseract-macos.sh [--check]
#
# Build the tesseract CLI and libtesseract.5.dylib from source, for the
# oldest macOS Goop declares, into <repo>/.tesseract-deps/.
#
# Why not Homebrew's: its bottles are linked for the macOS of the machine
# that built them. tesseract 5.5.3's arm64_sonoma bottle, the one the
# macos-14 runner installs, is minos 14.8.5, above the 14.0 floor, while its
# dependencies (leptonica, libarchive) are 14.0. Homebrew's gs links the
# same libtesseract.5.dylib, so the gap is not OCR's alone.
#
# The build is Homebrew's own recipe with the floor added: the same pinned
# source, autotools (libtool gives libtesseract.5.dylib the compatibility
# version 6.0.0 that Homebrew's gs records; a CMake build names and
# versions the library differently), the same default features (legacy
# engine, libarchive, libcurl), linked against the runner's Homebrew
# leptonica and libarchive. fetch-sidecars.sh then bundles this build in
# place of Homebrew's, for both tesseract and gs.
#
# macOS deployment target: bundle.macOS.minimumSystemVersion in
# src-tauri/tauri.conf.json (read by scripts/macos-deployment-target.mjs; no
# floor, no build), exported as MACOSX_DEPLOYMENT_TARGET for every compile
# and link. A build is reused only when both Mach-O files are linked for the
# floor, tesseract loads the libtesseract.5.dylib in this prefix, and
# BUILD-INFO records the same source, floor, leptonica, libarchive and
# script. Anything else is rebuilt. audit.yml caches the prefix, keyed on the
# floor, the runner image and this script; release.yml builds it every run.
#
# --check reports whether the prefix is reusable (exit 0) or why not
# (exit 1), and never downloads or builds.
#
# Needs autoconf, automake, libtool, pkgconf, leptonica and libarchive from
# Homebrew; fetch-sidecars.sh installs any that are missing.
set -euo pipefail

TESSERACT_VERSION="5.5.3"
TESSERACT_SHA256="9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884"
TESSERACT_URL="https://github.com/tesseract-ocr/tesseract/archive/refs/tags/${TESSERACT_VERSION}.tar.gz"

usage() {
  echo "usage: $0 [--check]" >&2
  exit 2
}

CHECK_ONLY=0
case "$#:${1:-}" in
  0:) ;;
  1:--check) CHECK_ONLY=1 ;;
  *) usage ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
PREFIX="${REPO_ROOT}/.tesseract-deps"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read before anything is reused or downloaded, as in
# build-static-heif-deps.sh: the helper prints nothing whenever it fails, so
# an empty value is refused as well as a non-zero exit.
MACOS_FLOOR="$(node "${SCRIPT_DIR}/macos-deployment-target.mjs" \
  "${REPO_ROOT}/src-tauri/tauri.conf.json")" || MACOS_FLOOR=""
if [ -z "${MACOS_FLOOR}" ]; then
  echo "[tesseract] no usable macOS floor in src-tauri/tauri.conf.json — refusing to build or reuse tesseract." >&2
  exit 1
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "[tesseract] this build is macOS only; Windows bundles the upstream installer's tesseract." >&2
  exit 1
fi

BREW="$(command -v brew || echo /opt/homebrew/bin/brew)"
brew_version() {
  "${BREW}" list --versions "$1" 2>/dev/null || {
    echo "[tesseract] Homebrew's $1 is not installed; run: brew install $1" >&2
    exit 1
  }
}
LEPTONICA_VERSION="$(brew_version leptonica)"
LIBARCHIVE_VERSION="$(brew_version libarchive)"
SCRIPT_SHA256="$(shasum -a 256 "${BASH_SOURCE[0]}" | awk '{print $1}')"
BUILD_INFO="tesseract ${TESSERACT_VERSION} ${TESSERACT_SHA256}
macos ${MACOS_FLOOR}
${LEPTONICA_VERSION}
${LIBARCHIVE_VERSION}
script ${SCRIPT_SHA256}"

BINARIES=("bin/tesseract" "lib/libtesseract.5.dylib")
LIBTESSERACT="${PREFIX}/lib/libtesseract.5.dylib"

# stale_report prints one line for each reason the prefix cannot be reused,
# and nothing when it can. It fails if otool cannot read a file, which is a
# toolchain problem (an unaccepted Xcode licence makes every developer tool
# exit 69) that a rebuild would hit too.
stale_report() {
  local file minos
  for file in "${BINARIES[@]}" BUILD-INFO; do
    [ -e "${PREFIX}/${file}" ] || echo "${file}: missing"
  done
  if [ -f "${PREFIX}/BUILD-INFO" ] && [ "$(cat "${PREFIX}/BUILD-INFO")" != "${BUILD_INFO}" ]; then
    echo "BUILD-INFO: built from $(tr '\n' ';' < "${PREFIX}/BUILD-INFO"), not $(tr '\n' ';' <<<"${BUILD_INFO}")"
  fi
  for file in "${BINARIES[@]}"; do
    [ -f "${PREFIX}/${file}" ] || continue
    minos="$(otool -l "${PREFIX}/${file}" | awk '
      $1 == "cmd" { cmd = $2 }
      (cmd == "LC_BUILD_VERSION" && $1 == "minos") || (cmd == "LC_VERSION_MIN_MACOSX" && $1 == "version") { print $2; exit }
    ')" || return 1
    if [ -z "${minos}" ]; then
      echo "${file}: no macOS build version"
    elif ! awk -v a="${minos}" -v b="${MACOS_FLOOR}" '
      function norm(v) { while (v ~ /\.0$/) sub(/\.0$/, "", v); return v "" }
      BEGIN { exit !(norm(a) == norm(b)) }'; then
      echo "${file}: minos ${minos}, not the ${MACOS_FLOOR} floor"
    fi
  done
  # libtool records the library's absolute install path, so a prefix that
  # was moved or copied from another checkout still loads the original.
  if [ -f "${PREFIX}/bin/tesseract" ]; then
    otool -L "${PREFIX}/bin/tesseract" | tail -n +2 | awk '{print $1}' | grep -qxF "${LIBTESSERACT}" \
      || echo "bin/tesseract: does not load ${LIBTESSERACT}"
  fi
}

show_report() {
  awk 'NR <= 10 { print "  " $0 } END { if (NR > 10) print "  ... and " NR - 10 " more" }' <<<"$1" >&2
}

stale="$(stale_report)" || {
  echo "[tesseract] otool could not read ${PREFIX}; fix the toolchain, or delete ${PREFIX} to rebuild." >&2
  exit 1
}
if [ -z "${stale}" ]; then
  if [ "${CHECK_ONLY}" -eq 1 ]; then
    echo "[tesseract] ${PREFIX} holds tesseract ${TESSERACT_VERSION} built for macOS ${MACOS_FLOOR}."
  else
    echo "[tesseract] tesseract ${TESSERACT_VERSION} for macOS ${MACOS_FLOOR} already present at ${PREFIX} — skipping."
  fi
  exit 0
fi
echo "[tesseract] ${PREFIX} cannot be reused:" >&2
show_report "${stale}"
[ "${CHECK_ONLY}" -eq 0 ] || exit 1

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# fetch_verified retries transient network failures and checks the digest
# before anything is unpacked.
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/fetch-with-retry.sh"

# The source is fetched and verified, and every tool found, before the old
# prefix goes: a dropped connection or a missing tool then costs nothing.
echo "[tesseract] ${TESSERACT_VERSION}: download + verify..."
fetch_verified "${TESSERACT_URL}" "${TESSERACT_SHA256}" "${WORK}/tesseract.tar.gz"
tar -xzf "${WORK}/tesseract.tar.gz" -C "${WORK}"
for tool in autoconf automake pkg-config; do
  command -v "${tool}" >/dev/null || { echo "[tesseract] ${tool} not found; run: brew install ${tool/pkg-config/pkgconf}" >&2; exit 1; }
done
command -v glibtoolize >/dev/null || command -v libtoolize >/dev/null \
  || { echo "[tesseract] libtoolize not found; run: brew install libtool" >&2; exit 1; }
LEPTONICA_PREFIX="$("${BREW}" --prefix leptonica)"
LIBARCHIVE_PREFIX="$("${BREW}" --prefix libarchive)"

# Build into an empty prefix. A .tesseract-deps that is a symlink to another
# checkout's build is unlinked here, not written through.
rm -rf "${PREFIX}"

echo "[tesseract] building for macOS ${MACOS_FLOOR}..."
cd "${WORK}/tesseract-${TESSERACT_VERSION}"
export MACOSX_DEPLOYMENT_TARGET="${MACOS_FLOOR}"
# Homebrew's recipe: the leptonica headers by path, and libarchive (keg-only,
# since macOS ships one) through its own pkg-config directory.
export LIBLEPT_HEADERSDIR="${LEPTONICA_PREFIX}/include"
export PKG_CONFIG_PATH="${LIBARCHIVE_PREFIX}/lib/pkgconfig:${LEPTONICA_PREFIX}/lib/pkgconfig"
./autogen.sh >/dev/null
# --datarootdir is Homebrew's, so the compiled-in tessdata fallback is the
# one the Homebrew binary had; Goop always passes --tessdata-dir. libarchive
# and libcurl are asked for by name: configure's default is to drop a feature
# it cannot find, which would quietly build a different library. Static
# libraries are not needed and would double the compile.
./configure --prefix="${PREFIX}" --libdir="${PREFIX}/lib" --datarootdir=/opt/homebrew/share \
  --with-archive --with-curl \
  --disable-debug --disable-dependency-tracking --disable-static >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install datarootdir="${PREFIX}/share" >/dev/null
printf '%s\n' "${BUILD_INFO}" > "${PREFIX}/BUILD-INFO"

stale="$(stale_report)" || {
  echo "[tesseract] otool could not read the build in ${PREFIX}" >&2
  exit 1
}
if [ -n "${stale}" ]; then
  echo "[tesseract] the build just made is not what was asked for:" >&2
  show_report "${stale}"
  exit 1
fi
# `|| true` keeps the output of a binary that cannot run, a dyld error
# included, for the message below.
reported="$("${PREFIX}/bin/tesseract" --version 2>&1 | awk 'NR == 1' || true)"
if [ "${reported}" != "tesseract ${TESSERACT_VERSION}" ]; then
  echo "[tesseract] the build reports '${reported}', not tesseract ${TESSERACT_VERSION}" >&2
  exit 1
fi
echo "[tesseract] tesseract ${TESSERACT_VERSION} built for macOS ${MACOS_FLOOR} at ${PREFIX}."
