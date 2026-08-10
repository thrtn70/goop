#!/usr/bin/env bash
# scripts/fetch-with-retry.sh
#
# Sourceable helper that defines fetch_url(). Every network download in
# the repo goes through it: scripts/fetch-sidecars.sh (sidecar binaries
# and the tessdata pack) and scripts/build-static-heif-deps.sh (the
# libde265 + libheif tarballs).
#
# Why it exists: both callers run under `set -euo pipefail` in CI jobs
# whose matrix leaves the default fail-fast on, so one transient network
# error fails a whole job and cancels its sibling. Observed 2026-08-09 —
# a mid-transfer
#
#   curl: (92) HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR
#
# fetching ffprobe7arm.zip failed the macos-14 sidecar-smoke leg of a
# TypeScript-only PR and took the windows-latest leg with it. Re-running
# the same commit passed. Downloads are the only step in these jobs that
# depend on third-party availability; everything else is deterministic.
#
#   fetch_url <url> <dest>
#
# The flag set, and what each one buys:
#
#   -f                    fail on an HTTP error status instead of writing
#                         the response body to <dest>. Without it a 404 or
#                         a mirror's HTML maintenance page lands on disk
#                         and curl exits 0; the failure then surfaces much
#                         later as "cannot find zipfile directory" or a
#                         smoke test running a 200-byte "binary". Most
#                         call sites previously lacked this.
#   -L                    follow redirects — GitHub release assets,
#                         Codeberg and the ffmpeg mirrors all redirect.
#   --retry 5
#   --retry-delay 2       five attempts, two seconds apart.
#   --retry-all-errors    retry transport-level failures too, not just the
#                         transient HTTP status codes --retry handles on
#                         its own. The PROTOCOL_ERROR above is exactly
#                         such a failure, so this flag is the one that
#                         addresses the observed break. Needs curl >= 7.71
#                         (2020); the ubuntu-24.04, macos-14 and
#                         windows-latest images all ship 8.x.
#   --connect-timeout 30  bound the handshake so a black-holed mirror
#                         drops into the retry loop instead of hanging.
#   --no-progress-meter   drop the per-download progress spam from the CI
#                         logs while keeping error text — unlike -s, which
#                         hides both. (curl >= 7.67, below the floor
#                         --retry-all-errors already sets.)
#
# Trade-off worth naming: --retry-all-errors also retries genuine errors,
# so a mistyped version pin now costs ~10s of retries before it fails. It
# still fails, with the same message — a network blip no longer does.
fetch_url() {
  local url="$1" dest="$2"
  curl -fL --retry 5 --retry-delay 2 --retry-all-errors \
    --connect-timeout 30 --no-progress-meter -o "$dest" "$url"
}
