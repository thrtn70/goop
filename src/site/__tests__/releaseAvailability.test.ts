import { afterEach, describe, expect, it, vi } from "vitest";
import siteScript from "../../../site/app.js?raw";
import siteHtml from "../../../site/index.html?raw";

const bodyMarkup = siteHtml.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1]
  ?? (() => { throw new Error("site/index.html has no body"); })();

const repo = "https://github.com/thrtn70/goop";
const releasesPage = `${repo}/releases`;
const latestPage = `${repo}/releases/latest`;

type Asset = { name: string; browser_download_url: string };
type Release = {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Asset[];
};

function asset(tag: string, name: string): Asset {
  return { name, browser_download_url: `${repo}/releases/download/${tag}/${name}` };
}

function release(tag: string, extra: Partial<Release> = {}): Release {
  const version = tag.replace(/^v/, "");
  return {
    tag_name: tag,
    name: `Goop ${tag}`,
    html_url: `${repo}/releases/tag/${tag}`,
    published_at: "2026-10-18T00:00:00Z",
    assets: [
      asset(tag, `Goop_${version}_aarch64.dmg`),
      asset(tag, `Goop_${version}_aarch64.dmg.sha256`),
      asset(tag, "Goop_aarch64.app.tar.gz"),
    ],
    ...extra,
  };
}

const v036 = release("v0.3.6");
const v034 = release("v0.3.4", {
  assets: [
    asset("v0.3.4", "Goop_0.3.4_aarch64.dmg"),
    asset("v0.3.4", "Goop_0.3.4_x64_en-US.msi"),
    asset("v0.3.4", "Goop_0.3.4_x64-setup.exe"),
  ],
});
const dmgOf = (r: Release) => r.assets[0]!.browser_download_url;

function response(data: unknown, ok = true): Response {
  return { ok, json: async () => data } as Response;
}

function installPage(
  userAgent: string,
  fetchImpl: (input: string | URL | Request) => Promise<Response>,
) {
  document.body.innerHTML = bodyMarkup;
  vi.stubGlobal("navigator", { userAgent });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));

  Function(siteScript)();
  if (document.readyState === "loading") {
    document.dispatchEvent(new Event("DOMContentLoaded"));
  }
}

const macLinks = () => [...document.querySelectorAll<HTMLAnchorElement>("[data-mac-url]")];
const versionLabels = () => [...document.querySelectorAll<HTMLElement>("[data-latest-version]")];

// Every check below requires the elements to exist; an empty list would
// otherwise pass any per-element expectation vacuously.
function expectMacLinks(href: string) {
  const links = macLinks();
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link.getAttribute("href")).toBe(href);
}

function expectVersionLabels(check: (text: string | null) => void) {
  const labels = versionLabels();
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) check(label.textContent);
}

async function archiveRendered(rows: number) {
  await vi.waitFor(() => {
    expect(document.querySelectorAll(".archive__row")).toHaveLength(rows);
  });
}

function expectNoWindowsInstaller() {
  expect(document.querySelector("[data-win-url]")).toBeNull();
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    expect(link.getAttribute("href")).not.toMatch(/\.(?:msi|exe)$/);
  }
}

