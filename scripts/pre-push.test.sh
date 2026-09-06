#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# With FORCE_FAIL=1, script must exit nonzero.
if FORCE_FAIL=1 ./pre-push.sh; then
  echo "FAIL: pre-push.sh should have returned nonzero with FORCE_FAIL=1"
  exit 1
fi

stub_dir="$(mktemp -d)"
stub_log="$stub_dir/commands.log"
trap 'rm -rf "$stub_dir"' EXIT

cat > "$stub_dir/command-stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_name="$(basename "$0")"
printf '%s' "$command_name" >> "$STUB_LOG"
printf ' %q' "$@" >> "$STUB_LOG"
printf '\n' >> "$STUB_LOG"

case "$command_name" in
  cargo|npm)
    exit 0
    ;;
  uname)
    echo Darwin
    exit 0
    ;;
  node)
    if [[ "$*" == *"scripts/performance-baseline.test.mjs"* ]]; then
      exit 42
    fi
    exit 0
    ;;
  *)
    echo "unexpected stub command: $command_name" >&2
    exit 99
    ;;
esac
EOF
chmod +x "$stub_dir/command-stub"
for command_name in cargo npm node uname; do
  ln -s command-stub "$stub_dir/$command_name"
done

# A failing baseline harness must block the gate. All unrelated build commands
# are stubbed so this test exercises shell wiring without running real builds.
set +e
gate_output="$(PATH="$stub_dir:$PATH" STUB_LOG="$stub_log" ./pre-push.sh 2>&1)"
gate_status=$?
set -e

if [[ "$gate_status" -eq 0 ]]; then
  echo "FAIL: pre-push.sh ignored a failing baseline harness"
  echo "$gate_output"
  exit 1
fi

expected_harness="node --test --test-concurrency=1 scripts/performance-baseline.test.mjs scripts/startup-baseline.test.mjs"
if ! grep -Fqx "node --test scripts/startup-fonts.test.mjs" "$stub_log"; then
  echo "FAIL: pre-push.sh did not run the portable startup font checks"
  cat "$stub_log"
  exit 1
fi
if ! grep -Fqx "uname -s" "$stub_log"; then
  echo "FAIL: pre-push.sh did not detect the host platform"
  cat "$stub_log"
  exit 1
fi
if ! grep -Fqx "$expected_harness" "$stub_log"; then
  echo "FAIL: pre-push.sh did not run the sequential baseline harness"
  cat "$stub_log"
  exit 1
fi

echo "PASS"
