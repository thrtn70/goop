#!/usr/bin/env bash
# scripts/build-static-heif-deps.sh
#
# Build the HEIC decode stack — libde265 (HEVC decoder) + libheif — as
# STATIC libraries into <repo>/.heif-deps/, with every other libheif
# codec explicitly disabled.
#
# Why our own build instead of libheif-sys's `embedded-libheif` feature:
# that feature's cmake config enables every codec it can find on the
# build machine (WITH_<codec>=ON for all), so a Homebrew-equipped host
# silently links x265 (GPL-2.0!), x264 (GPL!), aom, dav1d, svt-av1,
# openjpeg... as *dynamic* refs — non-deterministic, breaks on user
# machines without Homebrew, and pulls GPL code into the link. Building
# here with explicit flags guarantees the link contains exactly two
# pinned, checksum-verified libraries and nothing else. The companion
# CI assert ("no non-system dylibs in the goop-converter test binary")
# enforces it stays that way.
#
# Decode-only scope: libde265 is the ONLY codec compiled in. No x265
# (encode-only → no GPL-2.0 component), no aom (AVIF is handled natively
# by the `image` crate). See LICENSING.md for the static-LGPL rationale.
#
# Used by: audit.yml (ubuntu rust job + macos smoke leg), release.yml
# (macOS builder), and local dev (idempotent — skips when the prefix is
# already populated, which also makes a CI cache restore a no-op).
#
# macOS deployment target: both libraries are linked statically into the
# app, so they are built for the oldest macOS the app declares,
# bundle.macOS.minimumSystemVersion in src-tauri/tauri.conf.json (read by
# scripts/macos-deployment-target.mjs; no floor, no build). Left unset,
# cmake targets the build machine's own macOS: ld links those objects into
# the app with only a warning, and the executable's minos still claims the
# declared floor. Every object's minos is checked against the floor after
# a build, and before an existing prefix is reused; a prefix built for any
# other macOS is discarded and rebuilt. The workflows put the floor in the
# cache key so a new floor restores nothing stale.
#
# Windows is NOT handled here: libheif-sys resolves libheif via vcpkg on
# MSVC. scripts/install-windows-heif-deps.sh checks out the reviewed vcpkg
# tree before installing "libheif[core]:x64-windows-static". [core] suppresses
# the port's DEFAULT 'hevc' feature, which is the x265 GPL *encoder*
# (libde265 is an unconditional core dependency, so HEIC decode always
# works). Set VCPKGRS_TRIPLET=x64-windows-static. The pure static
# triplet (/MT) matches the repo's crt-static RUSTFLAGS — the -md
# variant would reintroduce the duplicate-CRT link errors documented
# in .cargo/config.toml.
#
# After running, export for the cargo build (printed below; in GitHub
# Actions append to $GITHUB_ENV):
#   PKG_CONFIG_PATH=<prefix>/lib/pkgconfig:...
#   SYSTEM_DEPS_LIBHEIF_LINK=static
set -euo pipefail

DE265_VERSION="1.1.1"
DE265_SHA256="fd48a927e94ed74fc7ce8829d222b9d8599fcbfe8b6448ba66705babc56ab219"
DE265_URL="https://github.com/strukturag/libde265/releases/download/v${DE265_VERSION}/libde265-${DE265_VERSION}.tar.gz"

HEIF_VERSION="1.23.0"
HEIF_SHA256="4c9182b18897617182eed12ab5eb9f9d855b3aa3a736d6bdb31abc034ec7d393"
HEIF_URL="https://github.com/strukturag/libheif/releases/download/v${HEIF_VERSION}/libheif-${HEIF_VERSION}.tar.gz"

REPO_ROOT="$(git rev-parse --show-toplevel)"
PREFIX="${REPO_ROOT}/.heif-deps"

# Read before anything is reused or downloaded: a prefix cannot be judged
# current without knowing which macOS it has to target. The helper prints
# nothing whenever it fails, so an empty value is refused as well as a
# non-zero exit.
MACOS_FLOOR="$(node "$(dirname "${BASH_SOURCE[0]}")/macos-deployment-target.mjs" \
  "${REPO_ROOT}/src-tauri/tauri.conf.json")" || MACOS_FLOOR=""
