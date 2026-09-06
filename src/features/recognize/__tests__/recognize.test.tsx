import { api } from "@/ipc/commands";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/store/appStore";
import type { Job } from "@/types";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import QueueRow from "@/features/queue/QueueRow";
import { useRecognizeSession } from "@/store/recognizeSession";
import RecognizePage from "@/pages/RecognizePage";
import RecognizeChip from "@/features/recognize/RecognizeChip";
import RecognizeResultPane from "@/features/recognize/RecognizeResultPane";

// --- Mocks ---

const { mockTessInstalled, mockReveal } = vi.hoisted(() => ({
  mockTessInstalled: vi.fn(),
  mockReveal: vi.fn(),
}));

vi.mock("@/ipc/commands", () => ({
  api: {
    sidecar: { tessdataInstalled: () => mockTessInstalled() },
    pdf: { run: vi.fn(), recognizePeekText: vi.fn() },
    queue: { moveToTop: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]), reveal: (p: string) => mockReveal(p) },
  },
  pdfRecognizeText: (
    input: string,
    outputPath: string,
    outputKind: string,
    lang: string,
  ) => ({ kind: "recognize_text", input, output_path: outputPath, output_kind: outputKind, lang }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  mockTessInstalled.mockResolvedValue([
    { code: "eng", display_name: "English", bundled: true, size_bytes: 1, installed: true },
  ]);
  mockReveal.mockResolvedValue(undefined);
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecognizePage", () => {
  it("renders the dual PDF + image drop zone and format hint", async () => {
    render(
      <MemoryRouter>
        <RecognizePage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: /recognize text/i }),
    ).toBeDefined();
    expect(screen.getByText(/Drop a PDF or image here/i)).toBeDefined();
    expect(screen.getByText(/PDF, PNG, JPEG, WebP, BMP, TIFF/i)).toBeDefined();
    // Language packs are loaded on mount.
    await waitFor(() => expect(mockTessInstalled).toHaveBeenCalled());
  });
});

