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

# Every direct download below is version/content-pinned. A source with no
# immutable URL (the osxexperts arm64 builds) is still content-pinned: an
# upstream replacement fails the build until its bytes are reviewed and this
# digest is deliberately updated.
YT_DLP_VERSION="2026.08.19"
YT_DLP_WINDOWS_SHA256="66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"
YT_DLP_MACOS_SHA256="0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202"
YT_DLP_PORTABLE_SHA256="1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6"

# Pinned gallery-dl release on Codeberg. gallery-dl publishes no macOS
# binary and its own `--update` targets GitHub (which no longer hosts the
# release assets — they moved to Codeberg), so the bundled gallery-dl can't
# self-update; it ships with Goop and is refreshed by bumping this pin. Keep
# in sync with build-gallery-dl-macos.sh (which PyInstaller-builds the same
# version for macOS).
GALLERY_DL_VERSION="v1.32.11"
GALLERY_DL_BASE="https://codeberg.org/mikf/gallery-dl/releases/download/${GALLERY_DL_VERSION}"
GALLERY_DL_WINDOWS_SHA256="f51c739d961004961e303fb9b6146ffdbac9e022163a091319c75c02760b4523"
GALLERY_DL_LINUX_SHA256="6b96a9d2a30923703995237384b56e1c496ffa951014feebd8f0569b869198ca"

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
TESSERACT_SHA256="f3fc4236425b690c8be756f35793f77394ee004be0a6460a440c754d892f68bc"

# Pinned tessdata_fast release tag. The trained-data file under this tag
# is compatible with tesseract 5.x; only `eng` is bundled — other
# languages download on demand into the app's data dir (Settings → OCR
# Languages). Bumping requires a regression sweep against the OCR
# fixture corpus.
TESSDATA_VER="4.1.0"
TESSDATA_BASE="https://github.com/tesseract-ocr/tessdata_fast/raw/${TESSDATA_VER}"
TESSDATA_ENG_SHA256="7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"