if [ -z "${MACOS_FLOOR}" ]; then
  echo "[heif-deps] no usable macOS floor in src-tauri/tauri.conf.json — refusing to build or reuse the stack." >&2
  exit 1
fi

print_exports() {
  echo "export PKG_CONFIG_PATH=\"${PREFIX}/lib/pkgconfig:\${PKG_CONFIG_PATH:-}\""
  echo "export SYSTEM_DEPS_LIBHEIF_LINK=static"
}

# floor_report prints one line for each object in the two archives that
# was not built for MACOS_FLOOR, or that carries no macOS build version at
# all, and nothing when every object matches. It fails if otool cannot
# read an archive. Only Mach-O objects carry a minos, so on Linux there is
# nothing to report. The minos is LC_BUILD_VERSION's; LC_VERSION_MIN_MACOSX
# (x86_64 objects built for 10.13 and older) is read too, so an object of
# either kind is judged rather than reported as unversioned.
floor_report() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  local lib
  for lib in "${PREFIX}/lib/libde265.a" "${PREFIX}/lib/libheif.a"; do
    otool -l "${lib}" | awk -v lib="${lib##*/}" -v want="${MACOS_FLOOR}" '
      function norm(v) { while (v ~ /\.0$/) sub(/\.0$/, "", v); return v "" }
      function finish() { if (member != "" && !seen) print lib "(" member "): no macOS build version" }
      /^[^ ].*\(.*\):$/ {
        finish()
        member = $0; sub(/^.*\(/, "", member); sub(/\):$/, "", member)
        seen = 0; cmd = ""; members++
        next
      }
      $1 == "cmd" { cmd = $2 }
      (cmd == "LC_BUILD_VERSION" && $1 == "minos") || (cmd == "LC_VERSION_MIN_MACOSX" && $1 == "version") {
        seen = 1
        if (norm($2) != norm(want)) print lib "(" member "): minos " $2
      }
      END { finish(); if (!members) print lib ": no objects" }' || return 1
  done
}

show_report() {
  awk 'NR <= 10 { print "  " $0 } END { if (NR > 10) print "  ... and " NR - 10 " more" }' <<<"$1" >&2
}

if [ -f "${PREFIX}/lib/libde265.a" ] && [ -f "${PREFIX}/lib/libheif.a" ] \
   && [ -f "${PREFIX}/lib/pkgconfig/libheif.pc" ]; then
  # otool failing is a toolchain problem (an unaccepted Xcode licence makes
  # every developer tool exit 69). A rebuild needs the same toolchain, so
  # stop with the stack intact rather than discard it.
  stale="$(floor_report)" || {
    echo "[heif-deps] otool could not read the archives in ${PREFIX}/lib; fix the toolchain, or delete ${PREFIX} to rebuild." >&2
    exit 1
  }
  if [ -z "${stale}" ]; then
    echo "[heif-deps] static stack already present at ${PREFIX} — skipping."
    print_exports
    exit 0
  fi
  echo "[heif-deps] ${PREFIX} holds objects not built for macOS ${MACOS_FLOOR} — rebuilding it:" >&2
  show_report "${stale}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# fetch_url retries transient network failures. These two tarballs are
# fetched in the same CI jobs as the sidecars and share their failure
# mode: without retries a single dropped connection fails the job.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/fetch-with-retry.sh"

fetch_verify() {
  local url="$1" sha="$2" out="$3"
  fetch_url "${url}" "${out}"
  echo "${sha}  ${out}" | shasum -a 256 -c -
}

# Both sources are fetched and verified, and cmake found, before the old
# prefix goes: a dropped connection or a missing tool then costs nothing.
echo "[heif-deps] libde265 v${DE265_VERSION}: download + verify..."
fetch_verify "${DE265_URL}" "${DE265_SHA256}" "${WORK}/libde265.tar.gz"
tar -xzf "${WORK}/libde265.tar.gz" -C "${WORK}"
echo "[heif-deps] libheif v${HEIF_VERSION}: download + verify..."
fetch_verify "${HEIF_URL}" "${HEIF_SHA256}" "${WORK}/libheif.tar.gz"
tar -xzf "${WORK}/libheif.tar.gz" -C "${WORK}"
command -v cmake >/dev/null || { echo "[heif-deps] cmake not found" >&2; exit 1; }

