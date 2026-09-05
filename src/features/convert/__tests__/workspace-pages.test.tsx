import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ConvertPage from "@/pages/ConvertPage";
import CompressPage from "@/pages/CompressPage";
import { clearWorkspaceDrafts } from "@/store/workspaceDrafts";
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  enqueue: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/ipc/commands", () => ({
  api: {
    convert: { inspect: mocks.inspect, fromFile: mocks.enqueue },
    queue: { list: vi.fn().mockResolvedValue([]) },
    pdf: { probe: vi.fn().mockResolvedValue({ pages: 3 }) },
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
  save: mocks.save,
}));
vi.mock("@/features/convert/DropZone", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/features/presets/PresetChips", () => ({ default: () => null }));
vi.mock("@/features/presets/PresetSaveDialog", () => ({ default: () => null }));
const inspection = {
  probe: {
    source_kind: "video",
    video_codec: "h264",
    audio_codec: "aac",
    has_video: true,
    has_audio: true,
    duration_ms: 1000,
    file_size: 100,
    width: 2,
    height: 2,
    audio_codecs: ["aac"],
    subtitle_codecs: [],
  },
  capabilities: {
    targets: ["mp4", "mkv", "gif"].map((target) => ({
      target,
      available: true,
      reason: null,
      metadata_warning: null,
    })),
    compression: {
      quality: true,
      target_size: true,
      lossless: false,
      reason: null,
    },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue(inspection);
  mocks.open.mockResolvedValue(["/a.mp4"]);
  mocks.save.mockResolvedValue("/out.mp4");
  mocks.enqueue.mockResolvedValue("job");
});
afterEach(cleanup);
const page = (tool: "convert" | "compress") => (
  <MemoryRouter>
    {tool === "convert" ? <ConvertPage /> : <CompressPage />}
  </MemoryRouter>
);
for (const tool of ["convert", "compress"] as const) {
  const label = tool === "convert" ? "Convert" : "Compress";
  it(`${tool} snapshots a dialog request, retains later edits/new files and reconciles once after remount`, async () => {
    let choose!: (path: string) => void;
    mocks.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const first = render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 1 file",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: label + " 1 file" }));
    if (tool === "convert")
      fireEvent.click(screen.getByRole("button", { name: "MKV" }));
    else
      fireEvent.change(screen.getByRole("slider"), { target: { value: "30" } });
    mocks.open.mockResolvedValue(["/b.mp4"]);
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await screen.findByRole("button", { name: "Select b.mp4" });
    first.unmount();
    render(page(tool));
    expect(
      (
        screen.getByRole("button", {
          name: "Enqueuing...",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => choose("/out.mp4"));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      input_path: "/a.mp4",
      target: "mp4",
    });
    if (tool === "compress")
      expect(mocks.enqueue.mock.calls[0][0].compress_mode.value).toBe(75);
    expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select b.mp4" })).toBeTruthy();
    expect(screen.getByText(/Earlier settings queued/)).toBeTruthy();
  });
  it(`${tool} keeps a recreated source through an old IPC settlement and disables a duplicate Start`, async () => {
    let settle!: (job: string) => void;
    mocks.enqueue.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const first = render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 1 file",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: label + " 1 file" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Remove a.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await screen.findByRole("button", { name: "Select a.mp4" });
    first.unmount();
    render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Enqueuing..." }));
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    await act(async () => settle("job"));
    expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 1 file",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
  it(`${tool} removes only successful batch entries so retry does not duplicate them`, async () => {
    mocks.open.mockResolvedValue(["/a.mp4", "/b.mp4"]);
    mocks.enqueue.mockImplementation((request: { input_path: string }) =>
      request.input_path === "/a.mp4"
        ? Promise.resolve("a")
        : Promise.reject(new Error("disk full")),
    );
    render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 2 files",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: label + " 2 files" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Select a.mp4" })).toBeNull();
    expect(screen.getByRole("button", { name: "Select b.mp4" })).toBeTruthy();
    mocks.enqueue.mockResolvedValue("b");
    fireEvent.click(screen.getByRole("button", { name: label + " 1 file" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(3));
    expect(mocks.enqueue.mock.calls.map((c) => c[0].input_path)).toEqual([
      "/a.mp4",
      "/b.mp4",
      "/b.mp4",
    ]);
  });
  it(`${tool} requires fresh inspection on remount even with saved options`, async () => {
    const first = render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 1 file",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    first.unmount();
    let reject!: (error: Error) => void;
    mocks.inspect.mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    render(page(tool));
    expect(
      (
        screen.getByRole("button", {
          name: label + " 1 file",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(2));
    await act(async () => reject(new Error("source missing")));
    expect(
      (
        screen.getByRole("button", {
          name: label + " 1 file",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 1 file",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
  it(`${tool} clears explicit reset authority while preserving its pending latch`, async () => {
    let choose!: (path: string | null) => void;
    mocks.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: label + " 1 file",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: label + " 1 file" }));
    act(() => clearWorkspaceDrafts(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    await screen.findByRole("button", { name: "Select a.mp4" });
    expect(
      (
        screen.getByRole("button", {
          name: "Enqueuing...",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => choose(null));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
  });
}

it("bounds active inspection across navigation and both tools, skipping retired queued sources", async () => {
  let settleA!: (value: typeof inspection) => void;
  let active = 0,
    maximum = 0;
  mocks.inspect.mockImplementation((path: string) => {
    active++;
    maximum = Math.max(maximum, active);
    const result =
      path === "/a.mp4" && mocks.inspect.mock.calls.length === 1
        ? new Promise<typeof inspection>((resolve) => {
            settleA = resolve;
          })
        : Promise.resolve(inspection);
    return result.finally(() => {
      active--;
    });
  });
  mocks.open.mockResolvedValue(["/a.mp4", "/b.mp4"]);
  const first = render(page("convert"));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(1));
  first.unmount();
  mocks.open.mockResolvedValue(["/c.mp4"]);
  const second = render(page("compress"));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await screen.findByRole("button", { name: "Select c.mp4" });
  expect(mocks.inspect).toHaveBeenCalledTimes(1);
  second.unmount();
  render(page("convert"));
  expect(mocks.inspect).toHaveBeenCalledTimes(1);
  await act(async () =>
    settleA({
      ...inspection,
      probe: { ...inspection.probe, video_codec: "STALE" },
    }),
  );
  await waitFor(() => expect(mocks.inspect).toHaveBeenCalledTimes(3));
  expect(mocks.inspect.mock.calls.map((c) => c[0])).toEqual([
    "/a.mp4",
    "/a.mp4",
    "/b.mp4",
  ]);
  expect(maximum).toBe(1);
  expect(screen.queryByText(/STALE/)).toBeNull();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Convert 2 files",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});

it("keeps an unselected unsupported source from being submitted", async () => {
  mocks.open.mockResolvedValue(["/a.mp4", "/b.mp4"]);
  mocks.inspect.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/a.mp4"
        ? inspection
        : {
            ...inspection,
            capabilities: {
              ...inspection.capabilities,
              targets: [
                {
                  target: "mp4",
                  available: false,
                  reason: "Encoder unavailable",
                },
              ],
            },
          },
    ),
  );
  render(page("convert"));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await screen.findByText("Encoder unavailable");
  expect(
    (
      screen.getByRole("button", {
        name: "Convert 2 files",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Select a.mp4" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

for (const tool of ["convert", "compress"] as const) {
  it(`${tool} keeps PDF operations visible alongside media without counting PDFs as media`, async () => {
    mocks.open.mockResolvedValue(["/a.mp4", "/document.pdf"]);
    render(page(tool));
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    expect(
      await screen.findByRole("region", { name: "PDF operations" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: (tool === "convert" ? "Convert" : "Compress") + " 1 file",
      }),
    ).toBeTruthy();
    expect(mocks.inspect.mock.calls.map((c) => c[0])).toEqual(["/a.mp4"]);
  });
}

for (const field of ["Start", "End"] as const) {
  it(
    "keeps newer unblurred GIF " +
      field +
      " text after an earlier enqueue succeeds",
    async () => {
      let settle!: (job: string) => void;
      mocks.enqueue.mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      );
      render(page("convert"));
      fireEvent.click(screen.getByRole("button", { name: "Add files" }));
      fireEvent.click(await screen.findByRole("button", { name: "GIF" }));
      fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
      await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
      const input = screen.getByLabelText(field) as HTMLInputElement;
      input.focus();
      fireEvent.change(input, { target: { value: "12:" } });
      expect(document.activeElement).toBe(input);
      await act(async () => settle("job"));
      expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
      expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe(
        "12:",
      );
      expect(document.activeElement).toBe(input);
      expect(screen.getByText(/Earlier settings queued/)).toBeTruthy();
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(mocks.enqueue.mock.calls[0][0].gif_options).toMatchObject({
        trim_start_ms: null,
        trim_end_ms: null,
      });
    },
  );
}
it("keeps newer unblurred target-size text and unit after an earlier enqueue succeeds", async () => {
  let settle!: (job: string) => void;
  mocks.enqueue.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  render(page("compress"));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Target size" }));
  fireEvent.click(screen.getByRole("button", { name: "Compress 1 file" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  const input = screen.getByLabelText("Target size value") as HTMLInputElement;
  input.focus();
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Target size unit"), {
    target: { value: "kb" },
  });
  expect(document.activeElement).toBe(input);
  await act(async () => settle("job"));
  expect(screen.getByRole("button", { name: "Select a.mp4" })).toBeTruthy();
  expect(
    (screen.getByLabelText("Target size value") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Target size unit") as HTMLSelectElement).value,
  ).toBe("kb");
  expect(document.activeElement).toBe(input);
  expect(screen.getByText(/Earlier settings queued/)).toBeTruthy();
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  expect(mocks.enqueue.mock.calls[0][0].compress_mode).toEqual({
    kind: "target_size_bytes",
    value: 10485760,
  });
});