case "$TARGET" in
  x86_64-pc-windows-msvc)
    # ffmpeg — Gyan essentials (LGPL)
    fetch_verified \
      "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip" \
      "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec" \
      /tmp/ffmpeg.zip
    unzip -p /tmp/ffmpeg.zip '*/bin/ffmpeg.exe' > "$OUT_DIR/ffmpeg-$TARGET.exe"
    unzip -p /tmp/ffmpeg.zip '*/bin/ffprobe.exe' > "$OUT_DIR/ffprobe-$TARGET.exe"
    # yt-dlp
    fetch_verified \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp.exe" \
      "$YT_DLP_WINDOWS_SHA256" "$OUT_DIR/yt-dlp-$TARGET.exe"
    # gallery-dl (Codeberg PyInstaller bundle)
    fetch_verified "${GALLERY_DL_BASE}/gallery-dl.exe" \
      "$GALLERY_DL_WINDOWS_SHA256" "$OUT_DIR/gallery-dl-$TARGET.exe"
    # Ghostscript — Artifex official release. The installer is a 7z-
    # compressed self-extractor; 7z is preinstalled on windows-latest.
    GS_VER_NODOT="10040"
    fetch_verified \
      "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VER_NODOT}/gs${GS_VER_NODOT}w64.exe" \
      "7e81126cb545e62e7ce9c92b5f11390c76c6321d25b049fdaf9aa6c6fc4eac4f" \
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
    fetch_verified "${MUPDF_BASE}/mupdf-${MUPDF_VER}-windows.zip" \
      "f3e60b630453301914e52fb8ec001f6ab56cdb90daf39e533deae3ff214fcff8" \
      /tmp/mupdf.zip
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
    fetch_verified "$TESSERACT_URL" "$TESSERACT_SHA256" /tmp/tesseract.exe
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
    fetch_verified "https://osxexperts.net/ffmpeg7arm.zip" \
      "563111a239fe70d2e5c84a5382204a7d0bf0a332385a92a44baff36d313e27f2" \
      /tmp/ffmpeg7arm.zip
    unzip -o /tmp/ffmpeg7arm.zip -d /tmp/ffmpeg7arm/
    mv /tmp/ffmpeg7arm/ffmpeg "$OUT_DIR/ffmpeg-$TARGET"
    chmod +x "$OUT_DIR/ffmpeg-$TARGET"
    rm -rf /tmp/ffmpeg7arm.zip /tmp/ffmpeg7arm/
    fetch_verified "https://osxexperts.net/ffprobe7arm.zip" \
      "e5ae34ee2f0b3594892a695fd733646904bbc7eb40af3b359ed91538ddcb5513" \
      /tmp/ffprobe7arm.zip
    unzip -o /tmp/ffprobe7arm.zip -d /tmp/ffprobe7arm/
    mv /tmp/ffprobe7arm/ffprobe "$OUT_DIR/ffprobe-$TARGET"
    chmod +x "$OUT_DIR/ffprobe-$TARGET"
    rm -rf /tmp/ffprobe7arm.zip /tmp/ffprobe7arm/
    # yt-dlp
    fetch_verified \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_macos" \
      "$YT_DLP_MACOS_SHA256" "$OUT_DIR/yt-dlp-$TARGET"
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
    # Arch sweep. Every macOS sidecar must carry an arm64 slice, and until now
    # nothing proved it — the note above only claimed lipo -archs was checked
    # by hand, once, when the ffmpeg vendor changed.
    #
    # Nothing downstream can catch it either. An x86_64 Mach-O runs fine on
    # this Apple Silicon runner under Rosetta 2, so audit.yml's `ffmpeg
    # -version` smoke test and release.yml's in-.app loop both pass on a binary
    # that faults on a user Mac which has never installed Rosetta — and drags
    # Apple's Intel-deprecation prompt in front of the ones that have.
    # ffmpeg/ffprobe are the known offender (evermeet.cx's getrelease silently
    # served x86_64, which is why the fetch above moved to osxexperts.net) and
    # they appear in no verification loop anywhere. But they are not the only
    # unpinned arch: yt-dlp_macos comes from releases/latest/download, and
    # gallery-dl is PyInstaller-frozen against whatever python3 the runner
    # resolves, so it inherits the INTERPRETER's arch, not the runner's.
    # Assert on the artefacts rather than trusting any of that.
    #
    # yt-dlp_macos is universal2 (x86_64 + arm64) and that is fine — dyld picks
    # the arm64 slice. So the test is "arm64 is AMONG the archs", not "archs ==
    # arm64", which would reject a healthy yt-dlp. The spaces around arm64 in
    # the pattern are load-bearing: without them arm64e and arm64_32 match.
    #
    # Named list rather than a "$OUT_DIR"/*-"$TARGET" glob: a glob with the
    # customary `[ -f "$f" ] || continue` iterates the literal unexpanded
    # pattern when nothing matches and then skips it, so the loop passes having
    # inspected zero binaries. These are the same seven names as
    # bundle.externalBin in tauri.conf.json; a missing one is an error here,
    # not a silent skip. This runs last in the arm because gs, mutool and
    # tesseract do not exist until the Homebrew installs above.
    for name in ffmpeg ffprobe yt-dlp gallery-dl gs mutool tesseract; do
      f="$OUT_DIR/$name-$TARGET"
      [ -f "$f" ] || {
        echo "::error::$name-$TARGET is missing from src-tauri/bin — the macOS sidecar set is incomplete" >&2
        exit 1
      }
      # `|| true` so a non-Mach-O is reported here instead of letting errexit
      # kill the script on lipo's bare "can't figure out the architecture type
      # of", which names no sidecar and emits no annotation.
      archs="$(lipo -archs "$f" 2>/dev/null || true)"
      [ -n "$archs" ] || {
        echo "::error::$name-$TARGET is not a readable Mach-O binary — lipo could not report its architecture" >&2
        exit 1
      }
      case " $archs " in
        *" arm64 "*) ;;
        *)
          echo "::error::$name-$TARGET is $archs, not arm64 — it would run under Rosetta 2 on this runner and fault on a user Mac without Rosetta" >&2
          exit 1 ;;
      esac
    done
    echo "arch sweep clean — every macOS sidecar carries an arm64 slice"
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
    fetch_verified \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-05-13-10/ffmpeg-N-126416-g9997fd0606-linux64-lgpl.tar.xz" \
      "8ad0f604bbeb6f580840d47b65001ba370d69eec4263423235a604dd3728cab6" \
      "$EXTRACT_DIR/ffmpeg.tar.xz"
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
    fetch_verified \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" \
      "$YT_DLP_PORTABLE_SHA256" "$OUT_DIR/yt-dlp-$TARGET"
    chmod +x "$OUT_DIR/yt-dlp-$TARGET"
    # gallery-dl (Codeberg PyInstaller bundle for Linux). Used by the
    # audit job's sidecar-smoke `--version` check; never shipped.
    fetch_verified "${GALLERY_DL_BASE}/gallery-dl.bin" \
      "$GALLERY_DL_LINUX_SHA256" "$OUT_DIR/gallery-dl-$TARGET"
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
# agnostic, so download once per build. Re-fetch even when a prior target left
# a copy behind: fetch_verified preserves good bytes on failure and prevents
# stale or locally modified bytes from bypassing the pin. Other languages download on demand
# into the app's data dir (Settings → OCR Languages).
mkdir -p "$OUT_DIR/tesseract-data"
fetch_verified "${TESSDATA_BASE}/eng.traineddata" "$TESSDATA_ENG_SHA256" \
  "$OUT_DIR/tesseract-data/eng.traineddata"

echo "Sidecars written to $OUT_DIR/"
ls -la "$OUT_DIR/"
