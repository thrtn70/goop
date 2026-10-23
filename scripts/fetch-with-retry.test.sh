#!/usr/bin/env bash
# Tests for scripts/fetch-with-retry.sh.
#
# Behavioural checks against a throwaway local HTTP server prove that
# fetch_url retries a failing download, that an HTTP error status fails
# the fetch instead of landing on disk, and that fetch_verified accepts
# only a payload matching its pinned SHA-256 — plus a static guard that
# nothing under scripts/ downloads with a bare curl. The guard is the one
# that keeps paying: the flag set only helps if the next download added
# to the repo goes through the helper too.
#
# Run: ./scripts/fetch-with-retry.test.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$PWD"

# shellcheck disable=SC1091
source ./fetch-with-retry.sh
# A cache inherited from the caller could serve checks 1-11 offline, so they
# would pass without exercising a download. The cache checks set their own.
unset GOOP_SIDECAR_CACHE

command -v python3 >/dev/null 2>&1 || {
  echo "FAIL: python3 is required for the local test server" >&2
  exit 1
}

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  # An `a && b` list here would be a trap: under errexit a failing `kill`
  # (the server already gone) aborts the trap body, so $WORK never gets
  # removed and kill's status becomes the script's — a passing run would
  # report failure.
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

PAYLOAD="sidecar-payload"

# /flaky answers 404 twice, then serves the payload. A 404 is NOT in the
# set of statuses plain --retry treats as transient, so this endpoint only
# succeeds if --retry-all-errors is in the flag set.
# /missing answers 404 forever, with an HTML body — the shape of a moved
# release asset or a mirror's maintenance page.
cat > "$WORK/server.py" <<PY
import http.server, socketserver

hits = {}
PAYLOAD = b"${PAYLOAD}"

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        hits[self.path] = hits.get(self.path, 0) + 1
        if self.path == "/flaky":
            if hits[self.path] < 3:
                self._send(404, b"<html>not yet</html>")
            else:
                self._send(200, PAYLOAD)
        elif self.path == "/missing":
            self._send(404, b"<html>no such release asset</html>")
        else:
            self._send(200, PAYLOAD)

    def log_message(self, *args):
        pass

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as srv:
    print(srv.server_address[1], flush=True)
    srv.serve_forever()
PY

python3 "$WORK/server.py" > "$WORK/port" 2> "$WORK/server.err" &
SERVER_PID=$!
# Detach so the SIGTERM in cleanup does not make the shell print a job
# status line ("Terminated: 15") over the test output. Reaping it with
# `wait` instead re-enters the EXIT trap on bash 3.2 — the version macOS
# still ships — and leaks 143 out as the script's exit status.
disown "$SERVER_PID" 2>/dev/null || true
PORT=""
for _ in $(seq 1 50); do
  PORT="$(head -1 "$WORK/port" 2>/dev/null || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || {
  echo "FAIL: local test server did not start" >&2
  cat "$WORK/server.err" >&2
  exit 1
}
BASE="http://127.0.0.1:$PORT"

fail=0

# 1. A download that fails twice before succeeding must still produce the
#    real payload. This is the observed CI break in miniature.
if fetch_url "$BASE/flaky" "$WORK/flaky.bin" 2>/dev/null; then
  got="$(cat "$WORK/flaky.bin")"
  if [ "$got" = "$PAYLOAD" ]; then
    echo "  ok   retries a failing download and writes the real payload"
  else
    echo "  FAIL retry succeeded but wrote unexpected content: '$got'"
    fail=1
  fi
else
  echo "  FAIL gave up on a download that succeeds on the third attempt"
  fail=1
fi

# 2. A persistent HTTP error must fail the fetch AND leave no error page
#    behind. Without -f the HTML body becomes the "binary" and the failure
#    only surfaces at unzip or smoke-test time.
if fetch_url "$BASE/missing" "$WORK/missing.bin" 2>/dev/null; then
  echo "  FAIL reported success for a 404"
  fail=1
elif [ -s "$WORK/missing.bin" ]; then
  echo "  FAIL wrote the 404 response body to the destination"
  fail=1
