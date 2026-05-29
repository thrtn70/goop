import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
    queue: { list: vi.fn().mockResolvedValue([]), reveal: (p: string) => mockReveal(p) },
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
