#!/usr/bin/env bash
# Tests for scripts/fetch-with-retry.sh.
#
# Two behavioural checks against a throwaway local HTTP server — that
# fetch_url retries a failing download, and that an HTTP error status
# fails the fetch instead of landing on disk — plus a static guard that
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

# 3. No script may download with a bare curl. Comment lines are stripped
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