else
  echo "  ok   a 404 fails the fetch instead of writing the error page"
fi

# 3. A verified download with the expected digest lands atomically.
PAYLOAD_SHA256="f35e144db93df07dcb387804a9e3655f95f1109469ce59ebdea785dccdff9d92"
staging_exists() {
  compgen -G "$WORK/.$1.download.*" >/dev/null
}

if fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/verified.bin" 2>/dev/null \
    && [ "$(cat "$WORK/verified.bin")" = "$PAYLOAD" ] \
    && ! staging_exists verified.bin; then
  echo "  ok   a matching SHA-256 installs the downloaded payload"
else
  echo "  FAIL a matching SHA-256 did not install cleanly"
  fail=1
fi

# 4. A mismatch must fail closed, remove its temporary payload, and leave an
# existing destination untouched. That last property keeps a transient CDN
# or metadata problem from destroying the last known-good sidecar.
printf 'known-good' > "$WORK/preserved.bin"
if fetch_verified "$BASE/payload" "${PAYLOAD_SHA256%?}0" "$WORK/preserved.bin" 2>/dev/null; then
  echo "  FAIL a mismatched SHA-256 was accepted"
  fail=1
elif [ "$(cat "$WORK/preserved.bin")" != "known-good" ]; then
  echo "  FAIL a checksum mismatch replaced the existing destination"
  fail=1
elif staging_exists preserved.bin; then
  echo "  FAIL a checksum mismatch left its temporary payload behind"
  fail=1
else
  echo "  ok   a checksum mismatch fails closed and preserves the destination"
fi

# 5. The verified payload must be staged inside an exclusively created,
# randomized directory beside the destination. This closes shared-/tmp
# symlink and cross-process races while preserving same-filesystem renames.
if (
  fetch_url() {
    case "$2" in
      "$WORK"/.exclusive.bin.download.*/payload) printf '%s' "$PAYLOAD" > "$2" ;;
      *) return 1 ;;
    esac
  }
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/exclusive.bin" 2>/dev/null
) && [ "$(cat "$WORK/exclusive.bin")" = "$PAYLOAD" ] \
    && ! compgen -G "$WORK/.exclusive.bin.download.*" >/dev/null; then
  echo "  ok   verified downloads use an exclusive private staging directory"
else
  echo "  FAIL verified downloads did not use an exclusive private staging directory"
  fail=1
fi

# 6. A hashing-tool failure must clean up and preserve a known-good file.
printf 'known-good' > "$WORK/hash-tool-failure.bin"
if (
  sha256_file() { return 1; }
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/hash-tool-failure.bin" 2>/dev/null
); then
  echo "  FAIL a hashing-tool failure was accepted"
  fail=1
elif [ "$(cat "$WORK/hash-tool-failure.bin")" != "known-good" ] \
    || staging_exists hash-tool-failure.bin; then
  echo "  FAIL a hashing-tool failure did not clean up safely"
  fail=1
else
  echo "  ok   a hashing-tool failure preserves the destination and cleans up"
fi

# 7. A refused final install must also remove the verified temporary file.
printf 'known-good' > "$WORK/install-failure.bin"
if (
  install_verified_file() { return 1; }
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/install-failure.bin" 2>/dev/null
); then
  echo "  FAIL a refused final install was accepted"
  fail=1
elif [ "$(cat "$WORK/install-failure.bin")" != "known-good" ] \
    || staging_exists install-failure.bin; then
  echo "  FAIL a refused final install did not clean up safely"
  fail=1
else
  echo "  ok   a refused final install preserves the destination and cleans up"
fi

# 8. The sidecar build must not bypass verification, and the expected 12
# external artifacts lock the coverage count. Adding or removing a download
# requires this assertion to move with it.
unverified_fetches="$({
  grep -n -E '^[[:space:]]*fetch_url[[:space:]]' ./fetch-sidecars.sh || true
})"
verified_count="$(grep -c -E '^[[:space:]]*fetch_verified[[:space:]]' ./fetch-sidecars.sh)"
if [ -n "$unverified_fetches" ]; then
  echo "  FAIL fetch-sidecars.sh contains unverified downloads:"
  echo "$unverified_fetches" | sed 's/^/       /'
  fail=1
