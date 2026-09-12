import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const lines = workflow.split("\n");

function job(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
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
