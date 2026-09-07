import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DRAFT_STORAGE_KEY } from "../workspacePersistence";
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads editable intent into a fresh store and preserves subsequent clearing on another restart", async () => {
  const key = JSON.stringify(["image", "ImagePage.files"]);
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({version:1, entries:{[key]:{value:["/missing.png"]}}}));
  vi.resetModules();
  const first = await import("../workspaceDrafts");
  const wrapper=({children}:{children:ReactNode})=>createElement(first.WorkspaceDraftProvider,{tool:"image"},children);
  const draft=renderHook(()=>first.useWorkspaceDraftState<string[]>("ImagePage.files",[]),{wrapper});
  expect(draft.result.current[0]).toEqual(["/missing.png"]);
  act(()=>first.clearWorkspaceDrafts("image"));
  expect(draft.result.current[0]).toEqual([]);
  draft.unmount();
  vi.resetModules();
  const second=await import("../workspaceDrafts");
  const restored=renderHook(()=>second.useWorkspaceDraftState<string[]>("ImagePage.files",[]),{wrapper:({children}:{children:ReactNode})=>createElement(second.WorkspaceDraftProvider,{tool:"image"},children)});
  expect(restored.result.current[0]).toEqual([]);
});

const jpegMocks = vi.hoisted(() => ({ inspect: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@/ipc/commands", () => ({ api: { convert: { inspect: jpegMocks.inspect }, preview: { cancel: vi.fn().mockResolvedValue(null) } } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: jpegMocks.open, save: jpegMocks.save }));
vi.mock("@/features/convert/DropZone", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/features/presets/PresetChips", () => ({ default: () => null }));

it("restores empty image width in a fresh store and blocks submission even while another inspector is selected", async () => {
  const { render, screen, fireEvent, waitFor } = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { MemoryRouter } = await import("react-router-dom");
  const descriptor = { available: true, reason: null, quality_min: 1, quality_max: 100, default_quality: 75, max_dimension: 32768, max_output_pixels: 100000000, fit_within: true, upscale: false, preview_original_available: false, preview_fit_within: false, preview_unavailable_reason: "No preview" };
  jpegMocks.inspect.mockResolvedValue({ probe: { source_kind: "image", image_format: "dng", width: 6048, height: 8064, duration_ms: 0, file_size: 100, audio_codecs: [], subtitle_codecs: [] }, capabilities: { targets: [{ target: "jpeg", available: true, reason: null, image_settings: descriptor }], compression: { quality: false, target_size: false, lossless: false, reason: null } } });
  jpegMocks.open.mockResolvedValue(["/a.dng", "/b.dng"]);
  vi.resetModules();
  const { default: FirstPage } = await import("@/pages/ConvertPage");
  const first = render(createElement(MemoryRouter, {}, createElement(FirstPage)));
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await screen.findByRole("textbox", { name: "JPEG quality" });
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox", { name: "Image dimensions" }), "fit_within");
  await user.clear(screen.getByRole("textbox", { name: "Image width" }));
  fireEvent.click(screen.getByRole("button", { name: "Select b.dng" }));
  first.unmount();
  expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toContain("ImageOptionsPanel.widthDraft");
  vi.resetModules();
  const { default: SecondPage } = await import("@/pages/ConvertPage");
  render(createElement(MemoryRouter, {}, createElement(SecondPage)));
  await screen.findByRole("textbox", { name: "JPEG quality" });
  await waitFor(() => expect(screen.queryByText("Inspecting source…")).toBeNull());
  expect((screen.getByRole("button", { name: "Convert 2 files" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Select a.dng" }));
  expect((screen.getByRole("textbox", { name: "Image width" }) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("button", { name: "Save as preset" }) as HTMLButtonElement).disabled).toBe(true);
  expect(jpegMocks.save).not.toHaveBeenCalled();
});

it("keeps preexisting GIF text drafts at their established scope after adding identity-scoped image controls", async () => {
  const { render, screen } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const file = { id: "existing-video", revision: 2, optionsReady: true, path: "/movie.mp4", sourceDir: "/", target: "gif", gifOptions: { size_preset: "medium", trim_start_ms: null, trim_end_ms: null }, subtitle: null, metadataPolicy: "preserve", qualityPreset: null, resolutionCap: null };
  window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({version:1, entries: {
    [JSON.stringify(["convert", "ConvertPage.files"])]: { value: [file] },
    [JSON.stringify(["convert", "source", file.path, "GifOptionsPanel.startDraft"])]: { value: "00:" },
    [JSON.stringify(["convert", "source", file.path, "GifOptionsPanel.appliedStart"])]: { value: "" },
  }}));
  jpegMocks.inspect.mockResolvedValue({ probe: { source_kind: "video", video_codec: "h264", has_video: true, duration_ms: 1000, width: 100, height: 100, file_size: 100, audio_codecs: [], subtitle_codecs: [] }, capabilities: { targets: [{ target: "gif", available: true }], compression: { quality: false, target_size: false, lossless: false } } });
  vi.resetModules();
  const { default: Page } = await import("@/pages/ConvertPage");
  render(createElement(MemoryRouter, {}, createElement(Page)));
  expect((await screen.findByRole("textbox", { name: "Start" }) as HTMLInputElement).value).toBe("00:");
});
