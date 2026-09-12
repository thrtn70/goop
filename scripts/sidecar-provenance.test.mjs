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
  assert.match(script, /^MACOS_MUPDF_VERSION="1\.28\.3"$/m);
  assert.match(script, /^MACOS_TESSERACT_VERSION="5\.5\.3"$/m);
});
