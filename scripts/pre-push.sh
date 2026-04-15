#!/usr/bin/env bash
# Pre-push quality gate: format, lint, test, typecheck.
# Any failure blocks the push. Set FORCE_FAIL=1 for the test harness to simulate failure.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ "${FORCE_FAIL:-0}" == "1" ]]; then
  echo "FORCE_FAIL=1: simulating failure"
  exit 1
fi

# Preflight: required tools must be present, else fail closed (never fail open).
for tool in cargo npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[goop] required tool '$tool' not found — cannot run quality gate; blocking push." >&2
    exit 1
  fi
done

echo "[goop] Running pre-push quality gate..."

fail=0

run_step() {
  local name="$1"; shift
  echo "  → $name"
  if "$@"; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name"
    fail=1
  fi
}

run_step "cargo fmt --check" cargo fmt --all --check
run_step "cargo clippy"      cargo clippy --workspace --all-targets -- -D warnings
run_step "cargo test"        cargo test --workspace --quiet
run_step "tsc typecheck"     npm run --silent typecheck
run_step "vitest"            npm run --silent test

if [[ "$fail" != "0" ]]; then
  echo "[goop] Pre-push gate blocked push. Fix issues above."
  exit 1
fi

echo "[goop] Pre-push gate: all clear."
