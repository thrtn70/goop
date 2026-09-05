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

# 8. The sidecar build must not bypass verification, and the expected 13
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
elif [ "$verified_count" != "13" ]; then
  echo "  FAIL expected 13 verified sidecar artifacts, found $verified_count"
  fail=1
else
  echo "  ok   all 13 sidecar artifacts are checksum-verified"
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

if [ "$fail" != "0" ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
