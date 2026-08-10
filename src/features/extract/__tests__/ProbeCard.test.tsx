import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProbeCard from "@/features/extract/ProbeCard";
import type { UrlProbe } from "@/types";

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