elif [ "$verified_count" != "12" ]; then
  echo "  FAIL expected 12 verified sidecar artifacts, found $verified_count"
  fail=1
else
  echo "  ok   all 12 sidecar artifacts are checksum-verified"
fi

# Linux is audit-only and needs externalBin paths to exist, but the Rust job
# never invokes ffmpeg or ffprobe. BtbN retains dated autobuild releases only
# briefly, so pinning one makes an unchanged tree start returning 404s. Keep
# these two Linux artifacts local placeholders instead of a remote download.
if grep -q 'releases/download/autobuild-' ./fetch-sidecars.sh; then
  echo "  FAIL Linux audit bootstrap depends on an expiring BtbN autobuild"
  fail=1
else
  echo "  ok   Linux audit bootstrap has no expiring BtbN autobuild"
fi

# 9. Keep the macOS freezer and prebuilt sidecar on the same gallery-dl
# release, and require the freezer inputs to stay hash-locked.
sidecar_gallery="$(sed -n 's/^GALLERY_DL_VERSION="v\([^"]*\)"/\1/p' ./fetch-sidecars.sh)"
requirement_gallery="$(sed -n 's/^gallery-dl==\([^[:space:]]*\).*/\1/p' ./gallery-dl-macos-requirements.txt)"
if [ -z "$sidecar_gallery" ] || [ "$sidecar_gallery" != "$requirement_gallery" ]; then
  echo "  FAIL gallery-dl versions differ between sidecar fetch and macOS freezer"
  fail=1
elif ! grep -q '^pyinstaller==[^[:space:]]* \\$' ./gallery-dl-macos-requirements.txt; then
  echo "  FAIL PyInstaller is not pinned in the macOS freezer requirements"
  fail=1
elif ! grep -q -- '--require-hashes' ./build-gallery-dl-macos.sh; then
  echo "  FAIL the macOS freezer install does not enforce requirement hashes"
  fail=1
else
  echo "  ok   macOS gallery-dl freezer inputs are synchronized and hash-locked"
fi

# 10. The language pack must be fetched through verification even if an old
# copy is already present. A conditional existence guard would silently trust
# stale or locally modified bytes.
if grep -q 'if \[ ! -f .*eng\.traineddata' ./fetch-sidecars.sh; then
  echo "  FAIL an existing eng.traineddata bypasses checksum verification"
  fail=1
else
  echo "  ok   eng.traineddata is always checksum-verified"
fi

# 11. No script may download with a bare curl. Comment lines are stripped
#    so prose about curl does not trip the guard, and fetch-with-retry.sh
#    (which owns the one legitimate invocation) plus this file (which has
#    to spell the word to report it) are excluded by name.
bare_curl="$(
  grep -rn --include='*.sh' -E '(^|[[:space:]]|[|(&;`])curl([[:space:]]|$)' "$SCRIPT_DIR" \
    | grep -v '/fetch-with-retry\(\.test\)\?\.sh:' \
    | awk '{ rest = $0; sub(/^[^:]*:[0-9]+:/, "", rest); if (rest !~ /^[[:space:]]*#/) print }'
)" || true
if [ -n "$bare_curl" ]; then
  echo "  FAIL bare curl outside the helper — route it through fetch_url:"
  echo "$bare_curl" | sed 's/^/       /'
  fail=1
else
  echo "  ok   every download under scripts/ goes through fetch_url"
fi

# 12-22. The download cache. CI points GOOP_SIDECAR_CACHE at a directory it
# restores between runs, so an upstream outage cannot fail a build that
# already holds the pinned bytes. Entries are named by their SHA-256, and a
# restored entry goes through the same digest check as a fresh download.
# The fetch_url stubs below record any network attempt instead of making one.
CACHE="$WORK/download-cache"
UPPER_SHA256="$(printf '%s' "$PAYLOAD_SHA256" | tr '[:lower:]' '[:upper:]')"

# 12. A miss downloads, verifies and installs as before, and keeps the
#     verified bytes under their lowercase digest.
if (
  export GOOP_SIDECAR_CACHE="$CACHE"
  fetch_verified "$BASE/payload" "$UPPER_SHA256" "$WORK/cache-miss.bin" >/dev/null 2>&1
) && [ "$(cat "$WORK/cache-miss.bin")" = "$PAYLOAD" ] \
    && [ "$(cat "$CACHE/$PAYLOAD_SHA256" 2>/dev/null)" = "$PAYLOAD" ]; then
  echo "  ok   a cache miss installs the download and caches it by digest"
else
  echo "  FAIL a cache miss did not install and cache the verified download"
  fail=1
fi

# 13. A hit installs the cached bytes without touching the network, still
#     verifies them, and says so in the log. The installed file must look like
#     a download too: same mode, whatever mode the restored entry carries.
rm -f "$WORK/net-called"
chmod 600 "$CACHE/$PAYLOAD_SHA256"
if hit_log="$(
  fetch_url() { : > "$WORK/net-called"; return 1; }
  export GOOP_SIDECAR_CACHE="$CACHE"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/cache-hit.bin" 2>&1
)" && [ ! -e "$WORK/net-called" ] \
    && [ "$(cat "$WORK/cache-hit.bin")" = "$PAYLOAD" ] \
    && [ "$(ls -l "$WORK/cache-hit.bin" | cut -c1-10)" = "$(ls -l "$WORK/cache-miss.bin" | cut -c1-10)" ] \
    && ! staging_exists cache-hit.bin \
    && printf '%s' "$hit_log" | grep -q "verified cache-hit.bin from the download cache (sha256 $PAYLOAD_SHA256)"; then
  echo "  ok   a cache hit installs verified bytes without a download"
