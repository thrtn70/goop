import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import UrlHero from "@/features/extract/UrlHero";
import { useAppStore } from "@/store/appStore";
import type { UrlProbe } from "@/types";

const apiMocks = vi.hoisted(() => ({
  extract: { probe: vi.fn(), fromUrl: vi.fn() },
  queue: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/ipc/commands", () => ({ api: apiMocks }));

function probeResult(overrides: Partial<UrlProbe> = {}): UrlProbe {
  return {
    url: "https://example.com/x",
    title: "Example",
    uploader: null,
    duration_secs: null,
    thumbnail_url: null,
    formats: [],
    direct: null,
    debrid: null,
    extractor: null,
    ...overrides,
  };
}

/** The single `ExtractRequest` the component sent. */
function sentRequest() {
  return apiMocks.extract.fromUrl.mock.calls[0]?.[0];
}

async function probeThenStart(probe: UrlProbe) {
  apiMocks.extract.probe.mockResolvedValue(probe);
  apiMocks.extract.fromUrl.mockResolvedValue("job-1");
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <UrlHero url={probe.url} />
    </MemoryRouter>,
  );
  // The component probes on mount when handed a URL.
  await waitFor(() => expect(apiMocks.extract.probe).toHaveBeenCalled());
  await user.click(await screen.findByRole("button", { name: /^Start$/ }));
  await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalled());
}

beforeEach(() => {
  apiMocks.extract.probe.mockReset();
  apiMocks.extract.fromUrl.mockReset();
  useAppStore.setState({ jobs: [], toasts: [] });
});

afterEach(cleanup);

describe("UrlHero carries the probe's extractor verdict", () => {
  it("passes the extractor that answered the probe into the download", async () => {
    // The whole chain is pointless if the UI drops the verdict on the
    // floor: the worker would re-guess from the URL's shape and spawn the
    // wrong extractor first on everything the classifier gets wrong.
    await probeThenStart(probeResult({ extractor: "gallery_dl" }));
    expect(sentRequest()?.extractor_hint).toBe("gallery_dl");
  });

  it("sends no hint when the probe named no extractor", async () => {
    // Direct and debrid probes run no extractor at all. A fabricated hint
    // would be a guess dressed up as a verdict.
    await probeThenStart(probeResult({ extractor: null }));
    expect(sentRequest()?.extractor_hint).toBeNull();
  });
});
