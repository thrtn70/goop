import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

/** A format the picker offers, so a selection is there to be preserved. */
function videoFormat() {
  return {
    format_id: "299",
    ext: "mp4",
    resolution: "1920x1080",
    filesize: null,
    is_audio_only: false,
  };
}

/**
 * Probe the URL, pick `299`, then click Start with the enqueue failing.
 * Returns once the enqueue banner is on screen, so the assertions built on
 * this can't pass by looking for text that was never rendered.
 */
async function probeThenFailStart(err: unknown = { code: "queue", message: "the queue is full" }) {
  apiMocks.extract.probe.mockResolvedValue(probeResult({ formats: [videoFormat()] }));
  apiMocks.extract.fromUrl.mockRejectedValue(err);
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <UrlHero url="https://example.com/x" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(apiMocks.extract.probe).toHaveBeenCalled());
  await user.selectOptions(await screen.findByRole("combobox"), "299");
  await user.click(await screen.findByRole("button", { name: /^Start$/ }));
  await screen.findByText(/couldn't start that download/i);
  return user;
}

describe("UrlHero tells an enqueue failure apart from a probe failure", () => {
  it("names the download, not the link, when the enqueue fails", async () => {
    // The link loaded fine — the card built from it is on screen. Blaming
    // the lookup sends the user back to re-paste a URL that already works.
    await probeThenFailStart();
    expect(screen.queryByText(/couldn't load that link/i)).toBeNull();
  });

  it("surfaces the backend's reason for refusing the job", async () => {
    await probeThenFailStart({ code: "queue", message: "the queue is full" });
    expect(screen.getByText(/the queue is full/i)).toBeTruthy();
  });

  it("retries the enqueue with the format already chosen, without re-probing", async () => {
    // Re-probing nulls the probe, which unmounts the card and discards the
    // selection. The format is already known; only the enqueue failed.
    const user = await probeThenFailStart();
    apiMocks.extract.fromUrl.mockResolvedValue("job-1");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));
    expect(apiMocks.extract.probe).toHaveBeenCalledTimes(1);
    expect(apiMocks.extract.fromUrl.mock.calls[1]?.[0]?.format).toBe("299");
  });

  it("clears the failure once the retry gets the job queued", async () => {
    const user = await probeThenFailStart();
    apiMocks.extract.fromUrl.mockResolvedValue("job-1");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() =>
      expect(screen.queryByText(/couldn't start that download/i)).toBeNull(),
    );
  });

  it("dismisses the failure without disturbing the card", async () => {
    const user = await probeThenFailStart();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/couldn't start that download/i)).toBeNull();
    expect(screen.getByRole("combobox")).toHaveProperty("value", "299");
  });
});

describe("UrlHero still reports a probe failure as a probe failure", () => {
  it("blames the link and re-probes on Try again", async () => {
    // The other half of the split: giving the enqueue its own banner must
    // not cost the probe banner its copy or its re-probe retry.
    apiMocks.extract.probe.mockRejectedValue({ code: "unknown", message: "no extractor matched" });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/x" />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/couldn't load that link/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(apiMocks.extract.probe).toHaveBeenCalledTimes(2));
    expect(apiMocks.extract.fromUrl).not.toHaveBeenCalled();
  });
});

describe("UrlHero only reports the enqueue the user is still waiting on", () => {
  /** A `fromUrl` call that hangs until the test settles it by hand. */
  function pendingStart() {
    let settle!: (outcome: { reject: unknown } | { resolve: string }) => void;
    apiMocks.extract.fromUrl.mockReturnValueOnce(
      new Promise<string>((resolve, reject) => {
        settle = (o) => ("reject" in o ? reject(o.reject) : resolve(o.resolve));
      }),
    );
    return (outcome: { reject: unknown } | { resolve: string }) => settle(outcome);
  }

  it("drops a failure that lands after the user moved on to another link", async () => {
    // `UrlHero` is re-rendered with a new `url`, never remounted, so an
    // enqueue still in flight outlives the card it belongs to. Reporting it
    // under the new card would offer a Try again that replays the old
    // format against the new URL.
    apiMocks.extract.probe.mockImplementation((u: string) =>
      Promise.resolve(probeResult({ url: u, title: u, formats: [videoFormat()] })),
    );
    const settleFirst = pendingStart();
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter>
        <UrlHero url="https://example.com/a" />
      </MemoryRouter>,
    );
    await screen.findByRole("combobox");
    await user.selectOptions(screen.getByRole("combobox"), "299");
    await user.click(screen.getByRole("button", { name: /^Start$/ }));

    rerender(
      <MemoryRouter>
        <UrlHero url="https://example.com/b" />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(apiMocks.extract.probe).toHaveBeenCalledWith("https://example.com/b"),
    );
    await screen.findByText("https://example.com/b");

    await act(async () => settleFirst({ reject: { code: "queue", message: "the queue is full" } }));
    expect(screen.queryByText(/couldn't start that download/i)).toBeNull();
  });

  it("drops a slow failure once a later attempt has already queued the job", async () => {
    // Two overlapping enqueues resolving out of order: the stale rejection
    // would otherwise claim a job that is sitting in the queue right now.
    apiMocks.extract.probe.mockResolvedValue(probeResult({ formats: [videoFormat()] }));
    const settleFirst = pendingStart();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/x" />
      </MemoryRouter>,
    );
    const start = await screen.findByRole("button", { name: /^Start$/ });
    await user.click(start);
    apiMocks.extract.fromUrl.mockResolvedValue("job-2");
    await user.click(start);
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));

    await act(async () => settleFirst({ reject: { code: "queue", message: "the queue is full" } }));
    expect(screen.queryByText(/couldn't start that download/i)).toBeNull();
  });
});
