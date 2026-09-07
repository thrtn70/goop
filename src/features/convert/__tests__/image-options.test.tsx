import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ConvertPage from "@/pages/ConvertPage";
import CompressPage from "@/pages/CompressPage";
import type { Preset } from "@/types";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), enqueue: vi.fn(), open: vi.fn(), save: vi.fn(), preset: null as Preset | null, preview: vi.fn(), presetSave: vi.fn() }));
vi.mock("@/ipc/commands", () => ({ api: {
  convert: { inspect: mocks.inspect, fromFile: mocks.enqueue },
  preview: { generate: mocks.preview, cancel: vi.fn().mockResolvedValue(null) },
  preset: { save: mocks.presetSave, list: vi.fn().mockResolvedValue([]) },
} }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => "asset://" + path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@/features/convert/DropZone", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/features/presets/PresetChips", () => ({ default: ({ onApply }: { onApply: (p: Preset) => void }) => mocks.preset && <button onClick={() => onApply(mocks.preset!)}>Apply test preset</button> }));
export const imageCapability = { available: true, reason: null, quality_min: 1, quality_max: 100, default_quality: 75, max_dimension: 32768, max_output_pixels: 100000000, fit_within: true, upscale: false, preview_original_available: true, preview_fit_within: false, preview_unavailable_reason: "Resized samples are unavailable" };
const inspect = (video = false) => ({
  probe: { source_kind: video ? "video" : "image", image_format: video ? null : "jpeg", image_has_alpha: false, video_codec: video ? "h264" : null, audio_codec: video ? "aac" : null, has_video: video, has_audio: video, duration_ms: 0, file_size: 100, width: 6048, height: 8064, audio_codecs: [], subtitle_codecs: [] },
  capabilities: { targets: (video ? ["mp4"] : ["jpeg", "png"]).map(target => ({ target, available: true, reason: null, metadata_warning: null, image_settings: target === "jpeg" ? imageCapability : null })), compression: { quality: true, target_size: false, lossless: false, reason: null } },
});
const fit = { jpeg_quality: 90, resize: { kind: "fit_within" as const, width: 2048, height: 2048 } };
const preset = (image_options: Preset["image_options"] = fit) => ({ name: "Photo", target: "jpeg", image_options, quality_preset: null, resolution_cap: null, compress_mode: null, gif_options: null, subtitle: null, metadata_policy: "preserve" }) as Preset;
beforeEach(() => {
  vi.clearAllMocks(); mocks.preset = null;
  mocks.inspect.mockImplementation((path: string) => Promise.resolve(inspect(path.endsWith("mp4"))));
  mocks.open.mockResolvedValue(["/a.jpg"]); mocks.save.mockResolvedValue("/out.jpg"); mocks.enqueue.mockResolvedValue("job");
});
afterEach(cleanup);
const page = () => <MemoryRouter><ConvertPage /></MemoryRouter>;
async function add(paths = ["/a.jpg"]) {
  mocks.open.mockResolvedValue(paths);
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await screen.findByRole("button", { name: "JPEG" });
  fireEvent.click(screen.getByRole("button", { name: "JPEG" }));
  await screen.findByRole("textbox", { name: "JPEG quality" });
}
async function setFit() {
  const user = userEvent.setup();
  await user.clear(screen.getByRole("textbox", { name: "JPEG quality" }));
  await user.type(screen.getByRole("textbox", { name: "JPEG quality" }), "90");
  await user.selectOptions(screen.getByRole("combobox", { name: "Image dimensions" }), "fit_within");
}
const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

it("edits explicit JPEG quality and fit bounds through the inspector and submits exactly that intent", async () => {
  render(page()); await add(); await setFit();
  expect(screen.getByText(/1536 × 2048/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_options).toEqual(fit);
});
it("keeps empty width through selection and remount, blocking Convert, apply, save and samples", async () => {
  const view = render(page()); await add(["/a.jpg", "/b.jpg"]); await setFit();
  await userEvent.setup().clear(screen.getByRole("textbox", { name: "Image width" }));
  expect(disabled("Convert 2 files")).toBe(true); expect(disabled("Apply first to all")).toBe(true); expect(disabled("Save as preset")).toBe(true);
  expect(screen.queryByRole("button", { name: "Preview sample" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select b.jpg" }));
  expect(disabled("Convert 2 files")).toBe(true);
  view.unmount(); render(page());
  await screen.findByRole("button", { name: "JPEG" });
  fireEvent.click(screen.getByRole("button", { name: "Select a.jpg" }));
  expect((screen.getByRole("textbox", { name: "Image width" }) as HTMLInputElement).value).toBe("");
  expect(disabled("Convert 2 files")).toBe(true);
});
it("retains edited JPEG draft while an older Save dialog submits an independent snapshot", async () => {
  let resolve!: (path: string) => void; mocks.save.mockImplementation(() => new Promise(r => { resolve = r; }));
  render(page()); await add(); await setFit();
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "30" } });
  for (const name of ["Image width", "Image height"]) fireEvent.change(screen.getByRole("textbox", { name }), { target: { value: "512" } });
  await act(async () => resolve("/out.jpg"));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_options).toEqual(fit);
  expect((screen.getByRole("textbox", { name: "Image width" }) as HTMLInputElement).value).toBe("512");
  expect(screen.getByText(/Earlier settings queued/)).toBeTruthy();
});
it("copies independent settings and retries only the unacknowledged JPEG", async () => {
  render(page()); await add(["/a.jpg", "/b.jpg"]); await setFit();
  fireEvent.click(screen.getByRole("button", { name: "Apply first to all" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Image width" }), { target: { value: "512" } });
  mocks.enqueue.mockImplementation((r: { input_path: string }) => r.input_path === "/b.jpg" ? Promise.reject(new Error("disk full")) : Promise.resolve("a"));
  fireEvent.click(screen.getByRole("button", { name: "Convert 2 files" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Select a.jpg" })).toBeNull());
  expect(mocks.enqueue.mock.calls[1][0].image_options).toEqual(fit);
  mocks.enqueue.mockResolvedValue("b"); fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(3));
  expect(mocks.enqueue.mock.calls.map(c => c[0].input_path)).toEqual(["/a.jpg", "/b.jpg", "/b.jpg"]);
  expect(mocks.enqueue.mock.calls[2][0].image_options).toEqual(fit);
});
it("rejects mixed-source batch and preset applications atomically with the incompatible source name", async () => {
  mocks.preset = preset(); render(page()); await add(["/a.jpg", "/clip.mp4"]); await setFit();
  await waitFor(() => expect(disabled("Apply first to all")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Apply first to all" }));
  expect(screen.getByRole("alert").textContent).toContain("clip.mp4");
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.getByRole("alert").textContent).toContain("clip.mp4");
  fireEvent.click(screen.getByRole("button", { name: "Select clip.mp4" }));
  expect(screen.getByRole("button", { name: "MP4" }).className).toContain("bg-accent");
});
it("equal-value presets replace invalid raw text and legacy presets clear explicit intent", async () => {
  mocks.preset = preset(); render(page()); await add(); await setFit();
  fireEvent.change(screen.getByRole("textbox", { name: "Image width" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect((screen.getByRole("textbox", { name: "Image width" }) as HTMLInputElement).value).toBe("2048");
  expect(disabled("Convert 1 file")).toBe(false);
  mocks.preset = preset(null); fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.getByText(/Default \(75\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_options).toBeNull();
});
it("retains unsupported target intent until the user clears it", async () => {
  render(page()); await add(); await setFit();
  fireEvent.click(screen.getByRole("button", { name: "PNG" }));
  expect(disabled("Convert 1 file")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear image settings" }));
  expect(disabled("Convert 1 file")).toBe(false);
});
it("recreated same-path files never inherit the removed identity's partial text", async () => {
  render(page()); await add(); await setFit();
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove a.jpg" })); await add();
  expect((screen.getByRole("textbox", { name: "JPEG quality" }) as HTMLInputElement).value).toBe("75");
  expect(disabled("Convert 1 file")).toBe(false);
});
it("Compress refuses a preset carrying meaningful image intent", async () => {
  mocks.preset = { ...preset(), compress_mode: { kind: "quality", value: 30 } };
  render(<MemoryRouter><CompressPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await screen.findByRole("slider");
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.getByRole("alert").textContent).toMatch(/image settings.*Compress/i);
  expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("75");
});

it("seeds the engine's default only for newly inspected applicable drafts", async () => {
  const descriptor = { ...imageCapability, default_quality: 68 };
  const raw = inspect(); raw.probe.image_format = "dng"; raw.capabilities.targets[0].image_settings = descriptor;
  mocks.inspect.mockResolvedValue(raw);
  const first = render(page());
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  await screen.findByRole("textbox", { name: "JPEG quality" });
  expect((screen.getByRole("textbox", { name: "JPEG quality" }) as HTMLInputElement).value).toBe("68");
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "90" } });
  first.unmount(); render(page());
  await screen.findByRole("textbox", { name: "JPEG quality" });
  expect((screen.getByRole("textbox", { name: "JPEG quality" }) as HTMLInputElement).value).toBe("90");
});
it("retains legacy null after preset application and fresh inspection on remount", async () => {
  mocks.preset = preset(null);
  const first = render(page()); await add();
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" })); first.unmount(); render(page());
  await screen.findByText(/Default \(75\)/);
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_options).toBeNull();
});
it("saves an independent preset snapshot from the real inspector", async () => {
  const { useAppStore } = await import("@/store/appStore");
  const originalSave = useAppStore.getState().savePreset;
  const savePreset = vi.fn().mockResolvedValue(null);
  useAppStore.setState({ savePreset });
  try {
    render(page()); await add(); await setFit();
    fireEvent.click(screen.getByRole("button", { name: "Save as preset" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Image width" }), { target: { value: "512" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Preset name" }), { target: { value: "Photo export" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savePreset).toHaveBeenCalledOnce());
    expect(savePreset.mock.calls[0][0].image_options).toEqual(fit);
  } finally { useAppStore.setState({ savePreset: originalSave }); }
});
it("refuses image preset application until every source inspection is ready", async () => {
  mocks.preset = preset();
  let resolve!: (value: ReturnType<typeof inspect>) => void;
  mocks.inspect.mockImplementation((path: string) => path === "/b.jpg" ? new Promise(r => { resolve = r; }) : Promise.resolve(inspect()));
  render(page()); await add(["/a.jpg", "/b.jpg"]);
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.getByRole("alert").textContent).toContain("b.jpg: Inspecting");
  expect((screen.getByRole("textbox", { name: "JPEG quality" }) as HTMLInputElement).value).toBe("75");
  await act(async () => resolve(inspect()));
});

it("a partial edit of legacy JPEG settings becomes explicit intent and cannot disappear on target change", async () => {
  mocks.preset = preset(null); render(page()); await add();
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "PNG" }));
  expect(disabled("Convert 1 file")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear image settings" }));
  expect(disabled("Convert 1 file")).toBe(false);
});
it("large fit boxes preserve original small output without treating the box area as raster pixels", async () => {
  render(page()); await add(); await setFit();
  for (const name of ["Image width", "Image height"]) fireEvent.change(screen.getByRole("textbox", { name }), { target: { value: "32768" } });
  expect(disabled("Convert 1 file")).toBe(false);
  expect(screen.getByText(/JPEG · Quality 90 · 6048 × 8064/)).toBeTruthy();
});
it("JPEG presets copy independent nested settings to each compatible source", async () => {
  mocks.preset = preset(); render(page()); await add(["/a.jpg", "/b.jpg"]);
  await waitFor(() => expect(disabled("Apply first to all")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Image width" }), { target: { value: "512" } });
  fireEvent.click(screen.getByRole("button", { name: "Convert 2 files" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
  expect(mocks.enqueue.mock.calls[0][0].image_options.resize.width).toBe(512);
  expect(mocks.enqueue.mock.calls[1][0].image_options).toEqual(fit);
  expect(mocks.preset.image_options).toEqual(fit);
});
it("raw-only edits made during a Save dialog retain their newer revision after enqueue", async () => {
  let resolve!: (path: string) => void; mocks.save.mockImplementation(() => new Promise(r => { resolve = r; }));
  render(page()); await add(); await setFit();
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Image width" }), { target: { value: "" } });
  await act(async () => resolve("/out.jpg"));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_options).toEqual(fit);
  expect((screen.getByRole("textbox", { name: "Image width" }) as HTMLInputElement).value).toBe("");
  expect(disabled("Convert 1 file")).toBe(true);
});

it("forwards selected JPEG quality to preview and disables Fit within with the engine reason", async () => {
  mocks.preview.mockImplementation(async request => ({...request,kind:"image",before_path:"/before.png",after_path:"/after.png",width:160,height:100,sample_bytes:100}));
  render(page()); await add();
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview sample" }));
  await screen.findByAltText("Output sample");
  expect(mocks.preview.mock.calls[0][0].image_options).toEqual({jpeg_quality:30,resize:{kind:"original"}});
  await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Image dimensions" }), "fit_within");
  expect(disabled("Preview sample")).toBe(true);
  expect(screen.getByText(imageCapability.preview_unavailable_reason)).toBeTruthy();
  expect(screen.queryByAltText("Output sample")).toBeNull();
  expect(mocks.preview).toHaveBeenCalledTimes(1);
});
it("retires an in-flight preview on a raw invalid edit and ignores its late response after correction", async () => {
  let resolve!: (value:unknown) => void;
  mocks.preview.mockImplementationOnce(() => new Promise(r => {resolve = r;}));
  render(page()); await add();
  fireEvent.click(screen.getByRole("button", { name: "Preview sample" }));
  const request = mocks.preview.mock.calls[0][0];
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "" } });
  expect(screen.queryByRole("button", { name: "Preview sample" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "JPEG quality" }), { target: { value: "90" } });
  await act(async () => resolve({...request,kind:"image",before_path:"/before.png",after_path:"/stale.png",width:160,height:100,sample_bytes:100}));
  expect(screen.queryByAltText("Output sample")).toBeNull();
  expect(disabled("Preview sample")).toBe(false);
});

it.each([
  ["preserve", fit, true],
  ["strip_all", fit, false],
  ["preserve", null, false],
] as const)("gates the real producer Jpeg preservation notice for %s and %j", async (policy, options, visible) => {
  const inspected = inspect(); inspected.probe.image_format = "Jpeg";
  mocks.inspect.mockResolvedValue(inspected);
  mocks.preset = { ...preset(options), metadata_policy: policy };
  render(page()); await add();
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.queryByText(/JPEG preservation removes the EXIF thumbnail reference/) !== null).toBe(visible);
});

it.each([
  [2200, 583, 1500, 1500, 1500, 398],
  [22, 11, 15, 15, 15, 8],
  [583, 2200, 1500, 1500, 398, 1500],
  [11, 22, 15, 15, 8, 15],
  [90, 120, 2048, 2048, 90, 120],
  [400, 300, 101, 101, 101, 76],
  [32768, 3051, 16384, 32768, 16384, 1526],
])("shows engine fit geometry for %i × %i into %i × %i", async (sw, sh, width, height, ow, oh) => {
  const inspected = inspect(); inspected.probe.width = sw; inspected.probe.height = sh;
  mocks.inspect.mockResolvedValue(inspected);
  mocks.preset = preset({ jpeg_quality: 90, resize: { kind: "fit_within", width, height } });
  render(page()); await add();
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.getByText(`JPEG · Quality 90 · ${ow} × ${oh} px upright`)).toBeTruthy();
});

it("describes legacy null StripAll without promising upright output geometry from an oriented Jpeg probe", async () => {
  // The orientation-6 producer reports upright 1600 × 2400 for stored 2400 × 1600.
  const inspected = inspect();
  Object.assign(inspected.probe, { image_format: "Jpeg", width: 1600, height: 2400 });
  mocks.inspect.mockResolvedValue(inspected);
  mocks.preset = { ...preset(null), metadata_policy: "strip_all" };
  render(page()); await add();
  expect(screen.getByText("JPEG · Quality 75 · 1600 × 2400 px upright")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply test preset" }));
  expect(screen.getByText("Default (75), Original size")).toBeTruthy();
  expect(screen.queryByText(/px upright/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({ image_options: null, metadata_policy: "strip_all" });
});
