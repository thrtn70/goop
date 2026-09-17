import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const localGate = readFileSync(new URL("./pre-push.sh", import.meta.url), "utf8");
const auditWorkflow = readFileSync(new URL("../.github/workflows/audit.yml", import.meta.url), "utf8");
const previewCommands = readFileSync(new URL("../src-tauri/src/commands/preview.rs", import.meta.url), "utf8");
const tauriLibrary = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const command = "node --test scripts/desktop-preview.test.mjs";
const featureOffClippy = "cargo clippy -p goop-converter --all-targets --no-default-features -- -D warnings";
const featureOffTest = "cargo test -p goop-converter --no-default-features";

test("the desktop client enables the bounded HEIC preview engine", () => {
  assert.match(
    manifest,
    /^goop-converter = \{ path = "\.\.\/crates\/goop-converter", features = \["heic-thumbnail-preview"\] \}$/m,
  );
});

test("local and hosted gates enforce desktop preview activation", () => {
  assert.match(localGate, new RegExp(command.replaceAll(".", "\\.")));
  assert.match(auditWorkflow, new RegExp(command.replaceAll(".", "\\.")));
});

test("local and hosted gates preserve the feature-off converter contract", () => {
  for (const gate of [localGate, auditWorkflow]) {
    assert.match(gate, new RegExp(featureOffClippy.replaceAll("-", "\\-")));
    assert.match(gate, new RegExp(featureOffTest.replaceAll("-", "\\-")));
  }
});

test("the desktop client exposes engine-owned preview eligibility", () => {
  assert.match(previewCommands, /pub async fn preview_eligibility\(/);
  assert.match(previewCommands, /\.eligibility\(&state\.resolver, request\)/);
  assert.match(tauriLibrary, /commands::preview::preview_eligibility,/);
});
