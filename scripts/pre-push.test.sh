#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# With FORCE_FAIL=1, script must exit nonzero.
if FORCE_FAIL=1 ./pre-push.sh; then
  echo "FAIL: pre-push.sh should have returned nonzero with FORCE_FAIL=1"
  exit 1
fi
echo "PASS"
