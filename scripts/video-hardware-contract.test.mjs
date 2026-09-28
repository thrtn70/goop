import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const audit = readFileSync(new URL("../.github/workflows/audit.yml", import.meta.url), "utf8");
const gate = readFileSync(new URL("./pre-push.sh", import.meta.url), "utf8");
const controls = readFileSync(new URL("../crates/goop-converter/tests/video_controls.rs", import.meta.url), "utf8");

test("portable gates retain the hardware policy contract checks", () => {
  for (const source of [audit, gate]) {
    assert(source.includes("node --test scripts/video-hardware-contract.test.mjs"));
  }
});

test("platform video-control inventories include required hardware admission", () => {
  assert(audit.includes("macOS) expected_video_controls=42"));
  assert(audit.includes("Windows) expected_video_controls=38"));
  assert(audit.includes("hardware_capabilities_are_separate_and_reuse_transform_authority"));
  assert(audit.includes("hardware_required_portable_intent_is_unavailable_on_this_platform"));
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
