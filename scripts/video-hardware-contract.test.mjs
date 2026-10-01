import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const audit = readFileSync(new URL("../.github/workflows/audit.yml", import.meta.url), "utf8");
const gate = readFileSync(new URL("./pre-push.sh", import.meta.url), "utf8");
const controls = readFileSync(new URL("../crates/goop-converter/tests/video_controls.rs", import.meta.url), "utf8");

function platformInventoryBranches(step) {
  const branches = [...step.matchAll(
    /^[ \t]*if \[\[ "\$RUNNER_OS" == macOS \]\]; then[ \t]*\r?\n([\s\S]*?)^[ \t]*else[ \t]*\r?\n([\s\S]*?)^[ \t]*fi[ \t]*$/gm,
  )];
  assert.equal(
    branches.length,
    1,
    "expected exactly one complete macOS/Windows inventory branch",
  );
  return {
    macChecks: branches[0][1],
    windowsChecks: branches[0][2],
  };
}

test("portable gates retain the hardware policy contract checks", () => {
  for (const source of [audit, gate]) {
    assert(source.includes("node --test scripts/video-hardware-contract.test.mjs"));
  }
});

test("platform video-control inventories include Unix readiness guards only on macOS", () => {
  assert(audit.includes("macOS) expected_video_controls=44"));
  assert(audit.includes("Windows) expected_video_controls=38"));
  assert(audit.includes("hardware_capabilities_are_separate_and_reuse_transform_authority"));
  assert(audit.includes("hardware_required_portable_intent_is_unavailable_on_this_platform"));

  const stepStart = audit.indexOf("      - name: Video controls (real ffmpeg)");
  const stepEnd = audit.indexOf("      - name: Audio controls (real ffmpeg)", stepStart);
  assert.notEqual(stepStart, -1, "missing video-controls audit step");
  assert.notEqual(stepEnd, -1, "missing audio-controls boundary");
  const step = audit.slice(stepStart, stepEnd);
  const { macChecks, windowsChecks } = platformInventoryBranches(step);

  for (const name of [
    "executable_readiness_probe_does_not_run_the_fixture_body",
    "executable_readiness_rejects_a_nonzero_probe_exit",
  ]) {
    assert(controls.includes(`fn ${name}()`), `missing ${name} source regression`);
    assert(macChecks.includes(name), `macOS inventory does not require ${name}`);
    assert(!windowsChecks.includes(name), `Windows inventory must not require Unix-only ${name}`);
  }
});

test("platform inventory parsing inspects a complete Windows branch", () => {
  const forbiddenName = "executable_readiness_probe_does_not_run_the_fixture_body";
  const injected = [
    'if [[ "$RUNNER_OS" == macOS ]]; then',
    "  grep -q '^mac_only: test$' tests.txt",
    "else",
    `  grep -q '^${forbiddenName}: test$' tests.txt`,
    "fi",
  ].join("\n");

  const { windowsChecks } = platformInventoryBranches(injected);
  assert(
    windowsChecks.includes(forbiddenName),
    "the complete Windows branch must expose a forbidden Unix-only readiness guard",
  );
});

test("actual VideoToolbox acceptance is separate from the portable stream suite", () => {
  const streams = readFileSync(new URL("../crates/goop-converter/tests/video_track_options.rs", import.meta.url), "utf8");
  assert(!streams.includes("bundled_hardware_required_covers_container_transform_fps_and_tracks_without_surrogate"));
  const hardware = readFileSync(new URL("../crates/goop-converter/tests/video_hardware_required.rs", import.meta.url), "utf8");
  assert(hardware.includes("target_os = \"macos\""));
  assert(hardware.includes("target_arch = \"aarch64\""));
  assert(hardware.includes("bundled_hardware_required_covers_container_transform_fps_and_tracks_without_surrogate"));
  assert(hardware.includes("#[ignore"));
  assert(hardware.includes('"-display_rotation"'), "rotated source needs a display matrix, not an encode-time metadata tag");
  assert(hardware.includes("rotation_degrees"), "real fixture must assert the marked source before exercising hardware");
});

test("bundled software availability does not require VideoToolbox on Windows", () => {
  const start = controls.indexOf("async fn bundled_required_video_encoders_are_available()");
  const end = controls.indexOf("#[tokio::test]", start);
  assert(!controls.slice(start, end).includes("supports_h264_videotoolbox_required"));
});

test("macOS-only process helpers are absent from Linux lint builds", () => {
  const processTests = readFileSync(new URL("../crates/goop-converter/tests/video_attempts_process.rs", import.meta.url), "utf8");
  for (const name of ["hardware_required_request", "hardware_required_backend"]) {
    assert.match(processTests, new RegExp(`#\\[cfg\\(all\\(target_os = "macos", target_arch = "aarch64"\\)\\)\\]\\nfn ${name}\\(`));
  }
});

test("platform-only publication fixture is absent from Linux lint builds", () => {
  const publication = readFileSync(new URL("../crates/goop-queue/src/publication.rs", import.meta.url), "utf8");
  assert.match(publication, /#\[cfg\(any\(target_os = "macos", target_os = "windows"\)\)\]\n {4}fn hardware_result\(/);
});