const userAgents = [
  ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)"],
  ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
  ["unknown", "Mozilla/5.0 (X11; Linux x86_64)"],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("macOS downloads", () => {
  it("ships a macOS download that falls back to the latest release page, and no pause copy", () => {
    document.body.innerHTML = bodyMarkup;
    expectMacLinks(latestPage);
    expect(document.querySelector('[data-cta="mac"]')?.textContent).toMatch(/download for macos/i);
    expect(document.querySelector("[data-download-paused]")).toBeNull();
    expect(siteHtml).not.toMatch(/temporarily paused|patched macos build/i);
    expectNoWindowsInstaller();
  });

  it("tells everyone else the release is macOS-only and points at the release history", () => {
    document.body.innerHTML = bodyMarkup;
    const notice = document.querySelector<HTMLElement>("[data-platform-notice]");
    expect(notice?.textContent).toMatch(/apple silicon/i);
    expect(notice?.textContent).toMatch(/intel macs aren.t supported/i);
    expect(notice?.textContent).toMatch(/windows/i);
    const history = notice?.querySelector<HTMLAnchorElement>("[data-release-history]");
    expect(history?.getAttribute("href")).toBe(releasesPage);
  });

  it("explains Open Anyway as the first-launch step for an unsigned app", () => {
    expect(siteHtml).toMatch(/privacy &amp; security/i);
    expect(siteHtml).toMatch(/open anyway/i);
  });

  it.each(userAgents)("links the newest eligible DMG and its version on %s", async (_os, ua) => {
    installPage(ua, async () => response([v036, v034]));
    await archiveRendered(2);

    expectMacLinks(dmgOf(v036));
    expectVersionLabels((text) => expect(text).toBe("v0.3.6"));
    expectNoWindowsInstaller();
  });

  it.each(userAgents)("never promotes a release older than v0.3.6 on %s", async (_os, ua) => {
    installPage(ua, async () => response([v034]));
    await archiveRendered(1);

    expectMacLinks(latestPage);
    expectVersionLabels((text) => expect(text).not.toBe("v0.3.4"));
    expect(document.querySelector(`[href="${dmgOf(v034)}"]`)).toBeNull();
    expectNoWindowsInstaller();
  });

  it.each([
    ["older first", [v036, release("v0.3.7")]],
    ["newer first", [release("v0.3.7"), v036]],
  ])("picks the highest eligible version, %s", async (_order, releases) => {
    installPage("Mozilla/5.0 (Macintosh)", async () => response(releases));
    await archiveRendered(2);

    expectMacLinks(dmgOf(release("v0.3.7")));
    expectVersionLabels((text) => expect(text).toBe("v0.3.7"));
  });

  it("compares versions numerically, so v0.3.10 beats v0.3.9", async () => {
    const v0310 = release("v0.3.10");
    installPage("Mozilla/5.0 (Macintosh)", async () => response([release("v0.3.9"), v0310]));
    await archiveRendered(2);

    expectMacLinks(dmgOf(v0310));
    expectVersionLabels((text) => expect(text).toBe("v0.3.10"));
  });

  it("labels the version as v<x.y.z> even when the tag has no v prefix", async () => {
    const bare = release("0.3.7");
    installPage("Mozilla/5.0 (Macintosh)", async () => response([bare, v036]));
    await archiveRendered(2);

    expectMacLinks(dmgOf(bare));
    expectVersionLabels((text) => expect(text).toBe("v0.3.7"));
  });

  it("skips drafts, prereleases and flagged releases", async () => {
    const releases = [
      release("v0.3.9", { draft: true }),
      release("v0.3.8", { prerelease: true }),
      release("v0.3.8-rc.1", { prerelease: true }),
      release("v0.3.7", { name: "Broken: do not use v0.3.7" }),
      release("v0.3.7-hotfix"),
      v036,
    ];
    installPage("Mozilla/5.0 (Macintosh)", async () => response(releases));
    await archiveRendered(6);

    expectMacLinks(dmgOf(v036));
  });

  it("only trusts a DMG served from this repository's own release downloads", async () => {
    const foreign = release("v0.3.8", {
      assets: [{ name: "Goop_0.3.8_aarch64.dmg", browser_download_url: "https://example.com/Goop_0.3.8_aarch64.dmg" }],
    });
    const otherTag = release("v0.3.9", {
      assets: [asset("v0.3.6", "Goop_0.3.9_aarch64.dmg")],
    });
    const mismatched = release("v0.3.10", {
      assets: [asset("v0.3.10", "Goop_0.3.6_aarch64.dmg")],
    });
    const windowsOnly = release("v0.3.11", {
      assets: [asset("v0.3.11", "Goop_0.3.11_x64_en-US.msi")],
    });
    installPage("Mozilla/5.0 (Macintosh)", async () =>
      response([windowsOnly, mismatched, otherTag, foreign, v036]));
    await archiveRendered(5);

    expectMacLinks(dmgOf(v036));
    expectNoWindowsInstaller();
  });

  it.each([
    ["an error status", async () => response([], false)],
    ["a rejected request", async () => { throw new Error("offline"); }],
    ["a non-array body", async () => response({ message: "API rate limit exceeded" })],
  ] as const)("keeps the latest-release link after %s", async (_case, fetchImpl) => {
    installPage("Mozilla/5.0 (Macintosh)", fetchImpl);

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("[data-fetch-status]")?.hidden).toBe(false);
    });
    expectMacLinks(latestPage);
    expect(document.querySelector(".archive__fallback-row")).not.toBeNull();
  });

  it.each(userAgents)("keeps the latest-release link when the fetch fails on %s", async (_os, ua) => {
    installPage(ua, async () => response([], false));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("[data-fetch-status]")?.hidden).toBe(false);
    });
    expectMacLinks(latestPage);
    expect(document.querySelector(".archive__fallback-row")).not.toBeNull();
    expectNoWindowsInstaller();
  });

  it("still lists only release pages in the archive", async () => {
    installPage("Mozilla/5.0 (Macintosh)", async () => response([v036, v034]));
    await archiveRendered(2);

    const archiveLinks = [...document.querySelectorAll<HTMLAnchorElement>(".archive__link")];
    expect(archiveLinks.map((link) => link.textContent)).toEqual(["Release page", "Release page"]);
    expect(archiveLinks.map((link) => link.getAttribute("href"))).toEqual([v036.html_url, v034.html_url]);
  });
});
