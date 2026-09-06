import ImageOcrFlow from "@/features/pdf/ImageOcrFlow";
import ImagesToPdfFlow from "@/features/pdf/ImagesToPdfFlow";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import RecognizePage from "@/pages/RecognizePage";
import ImagePage from "@/pages/ImagePage";
import MetadataPage from "@/pages/MetadataPage";
import ConvertPage from "@/pages/ConvertPage";
import CompressPage from "@/pages/CompressPage";
import PdfFlow from "@/features/pdf/PdfFlow";
import { WorkspaceDraftProvider } from "../workspaceDrafts";
const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), image: vi.fn(), metadata: vi.fn(), pdf: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@/features/convert/DropZone", () => ({ default: ({children}: {children: React.ReactNode}) => children }));
vi.mock("@/features/presets/PresetChips", () => ({ default: () => null }));
vi.mock("@/features/presets/PresetSaveDialog", () => ({ default: () => null }));
vi.mock("@/ipc/commands", async (original) => {
 const real = await original<typeof import("@/ipc/commands")>();
 return {...real, api: {...real.api, sidecar: {...real.api.sidecar, tessdataInstalled: vi.fn().mockResolvedValue([{code: "eng"}])}, image: {...real.api.image, run: mocks.image}, metadata: {...real.api.metadata, run: mocks.metadata, read: vi.fn(async (paths: string[]) => paths.map(path => ({path, domain: "audio", audio: {title: "Original"}, cover_art: null, raw: []})))}, pdf: {...real.api.pdf, run: mocks.pdf, probe: vi.fn().mockResolvedValue({pages: 3})}}};
});
function deferred() { let resolve!: (value: string) => void; const promise = new Promise<string>(done => {resolve = done;}); return {promise, resolve}; }
const page = (tool: "image" | "metadata" | "convert" | "compress") => <MemoryRouter>{tool === "image" ? <ImagePage /> : tool === "metadata" ? <MetadataPage /> : tool === "convert" ? <ConvertPage /> : <CompressPage />}</MemoryRouter>;
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockResolvedValue("/out.png"); });
afterEach(cleanup);

