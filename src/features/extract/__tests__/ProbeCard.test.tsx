import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProbeCard from "@/features/extract/ProbeCard";
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
    render(<ProbeCard probe={baseProbe({ formats })} onStart={vi.fn()} />);
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
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /audio only/i })).toBeTruthy();
  });

  it("stays disabled when the format changes while the enqueue is in flight", async () => {
    // The select is not disabled during the call, so nudging it used to
    // fire the reset and re-arm Start while the first request was still
    // pending — the same double enqueue, reached a different way.
    let release!: () => void;
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <ProbeCard
        probe={baseProbe({
          formats: [
            fmt({ format_id: "299", resolution: "1920x1080" }),
            fmt({ format_id: "18", resolution: "640x360" }),
          ],
        })}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Start$/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "299" } });

    const btn = screen.getByRole("button", { name: /starting/i });
    expect(btn).toHaveProperty("disabled", true);
    fireEvent.click(btn);
    expect(onStart).toHaveBeenCalledTimes(1);

    // Once it settles, the now-different selection re-arms the button.
    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Start$/ })).toHaveProperty("disabled", false),
    );
  });

  it("hands the whole format back on start, so the caller gets its selector", () => {
    const onStart = vi.fn();
    const video = fmt({
      format_id: "299",
      resolution: "1920x1080",
      selector: "299+bestaudio/299",
    });
    render(<ProbeCard probe={baseProbe({ formats: [video] })} onStart={onStart} />);
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
      <ProbeCard probe={baseProbe(extra as Partial<UrlProbe>)} onStart={onStart} busy />,
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
    // The guard keys off what would be downloaded, and every freshly
    // probed video starts on the same default selection. Keying off the
    // selection alone made that default collide across videos, so the
    // second video's Start button opened already reporting the first
    // one's enqueue — for a job the user never started. It only looked
    // fine because `UrlHero` happens to null its probe between lookups,
    // unmounting this subtree; nothing stated that or pinned it.
    const onStart = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ProbeCard
        probe={baseProbe({ url: "https://example.com/a", formats: [fmt("18")] })}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Start$/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /added to queue/i })).toBeTruthy(),
    );

    rerender(
      <ProbeCard
        probe={baseProbe({ url: "https://example.com/b", formats: [fmt("18")] })}
        onStart={onStart}
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
    const onStart = vi.fn().mockRejectedValue(new Error("queue is closed"));
    render(<ProbeCard probe={baseProbe({ formats: [fmt("18")] })} onStart={onStart} />);

    fireEvent.click(screen.getByRole("button", { name: /^Start$/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Start$/ })).toHaveProperty("disabled", false),
    );
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
