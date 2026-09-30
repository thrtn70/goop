import { afterEach, describe, expect, it, vi } from "vitest";
import siteScript from "../../../site/app.js?raw";
import siteHtml from "../../../site/index.html?raw";

const bodyMarkup = siteHtml.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1]
  ?? (() => { throw new Error("site/index.html has no body"); })();

const releasesPage = "https://github.com/thrtn70/goop/releases/latest";
const windowsArchive = "https://github.com/thrtn70/goop/releases/tag/v0.3.4";
const macAsset =
  "https://github.com/thrtn70/goop/releases/download/v0.3.5/Goop_0.3.5_aarch64.dmg";
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

function latestRelease() {
  return {
    tag_name: "v0.3.5",
    html_url: "https://github.com/thrtn70/goop/releases/tag/v0.3.5",
    published_at: "2026-09-30T00:00:00Z",
    name: "Goop v0.3.5",
    assets: [
      { name: "Goop_0.3.5_aarch64.dmg", browser_download_url: macAsset },
      {
        name: "Goop_0.3.5_aarch64.dmg.sha256",
        browser_download_url: `${macAsset}.sha256`,
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("published download availability", () => {
  it("ships v0.3.5 as the static fallback in both visible labels", () => {
    expect(siteScript).toMatch(/version: ['"]v0\.3\.5['"]/);
    expect(
      [...siteHtml.matchAll(/data-latest-version>v([^<]+)</g)].map(
        (match) => match[1],
      ),
    ).toEqual(["0.3.5", "0.3.5"]);
  });

  it.each([
    ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)"],
    ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["unknown", "Mozilla/5.0 (X11; Linux x86_64)"],
  ])("keeps the current Mac download safe while fetches are pending on %s", (_os, ua) => {
    installPage(ua, () => new Promise<Response>(() => undefined));

    const macCta = document.querySelector<HTMLAnchorElement>('[data-cta="mac"]');
    expect(macCta).not.toBeNull();
    expect(macCta?.hidden).toBe(false);
    expect(macCta?.getAttribute("href")).toBe(releasesPage);
    expect(document.querySelector('[data-cta="win"]')).toBeNull();

    const historicalLinks = [
      ...document.querySelectorAll<HTMLAnchorElement>("[data-windows-archive]"),
    ];
    expect(historicalLinks.length).toBeGreaterThan(0);
    for (const link of historicalLinks) {
      expect(link.getAttribute("href")).toBe(windowsArchive);
      expect(link.textContent).toMatch(/older|v0\.3\.4/i);
    }
  });

  it("uses the published Mac asset and ignores Windows as a current offer", async () => {
    installPage("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", async (input) => {
      if (String(input).includes("/releases/latest")) return response(latestRelease());
      return response([latestRelease()]);
    });

    await vi.waitFor(() => {
      for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-mac-url]")) {
        expect(link.getAttribute("href")).toBe(macAsset);
      }
    });

    expect(
      [...document.querySelectorAll("[data-latest-version]")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["v0.3.5", "v0.3.5"]);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-mac-url]")) {
      expect(link.getAttribute("href")).toBe(macAsset);
    }
    expect(document.querySelector('[data-cta="win"]')).toBeNull();
    expect(document.querySelector(`[href="${windowsAsset}"]`)).toBeNull();
  });

  it("retains the Mac fallback and reports a failed live check", async () => {
    installPage("Mozilla/5.0 (X11; Linux x86_64)", async (input) => {
      if (String(input).includes("/releases/latest")) return response({}, false);
      return response([], false);
    });

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("[data-fetch-status]")?.hidden).toBe(false);
    });

    expect(
      [...document.querySelectorAll("[data-latest-version]")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["v0.3.5", "v0.3.5"]);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-mac-url]")) {
      expect(link.getAttribute("href")).toBe(releasesPage);
    }
    expect(document.querySelector('[data-cta="win"]')).toBeNull();
  });

  it("renders archive platform links only when that release contains the asset", async () => {
    const archivedWindowsRelease = {
      tag_name: "v0.3.4",
      html_url: windowsArchive,
      published_at: "2026-09-24T00:00:00Z",
      name: "Goop v0.3.4",
      assets: [
        {
          name: "Goop_0.3.4_aarch64.dmg",
          browser_download_url:
            "https://github.com/thrtn70/goop/releases/download/v0.3.4/Goop_0.3.4_aarch64.dmg",
        },
        { name: "Goop_0.3.4_x64_en-US.msi", browser_download_url: windowsAsset },
      ],
    };

    installPage("Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)", async (input) => {
      if (String(input).includes("/releases/latest")) return response(latestRelease());
      return response([latestRelease(), archivedWindowsRelease]);
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".archive__row")).toHaveLength(2);
    });

    const rows = [...document.querySelectorAll<HTMLElement>(".archive__row")];
    const current = rows.find((row) => row.querySelector(".archive__tag")?.textContent === "v0.3.5");
    const historical = rows.find((row) => row.querySelector(".archive__tag")?.textContent === "v0.3.4");

    expect(
      [...(current?.querySelectorAll(".archive__link") ?? [])].map((link) => link.textContent),
    ).toEqual(["macOS", "Notes"]);
    expect(
      [...(historical?.querySelectorAll(".archive__link") ?? [])].map(
        (link) => link.textContent,
      ),
    ).toEqual(["macOS", "Windows", "Notes"]);
    expect(historical?.querySelector<HTMLAnchorElement>('[href$=".msi"]')?.href).toBe(
      windowsAsset,
    );
  });
});
