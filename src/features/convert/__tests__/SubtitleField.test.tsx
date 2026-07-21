import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SubtitleField, { subtitleSupport } from "../SubtitleField";
import type { SubtitleOptions } from "@/types";

const { mockOpen, mockEnqueueToast } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockEnqueueToast: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  save: vi.fn(),
}));

vi.mock("@/store/appStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ enqueueToast: mockEnqueueToast }),
}));

const ALL = { soft: true, burn: true };

describe("subtitleSupport", () => {
  it("mirrors the backend support matrix", () => {
    for (const t of ["mp4", "mov", "mkv", "webm"] as const) {
      expect(subtitleSupport(t)).toEqual({ soft: true, burn: true });
    }
    // AVI has no usable text-subtitle track, but can still be burned into.
    expect(subtitleSupport("avi")).toEqual({ soft: false, burn: true });
    for (const t of ["gif", "mp3", "flac", "png", "jpeg"] as const) {
      expect(subtitleSupport(t)).toEqual({ soft: false, burn: false });
    }
  });
});

describe("SubtitleField", () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it("picks a file and defaults to a soft track", async () => {
    mockOpen.mockResolvedValue("/tmp/movie.srt");
    const onChange = vi.fn();
    render(<SubtitleField subtitle={null} onChange={onChange} support={ALL} />);

    await userEvent.click(screen.getByRole("button", { name: /add file/i }));

    expect(onChange).toHaveBeenCalledWith({ source_path: "/tmp/movie.srt", mode: "soft" });
    expect(mockOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }],
      }),
    );
  });

  it("falls back to burn-in when the container can't hold a track", async () => {
    mockOpen.mockResolvedValue("/tmp/movie.srt");
    const onChange = vi.fn();
    render(
      <SubtitleField subtitle={null} onChange={onChange} support={{ soft: false, burn: true }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /add file/i }));

    expect(onChange).toHaveBeenCalledWith({ source_path: "/tmp/movie.srt", mode: "burn_in" });
  });

  it("does nothing when the picker is dismissed", async () => {
    mockOpen.mockResolvedValue(null);
    const onChange = vi.fn();
    render(<SubtitleField subtitle={null} onChange={onChange} support={ALL} />);

    await userEvent.click(screen.getByRole("button", { name: /add file/i }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("surfaces a picker failure instead of failing silently", async () => {
    mockOpen.mockRejectedValue(new Error("dialog unavailable"));
    const onChange = vi.fn();
    render(<SubtitleField subtitle={null} onChange={onChange} support={ALL} />);

    await userEvent.click(screen.getByRole("button", { name: /add file/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(mockEnqueueToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error" }),
    );
  });

  it("shows the filename and lets the mode change", async () => {
    const subtitle: SubtitleOptions = { source_path: "/tmp/subs/movie.srt", mode: "soft" };
    const onChange = vi.fn();
    render(<SubtitleField subtitle={subtitle} onChange={onChange} support={ALL} />);

    expect(screen.getByText("movie.srt")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /burn in/i }));

    expect(onChange).toHaveBeenCalledWith({ source_path: "/tmp/subs/movie.srt", mode: "burn_in" });
  });

  it("disables the soft track button when the container can't hold one", () => {
    const subtitle: SubtitleOptions = { source_path: "/tmp/movie.srt", mode: "burn_in" };
    render(
      <SubtitleField
        subtitle={subtitle}
        onChange={vi.fn()}
        support={{ soft: false, burn: true }}
      />,
    );

    expect(screen.getByRole("button", { name: /soft track/i })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /burn in/i })).toHaveProperty("disabled", false);
  });

  it("clears the subtitle when removed", async () => {
    const onChange = vi.fn();
    render(
      <SubtitleField
        subtitle={{ source_path: "/tmp/movie.srt", mode: "soft" }}
        onChange={onChange}
        support={ALL}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /remove subtitle/i }));

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