for (const tool of ["image", "metadata"] as const) {
 it(`${tool} completion after remount removes only submitted files`, async () => {
  const request = deferred(); (tool === "image" ? mocks.image : mocks.metadata).mockReturnValue(request.promise);
  const extension = tool === "image" ? "png" : "mp3";
  mocks.open.mockResolvedValue([`/a.${extension}`]);
  const first = render(page(tool));
  fireEvent.click(screen.getByRole("button", {name: tool === "image" ? "Pick images…" : "Pick files…"}));
  if(tool === "image") { fireEvent.click(await screen.findByRole("button", {name: /^Resize/})); fireEvent.click(screen.getByRole("button", {name: "Resize image"})); }
  else { fireEvent.change(await screen.findByLabelText("Title"), {target: {value: "Submitted"}}); fireEvent.click(screen.getByRole("button", {name: "Save in place"})); }
  await waitFor(() => expect(tool === "image" ? mocks.image : mocks.metadata).toHaveBeenCalledTimes(1));
  first.unmount(); render(page(tool));
  mocks.open.mockResolvedValue([`/b.${extension}`]);
  fireEvent.click(screen.getByRole("button", {name: tool === "image" ? "Pick images…" : "Pick files…"}));
  await screen.findByRole("button", {name: `Remove b.${extension}`});
  await act(async () => request.resolve("job"));
  expect(screen.getByRole("button", {name: `Remove b.${extension}`})).toBeTruthy();
  expect(screen.queryByRole("button", {name: `Remove a.${extension}`})).toBeNull();
 });
 it(`${tool} keeps newer same-source fields after an old request completes`, async () => {
  const request = deferred(); (tool === "image" ? mocks.image : mocks.metadata).mockReturnValue(request.promise);
  mocks.open.mockResolvedValue([tool === "image" ? "/a.png" : "/a.mp3"]);
  const first = render(page(tool));
  fireEvent.click(screen.getByRole("button", {name: tool === "image" ? "Pick images…" : "Pick files…"}));
  if(tool === "image") { fireEvent.click(await screen.findByRole("button", {name: /^Resize/})); fireEvent.click(screen.getByRole("button", {name: "Resize image"})); }
  else { fireEvent.change(await screen.findByLabelText("Title"), {target: {value: "Submitted"}}); fireEvent.click(screen.getByRole("button", {name: "Save in place"})); }
  await waitFor(() => expect(tool === "image" ? mocks.image : mocks.metadata).toHaveBeenCalledTimes(1));
  first.unmount(); render(page(tool));
  const field = await screen.findByLabelText(tool === "image" ? /Width/ : "Title");
  expect((screen.getByRole("button", {name: "Saving…"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, {target: {value: tool === "image" ? "987" : "Newer title"}});
  await act(async () => request.resolve("job"));
  expect((screen.getByLabelText(tool === "image" ? /Width/ : "Title") as HTMLInputElement).value).toBe(tool === "image" ? "987" : "Newer title");
 });
}
it("PDF completion preserves newer retained metadata fields", async () => {
 const request = deferred(); mocks.pdf.mockReturnValue(request.promise); const done = vi.fn();
 const view = () => <WorkspaceDraftProvider tool="convert"><PdfFlow files={["/a.pdf"]} defaultOp="set_metadata" onFilesChanged={() => {}} onDone={done} /></WorkspaceDraftProvider>;
 const first = render(view());
 fireEvent.change(await screen.findByLabelText("Title"), {target: {value: "Submitted"}});
 fireEvent.click(screen.getByRole("button", {name: "Save metadata"}));
 await waitFor(() => expect(mocks.pdf).toHaveBeenCalledTimes(1));
 first.unmount(); render(view());
 expect((screen.getByRole("button", {name: "Saving…"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(await screen.findByLabelText("Title"), {target: {value: "Newer PDF title"}});
 await act(async () => request.resolve("job"));
 expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Newer PDF title");
 expect(done).not.toHaveBeenCalled();
});
for (const tool of ["convert", "compress"] as const) it(`${tool} PDF completion retains later added PDF sources`, async () => {
 const request = deferred(); mocks.pdf.mockReturnValue(request.promise); mocks.open.mockResolvedValue(["/a.pdf"]);
 const first = render(page(tool)); fireEvent.click(screen.getByRole("button", {name: "Add files"}));
 fireEvent.click(await screen.findByRole("button", {name: /Edit metadata/}));
 fireEvent.change(screen.getByLabelText("Title"), {target: {value: "Submitted"}});
 fireEvent.click(screen.getByRole("button", {name: "Save metadata"}));
 await waitFor(() => expect(mocks.pdf).toHaveBeenCalledTimes(1));
 first.unmount(); render(page(tool)); mocks.open.mockResolvedValue(["/b.pdf"]);
 fireEvent.click(screen.getByRole("button", {name: "Add files"})); await screen.findByText("b.pdf");
 await act(async () => request.resolve("job")); expect(screen.getByText("b.pdf")).toBeTruthy();
});
it("recompress completion cannot remove a same-path replacement after remove/re-add", async () => {
 const request = deferred(); mocks.image.mockReturnValue(request.promise); mocks.open.mockResolvedValue(["/a.png", "/b.png"]);
 render(page("image")); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 await screen.findByRole("button", {name: "Recompress 2 images"});
 mocks.open.mockResolvedValue("/output"); fireEvent.click(screen.getByRole("button", {name: "Recompress 2 images"}));
 await waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole("button", {name: "Remove a.png"}));
 mocks.open.mockResolvedValue(["/a.png"]); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 await screen.findByRole("button", {name: "Remove a.png"});
 await act(async () => request.resolve("job"));
 expect(screen.getByRole("button", {name: "Remove a.png"})).toBeTruthy();
 expect(mocks.image).toHaveBeenCalledTimes(1);
});
it("recompress stays busy after route remount and releases after failed enqueue", async () => {
 let fail!: (error: Error) => void;
 mocks.image.mockReturnValue(new Promise((_, reject) => {fail = reject;}));
 mocks.open.mockResolvedValue(["/a.png", "/b.png"]);
 const first = render(page("image")); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 await screen.findByRole("button", {name: "Recompress 2 images"});
 mocks.open.mockResolvedValue("/output"); fireEvent.click(screen.getByRole("button", {name: "Recompress 2 images"}));
 await waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(1));
 first.unmount(); render(page("image"));
 const action = screen.getByRole("button", {name: /Saving…|Recompress 2 images/});
 expect((action as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(action);
 expect(mocks.image).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByRole("slider"), {target: {value: "88"}});
 await act(async () => fail(new Error("enqueue failed")));
 expect((screen.getByRole("button", {name: "Recompress 2 images"}) as HTMLButtonElement).disabled).toBe(false);
 expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("88");
});
it("old recompress completion preserves a newer watermark edit for the same source", async () => {
 const request = deferred(); mocks.image.mockReturnValue(request.promise); mocks.open.mockResolvedValue(["/a.png"]);
 render(page("image")); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 fireEvent.click(await screen.findByRole("button", {name: /^Recompress/}));
 mocks.open.mockResolvedValue("/output"); fireEvent.click(screen.getByRole("button", {name: "Recompress 1 image"}));
 await waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(1));
 fireEvent.click(screen.getByRole("button", {name: /^Watermark/}));
 fireEvent.change(screen.getByRole("textbox"), {target: {value: "New watermark"}});
 await act(async () => request.resolve("job"));
 expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("New watermark");
});

it("Recognize holds its pending enqueue across route remount and releases after failure", async () => {
 let fail!: (error: Error) => void; mocks.pdf.mockReturnValue(new Promise((_, reject) => {fail = reject;}));
 mocks.open.mockResolvedValue("/a.png");
 const view = () => <MemoryRouter><RecognizePage /></MemoryRouter>;
 const first = render(view()); fireEvent.click(screen.getByRole("button", {name: "Pick a file…"}));
 await waitFor(() => expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button", {name: "Recognize text"}));
 await waitFor(() => expect(mocks.pdf).toHaveBeenCalledTimes(1));
 first.unmount(); render(view());
 await act(async () => {});
 const action = screen.getByRole("button", {name: /Recognize text|Starting/});
 expect((action as HTMLButtonElement).disabled).toBe(true); fireEvent.click(action);
 expect(mocks.pdf).toHaveBeenCalledTimes(1);
 await act(async () => fail(new Error("enqueue failed")));
 expect((screen.getByRole("button", {name: "Recognize text"}) as HTMLButtonElement).disabled).toBe(false);
});

for (const tool of ["image", "metadata", "convert"] as const) it(`${tool} retains off-route rejection for its submitted source`, async () => {
 let reject!: (error: Error) => void;
 const run = tool === "image" ? mocks.image : tool === "metadata" ? mocks.metadata : mocks.pdf;
 run.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
 mocks.open.mockResolvedValue([tool === "image" ? "/a.png" : tool === "metadata" ? "/a.mp3" : "/a.pdf"]);
 const first = render(page(tool));
 fireEvent.click(screen.getByRole("button", {name: tool === "image" ? "Pick images…" : tool === "metadata" ? "Pick files…" : "Add files"}));
 if (tool === "image") {
  fireEvent.click(await screen.findByRole("button", {name: /^Resize/}));
  fireEvent.click(screen.getByRole("button", {name: "Resize image"}));
 } else {
  if (tool === "convert") fireEvent.click(await screen.findByRole("button", {name: /Edit metadata/}));
  fireEvent.change(await screen.findByLabelText("Title"), {target: {value: "Submitted"}});
  fireEvent.click(screen.getByRole("button", {name: tool === "metadata" ? "Save in place" : "Save metadata"}));
 }
 await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
 first.unmount();
 await act(async () => reject(new Error("Disk unavailable")));
 render(page(tool));
 expect(await screen.findByText("Disk unavailable")).toBeTruthy();
});

it("removed and re-added image does not receive its retired off-route failure", async () => {
 let reject!: (error: Error) => void;
 mocks.image.mockReturnValue(new Promise((_, fail) => {reject = fail;}));
 mocks.open.mockResolvedValue(["/a.png"]);
 const first = render(page("image")); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 fireEvent.click(await screen.findByRole("button", {name: /^Resize/}));
 fireEvent.click(screen.getByRole("button", {name: "Resize image"}));
 await waitFor(() => expect(mocks.image).toHaveBeenCalledTimes(1));
 first.unmount(); const second = render(page("image"));
 fireEvent.click(screen.getByRole("button", {name: "Remove a.png"}));
 second.unmount(); render(page("image"));
 fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 await screen.findByRole("button", {name: "Remove a.png"});
 await act(async () => reject(new Error("Retired failure")));
 expect(screen.queryByText("Retired failure")).toBeNull();
});
it("image Save cancellation releases busy while preserving newer retained fields", async () => {
 let resolve!: (value: null) => void;
 mocks.save.mockReturnValue(new Promise(done => {resolve = done;}));
 mocks.open.mockResolvedValue(["/a.png"]);
 const first = render(page("image")); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 fireEvent.click(await screen.findByRole("button", {name: /^Resize/}));
 fireEvent.click(screen.getByRole("button", {name: "Resize image"}));
 await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
 first.unmount(); render(page("image"));
 fireEvent.change(screen.getByLabelText(/Width/), {target: {value: "987"}});
 await act(async () => resolve(null));
 expect((screen.getByLabelText(/Width/) as HTMLInputElement).value).toBe("987");
 expect((screen.getByRole("button", {name: "Resize image"}) as HTMLButtonElement).disabled).toBe(false);
 expect(mocks.image).not.toHaveBeenCalled();
});

for (const ocr of [false, true]) it(`internal PDF image selection retires removed-source failure (OCR=${ocr})`, async () => {
 let reject!: (error: Error) => void;
 mocks.pdf.mockReturnValue(new Promise((_, fail) => {reject = fail;}));
 mocks.open.mockResolvedValue(["/a.png"]);
 const view = () => <MemoryRouter><WorkspaceDraftProvider tool="convert">{ocr ? <ImageOcrFlow onDone={() => {}} /> : <ImagesToPdfFlow onDone={() => {}} />}</WorkspaceDraftProvider></MemoryRouter>;
 const first = render(view()); fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 const action = await screen.findByRole("button", {name: ocr ? "Run OCR" : "Combine 1 image into PDF"});
 await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(action);
 await waitFor(() => expect(mocks.pdf).toHaveBeenCalledTimes(1));
 first.unmount(); const second = render(view());
 fireEvent.click(screen.getByRole("button", {name: "Remove a.png"}));
 second.unmount(); render(view());
 fireEvent.click(screen.getByRole("button", {name: "Pick images…"}));
 await screen.findByRole("button", {name: "Remove a.png"});
 await act(async () => reject(new Error("Retired failure")));
 expect(screen.queryByText("Retired failure")).toBeNull();
});
it("batch metadata retains an off-route error", async () => {
 let reject!: (error: Error) => void;
 mocks.metadata.mockReturnValue(new Promise((_, fail) => {reject = fail;}));
 mocks.open.mockResolvedValue(["/a.mp3", "/b.mp3"]);
 const first = render(page("metadata")); fireEvent.click(screen.getByRole("button", {name: "Pick files…"}));
 fireEvent.change(await screen.findByLabelText("Artist"), {target: {value: "Shared artist"}});
 fireEvent.click(screen.getByRole("button", {name: "Apply to 2 tracks"}));
 await waitFor(() => expect(mocks.metadata).toHaveBeenCalledTimes(1));
 first.unmount(); await act(async () => reject(new Error("Batch unavailable")));
 render(page("metadata")); expect(await screen.findByText("Batch unavailable")).toBeTruthy();
});
