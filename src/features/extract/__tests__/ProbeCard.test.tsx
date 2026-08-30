import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProbeCard from "@/features/extract/ProbeCard";
import { IDLE_START, type StartOptions, type StartState } from "@/features/extract/startState";
import type { FormatOption, UrlProbe } from "@/types";

afterEach(() => {
  cleanup();
});

function baseProbe(overrides: Partial<UrlProbe>): UrlProbe {
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

const NO_OPTS: StartOptions = { format: null, audioOnly: false };

/** A start in flight for `url`, whatever was selected. */
function startingFor(url: string): StartState {
  return { kind: "starting", id: 1, url, opts: NO_OPTS, retryingAfter: null };
}

/** A start that settled for `url` and exactly these options. */
function startedFor(url: string, opts: StartOptions = NO_OPTS): StartState {
  return { kind: "started", id: 1, url, opts };
}

describe("ProbeCard debrid rendering", () => {
  it("renders the TorBox card for a magnet probe and starts on click", () => {
    const onStart = vi.fn();
    render(
      <ProbeCard
        probe={baseProbe({
          url: "magnet:?xt=urn:btih:abc&dn=My+Torrent",
          title: "My Torrent",
          debrid: { magnet: true },
        })}
        start={IDLE_START}
        onStart={onStart}
      />,
    );
    expect(screen.getByText("My Torrent")).toBeTruthy();
    expect(screen.getByText(/via TorBox/i)).toBeTruthy();
    expect(screen.getByText(/magnet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(onStart).toHaveBeenCalledWith({ format: null, audioOnly: false });
  });

  it("renders the hoster variant without the magnet label", () => {
    render(
      <ProbeCard
        probe={baseProbe({
          url: "https://rapidgator.net/file/abc",
          title: "https://rapidgator.net/file/abc",
          debrid: { magnet: false },
        })}
        start={IDLE_START}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByText(/via TorBox/i)).toBeTruthy();
    expect(screen.queryByText(/magnet link/i)).toBeNull();
  });

  it("prefers the direct card when both hints are absent-ish (direct set)", () => {
    render(
      <ProbeCard
        probe={baseProbe({
          title: "file.bin",
          direct: {
            filename: "file.bin",
            size_bytes: 1024n as unknown as bigint,
            content_type: "application/octet-stream",
            resumable: true,
          },
        })}
        start={IDLE_START}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByText(/Direct download/i)).toBeTruthy();
  });
});

describe("ProbeCard format picker", () => {
  function fmt(overrides: Partial<FormatOption> & { format_id: string }): FormatOption {
    return {
      ext: "mp4",
      resolution: null,
      filesize: null,
      is_audio_only: false,
      selector: overrides.format_id,
      ...overrides,
    };
  }

  it("offers every format the probe returned", () => {
    // The list used to be truncated to the first 20 entries. Because the
    // backend hands them back best-first, a cap silently amputates the
    // high-quality end — the reason 1080p and 4K were unreachable.
    const formats = Array.from({ length: 25 }, (_, i) =>
      fmt({ format_id: `f${i}`, resolution: `${i}p` }),
    );
    render(<ProbeCard probe={baseProbe({ formats })} start={IDLE_START} onStart={vi.fn()} />);
    // 25 formats + the "Best (auto)" entry.
    expect(screen.getAllByRole("option")).toHaveLength(26);
    expect(screen.getByRole("option", { name: /24p/ })).toBeTruthy();
  });

  it("renders formats in the order given, best first", () => {
    render(
      <ProbeCard
        probe={baseProbe({
          formats: [
            fmt({ format_id: "best", resolution: "1920x1080" }),
            fmt({ format_id: "worst", resolution: "256x144" }),
          ],
        })}
        start={IDLE_START}
        onStart={vi.fn()}
      />,
    );
    const labels = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(labels[0]).toMatch(/Best \(auto\)/);
    expect(labels[1]).toMatch(/1920x1080/);
    expect(labels[2]).toMatch(/256x144/);
  });

  it("marks audio-only entries so they aren't mistaken for video", () => {
    // Nothing in the label distinguished an audio-only stream from a
    // video one, so `is_audio_only` shipped with no consumer at all.
    render(
      <ProbeCard
        probe={baseProbe({
          formats: [fmt({ format_id: "140", ext: "m4a", is_audio_only: true })],
        })}
        start={IDLE_START}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /audio only/i })).toBeTruthy();
  });

  it("stays disabled when the format changes while the enqueue is in flight", async () => {
    // The select is not disabled during the call, so nudging it is the
    // easy way to ask for a second job on the same .part. The card is busy
    // for the whole URL, not for one selection, which is why the phase
    // lookup deliberately ignores the options while a start is running.
    const onStart = vi.fn();
    render(
      <ProbeCard
        probe={baseProbe({
          formats: [
            fmt({ format_id: "299", resolution: "1920x1080" }),
            fmt({ format_id: "18", resolution: "640x360" }),
          ],
        })}
        start={startingFor("https://example.com/x")}
        onStart={onStart}
      />,
    );
    const btn = screen.getByRole("button", { name: /starting/i });
    expect(btn).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "299" } });
    fireEvent.click(screen.getByRole("button", { name: /starting/i }));
    expect(onStart).not.toHaveBeenCalled();

    // Once it settles, the now-different selection re-arms the button.
    cleanup();
    render(
      <ProbeCard
        probe={baseProbe({ formats: [fmt({ format_id: "299" })] })}
        start={startedFor("https://example.com/x", { format: null, audioOnly: false })}
        onStart={onStart}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "299" } });
    expect(screen.getByRole("button", { name: /^Start$/ })).toHaveProperty("disabled", false);
  });

  it("hands the whole format back on start, so the caller gets its selector", () => {
    const onStart = vi.fn();
    const video = fmt({
      format_id: "299",
      resolution: "1920x1080",
      selector: "299+bestaudio/299",
    });
    render(
      <ProbeCard probe={baseProbe({ formats: [video] })} start={IDLE_START} onStart={onStart} />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "299" } });
    fireEvent.click(screen.getByRole("button", { name: /^Start$/ }));
    expect(onStart).toHaveBeenCalledWith({ format: video, audioOnly: false });
  });
});

