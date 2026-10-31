import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./fetch-sidecars.sh", import.meta.url), "utf8");

test("macOS Homebrew sidecars fail closed on installation and version drift", () => {
  assert.doesNotMatch(script, /brew" install --quiet (?:ghostscript|mupdf-tools|tesseract) \|\| true/);
  for (const variable of [
    "MACOS_GHOSTSCRIPT_VERSION",
    "MACOS_MUPDF_VERSION",
    "MACOS_TESSERACT_VERSION",
  ]) {
    assert.match(script, new RegExp(`^${variable}="[0-9.]+"$`, "m"));
  }
  assert.match(script, /Ghostscript version drift/);
  assert.match(script, /MuPDF version drift/);
  assert.match(script, /Tesseract version drift/);
  assert.match(script, /^MACOS_GHOSTSCRIPT_VERSION="10\.08\.0"$/m);
  assert.match(script, /^MACOS_MUPDF_VERSION="1\.28\.5"$/m);
  assert.match(script, /^MACOS_TESSERACT_VERSION="5\.5\.3"$/m);
});

test("macOS Homebrew sidecars preserve the reviewed runner formula set", () => {
  assert.doesNotMatch(script, /"\$GS_BREW" update/);
  assert.doesNotMatch(script, /"\$GS_BREW" upgrade/);
  assert.match(script, /if ! "\$GS_BREW" list --versions "\$formula"/);
  assert.match(script, /"\$GS_BREW" install --quiet "\$formula"/);
  for (const formula of ["ghostscript", "mupdf-tools", "tesseract"]) {
    assert.match(script, new RegExp(`ensure_reviewed_brew_formula ${formula}`));
  }
});

// 2026.08.19's frozen binaries carry certifi 2026.07.22, which still trusts
// the compromised "emSign ECC Root CA - G3". check-yt-dlp-runtime.mjs proves
// each fetched binary clears the floors; this records the reviewed pin.
test("yt-dlp is pinned to a release whose binaries carry the patched certifi and urllib3", () => {
  assert.match(script, /^YT_DLP_VERSION="2026\.10\.21"$/m);
  for (const asset of ["WINDOWS", "MACOS", "PORTABLE"]) {
    assert.match(script, new RegExp(`^YT_DLP_${asset}_SHA256="[0-9a-f]{64}"$`, "m"));
  }
});

test("Ghostscript resources are replaced on every run", () => {
  assert.doesNotMatch(script, /if \[ ! -d "\$OUT_DIR\/gs-resources\/Resource" \]/);
  assert.match(
    script,
    /rm -rf "\$OUT_DIR\/gs-resources"\n\s+GS_SHARE="\$GS_PREFIX\/share\/ghostscript"/,
  );
});
