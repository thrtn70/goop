import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Audit CI restores the verified sidecar downloads between runs so that an
// upstream host outage (osxexperts.net returned 503 for about three hours on
// 2026-10-18 and failed every macOS sidecar-smoke leg) cannot fail a build that
// already holds the pinned bytes. fetch-with-retry.test.sh proves the helper
// re-verifies every restored byte; these tests pin how the workflows use it.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const audit = read("../.github/workflows/audit.yml");
const release = read("../.github/workflows/release.yml");
const fetchScript = read("./fetch-sidecars.sh");
const prePush = read("./pre-push.sh");
const gitignore = read("../.gitignore");

const cachePath = ".sidecar-downloads";
const keyPrefix = "sidecar-downloads-v1-${{ runner.os }}-";
const key = `${keyPrefix}\${{ hashFiles('scripts/fetch-sidecars.sh') }}`;
const restoreId = "sidecar-downloads";

function job(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function steps(body) {
  return body.split(/\n(?= {6}- )/).filter((step) => step.startsWith("      - "));
}

const field = (step, name) => step.match(new RegExp(`^ {8,10}${name}: (.*)$`, "m"))?.[1];
const condition = (step) => step.match(/^ {8}if: (.*)$/m)?.[1];
const isFetch = (step) => /\.\/scripts\/fetch-sidecars\.sh /.test(step);

function cacheActionSha() {
  const refs = [...`${audit}\n${release}`.matchAll(/actions\/cache(?:\/(?:restore|save))?@([^\s]+)/g)];
  const shas = new Set(refs.map((match) => match[1]));
  assert.equal(shas.size, 1, `every actions/cache reference must share one pinned commit: ${[...shas]}`);
  const [sha] = shas;
  assert.match(sha, /^[0-9a-f]{40}$/);
  return sha;
}

for (const name of ["rust", "sidecar-smoke"]) {
  test(`audit ${name} restores verified downloads, always verifies, and saves right after the fetch`, () => {
    const sha = cacheActionSha();
    const list = steps(job(audit, name));

    const fetches = list.filter(isFetch);
    assert.equal(fetches.length, 1, `${name} should fetch sidecars exactly once`);
    const fetchAt = list.indexOf(fetches[0]);
    const fetch = list[fetchAt];
    assert.equal(field(fetch, "GOOP_SIDECAR_CACHE"), cachePath, `${name} fetch must read and fill the cache:\n${fetch}`);
    // Hit or miss, the fetch runs, and fetch_verified checks every digest.
    assert.equal(condition(fetch), undefined, `${name} fetch must never be skipped on a cache hit`);

    // The job restores other caches too (the HEIC stack), so pick this one by
    // its path, and require it to be the only one.
    const restores = list.filter(
      (step) => step.includes(`uses: actions/cache/restore@${sha}`) && field(step, "path") === cachePath,
    );
    assert.equal(restores.length, 1, `${name} restores the downloads exactly once`);
    const restoreAt = list.indexOf(restores[0]);
    assert.ok(restoreAt < fetchAt, `${name} must restore the cache before fetching`);
    const restore = list[restoreAt];
    assert.equal(field(restore, "id"), restoreId);
    assert.equal(field(restore, "key"), key);
    assert.match(restore, new RegExp(`^ {10}restore-keys: ${keyPrefix.replace(/[$.{}]/g, "\\$&")}$`, "m"));
    assert.equal(condition(restore), undefined, `${name} restores on every leg`);
    // A miss must fall through to the network, never end the job.
    assert.doesNotMatch(restore, /fail-on-cache-miss|lookup-only/);

    // Saved straight after a successful fetch, not in a post step, so a later
    // flaky test in the same job cannot throw the downloads away.
    const save = list[fetchAt + 1];
    assert.ok(save?.includes(`uses: actions/cache/save@${sha}`), `${name} must save immediately after the fetch`);
    assert.equal(condition(save), `steps.${restoreId}.outputs.cache-hit != 'true'`);
    assert.equal(field(save, "path"), cachePath);
    assert.equal(field(save, "key"), key);
  });
}

test("every sidecar fetch in audit uses the download cache", () => {
  const fetches = steps(audit).filter(isFetch);
  assert.equal(fetches.length, 2, "a new fetch site needs the cache wired the same way");
  for (const step of fetches) assert.equal(field(step, "GOOP_SIDECAR_CACHE"), cachePath);
});

test("release builds always fetch sidecars fresh from upstream", () => {
  // Releases are rare and can wait out an outage. Fetching fresh there is the
  // one remaining proof that the pinned URLs still serve the pinned bytes,
  // which cache-first audit runs stop noticing.
  assert.match(job(release, "build"), /\.\/scripts\/fetch-sidecars\.sh "\$\{\{ matrix\.target \}\}"/);
  assert.doesNotMatch(release, /GOOP_SIDECAR_CACHE|sidecar-downloads/);
  assert.doesNotMatch(release, /actions\/cache\/(?:restore|save)@/);
});

test("fetch-sidecars prunes the cache after its last download", () => {
  const prune = fetchScript.lastIndexOf("\nprune_download_cache\n");
  assert.notEqual(prune, -1, "fetch-sidecars.sh never prunes the download cache");
  assert.ok(prune > fetchScript.lastIndexOf("fetch_verified "), "pruning before a download would drop its entry");
});

test("the cache directory is never committed", () => {
  assert.match(gitignore, /^\/\.sidecar-downloads$/m);
});

test("both quality gates run these tests", () => {
  assert.match(prePush, /node --test scripts\/sidecar-download-cache\.test\.mjs/);
  // The behavioural cache checks otherwise run only in the Linux rust job;
  // locally they also cover macOS's bash 3.2 before CI's real fetch does.
  assert.match(prePush, /\.\/scripts\/fetch-with-retry\.test\.sh/);
  assert.match(job(audit, "web"), /- run: node --test scripts\/sidecar-download-cache\.test\.mjs/);
});
