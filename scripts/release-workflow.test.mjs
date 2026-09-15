import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const auditWorkflow = readFileSync(new URL("../.github/workflows/audit.yml", import.meta.url), "utf8");
const lines = workflow.split("\n");
const auditLines = auditWorkflow.split("\n");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const siteScript = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");
const siteHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const windowsHeifInstaller = readFileSync(
  new URL("./install-windows-heif-deps.sh", import.meta.url),
  "utf8",
);

function job(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function auditJob(name) {
  const start = auditLines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} audit job`);
  const end = auditLines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return auditLines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("release builds run read-only and without persisted checkout credentials", () => {
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(workflow, /^permissions:\n {2}contents: write$/m);
  for (const name of ["validate", "legal", "build"]) {
    const body = job(name);
    assert.doesNotMatch(body, /contents: write/);
    if (body.includes("actions/checkout@")) assert.match(body, /persist-credentials: false/);
  }

  const build = job("build");
  assert.match(build, /tauri-apps\/tauri-action@[0-9a-f]{40}/);
  assert.doesNotMatch(build, /GITHUB_TOKEN|releaseId:|tagName:/);
});

test("only the no-build publish job can write release state", () => {
  const publish = job("publish");
  assert.match(publish, /permissions:\n {6}contents: write/);
  assert.match(publish, /needs: \[validate, legal, build\]/);
  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(publish, /actions\/checkout|npm |cargo |rust-toolchain|tauri-action|fetch-sidecars|\.\/scripts\//);
  assert.match(publish, /draft: true/);
  assert.doesNotMatch(publish, /draft: false/);
});

test("both platform builds stage immutable workflow artifacts before publication", () => {
  const build = job("build");
  assert.match(build, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(build, /name: release-assets-\$\{\{ matrix\.target \}\}/);
  assert.match(build, /if-no-files-found: error/);
  assert.match(build, /overwrite: true/);
  assert.match(workflow, /group: release-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("audit executes the pinned static Little CMS transform on both release targets", () => {
  const smoke = auditJob("sidecar-smoke");
  assert.match(smoke, /os: \[macos-14, windows-latest\]/);
  const step = smoke.match(/ {6}- name: Portable color static link\n([\s\S]*?)\n {6}- name: Image conversion correctness/);
  assert.ok(step, "missing bounded portable color static-link step");
  assert.doesNotMatch(step[0], /^\s*if:/m);
  assert.match(step[0], /cargo tree -p lcms2@6\.2\.0 --depth 1 --prefix none/);
  assert.match(step[0], /grep -qx 'lcms2-sys v4\.0\.7'/);
  assert.match(step[0], /cargo clean -p lcms2-sys/);
  assert.match(step[0], /env -u LCMS2_LIB_DIR -u LCMS2_INCLUDE_DIR cargo test/);
  assert.match(step[0], /--test lcms_static/);
  assert.match(step[0], /otool -L "\$BIN"/);
  assert.match(step[0], /objdump\.exe -p "\$BIN"/);
  assert.match(step[0], /lcms2\[\^ \]\*\\\.dll/);
});

test("Windows audit and release use one immutable libheif 1.23 vcpkg tree", () => {
  const installer = "./scripts/install-windows-heif-deps.sh";
  assert.equal(auditWorkflow.match(new RegExp(installer.replaceAll(".", "\\."), "g"))?.length, 1);
  assert.equal(workflow.match(new RegExp(installer.replaceAll(".", "\\."), "g"))?.length, 1);
  assert.match(windowsHeifInstaller, /VCPKG_COMMIT="[0-9a-f]{40}"/);
  assert.match(windowsHeifInstaller, /checkout --detach "\$VCPKG_COMMIT"/);
  assert.match(windowsHeifInstaller, /libheif\[core\]:x64-windows-static/);
  assert.match(auditWorkflow, /hashFiles\('scripts\/install-windows-heif-deps\.sh'\)/);
  assert.match(workflow, /hashFiles\('scripts\/install-windows-heif-deps\.sh'\)/);
});

test("Windows audit records fresh-process HEIC preview memory evidence", () => {
  const smoke = auditJob("sidecar-smoke");
  const handoff = smoke.match(
    / {6}- name: Cargo check \(Windows-only paths\)\n([\s\S]*?)\n {6}- name: HEIC preview fresh-process memory \(Windows\)/,
  );
  assert.ok(handoff, "missing Windows HEIC preview executable handoff");
  assert.match(
    handoff[0],
    /CARGO_INCREMENTAL=0 cargo test -p goop-converter --release --features heic-thumbnail-preview --lib --no-run --message-format=json/,
  );
  assert.match(handoff[0], /printf 'HEIC_PREVIEW_TEST_BINARY=%s\\n' "\$BIN" >> "\$GITHUB_ENV"/);

  const step = smoke.match(
    / {6}- name: HEIC preview fresh-process memory \(Windows\)\n([\s\S]*?)\n {6}- name: Lossy WebP static link/,
  );
  assert.ok(step, "missing Windows HEIC preview memory evidence step");
  assert.match(step[0], /if: matrix\.os == 'windows-latest'/);
  assert.match(step[0], /shell: pwsh/);
  assert.match(step[0], /memory_probe_baseline_without_decode/);
  assert.match(step[0], /memory_probe_12mp_primary_with_512x384_thumbnail/);
  assert.match(step[0], /memory_probe_48mp_primary_with_512x384_thumbnail/);
  assert.match(step[0], /memory_probe_exact_4mp_thumbnail/);
  assert.match(step[0], /\$binary = \$env:HEIC_PREVIEW_TEST_BINARY/);
  assert.match(step[0], /for \(\$iteration = 0; \$iteration -lt 6; \$iteration\+\+\)/);
  assert.match(step[0], /@\("--quiet", "--exact", \$case\.Value, "--ignored"\)/);
  assert.match(step[0], /if \(\$process\.ExitCode -ne 0\)/);
  assert.match(step[0], /PeakWorkingSet64/);
  assert.match(step[0], /if \(\$peak -le 0\)/);
  assert.match(step[0], /if \(\$iteration -gt 0\)/);
  assert.match(step[0], /\$median = \[long\]\$ordered\[2\]/);
  assert.match(step[0], /HEIC_PREVIEW_MEMORY/);
  assert.match(step[0], /if \(\$primaryDelta -gt 16MB\)/);
});

const version = "0.3.3";
const installers = [
  `Goop_${version}_aarch64.dmg`,
  "Goop_aarch64.app.tar.gz",
  `Goop_${version}_x64-setup.exe`,
  `Goop_${version}_x64_en-US.msi`,
];
const expectedAssets = [...installers, ...installers.map((name) => `${name}.sha256`)].sort();
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("static website release fallbacks match the packaged version", () => {
  assert.equal(packageVersion, version);
  assert.match(siteScript, new RegExp(`version: ['"]v${version}['"]`));
  assert.deepEqual(
    [...siteHtml.matchAll(/data-latest-version>v([^<]+)</g)].map((match) => match[1]),
    [version, version],
  );
});