describe("ProbeCard honours the card-wide busy signal", () => {
  // The hero's failure banner can start an enqueue without going through
  // any of these buttons, so `busy` is how they learn about it. Every
  // variant has to take it — the two single-action cards are threaded
  // separately from the media card and were the easy ones to miss.
  it.each([
    ["direct", { direct: { content_type: "application/zip", size_bytes: 1, filename: "a.zip" } }],
    ["debrid", { debrid: { magnet: true } }],
  ])("refuses a start on the %s card while one is already in flight", async (_name, extra) => {
    const onStart = vi.fn();
    render(
      <ProbeCard
        probe={baseProbe(extra as Partial<UrlProbe>)}
        start={startingFor("https://example.com/x")}
        onStart={onStart}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveProperty("disabled", true);
    fireEvent.click(btn);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("ProbeCard start guard", () => {
  function fmt(format_id: string): FormatOption {
    return {
      format_id,
      ext: "mp4",
      resolution: "640x360",
      filesize: null,
      is_audio_only: false,
      selector: format_id,
    };
  }

  it("does not carry one video's enqueue over to the next probe", async () => {
    // Every freshly probed video opens on the same default selection, so a
    // key made of the selection alone collides across videos and hands the
    // next one a button already reporting this one's enqueue. The URL is
    // part of what was started, so it is part of what re-arms.
    const started = startedFor("https://example.com/a");
    const { rerender } = render(
      <ProbeCard
        probe={baseProbe({ url: "https://example.com/a", formats: [fmt("18")] })}
        start={started}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /added to queue/i })).toHaveProperty(
      "disabled",
      true,
    );

    rerender(
      <ProbeCard
        probe={baseProbe({ url: "https://example.com/b", formats: [fmt("18")] })}
        start={started}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Start$/ })).toHaveProperty("disabled", false);
  });

  it("returns to idle on a failed enqueue, and leaves the announcing to the hero", async () => {
    // The failure is announced by `UrlHero`'s `role="alert"` banner, which
    // also carries the retry. Repeating the words in this live region
    // would announce the same failure twice and put one string on two
    // elements. What this component still owes is the retry: the button
    // has to come back, or a failed start strands the card.
    render(
      <ProbeCard
        probe={baseProbe({ formats: [fmt("18")] })}
        start={{
          kind: "failed",
          id: 1,
          url: "https://example.com/x",
          opts: { format: null, audioOnly: false },
          message: "the queue is full",
        }}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Start$/ })).toHaveProperty("disabled", false);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