describe("RecognizeChip", () => {
  it("navigates to /recognize with the file preloaded", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RecognizeChip path="/docs/scan.pdf" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /recognize text/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/recognize", {
      state: { recognizeInput: "/docs/scan.pdf" },
    });
  });

  it("renders nothing for non-recognizable inputs (HEIC)", () => {
    // HEIC decodes in the Image Workshop (v0.2.8) but tesseract can't
    // read it, so the chip must self-hide rather than route to a page
    // that would silently discard the file.
    const { container } = render(
      <MemoryRouter>
        <RecognizeChip path="/photos/IMG_0001.heic" />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("RecognizeResultPane", () => {
  it("renders recognized text and copies it to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <MemoryRouter>
        <RecognizeResultPane
          text="Hello recognized world"
          outputPath="/out/result.txt"
          truncated={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Hello recognized world")).toBeDefined();
    expect(screen.getByText(/Saved to result\.txt/i)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Hello recognized world"),
    );
  });

  it("shows an empty-state message when no text was found", () => {
    render(
      <MemoryRouter>
        <RecognizeResultPane text="   " outputPath="/out/empty.txt" truncated={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No text was found/i)).toBeDefined();
  });
});

function deferred<T>() {
 let resolve!: (value: T) => void;
 let reject!: (error: Error) => void;
 const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
 return {promise, resolve, reject};
}

const view = () => <MemoryRouter><RecognizePage /></MemoryRouter>;
const job = (id: string, state: Job["state"] = "done"): Job => ({id, kind: "pdf", state, payload: {}, result: {output_path: "/out/result.txt", bytes: null, duration_ms: 0n, result_kind: "file", file_count: 1}, priority: 0, attempts: 1, created_at: 0n, started_at: null, finished_at: null});
async function pick(path = "/a.png") {
 vi.mocked(open).mockResolvedValue(path);
 fireEvent.click(screen.getByRole("button", {name: "Pick a file…"}));
 await screen.findByText(path.slice(1));
 await waitFor(() => expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false));
}
async function start() {
 vi.mocked(save).mockResolvedValue("/out/result.txt");
 fireEvent.click(screen.getByRole("button", {name: "Recognize text"}));
 await waitFor(() => expect(api.pdf.run).toHaveBeenCalled());
}
beforeEach(() => {useAppStore.setState({jobs: []});});
it("restores acknowledgement and completion received off-route", async () => {
 const request = deferred<string>(); vi.mocked(api.pdf.run).mockReturnValue(request.promise);
 vi.mocked(api.pdf.recognizePeekText).mockResolvedValue("Retained text");
 const first = render(view()); await pick(); await start(); first.unmount();
 await act(async () => request.resolve("a"));
 act(() => useAppStore.setState({jobs: [job("a")]}));
 render(view());
 expect(await screen.findByText("Retained text")).toBeTruthy();
});
it("does not publish an old peek after selecting a newer source", async () => {
 const peek = deferred<string>(); vi.mocked(api.pdf.run).mockResolvedValue("a");
 vi.mocked(api.pdf.recognizePeekText).mockReturnValue(peek.promise);
 render(view()); await pick(); await start();
 act(() => useAppStore.setState({jobs: [job("a")]}));
 await waitFor(() => expect(api.pdf.recognizePeekText).toHaveBeenCalledTimes(1));
 await pick("/b.png");
 await act(async () => peek.resolve("Old text"));
 expect(screen.queryByText("Old text")).toBeNull();
});
it("retries a failed preview once without re-enqueueing", async () => {
 vi.mocked(api.pdf.run).mockResolvedValue("a");
 vi.mocked(api.pdf.recognizePeekText).mockRejectedValueOnce(new Error("Preview unavailable")).mockResolvedValue("Recovered");
 render(view()); await pick(); await start();
 act(() => useAppStore.setState({jobs: [job("a")]}));
 expect(await screen.findByText("Preview unavailable")).toBeTruthy();
 act(() => useAppStore.setState({jobs: [job("a")]}));
 expect(api.pdf.recognizePeekText).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole("button", {name: "Retry preview"}));
 expect(await screen.findByText("Recovered")).toBeTruthy();
 expect(api.pdf.run).toHaveBeenCalledTimes(1);
});
it("ends a cancelled session", async () => {
 vi.mocked(api.pdf.run).mockResolvedValue("a");
 render(view()); await pick(); await start();
 act(() => useAppStore.setState({jobs: [job("a", "cancelled")]}));
 expect(await screen.findByText(/Recognition cancelled/)).toBeTruthy();
 expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false);
});