else
  echo "  FAIL a cache hit did not install verified bytes offline"
  printf '%s\n' "${hit_log:-}" | sed 's/^/       /'
  fail=1
fi

# 14. A cached entry whose bytes do not match its name fails closed: no
#     install, no silent re-download, the existing destination preserved and
#     an error that points at the cache rather than at the pin.
POISONED_CACHE="$WORK/poisoned-cache"
mkdir -p "$POISONED_CACHE"
printf 'poisoned' > "$POISONED_CACHE/$PAYLOAD_SHA256"
printf 'known-good' > "$WORK/poisoned.bin"
rm -f "$WORK/net-called"
if poison_log="$(
  fetch_url() { : > "$WORK/net-called"; return 1; }
  export GOOP_SIDECAR_CACHE="$POISONED_CACHE"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/poisoned.bin" 2>&1
)"; then
  echo "  FAIL a poisoned cache entry was accepted"
  fail=1
elif [ -e "$WORK/net-called" ]; then
  echo "  FAIL a poisoned cache entry fell back to a download instead of failing"
  fail=1
elif [ "$(cat "$WORK/poisoned.bin")" != "known-good" ] || staging_exists poisoned.bin; then
  echo "  FAIL a poisoned cache entry did not preserve the destination and clean up"
  fail=1
elif ! printf '%s' "$poison_log" | grep -q "download cache"; then
  echo "  FAIL a poisoned cache entry failed without naming the download cache"
  fail=1
else
  echo "  ok   a poisoned cache entry fails closed"
fi

# 15. A download that fails verification never enters the cache, so a bad
#     upstream payload cannot be replayed into later runs.
MISMATCH_CACHE="$WORK/mismatch-cache"
if (
  export GOOP_SIDECAR_CACHE="$MISMATCH_CACHE"
  fetch_verified "$BASE/payload" "${PAYLOAD_SHA256%?}0" "$WORK/mismatch.bin" >/dev/null 2>&1
); then
  echo "  FAIL a mismatched download was accepted with the cache enabled"
  fail=1
elif [ -n "$(ls -A "$MISMATCH_CACHE" 2>/dev/null)" ]; then
  echo "  FAIL a mismatched download was written to the cache"
  fail=1
else
  echo "  ok   a mismatched download is never cached"
fi