function inlinePublishScript() {
  const body = job("publish").split("\n");
  const start = body.findIndex((line) => line === "          script: |");
  assert.notEqual(start, -1, "missing inline publish script");
  return body.slice(start + 1).map((line) => line.startsWith("            ") ? line.slice(12) : line).join("\n");
}

async function exercisePublish({ releases = [], initialAssets = [], corruptChecksum = false, failFirstUpload = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "goop-release-contract-"));
  const previous = process.cwd();
  const previousVersion = process.env.RELEASE_VERSION;
  const state = {
    releases: releases.map((release) => ({ ...release })),
    assets: initialAssets.map((name, index) => ({ id: index + 1, name })),
    created: 0,
    deleted: [],
    uploads: [],
    failures: [],
    failedOnce: false,
  };
  try {
    for (const root of ["release-input/macos", "release-input/windows"]) mkdirSync(join(directory, root), { recursive: true });
    for (const [index, name] of installers.entries()) {
      const root = index < 2 ? "release-input/macos" : "release-input/windows";
      const bytes = Buffer.from(`installer:${name}`);
      writeFileSync(join(directory, root, name), bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const writtenHash = corruptChecksum && index === 0 ? "0".repeat(64) : hash;
      writeFileSync(join(directory, root, `${name}.sha256`), `${writtenHash}  ${name}\n`);
    }
    process.chdir(directory);
    process.env.RELEASE_VERSION = version;

    const listReleases = async () => ({ data: state.releases });
    const listReleaseAssets = async () => ({ data: state.assets });
    const github = {
      paginate: async (method) => method === listReleases ? state.releases : state.assets,
      rest: { repos: {
        listReleases,
        listReleaseAssets,
        createRelease: async ({ tag_name, name, draft, prerelease }) => {
          state.created += 1;
          const release = { id: 77, tag_name, name, draft, prerelease };
          state.releases.push(release);
          return { data: release };
        },
        getRelease: async ({ release_id }) => ({ data: state.releases.find((release) => release.id === release_id) ?? { id: release_id, draft: true } }),
        deleteReleaseAsset: async ({ asset_id }) => {
          state.deleted.push(asset_id);
          state.assets = state.assets.filter((asset) => asset.id !== asset_id);
        },
        uploadReleaseAsset: async ({ name, data }) => {
          for await (const _chunk of data) { /* drain the exact stream shape used by github-script */ }
          state.uploads.push(name);
          state.assets.push({ id: 100 + state.uploads.length, name });
          if (name === failFirstUpload && !state.failedOnce) {
            state.failedOnce = true;
            throw new Error("ambiguous upload failure");
          }
          return { data: { name } };
        },
      } },
    };
    const core = {
      info: () => {},
      setFailed: (message) => state.failures.push(message),
    };
    const context = { ref: `refs/tags/v${version}`, repo: { owner: "thrtn70", repo: "goop" } };
    await new AsyncFunction("github", "context", "core", "require", inlinePublishScript())(github, context, core, require);
    return state;
  } finally {
    process.chdir(previous);
    if (previousVersion === undefined) delete process.env.RELEASE_VERSION;
    else process.env.RELEASE_VERSION = previousVersion;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("inline publisher validates bytes and release state before mutating a draft", async (t) => {
  await t.test("creates one draft with the exact eight-asset allowlist", async () => {
    const state = await exercisePublish();
    assert.deepEqual(state.failures, []);
    assert.equal(state.created, 1);
    assert.deepEqual(state.assets.map((asset) => asset.name).sort(), expectedAssets);
  });

  await t.test("refuses a checksum mismatch before any release API mutation", async () => {
    const state = await exercisePublish({ corruptChecksum: true });
    assert.match(state.failures[0], /checksum mismatch/);
    assert.equal(state.created, 0);
    assert.deepEqual(state.uploads, []);
  });

  await t.test("refuses published releases and stale draft assets", async () => {
    const published = await exercisePublish({ releases: [{ id: 8, tag_name: `v${version}`, draft: false }] });
    assert.match(published.failures[0], /already published/);
    assert.deepEqual(published.uploads, []);

    const stale = await exercisePublish({
      releases: [{ id: 9, tag_name: `v${version}`, draft: true }],
      initialAssets: ["unexpected.zip"],
    });
    assert.match(stale.failures[0], /unexpected assets: unexpected\.zip/);
    assert.deepEqual(stale.deleted, []);
    assert.deepEqual(stale.uploads, []);
  });

  await t.test("recovers an ambiguous upload by replacing the persisted duplicate", async () => {
    const state = await exercisePublish({
      releases: [{ id: 10, tag_name: `v${version}`, draft: true }],
      failFirstUpload: expectedAssets[0],
    });
    assert.deepEqual(state.failures, []);
    assert.equal(state.uploads.length, expectedAssets.length + 1);
    assert.equal(state.deleted.length, 1);
    assert.deepEqual(state.assets.map((asset) => asset.name).sort(), expectedAssets);
  });
});
