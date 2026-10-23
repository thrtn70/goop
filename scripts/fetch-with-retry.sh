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
#   fetch_verified <url> <sha256> <dest>
#   prune_download_cache
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

# Download into a sibling temporary file, verify the exact pinned payload,
# then move it into place. A failure never overwrites an existing destination.
# macOS ships shasum; Linux and the Windows Git Bash runners ship sha256sum.
sha256_file() {
  local file="$1" output=""
  if command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum "$file")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 "$file")" || return 1
  else
    return 1
  fi
  printf '%s' "${output%%[[:space:]]*}"
}

install_verified_file() {
  mv "$1" "$2"
}

cleanup_verified_staging() {
  rm -f "$1"
  rmdir "$2" 2>/dev/null || true
}

# Optional download cache. When GOOP_SIDECAR_CACHE names a directory, each
# verified payload is kept there under its lowercase SHA-256, and a later
# fetch_verified of the same pin copies it from there instead of downloading.
# Audit CI restores that directory between runs, so an upstream outage no
# longer fails a build that already holds the pinned bytes. Observed
# 2026-10-18: osxexperts.net answered 503 for about three hours and every
# macOS sidecar-smoke leg failed its fetch after exhausting the retries.
#
# A cached copy is checked against its pin exactly like a download, and a
# mismatch fails closed. It does not fall back to the network: only
# corruption or a poisoned cache entry produces one, and either wants a
# person to look and delete the entry, not a quiet re-download that leaves
# the bad snapshot in place for the next run. The cache is otherwise best
# effort: if it cannot be written or pruned, the verified download still
# installs and the run carries on with a warning. With GOOP_SIDECAR_CACHE
# unset, which is every local run, nothing is cached anywhere.

# The lowercase digests fetch_verified has installed in this shell, which
# prune_download_cache keeps. A plain shell variable, so only a prune in the
# same shell as every fetch sees them all.
FETCH_VERIFIED_DIGESTS=""

is_sha256_name() {
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
    *) ;;
  esac
  [ "${#1}" -eq 64 ]
}

store_in_download_cache() {
  local payload="$1" cache="$2" digest="$3" partial=""
  # Only a regular file counts as an entry, so anything else under this name
  # came from a tampered restore. A symlink is removed (rm unlinks it and never
  # follows it) so the verified copy can take its place. A directory is left
  # alone: mv would move the payload into it rather than replace it.
  if [ -L "$cache/$digest" ]; then
    rm -f "$cache/$digest" || return 1
  fi
  if [ -e "$cache/$digest" ]; then
    return 1
  fi
  mkdir -p "$cache" 2>/dev/null || return 1
  partial="$(mktemp "$cache/.$digest.XXXXXX" 2>/dev/null)" || return 1
  if cp "$payload" "$partial" && mv -f "$partial" "$cache/$digest"; then
    return 0
  fi
  rm -f "$partial"
  return 1
}

# Remove every cache entry this run did not verify. When the exact cache key
# misses, CI restores the newest older snapshot instead, so without this a
# superseded pin would be carried forward and saved again forever. Only the
# names the cache itself creates are touched: <sha256> entries and the
# .<sha256>.XXXXXX partial writes a failed store can leave behind.
#
# Call it once, at the end, from the shell that ran every fetch_verified (see
# FETCH_VERIFIED_DIGESTS). Run anywhere else it keeps nothing, and a cache
# shared by several targets' runs keeps only the last target's entries.
prune_download_cache() {
  local cache="${GOOP_SIDECAR_CACHE:-}" entry="" name="" digest=""
  if [ -z "$cache" ] || [ ! -d "$cache" ]; then
    return 0
  fi
  for entry in "$cache"/* "$cache"/.[!.]*; do
    [ -f "$entry" ] || continue
    name="${entry##*/}"
    digest="${name#.}"
    digest="${digest%%.*}"
    is_sha256_name "$digest" || continue
    if [ "$name" = "$digest" ]; then
      case " $FETCH_VERIFIED_DIGESTS " in
        *" $digest "*) continue ;;
        *) ;;
      esac
    else
      case "$name" in
        ".$digest."?*) ;;
        *) continue ;;
      esac
    fi
    # Callers run under errexit, and a failed prune must not fail a fetch
    # that has already installed every sidecar.
    rm -f "$entry" || echo "::warning::could not prune $name from the download cache at $cache" >&2
  done
}

fetch_verified() {
  local url="$1" expected="$2" dest="$3"
  local actual="" digest="" dest_dir="${dest%/*}" dest_name="${dest##*/}"
  local cache="${GOOP_SIDECAR_CACHE:-}" source="download"
  local staging_dir="" tmp=""

  if [ "$dest_dir" = "$dest" ]; then
    dest_dir="."
  fi

  case "$expected" in
    *[!0-9a-fA-F]*)
      echo "invalid SHA-256 for $url" >&2
      return 1
      ;;
    *) ;;
  esac
  if [ "${#expected}" -ne 64 ]; then
    echo "invalid SHA-256 length for $url" >&2
    return 1
  fi
  # Validated above, so it is safe as a file name inside the cache.
  digest="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"

  staging_dir="$(mktemp -d "$dest_dir/.${dest_name}.download.XXXXXX")" || return 1
  tmp="$staging_dir/payload"
  if [ -n "$cache" ] && [ -f "$cache/$digest" ] && [ ! -L "$cache/$digest" ]; then
    # A redirect, not cp: the payload is created with the umask's mode, as a
    # download is, instead of inheriting whatever mode the restored entry has.
    if ! cat "$cache/$digest" > "$tmp"; then
      echo "unable to read the cached copy of $url from the download cache at $cache" >&2
      cleanup_verified_staging "$tmp" "$staging_dir"
      return 1
    fi
    source="cache"
  elif ! fetch_url "$url" "$tmp"; then
    cleanup_verified_staging "$tmp" "$staging_dir"
    return 1
  fi

  if ! actual="$(sha256_file "$tmp")"; then
    echo "unable to compute SHA-256 for $url" >&2
    cleanup_verified_staging "$tmp" "$staging_dir"
    return 1
  fi

  if [ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" != "$digest" ]; then
    if [ "$source" = "cache" ]; then
      echo "::error::the download cache at $cache holds a copy of $url that does not match its pin: expected $digest, got $actual. Only corruption or a poisoned cache entry does this. Leave the pin alone and delete the cached snapshots, older ones included, since a miss falls back to them: gh cache list --key sidecar-downloads-" >&2
    else
      echo "SHA-256 mismatch for $url: expected $expected, got $actual" >&2
    fi
    cleanup_verified_staging "$tmp" "$staging_dir"
    return 1
  fi

  if [ "$source" = "cache" ]; then
    echo "verified $dest_name from the download cache (sha256 $digest)"
  elif [ -n "$cache" ] && ! store_in_download_cache "$tmp" "$cache" "$digest"; then
    echo "::warning::could not add $url to the download cache at $cache; the verified download still installs" >&2
  fi

  if ! install_verified_file "$tmp" "$dest"; then
    cleanup_verified_staging "$tmp" "$staging_dir"
    return 1
  fi
  cleanup_verified_staging "$tmp" "$staging_dir"
  FETCH_VERIFIED_DIGESTS="$FETCH_VERIFIED_DIGESTS $digest"
}
