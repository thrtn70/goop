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

describe("UrlHero guards against a double enqueue", () => {
  it("only enqueues once when Start is clicked twice", async () => {
    // There is no dedupe anywhere in the queue, and both jobs would run
    // the same output template with --continue against the same .part.
    // With the queue sidebar collapsed the only feedback is a count in a
    // 40px rail, so a second click is the natural reaction.
    apiMocks.extract.probe.mockResolvedValue(probeResult({}));
    let release!: () => void;
    apiMocks.extract.fromUrl.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("job-1");
        }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiMocks.extract.probe).toHaveBeenCalled());
    const start = await screen.findByRole("button", { name: /^Start$/ });
    await user.click(start);
    await user.click(start);
    expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(1);
    release();
  });

  it("stays disabled after the enqueue succeeds", async () => {
    // Re-clicking a second later is the same collision as a double-click,
    // so the button reports what happened instead of inviting a repeat.
    await probeThenStart(probeResult({}));
    const start = await screen.findByRole("button", { name: /added to queue/i });
    expect(start).toHaveProperty("disabled", true);
  });
});

describe("UrlHero sends the format's download selector", () => {
  function videoOnly1080p() {
    return {
      format_id: "299",
      ext: "mp4",
      resolution: "1920x1080",
      filesize: null,
      is_audio_only: false,
      // The backend composed this because 299 carries no audio track.
      selector: "299+bestaudio/299",
    };
  }

  it("sends the selector, not the bare format id", async () => {
    // Sending the bare id is how the picker used to hand back silent
    // files: yt-dlp downloads exactly that stream and never merges audio.
    apiMocks.extract.probe.mockResolvedValue(probeResult({ formats: [videoOnly1080p()] }));
    apiMocks.extract.fromUrl.mockResolvedValue("job-1");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/x" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(apiMocks.extract.probe).toHaveBeenCalled());
    await user.selectOptions(await screen.findByRole("combobox"), "299");
    await user.click(await screen.findByRole("button", { name: /^Start$/ }));
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalled());
    expect(sentRequest()?.format).toBe("299+bestaudio/299");
  });

  it("sends no format at all when the user leaves it on Best (auto)", async () => {
    // yt-dlp's own default already merges, so the absent case must stay
    // absent rather than being coerced into a selector.
    await probeThenStart(probeResult({ formats: [videoOnly1080p()] }));
    expect(sentRequest()?.format).toBeNull();
  });
});