# Build into an empty prefix. Anything already there is stale or about to
# be replaced, and a .heif-deps that is a symlink to another checkout's
# stack (see .cargo/config.toml) is unlinked here, not written through.
rm -rf "${PREFIX}"

# --- libde265 (static, lib only — example apps off) -------------------
echo "[heif-deps] libde265: building static..."
cmake -S "${WORK}/libde265-${DE265_VERSION}" -B "${WORK}/de265-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOS_FLOOR}" \
  -DENABLE_SDL=OFF \
  -DENABLE_DECODER=OFF \
  -DENABLE_ENCODER=OFF \
  `# ENABLE_DECODER/ENCODER gate the dec265/enc265 CLI example apps,` \
  `# not the library's codec capability — libde265.a always decodes.` \
  -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  >/dev/null
cmake --build "${WORK}/de265-build" --parallel >/dev/null
cmake --install "${WORK}/de265-build" >/dev/null

# --- libheif (static, decode-only: libde265 is the sole codec) --------
echo "[heif-deps] libheif: building static (libde265 only)..."
# PKG_CONFIG_LIBDIR (not _PATH) restricts pkg-config to OUR prefix only,
# so libheif's configure cannot discover stray system codecs even before
# the explicit WITH_*=OFF flags below.
# CMAKE_IGNORE_PREFIX_PATH blocks find_package from discovering codecs
# in Homebrew / /usr/local via PATH-derived prefixes — without it, a dev
# machine's brew x264 (GPL!) gets compiled in as a built-in backend even
# with pkg-config restricted (observed during the v0.2.8 spike).
PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig" \
cmake -S "${WORK}/libheif-${HEIF_VERSION}" -B "${WORK}/heif-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOS_FLOOR}" \
  -DCMAKE_PREFIX_PATH="${PREFIX}" \
  -DCMAKE_IGNORE_PREFIX_PATH="/opt/homebrew;/usr/local" \
  -DENABLE_PLUGIN_LOADING=OFF \
  -DWITH_LIBDE265=ON \
  -DWITH_LIBDE265_PLUGIN=OFF \
  -DWITH_X264=OFF \
  -DWITH_X265=OFF \
  -DWITH_AOM_DECODER=OFF \
  -DWITH_AOM_ENCODER=OFF \
  -DWITH_DAV1D=OFF \
  -DWITH_RAV1E=OFF \
  -DWITH_SvtEnc=OFF \
  -DWITH_JPEG_DECODER=OFF \
  -DWITH_JPEG_ENCODER=OFF \
  -DWITH_OpenJPEG_DECODER=OFF \
  -DWITH_OpenJPEG_ENCODER=OFF \
  -DWITH_OPENJPH_ENCODER=OFF \
  -DWITH_KVAZAAR=OFF \
  -DWITH_FFMPEG_DECODER=OFF \
  -DWITH_VVDEC=OFF \
  -DWITH_VVENC=OFF \
  -DWITH_UVG266=OFF \
  -DWITH_OpenH264_DECODER=OFF \
  -DWITH_OpenH264_ENCODER=OFF \
  -DWITH_LIBSHARPYUV=OFF \
  -DWITH_GDK_PIXBUF=OFF \
  -DWITH_EXAMPLES=OFF \
  -DBUILD_TESTING=OFF \
  -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  >/dev/null
cmake --build "${WORK}/heif-build" --parallel >/dev/null
cmake --install "${WORK}/heif-build" >/dev/null

stale="$(floor_report)" || {
  echo "[heif-deps] otool could not read the archives in ${PREFIX}/lib" >&2
  exit 1
}
if [ -n "${stale}" ]; then
  echo "[heif-deps] the stack just built does not target macOS ${MACOS_FLOOR}:" >&2
  show_report "${stale}"
  exit 1
fi
if [ "$(uname -s)" = "Darwin" ]; then
  echo "[heif-deps] every object targets macOS ${MACOS_FLOOR}."
fi

echo "[heif-deps] installed to ${PREFIX}:"
ls "${PREFIX}/lib/"*.a
print_exports
