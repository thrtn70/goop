import { afterEach, describe, expect, it, vi } from "vitest";
import siteScript from "../../../site/app.js?raw";
import siteHtml from "../../../site/index.html?raw";

const bodyMarkup = siteHtml.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1]
  ?? (() => { throw new Error("site/index.html has no body"); })();

const releasesPage = "https://github.com/thrtn70/goop/releases";
const windowsArchive = "https://github.com/thrtn70/goop/releases/tag/v0.3.4";
const macAsset =
  "https://github.com/thrtn70/goop/releases/download/v0.3.4/Goop_0.3.4_aarch64.dmg";
const windowsAsset =
  "https://github.com/thrtn70/goop/releases/download/v0.3.4/Goop_0.3.4_x64_en-US.msi";

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

function latestPublishedRelease() {
  return {
    tag_name: "v0.3.4",
    html_url: windowsArchive,
    published_at: "2026-09-24T00:00:00Z",
    name: "Goop v0.3.4",
    assets: [
      { name: "Goop_0.3.4_aarch64.dmg", browser_download_url: macAsset },
      { name: "Goop_0.3.4_x64_en-US.msi", browser_download_url: windowsAsset },
    ],
  };
}

function expectDownloadsPaused() {
  const status = document.querySelector<HTMLElement>("[data-download-paused]");
  expect(status).not.toBeNull();
  expect(status?.textContent).toMatch(/downloads? (?:are )?temporarily paused/i);
  expect(status?.classList.contains("btn")).toBe(false);
  expect(document.querySelector("[data-cta]")).toBeNull();
  expect(document.querySelector("[data-mac-url]")).toBeNull();
  expect(document.querySelector(`[href="${macAsset}"]`)).toBeNull();
  expect(document.querySelector(`[href="${windowsAsset}"]`)).toBeNull();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("paused release downloads", () => {
  it("ships an explicit paused state without a current installer link", () => {
    expect(siteHtml).toMatch(/release downloads are temporarily paused/i);
    expect(siteHtml).not.toMatch(/data-(?:cta|mac-url)/);
    expect(siteHtml).not.toContain("/releases/latest");
    expect(siteHtml).not.toContain("/releases/download/");
  });

  it.each([
    ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)"],
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["unknown", "Mozilla/5.0 (X11; Linux x86_64)"],
  ])("keeps downloads paused while release history is pending on %s", (_os, ua) => {
    installPage(ua, () => new Promise<Response>(() => undefined));

    expectDownloadsPaused();
    const historyLinks = [
      ...document.querySelectorAll<HTMLAnchorElement>("[data-release-history]"),
    ];
    expect(historyLinks.length).toBeGreaterThan(0);
    for (const link of historyLinks) {
      expect(link.getAttribute("href")).toBe(releasesPage);
      expect(link.textContent).toMatch(/history|releases/i);
    }
  });

  it.each([
    ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)"],
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["unknown", "Mozilla/5.0 (X11; Linux x86_64)"],
  ])("does not promote v0.3.4 when GitHub reports it as latest on %s", async (_os, ua) => {
    installPage(ua, async () => response([latestPublishedRelease()]));

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".archive__row")).toHaveLength(1);
    });

    expectDownloadsPaused();
    expect(document.body.textContent).not.toMatch(/current:\s*v?0\.3\.4/i);

    const archiveLinks = [
      ...document.querySelectorAll<HTMLAnchorElement>(".archive__link"),
    ];
    expect(archiveLinks.map((link) => link.textContent)).toEqual(["Release page"]);
    expect(archiveLinks[0]?.getAttribute("href")).toBe(windowsArchive);
  });

  it.each([
    ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)"],
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["unknown", "Mozilla/5.0 (X11; Linux x86_64)"],
  ])("keeps downloads paused when the release-history fetch fails on %s", async (_os, ua) => {
    installPage(ua, async () => response([], false));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("[data-fetch-status]")?.hidden).toBe(false);
    });

    expectDownloadsPaused();
    expect(document.querySelector(".archive__fallback-row")).not.toBeNull();
  });
});