# 16. With GOOP_SIDECAR_CACHE unset there is no cache anywhere: a local run
#     writes nothing beyond its destination.
mkdir -p "$WORK/no-cache"
if (
  unset GOOP_SIDECAR_CACHE
  cd "$WORK/no-cache"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/no-cache/out.bin" >/dev/null 2>&1
) && [ "$(ls -A "$WORK/no-cache")" = "out.bin" ]; then
  echo "  ok   no cache is written unless GOOP_SIDECAR_CACHE is set"
else
  echo "  FAIL an unset GOOP_SIDECAR_CACHE still wrote cache files"
  fail=1
fi

# 17. The cache is an optimisation. If it cannot be written, the verified
#     download still installs, with a warning.
printf 'not a directory' > "$WORK/cache-is-a-file"
if unwritable_log="$(
  export GOOP_SIDECAR_CACHE="$WORK/cache-is-a-file"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/unwritable.bin" 2>&1
)" && [ "$(cat "$WORK/unwritable.bin")" = "$PAYLOAD" ] \
    && printf '%s' "$unwritable_log" | grep -q "could not add .* to the download cache"; then
  echo "  ok   an unwritable cache warns and still installs the download"
else
  echo "  FAIL an unwritable cache broke the download or said nothing"
  printf '%s\n' "${unwritable_log:-}" | sed 's/^/       /'
  fail=1
fi

# 18. Pruning keeps only what this run verified. A restore from an older
#     snapshot would otherwise carry every superseded pin forward forever.
#     It removes stale digests and stray partial writes, never anything else.
PRUNE_CACHE="$WORK/prune-cache"
STALE_SHA256="0000000000000000000000000000000000000000000000000000000000000000"
mkdir -p "$PRUNE_CACHE"
printf '%s' "$PAYLOAD" > "$PRUNE_CACHE/$PAYLOAD_SHA256"
printf 'old pin' > "$PRUNE_CACHE/$STALE_SHA256"
printf 'partial' > "$PRUNE_CACHE/.$STALE_SHA256.Ab12Cd"
# Decoys: digest-like names the cache never creates must survive.
UPPER_STALE_SHA256="ABCDEF0000000000000000000000000000000000000000000000000000000000"
for decoy in notes.txt "$STALE_SHA256.zip" ".$STALE_SHA256" "$UPPER_STALE_SHA256"; do
  printf 'unrelated' > "$PRUNE_CACHE/$decoy"
done
if (
  fetch_url() { return 1; }
  export GOOP_SIDECAR_CACHE="$PRUNE_CACHE"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/prune.bin" >/dev/null 2>&1
  prune_download_cache
) && [ -f "$PRUNE_CACHE/$PAYLOAD_SHA256" ] \
    && [ ! -e "$PRUNE_CACHE/$STALE_SHA256" ] \
    && [ ! -e "$PRUNE_CACHE/.$STALE_SHA256.Ab12Cd" ] \
    && [ -f "$PRUNE_CACHE/notes.txt" ] \
    && [ -f "$PRUNE_CACHE/$STALE_SHA256.zip" ] \
    && [ -f "$PRUNE_CACHE/.$STALE_SHA256" ] \
    && [ -f "$PRUNE_CACHE/$UPPER_STALE_SHA256" ]; then
  echo "  ok   pruning keeps this run's digests and removes only stale entries"
else
  echo "  FAIL pruning removed the wrong cache entries:"
  ls -A "$PRUNE_CACHE" | sed 's/^/       /'
  fail=1
fi
if ( unset GOOP_SIDECAR_CACHE; prune_download_cache ); then
  echo "  ok   pruning is a no-op without a cache"
else
  echo "  FAIL pruning failed without a cache"
  fail=1
fi

# 19. The digest becomes a file name inside the cache, so it must be
#     validated before the cache or the network is touched.
rm -f "$WORK/net-called"
if (
  fetch_url() { : > "$WORK/net-called"; return 1; }
  export GOOP_SIDECAR_CACHE="$CACHE"
  fetch_verified "$BASE/payload" "../../$PAYLOAD_SHA256" "$WORK/traversal.bin" >/dev/null 2>&1
); then
  echo "  FAIL a malformed digest was accepted"
  fail=1
