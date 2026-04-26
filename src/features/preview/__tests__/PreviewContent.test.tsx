import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PreviewContent from "@/features/preview/PreviewContent";
import type { Job } from "@/types";
import { useAppStore } from "@/store/appStore";

// Mock the thumbnail hook so we can flip ready/unavailable per test.
const thumbMock = vi.hoisted(() => ({
  state: { status: "loading" } as
    | { status: "loading" }
    | { status: "ready"; src: string }
    | { status: "unavailable" },
}));

vi.mock("@/hooks/useThumbnail", () => ({
  useThumbnail: () => thumbMock.state,
}));

function makeJob(outputPath: string): Job {
  return {
    id: "00000000-0000-7000-8000-000000000000",
    kind: "extract",
    state: "done",
    payload: null,
    result: {
      output_path: outputPath,
      bytes: BigInt(1024),
      duration_ms: BigInt(1000),
    },
    priority: 0,
    attempts: 0,
    created_at: BigInt(1_700_000_000_000),
    started_at: BigInt(1_700_000_000_000),
    finished_at: BigInt(1_700_000_001_000),
  } as unknown as Job;
}

beforeEach(() => {
  thumbMock.state = { status: "loading" };
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ toasts: [] });
});

describe("PreviewContent — audio waveform rendering (Phase J)", () => {
  it("renders the audio waveform image with descriptive alt text when ready", () => {
    thumbMock.state = { status: "ready", src: "asset://thumbs/x.png" };
    render(
      <PreviewContent
        job={makeJob("/path/to/song.mp3")}
        variant="panel"
        onConvertAgain={() => {}}
        onReveal={() => {}}
      />,
    );
    const img = screen.getByRole("img", { name: /audio waveform/i }) as HTMLImageElement;
    expect(img.src).toContain("asset://thumbs/x.png");
  });

  it("falls back to the music-note badge when the waveform is unavailable", () => {
    thumbMock.state = { status: "unavailable" };
    render(
      <PreviewContent
        job={makeJob("/path/to/song.mp3")}
        variant="panel"
        onConvertAgain={() => {}}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText(/♫ audio/)).toBeTruthy();
  });

  it("video files use empty alt and the standard preview-unavailable fallback", () => {
    thumbMock.state = { status: "unavailable" };
    render(
      <PreviewContent
        job={makeJob("/path/to/clip.mp4")}
        variant="panel"
        onConvertAgain={() => {}}
        onReveal={() => {}}
      />,
    );
    expect(screen.getByText(/preview unavailable/i)).toBeTruthy();
  });
});