it("requires a successful snapshot requested after acknowledgement before reporting a missing job", async () => {
 const oldSnapshot = deferred<Job[]>(); const newSnapshot = deferred<Job[]>(); const request = deferred<string>();
 vi.mocked(api.queue.list).mockReturnValueOnce(oldSnapshot.promise).mockReturnValueOnce(newSnapshot.promise);
 const refreshing = useAppStore.getState().refreshJobs();
 vi.mocked(api.pdf.run).mockReturnValue(request.promise);
 render(view()); await pick(); await start();
 await act(async () => request.resolve("a"));
 await act(async () => {oldSnapshot.resolve([]); await refreshing;});
 expect(screen.getByRole("button", {name: "Recognizing…"})).toBeTruthy();
 await act(async () => newSnapshot.reject(new Error("offline")));
 expect(screen.getByRole("button", {name: "Recognizing…"})).toBeTruthy();
 vi.mocked(api.queue.list).mockResolvedValueOnce([]);
 fireEvent.click(screen.getByRole("button", {name: "Refresh queue"}));
 expect(await screen.findByText(/no longer in the queue/)).toBeTruthy();
 expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false);
});
it("accepts empty text from a searchable PDF and deduplicates pending peeks", async () => {
 const peek = deferred<string>();
 vi.mocked(api.pdf.run).mockResolvedValue("a");
 vi.mocked(api.pdf.recognizePeekText).mockReturnValue(peek.promise);
 render(view()); await pick();
 fireEvent.click(screen.getByRole("button", {name: "Searchable PDF"})); await start();
 expect(api.pdf.run).toHaveBeenCalledWith(expect.objectContaining({output_kind: "searchable_pdf"}));
 act(() => useAppStore.setState({jobs: [job("a")]}));
 await waitFor(() => expect(api.pdf.recognizePeekText).toHaveBeenCalledTimes(1));
 act(() => useAppStore.setState({jobs: [job("a")]}));
 await act(async () => peek.resolve(""));
 expect(await screen.findByText(/No text was found/)).toBeTruthy();
 expect(api.pdf.recognizePeekText).toHaveBeenCalledTimes(1);
});
it("keeps a newer attempt when an old preview resolves", async () => {
 const oldPeek = deferred<string>();
 vi.mocked(api.pdf.run).mockResolvedValueOnce("a").mockResolvedValueOnce("b");
 vi.mocked(api.pdf.recognizePeekText).mockReturnValueOnce(oldPeek.promise).mockResolvedValueOnce("New result");
 render(view()); await pick(); await start();
 act(() => useAppStore.setState({jobs: [job("a")]}));
 await waitFor(() => expect(api.pdf.recognizePeekText).toHaveBeenCalledTimes(1));
 await pick("/b.png"); await start();
 act(() => useAppStore.setState({jobs: [job("b")]}));
 expect(await screen.findByText("New result")).toBeTruthy();
 await act(async () => oldPeek.resolve("Old result"));
 expect(screen.queryByText("Old result")).toBeNull();
 expect(screen.getByText("New result")).toBeTruthy();
});
it("retains an off-route enqueue error and releases a cancelled Save without changing newer fields", async () => {
 const request = deferred<string>(); vi.mocked(api.pdf.run).mockReturnValue(request.promise);
 const first = render(view()); await pick(); await start(); first.unmount();
 await act(async () => request.reject(new Error("Disk unavailable")));
 const second = render(view()); expect(await screen.findByText("Disk unavailable")).toBeTruthy();
 const dialog = deferred<string | null>(); vi.mocked(save).mockReturnValue(dialog.promise);
 fireEvent.click(screen.getByRole("button", {name: "Recognize text"}));
 second.unmount(); render(view());
 fireEvent.click(screen.getByRole("button", {name: "Searchable PDF"}));
 await act(async () => dialog.resolve(null));
 expect(screen.getByRole("button", {name: "Searchable PDF"}).getAttribute("aria-pressed")).toBe("true");
 expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false);
});
it("ends an errored job and caps retained preview text at 100000 characters", async () => {
 vi.mocked(api.pdf.run).mockResolvedValueOnce("a").mockResolvedValueOnce("b");
 vi.mocked(api.pdf.recognizePeekText).mockResolvedValue("x".repeat(100_005));
 const first = render(view()); await pick(); await start();
 act(() => useAppStore.setState({jobs: [job("a", {error: {message: "OCR failed", detail: null}})]}));
 expect(await screen.findByText("OCR failed")).toBeTruthy();
 expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false);
 await start();
 act(() => useAppStore.setState({jobs: [job("b")]}));
 await screen.findByText(/Preview truncated/); first.unmount();
 const restored = render(view());
 expect(restored.container.querySelector("pre")?.textContent?.trim().length).toBe(100_000);
 expect(api.pdf.run).toHaveBeenCalledTimes(2);
});