elif [ -e "$WORK/net-called" ] || [ -e "$WORK/traversal.bin" ]; then
  echo "  FAIL a malformed digest reached the network or the destination"
  fail=1
else
  echo "  ok   a malformed digest is rejected before any lookup"
fi

# 20. Only a regular file counts as a cache entry. A directory under a
#     digest's name (what a tampered restore could plant) is a miss, and
#     storing must not move the download into it.
ODD_CACHE="$WORK/odd-cache"
mkdir -p "$ODD_CACHE/$PAYLOAD_SHA256"
if odd_log="$(
  export GOOP_SIDECAR_CACHE="$ODD_CACHE"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/odd.bin" 2>&1
)" && [ "$(cat "$WORK/odd.bin")" = "$PAYLOAD" ] \
    && [ -z "$(ls -A "$ODD_CACHE/$PAYLOAD_SHA256")" ] \
    && printf '%s' "$odd_log" | grep -q "could not add .* to the download cache"; then
  echo "  ok   a non-file cache entry is a miss and is never written through"
else
  echo "  FAIL a non-file cache entry was trusted or written through"
  ls -A "$ODD_CACHE/$PAYLOAD_SHA256" | sed 's/^/       /'
  fail=1
fi

# 21. A symlink under a digest's name is never read, even when it points at
#     the right bytes, and the verified download replaces the link itself.
#     Left in place, it would survive pruning and cost that pin its outage
#     protection on every run.
LINK_CACHE="$WORK/link-cache"
mkdir -p "$LINK_CACHE"
printf '%s' "$PAYLOAD" > "$WORK/link-target"
ln -s "$WORK/link-target" "$LINK_CACHE/$PAYLOAD_SHA256"
rm -f "$WORK/net-called"
if (
  fetch_url() { : > "$WORK/net-called"; printf '%s' "$PAYLOAD" > "$2"; }
  export GOOP_SIDECAR_CACHE="$LINK_CACHE"
  fetch_verified "$BASE/payload" "$PAYLOAD_SHA256" "$WORK/link.bin" >/dev/null 2>&1
) && [ -e "$WORK/net-called" ] \
    && [ ! -L "$LINK_CACHE/$PAYLOAD_SHA256" ] \
    && [ "$(cat "$LINK_CACHE/$PAYLOAD_SHA256")" = "$PAYLOAD" ] \
    && [ "$(cat "$WORK/link-target")" = "$PAYLOAD" ] \
    && [ "$(cat "$WORK/link.bin")" = "$PAYLOAD" ]; then
  echo "  ok   a symlinked cache entry is a miss and is replaced, not followed"
else
  echo "  FAIL a symlinked cache entry was read, followed, or left in place"
  fail=1
fi

# 22. Pruning is best effort too. The helper is sourced into errexit scripts,
#     so a failed removal must warn rather than abort a fetch that has
#     already installed every sidecar.
LOCKED_CACHE="$WORK/locked-cache"
mkdir -p "$LOCKED_CACHE"
printf 'old pin' > "$LOCKED_CACHE/$STALE_SHA256"
chmod 555 "$LOCKED_CACHE"
if [ -w "$LOCKED_CACHE" ]; then
  echo "  skip a read-only cache directory is still writable here (running as root?)"
# A separate process: errexit is suspended inside an if condition, which would
# let this pass even if the prune aborted a real fetch-sidecars.sh run.
elif locked_log="$(
  GOOP_SIDECAR_CACHE="$LOCKED_CACHE" bash -c \
    'set -euo pipefail; source "$1"; prune_download_cache; echo "after prune"' \
    _ "$SCRIPT_DIR/fetch-with-retry.sh" 2>&1
)" && printf '%s' "$locked_log" | grep -q "after prune" \
    && printf '%s' "$locked_log" | grep -q "could not prune"; then
  echo "  ok   a failed prune warns instead of aborting the fetch"
else
  echo "  FAIL a failed prune aborted the caller or said nothing"
  printf '%s\n' "${locked_log:-}" | sed 's/^/       /'
  fail=1
fi
chmod 755 "$LOCKED_CACHE"

if [ "$fail" != "0" ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
