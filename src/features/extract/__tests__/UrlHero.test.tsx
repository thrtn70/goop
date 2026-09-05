import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** The card's own Start button, whatever it currently reads. */
function cardStartButton() {
  const b = screen
    .getAllByRole("button")
    .find((el) => /^(Start|Starting…|Added to queue)$/.test(el.textContent ?? ""));
  if (!b) throw new Error("card Start button not found");
  return b;
}

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

/** A format the picker offers, so a selection is there to be preserved.
 *  Muxed, so its selector is the bare id and the assertions below can go
 *  on naming `299` — a video-only format would send `299+bestaudio/299`. */
function videoFormat() {
  return {
    format_id: "299",
    ext: "mp4",
    resolution: "1920x1080",
    filesize: null,
    is_audio_only: false,
    selector: "299",
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

  it("announces the failure, since the card's own button no longer does", async () => {
    // `StartButton` used to carry the failure in an sr-only live region.
    // It defers to this banner instead — one announcement, on the element
    // that also carries the retry — so the banner has to be a live region
    // or the failure goes unannounced entirely.
    await probeThenFailStart();
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/couldn't start that download/i);
    expect(banner.textContent).toMatch(/the queue is full/i);
  });

  it("comes back from a retry that fails too", async () => {
    // A retry that fails has to leave the banner retryable, carrying the
    // new reason. Nothing here rethrows any more, so this is no longer
    // standing in for an unhandled rejection — it pins the plain rule
    // that a second failure is reported like the first.
    const user = await probeThenFailStart();
    apiMocks.extract.fromUrl.mockRejectedValue({ code: "queue", message: "still full" });
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));

    const retry = await screen.findByRole("button", { name: /^Try again$/ });
    expect(retry).toHaveProperty("disabled", false);
    expect(screen.getByRole("alert").textContent).toMatch(/still full/i);
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

  it("announces the lookup failure the way it announces a start failure", async () => {
    // The banner beside this one is a live region, so a refused enqueue is
    // spoken. A refused lookup was not: the skeleton reading "Looking up
    // that link..." just vanished and nothing took its place, leaving a
    // screen-reader user waiting on a result that had already come back.
    apiMocks.extract.probe.mockRejectedValue({ code: "unknown", message: "no extractor matched" });
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/x" />
      </MemoryRouter>,
    );

    const box = await screen.findByRole("alert");
    expect(box.textContent).toMatch(/couldn't load that link/i);
    expect(box.textContent).toMatch(/no extractor matched/i);
  });

  it("never puts both failures on screen at once, so one alert is the only alert", async () => {
    // Both surfaces are alerts now, and every query above asks for that
    // role in the singular. What keeps those honest is not luck: a probe
    // retires the start state before it can fail, and a probe that fails
    // has already nulled the card any start belonged to. Pin it, because
    // the day the two can co-exist `getByRole("alert")` stops resolving
    // rather than starts failing usefully, and the report points at seven
    // healthy tests instead of at the change that broke them.
    apiMocks.extract.probe.mockResolvedValueOnce(probeResult({ formats: [videoFormat()] }));
    apiMocks.extract.fromUrl.mockRejectedValue({ code: "queue", message: "the queue is full" });
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter>
        <UrlHero url="https://example.com/a" />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("button", { name: /^Start$/ }));
    await screen.findByText(/couldn't start that download/i);

    apiMocks.extract.probe.mockRejectedValueOnce({
      code: "unknown",
      message: "no extractor matched",
    });
    rerender(
      <MemoryRouter>
        <UrlHero url="https://example.com/b" />
      </MemoryRouter>,
    );

    await screen.findByText(/couldn't load that link/i);
    expect(screen.queryByText(/couldn't start that download/i)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("UrlHero only reports the enqueue the user is still waiting on", () => {
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

  it("does not hand the next card a Start button stuck on busy", async () => {
    // The in-flight flag is cleared by the attempt that set it, and only
    // when it is still the current one. Replacing the card mid-flight
    // takes that clear away: the stale attempt settles, finds the epoch
    // moved on, and declines — leaving the flag true forever and every
    // later card's Start button disabled from the moment it mounts. The
    // transitions that retire a card have to retire its in-flight state
    // with it, the way they already retire its error.
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
    await user.click(screen.getByRole("button", { name: /^Start$/ }));

    rerender(
      <MemoryRouter>
        <UrlHero url="https://example.com/b" />
      </MemoryRouter>,
    );
    await screen.findByText("https://example.com/b");
    await act(async () => settleFirst({ reject: { code: "queue", message: "the queue is full" } }));

    const start = await screen.findByRole("button", { name: /^Start$/ });
    expect(start).toHaveProperty("disabled", false);
  });

  it("a dismissed retry still reports when it fails", async () => {
    // Dismiss takes the message; it must not take the attempt with it.
    // The two are separate events precisely so that a Dismiss landing
    // mid-retry cannot orphan a live enqueue — if it did, the card would
    // re-arm and the next click would queue a duplicate.
    const user = await probeThenFailStart();
    const settle = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByRole("button", { name: /trying/i });

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    // The attempt is still running: the card has not been handed back.
    expect(cardStartButton()).toHaveProperty("disabled", true);

    await act(async () => settle({ reject: { code: "queue", message: "still full" } }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/still full/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Try again$/ })).toHaveProperty("disabled", false);
  });

  it("a dismissed retry that succeeds leaves no banner behind", async () => {
    const user = await probeThenFailStart();
    const settle = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByRole("button", { name: /trying/i });
    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    await act(async () => settle({ resolve: "job-1" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByRole("button", { name: /added to queue/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("a Start click on the card disables the banner's retry", async () => {
    // Both controls start an enqueue and each only knows its own. The card
    // learned about the banner's retry; the banner never learned about the
    // card. So a start from the card leaves "Try again" live, and clicking
    // it queues a second job running the same output template with
    // --continue against the same .part.
    await probeThenFailStart();
    pendingStart();
    fireEvent.click(cardStartButton());
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("button", { name: /trying|try again/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("a retry that lands after the card was replaced does not re-arm a live one", async () => {
    // Every other piece of start state is cleared behind an epoch check.
    // The retry's busy flag is cleared unconditionally once its own start
    // settles, so a stale retry re-arms the retry button of whatever card
    // is on screen now, mid-flight.
    apiMocks.extract.probe.mockImplementation((u: string) =>
      Promise.resolve(probeResult({ url: u, title: u, formats: [videoFormat()] })),
    );
    const user = userEvent.setup();

    apiMocks.extract.fromUrl.mockRejectedValueOnce({ code: "queue", message: "a is full" });
    const { rerender } = render(
      <MemoryRouter>
        <UrlHero url="https://example.com/a" />
      </MemoryRouter>,
    );
    await screen.findByRole("combobox");
    await user.click(screen.getByRole("button", { name: /^Start$/ }));
    await screen.findByText(/couldn't start that download/i);
    const settleA = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByRole("button", { name: /trying/i });

    rerender(
      <MemoryRouter>
        <UrlHero url="https://example.com/b" />
      </MemoryRouter>,
    );
    await screen.findByText("https://example.com/b");

    apiMocks.extract.fromUrl.mockRejectedValueOnce({ code: "queue", message: "b is full" });
    await user.click(screen.getByRole("button", { name: /^Start$/ }));
    await screen.findByText(/couldn't start that download/i);
    const settleB = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByRole("button", { name: /trying/i });

    await act(async () => settleA({ reject: { code: "queue", message: "a is full" } }));
    expect(screen.getByRole("button", { name: /trying/i })).toHaveProperty("disabled", true);

    await act(async () => settleB({ resolve: "job-b" }));
  });

  it("will not enqueue again from the card while a retry is in flight", async () => {
    // The banner's retry calls `handleStart` directly, so `StartButton`'s
    // own in-flight guard cannot see it: the card sits there looking idle
    // while a retry is in the air. Clicking Start then queues a second job
    // running the same output template with --continue against the same
    // .part file. Both controls have to answer to one in-flight signal.
    const user = await probeThenFailStart();
    const settleRetry = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));

    // fireEvent, not userEvent: userEvent refuses to click a disabled
    // control, which would make this pass without proving anything.
    // React declines to deliver the click, so `disabled` IS the guard
    // here — removing that attribute fails nine tests in this suite.
    fireEvent.click(cardStartButton());
    expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2);

    await act(async () => settleRetry({ resolve: "job-1" }));
  });

  it("keeps the failure on screen while its retry is in flight", async () => {
    // Clearing the banner the moment a retry starts takes the only sign of
    // activity off the screen — which is what invites the second click
    // above. The banner stays, and says it is working.
    const user = await probeThenFailStart();
    const settleRetry = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));

    const retry = await screen.findByRole("button", { name: /trying/i });
    expect(retry).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert")).toBeTruthy();

    await act(async () => settleRetry({ resolve: "job-1" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
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

describe("UrlHero keeps one enqueue per card", () => {
  // Both propositions are pinned inside ProbeCard's own tests, which reach
  // into the button's internal phase. They are restated here through the
  // rendered pair so they keep holding whatever ProbeCard's shape becomes.
  //
  // Each drives the start from the *banner's* retry, not from the card.
  // That is deliberate: a start begun on the card is already guarded by
  // that button's own phase, so a test that clicks the card twice proves
  // nothing about whether the card can see an enqueue begun elsewhere —
  // which is the thing that has broken here repeatedly.

  it("changing the format mid-flight does not re-arm the card", async () => {
    // The format select is not disabled during a start, so nudging it is
    // the easy way to ask the card for a second job on the same .part.
    apiMocks.extract.probe.mockResolvedValue(
      probeResult({
        formats: [
          { ...videoFormat(), format_id: "299" },
          { ...videoFormat(), format_id: "18", resolution: "640x360" },
        ],
      }),
    );
    apiMocks.extract.fromUrl.mockRejectedValueOnce({ code: "queue", message: "full" });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/x" />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("button", { name: /^Start$/ }));
    await screen.findByText(/couldn't start that download/i);

    const settle = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));

    await user.selectOptions(screen.getByRole("combobox"), "299");
    fireEvent.click(cardStartButton());
    expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2);

    await act(async () => settle({ resolve: "job-1" }));
  });

  it("a direct-file card refuses a second start while one is in flight", async () => {
    // The single-action cards are threaded separately from the media card
    // and have been missed once already.
    apiMocks.extract.probe.mockResolvedValue(
      probeResult({
        direct: {
          content_type: "application/zip",
          size_bytes: 10n,
          filename: "a.zip",
          resumable: true,
        },
      }),
    );
    apiMocks.extract.fromUrl.mockRejectedValueOnce({ code: "queue", message: "full" });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <UrlHero url="https://example.com/a.zip" />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole("button", { name: /^Download$/ }));
    await screen.findByText(/couldn't start that download/i);

    const settle = pendingStart();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: /^Download$|^Starting…$/ }));
    expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(2);

    await act(async () => settle({ resolve: "job-1" }));
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

it("restores a pending start across route remount and accepts its late acknowledgement once", async () => {
  const probe = probeResult();
  apiMocks.extract.probe.mockResolvedValue(probe);
  const settle = pendingStart();
  const first = render(<MemoryRouter><UrlHero url={probe.url} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /^Start$/ }));
  await waitFor(() => expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(1));
  first.unmount();
  render(<MemoryRouter><UrlHero /></MemoryRouter>);
  await waitFor(() => expect(apiMocks.extract.probe).toHaveBeenCalledTimes(2));
  expect((await screen.findByRole("button", { name: "Starting…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => settle({ resolve: "late-job" }));
  expect((await screen.findByRole("button", { name: "Added to queue" }) as HTMLButtonElement).disabled).toBe(true);
  expect(apiMocks.extract.fromUrl).toHaveBeenCalledTimes(1);
});

it("restores a selected format after re-probing and blocks a disappeared selection", async () => {
  const probe = probeResult({ formats: [videoFormat()] });
  apiMocks.extract.probe.mockResolvedValue(probe);
  const first = render(<MemoryRouter><UrlHero url={probe.url} /></MemoryRouter>);
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "299" } });
  first.unmount();
  const second = render(<MemoryRouter><UrlHero /></MemoryRouter>);
  expect((await screen.findByRole("combobox") as HTMLSelectElement).value).toBe("299");
  second.unmount();
  apiMocks.extract.probe.mockResolvedValue(probeResult());
  render(<MemoryRouter><UrlHero /></MemoryRouter>);
  expect(await screen.findByRole("option", { name: /Previous format unavailable/ })).toBeTruthy();
  expect((await screen.findByRole("button", { name: /^Start$/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(apiMocks.extract.fromUrl).not.toHaveBeenCalled();
});