for (const outcome of ["acknowledged", "rejected"] as const) it(`enqueues the captured approved Save after newer visible edits (${outcome})`, async () => {
 mockTessInstalled.mockResolvedValue([
  {code: "eng", display_name: "English"}, {code: "spa", display_name: "Spanish"},
 ]);
 const dialog = deferred<string | null>(); const request = deferred<string>();
 vi.mocked(save).mockReturnValue(dialog.promise);
 vi.mocked(api.pdf.run).mockReturnValue(request.promise);
 vi.mocked(api.pdf.recognizePeekText).mockResolvedValue("Retired text");
 const first = render(view()); await pick();
 fireEvent.click(screen.getByRole("button", {name: "Recognize text"}));
 await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
 first.unmount(); render(view());
 vi.mocked(open).mockResolvedValue("/b.png");
 fireEvent.click(screen.getByRole("button", {name: "Pick a file…"}));
 await screen.findByText("b.png");
 fireEvent.click(screen.getByRole("button", {name: "Searchable PDF"}));
 fireEvent.change(await screen.findByRole("combobox"), {target: {value: "spa"}});
 await act(async () => dialog.resolve("/out/original.txt"));
 await waitFor(() => expect(api.pdf.run).toHaveBeenCalledTimes(1));
 expect(api.pdf.run).toHaveBeenCalledWith({kind: "recognize_text", input: "/a.png", output_path: "/out/original.txt", output_kind: "text", lang: "eng"});
 if (outcome === "acknowledged") {
  await act(async () => request.resolve("retired"));
  act(() => useAppStore.setState({jobs: [job("retired")]}));
 } else await act(async () => request.reject(new Error("Retired enqueue error")));
 expect(screen.getByText("b.png")).toBeTruthy();
 expect(screen.getByRole("button", {name: "Searchable PDF"}).getAttribute("aria-pressed")).toBe("true");
 expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("spa");
 expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false);
 expect(api.pdf.run).toHaveBeenCalledTimes(1);
 expect(api.pdf.recognizePeekText).not.toHaveBeenCalled();
 expect(screen.queryByText("Retired enqueue error")).toBeNull();
 expect(screen.queryByText("Retired text")).toBeNull();
});

it("keeps the accepted Recognize snapshot when an older Move to top list resolves last", async () => {
  const oldSnapshot = deferred<Job[]>();
  const newSnapshot = deferred<Job[]>();
  const request = deferred<string>();
  const queued = job("queued", "queued");
  const recognizing = job("recognizing", "running");
  vi.mocked(api.queue.list).mockReturnValueOnce(oldSnapshot.promise).mockReturnValueOnce(newSnapshot.promise);
  vi.mocked(api.pdf.run).mockReturnValueOnce(request.promise);
  useAppStore.setState({ jobs: [queued] });
  const row = render(<QueueRow job={queued} index={0} />);
  fireEvent.contextMenu(row.container.firstElementChild!);
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to top" }));
  await waitFor(() => expect(api.queue.list).toHaveBeenCalledTimes(1));
  expect(api.queue.moveToTop).toHaveBeenCalledWith(queued.id);
  render(view());
  await pick();
  await start();
  await act(async () => request.resolve("recognizing"));
  await waitFor(() => expect(api.queue.list).toHaveBeenCalledTimes(2));
  await act(async () => newSnapshot.resolve([queued, recognizing]));
  const acceptedGeneration = useAppStore.getState().queueSnapshotGeneration;
  expect(acceptedGeneration).toBeGreaterThan(useRecognizeSession.getState().acknowledgedGeneration);
  expect(useRecognizeSession.getState().phase).toBe("running");
  await act(async () => oldSnapshot.resolve([queued]));
  expect(useAppStore.getState().jobs).toEqual([queued, recognizing]);
  expect(useAppStore.getState().queueSnapshotGeneration).toBe(acceptedGeneration);
  expect(useRecognizeSession.getState()).toMatchObject({ phase: "running", jobId: "recognizing", error: null, recovery: null });
  expect(screen.getByRole("button", { name: "Recognizing…" })).toBeTruthy();
  expect(screen.queryByText(/no longer in the queue/)).toBeNull();
});
