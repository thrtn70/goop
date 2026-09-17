import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPreview from "../SettingsPreview";
import type { ImageSettingsCapabilities } from "@/types";
const mocks=vi.hoisted(()=>({
  begin:vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111"),
  eligibility:vi.fn(),
  generate:vi.fn(),
  cancel:vi.fn().mockResolvedValue(undefined),
  release:vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/ipc/commands",()=>({api:{preview:mocks}}));
vi.mock("@tauri-apps/api/core",()=>({convertFileSrc:(path:string)=>"asset://"+path}));
beforeEach(()=>{mocks.eligibility.mockResolvedValue({available:true,reason:null});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const request={input_path:"/image.png",target:"jpeg",quality_preset:null,resolution_cap:null,compress_mode:null,metadata_policy:"preserve",subtitle:null,gif_options:null} as const;
async function enabledPreview() {
  const button=await screen.findByRole("button",{name:"Preview sample"});
  await waitFor(()=>expect(button).toHaveProperty("disabled",false));
  return button;
}

it("fails closed while checking and never generates an unavailable request", async () => {
  let resolve!: (value:{available:boolean;reason:string|null})=>void;
  mocks.eligibility.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  render(<SettingsPreview request={request}/>);

  const button=screen.getByRole("button",{name:"Checking preview availability…"});
  expect(button).toHaveProperty("disabled",true);
  fireEvent.click(button);
  expect(mocks.generate).not.toHaveBeenCalled();

  await act(async()=>resolve({available:false,reason:"Target size previews cannot predict output size."}));
  expect(screen.getByRole("status")).toHaveProperty("textContent","Target size previews cannot predict output size.");
  expect(screen.getByRole("button",{name:"Preview sample"})).toHaveProperty("disabled",true);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  expect(mocks.generate).not.toHaveBeenCalled();
});

it("ignores a late available answer for an older request", async () => {
  let resolveOld!: (value:{available:boolean;reason:string|null})=>void;
  mocks.eligibility
    .mockImplementationOnce(()=>new Promise(r=>{resolveOld=r;}))
    .mockResolvedValueOnce({available:false,reason:"PNG preview is unavailable."});
  const view=render(<SettingsPreview request={request}/>);
  const oldCheck=mocks.eligibility.mock.calls[0][0];
  view.rerender(<SettingsPreview request={{...request,target:"png"}}/>);

  expect(await screen.findByText("PNG preview is unavailable.")).toBeTruthy();
  expect(mocks.cancel).toHaveBeenCalledWith(oldCheck.request_id);
  await act(async()=>resolveOld({available:true,reason:null}));
  expect(screen.getByText("PNG preview is unavailable.")).toBeTruthy();
  expect(screen.getByRole("button",{name:"Preview sample"})).toHaveProperty("disabled",true);
});

it("offers a keyboard-accessible retry after an inspection error", async () => {
  mocks.eligibility
    .mockRejectedValueOnce(new Error("Source inspection timed out"))
    .mockResolvedValueOnce({available:true,reason:null});
  render(<SettingsPreview request={request}/>);

  expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("timed out"));
  const retry=screen.getByRole("button",{name:"Retry preview check"});
  retry.focus();
  fireEvent.keyDown(retry,{key:"Enter"});
  fireEvent.click(retry);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Preview sample"})).toHaveProperty("disabled",false));
  expect(mocks.eligibility).toHaveBeenCalledTimes(2);
});

it("keeps a known draft problem above request eligibility", async () => {
  render(<SettingsPreview request={request} blockedReason="JPEG quality is incomplete."/>);
  expect(screen.getByText("JPEG quality is incomplete.")).toBeTruthy();
  expect(screen.getByRole("button",{name:"Preview sample"})).toHaveProperty("disabled",true);
  expect(mocks.eligibility).not.toHaveBeenCalled();
});
it("requests a sample only on demand and cancels when settings change", async()=>{
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const view=render(<SettingsPreview request={request}/>);
  expect(mocks.generate).not.toHaveBeenCalled();
  fireEvent.click(await enabledPreview());
  const sent=mocks.generate.mock.calls[0][0];
  view.rerender(<SettingsPreview request={{...request,target:"png"}}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(sent.request_id);
  await act(async()=>resolve({request_id:sent.request_id,source_revision:sent.source_revision,kind:"image",before_path:"/before.png",after_path:"/after.png",sample_bytes:100,width:2,height:2}));
  expect(screen.queryByAltText("Output sample")).toBeNull();
});
it("shows backend limitations and permits another request", async()=>{
  mocks.generate.mockRejectedValue(new Error("Sample preview is unavailable for this source"));
  render(<SettingsPreview request={request}/>);
  fireEvent.click(await enabledPreview());
  expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("unavailable"));
});
it("shows source transparency against a checkerboard", async()=>{
  mocks.generate.mockImplementationOnce(async sent => ({...sent,kind:"image",before_path:"/before.png",after_path:"/after.png",width:2,height:2,sample_bytes:100,duration_ms:null}));
  render(<SettingsPreview request={{...request,image_alpha_policy:{kind:"flatten",background:{red:255,green:255,blue:255}}}}/>);
  fireEvent.click(await enabledPreview());
  const source = await screen.findByAltText("Source sample");
  expect(source.parentElement?.className).toContain("transparency-checkerboard");
});
it("retains a successful same-settings sample when replacement fails", async()=>{
  mocks.generate.mockImplementationOnce(async(sent)=>({...sent,kind:"image",before_path:"/before.png",after_path:"/after.png",width:2,height:2,sample_bytes:100,duration_ms:null}));
  render(<SettingsPreview request={request}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByAltText("Output sample");
  const original=mocks.generate.mock.calls[0][0].request_id;
  mocks.generate.mockRejectedValueOnce(new Error("Replacement failed"));
  fireEvent.click(await enabledPreview());
  await screen.findByRole("alert");
  expect(screen.getByAltText("Output sample")).toBeTruthy();
  expect(mocks.cancel).not.toHaveBeenCalledWith(original);
});

const imageSettings = { required_color_policy:"convert_to_srgb", available:true, reason:null, quality_min:1, quality_max:100, default_quality:75, max_dimension:32768, max_output_pixels:100000000, fit_within:true, upscale:false, preview_original_available:true, preview_fit_within:false, preview_unavailable_reason:"Fit within image samples are not available yet." } satisfies ImageSettingsCapabilities;
const explicit = {...request,input_path:"/photo.png",image_color_policy:"convert_to_srgb" as const,image_options:{jpeg_quality:30,resize:{kind:"original" as const}}};
const sample = (sent: {request_id:string;source_revision:string}, path = "/after.png") => ({...sent,kind:"image",before_path:"/before.png",after_path:path,width:2,height:2,sample_bytes:100,duration_ms:null});
it.each(["fit", "RAW", "HEIC", "oversized"])("disables %s previews with the engine descriptor reason", async (source) => {
  const reason = source === "fit" ? imageSettings.preview_unavailable_reason : `${source} preview is unavailable`;
  const settings = {...imageSettings,preview_original_available:source === "fit",preview_unavailable_reason:reason};
  render(<SettingsPreview imageSettings={settings} request={{...explicit,image_options:{jpeg_quality:90,resize:source === "fit" ? {kind:"fit_within",width:2048,height:2048} : {kind:"original"}}}}/>);
  const button = await screen.findByRole("button", {name:"Preview sample"});
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(button);
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("preserves legacy null eligibility even when explicit image controls are unsupported", async () => {
  render(<SettingsPreview request={{...request,image_options:null}} imageSettings={{...imageSettings,available:false,preview_original_available:false}}/>);
  expect((await enabledPreview() as HTMLButtonElement).disabled).toBe(false);
});
it("cancels pending quality revisions, refuses late results, and sends the latest explicit intent", async () => {
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const view = render(<SettingsPreview request={explicit} imageSettings={imageSettings}/>);
  fireEvent.click(await enabledPreview());
  const old = mocks.generate.mock.calls[0][0];
  const latest = {...explicit,image_options:{...explicit.image_options,jpeg_quality:90}};
  view.rerender(<SettingsPreview request={latest} imageSettings={imageSettings}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(old.request_id);
  mocks.generate.mockImplementationOnce(async sent => sample(sent,"/latest.png"));
  fireEvent.click(await enabledPreview());
  await screen.findByAltText("Output sample");
  const sent = mocks.generate.mock.calls[1][0];
  expect(sent.image_options).toEqual(latest.image_options);
  expect(sent.source_revision).not.toBe(old.source_revision);
  await act(async()=>resolve(sample(old,"/stale.png")));
  expect(screen.getByAltText("Output sample").getAttribute("src")).toBe("asset:///latest.png");
});
it("makes the alpha background part of preview identity and refuses a late prior background", async () => {
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const first = {...explicit,image_alpha_policy:{kind:"flatten" as const,background:{red:255,green:255,blue:255}}};
  const view = render(<SettingsPreview request={first} imageSettings={imageSettings}/>);
  fireEvent.click(await enabledPreview());
  const old = mocks.generate.mock.calls[0][0];
  const latest = {...first,image_alpha_policy:{kind:"flatten" as const,background:{red:17,green:34,blue:51}}};
  view.rerender(<SettingsPreview request={latest} imageSettings={imageSettings}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(old.request_id);
  mocks.generate.mockImplementationOnce(async sent => sample(sent,"/custom.png"));
  fireEvent.click(await enabledPreview());
  await screen.findByAltText("Output sample");
  const sent = mocks.generate.mock.calls[1][0];
  expect(sent.image_alpha_policy).toEqual(latest.image_alpha_policy);
  expect(sent.source_revision).not.toBe(old.source_revision);
  await act(async()=>resolve(sample(old,"/white.png")));
  expect(screen.getByAltText("Output sample").getAttribute("src")).toBe("asset:///custom.png");
});
it("releases a displayed sample immediately when dimensions become unavailable", async () => {
  mocks.generate.mockImplementationOnce(async sent => sample(sent));
  const view = render(<SettingsPreview request={explicit} imageSettings={imageSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByAltText("Output sample");
  const sent = mocks.generate.mock.calls[0][0];
  view.rerender(<SettingsPreview request={{...explicit,image_options:{jpeg_quality:30,resize:{kind:"fit_within",width:512,height:512}}}} imageSettings={imageSettings}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(sent.request_id);
  expect(screen.queryByAltText("Output sample")).toBeNull();
  expect((await screen.findByRole("button",{name:"Preview sample"}) as HTMLButtonElement).disabled).toBe(true);
});
it("cancels on descriptor invalidation without accepting the pending result", async () => {
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const view = render(<SettingsPreview request={explicit} imageSettings={imageSettings}/>);
  fireEvent.click(await enabledPreview());
  const sent = mocks.generate.mock.calls[0][0];
  view.rerender(<SettingsPreview request={explicit} imageSettings={{...imageSettings,preview_original_available:false,preview_unavailable_reason:"Source now exceeds sample bounds"}}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(sent.request_id);
  await act(async()=>resolve(sample(sent)));
  expect(screen.queryByAltText("Output sample")).toBeNull();
});

it.each([{kind:"copy" as const},{kind:"encode" as const,codec:"hevc" as const,processor:"software" as const,speed:"slow" as const,rate_control:{kind:"constant_quality" as const,crf:31}}])("never requests a legacy sample for explicit video %o", async options => {
  render(<SettingsPreview request={{...request,target:"mp4",video_options:options}} videoSettings={{preview_unavailable_reason:"Engine says explicit samples are unavailable"}}/>);
  const button=await screen.findByRole("button",{name:"Preview sample"});
  expect(button).toHaveProperty("disabled",true);
  expect(screen.getByText("Engine says explicit samples are unavailable")).toBeTruthy();
  fireEvent.click(button); expect(mocks.generate).not.toHaveBeenCalled();
});
it("keeps Automatic video samples available even when explicit previews are unavailable", async () => {
  mocks.generate.mockImplementationOnce(async sent => ({...sent,kind:"video",before_path:null,after_path:"/video.mp4",width:640,height:360,sample_bytes:100,duration_ms:1000}));
  render(<SettingsPreview request={{...request,input_path:"/source.mp4",target:"mp4",video_options:null}} videoSettings={{preview_unavailable_reason:"Custom unavailable"}}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByLabelText("Output video sample");
  expect(screen.getByText(/Audio, subtitle, and data streams are omitted; source metadata is not preserved/)).toBeTruthy();
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].video_options).toBeNull();
});

const heicRequest = {
  ...explicit,
  input_path:"/camera/photo.heic",
  image_options:{jpeg_quality:72,resize:{kind:"fit_within" as const,width:4032,height:3024}},
};
const heicSettings = {
  ...imageSettings,
  preview_fit_within:true,
  preview_unavailable_reason:null,
};
const heicSample = (sent: {request_id:string;source_revision:string}, overrides: Record<string, unknown> = {}) => ({
  ...sent,
  kind:"image" as const,
  before_path:"/source.png",
  after_path:"/current.png",
  width:512,
  height:384,
  sample_bytes:100,
  duration_ms:null,
  image_details:{
    sample_kind:"embedded_heic_thumbnail" as const,
    admitted_sample_width:512,
    admitted_sample_height:384,
    comparison_frame_width:512,
    comparison_frame_height:384,
    planned_output_width:4032,
    planned_output_height:3024,
    current_jpeg_quality:72,
    pinned_jpeg_quality:null,
    pinned_path:null,
  },
  ...overrides,
});

it("opens one bounded HEIC session and discloses sample and planned dimensions", async () => {
  mocks.generate.mockImplementationOnce(async sent => heicSample(sent));
  render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);

  fireEvent.click(await enabledPreview());

  expect(await screen.findByText("Embedded camera preview · 512 × 384")).toBeTruthy();
  expect(screen.getByText("Intended output · 4032 × 3024")).toBeTruthy();
  expect(screen.getByText(/cannot predict full-resolution detail, exact color fidelity, or final file size/i)).toBeTruthy();
  expect(mocks.begin).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].preview_session_id).toBe("11111111-1111-4111-8111-111111111111");
  expect(screen.getByRole("button",{name:"Current quality 72"}).getAttribute("aria-pressed")).toBe("true");
});

it("pins the current HEIC quality and supports source, current, pinned, and hold comparison", async () => {
  mocks.generate
    .mockImplementationOnce(async sent => heicSample(sent))
    .mockImplementationOnce(async sent => heicSample(sent,{
      image_details:{
        ...heicSample(sent).image_details,
        pinned_jpeg_quality:72,
        pinned_path:"/pinned.png",
      },
    }));
  render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Pin current quality 72"});

  fireEvent.click(screen.getByRole("button",{name:"Pin current quality 72"}));
  const pinned = await screen.findByRole("button",{name:"Pinned quality 72"});
  expect(mocks.generate.mock.calls[1][0].pinned_jpeg_quality).toBe(72);

  fireEvent.click(screen.getByRole("button",{name:"Source"}));
  expect(screen.getByAltText("Source sample").getAttribute("src")).toBe("asset:///source.png");
  fireEvent.click(pinned);
  expect(screen.getByAltText("Pinned quality 72 sample").getAttribute("src")).toBe("asset:///pinned.png");
  fireEvent.click(screen.getByRole("button",{name:"Current quality 72"}));
  const hold = screen.getByRole("button",{name:"Hold to show pinned quality 72"});
  fireEvent.pointerDown(hold);
  expect(screen.getByAltText("Pinned quality 72 sample")).toBeTruthy();
  fireEvent.pointerUp(hold);
  expect(screen.getByAltText("Current quality 72 sample")).toBeTruthy();
});

it("reuses the HEIC session across quality revisions and releases it on source change", async () => {
  mocks.generate.mockImplementation(async sent => heicSample(sent));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByText("Embedded camera preview · 512 × 384");

  view.rerender(<SettingsPreview request={{...heicRequest,image_options:{...heicRequest.image_options,jpeg_quality:84}}} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByText("Embedded camera preview · 512 × 384");
  expect(mocks.begin).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[1][0].preview_session_id).toBe(mocks.generate.mock.calls[0][0].preview_session_id);

  view.rerender(<SettingsPreview request={{...heicRequest,input_path:"/camera/other.heic"}} imageSettings={heicSettings}/>);
  expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
});

it("releases the HEIC session and artifacts when the preview closes", async () => {
  mocks.generate.mockImplementationOnce(async sent => heicSample(sent));
  render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByText("Embedded camera preview · 512 × 384");
  fireEvent.click(screen.getByRole("button",{name:"Close preview"}));
  expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  expect(screen.queryByText("Embedded camera preview · 512 × 384")).toBeNull();
});

it("keeps a pinned HEIC quality across same-source quality revisions", async () => {
  mocks.generate.mockImplementation(async sent => heicSample(sent,{
    after_path:`/current-${sent.image_options.jpeg_quality}.png`,
    image_details:{
      ...heicSample(sent).image_details,
      current_jpeg_quality:sent.image_options.jpeg_quality,
      pinned_jpeg_quality:sent.pinned_jpeg_quality ?? null,
      pinned_path:sent.pinned_jpeg_quality == null ? null : "/pinned.png",
    },
  }));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Pin current quality 72"});
  fireEvent.click(screen.getByRole("button",{name:"Pin current quality 72"}));
  await screen.findByRole("button",{name:"Pinned quality 72"});

  const latest = {...heicRequest,image_options:{...heicRequest.image_options,jpeg_quality:84}};
  view.rerender(<SettingsPreview request={latest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Current quality 84"});

  expect(mocks.generate.mock.calls[2][0].pinned_jpeg_quality).toBe(72);
  expect(mocks.begin).toHaveBeenCalledTimes(1);
});

it("does not retain pin intent when pinning fails", async () => {
  mocks.generate
    .mockImplementationOnce(async sent => heicSample(sent))
    .mockRejectedValueOnce(new Error("Pin failed"))
    .mockImplementationOnce(async sent => heicSample(sent));
  render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Pin current quality 72"});

  fireEvent.click(screen.getByRole("button",{name:"Pin current quality 72"}));
  expect((await screen.findByRole("alert")).textContent).toContain("Pin failed");
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Pin current quality 72"});

  expect(mocks.generate.mock.calls[2][0].pinned_jpeg_quality).toBeNull();
});

it("keeps a pinned HEIC quality while a same-source draft is temporarily invalid", async () => {
  mocks.generate.mockImplementation(async sent => heicSample(sent,{
    after_path:`/current-${sent.image_options.jpeg_quality}.png`,
    image_details:{
      ...heicSample(sent).image_details,
      current_jpeg_quality:sent.image_options.jpeg_quality,
      pinned_jpeg_quality:sent.pinned_jpeg_quality ?? null,
      pinned_path:sent.pinned_jpeg_quality == null ? null : "/pinned.png",
    },
  }));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Pin current quality 72"});
  fireEvent.click(screen.getByRole("button",{name:"Pin current quality 72"}));
  await screen.findByRole("button",{name:"Pinned quality 72"});

  view.rerender(<SettingsPreview request={heicRequest} imageSettings={heicSettings} blockedReason="JPEG quality is incomplete."/>);
  expect(screen.getByRole("button",{name:"Preview sample"})).toHaveProperty("disabled",true);
  expect(screen.getByText("JPEG quality is incomplete.")).toBeTruthy();

  const latest = {...heicRequest,image_options:{...heicRequest.image_options,jpeg_quality:84}};
  view.rerender(<SettingsPreview request={latest} imageSettings={heicSettings} blockedReason={null}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByRole("button",{name:"Pinned quality 72"});

  expect(mocks.generate.mock.calls[2][0].pinned_jpeg_quality).toBe(72);
  expect(mocks.begin).toHaveBeenCalledTimes(1);
});

it("releases the HEIC session on unmount", async () => {
  mocks.generate.mockImplementationOnce(async sent => heicSample(sent));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByText("Embedded camera preview · 512 × 384");
  view.unmount();
  expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
});

it("coalesces a pending HEIC session begin across same-source revisions", async () => {
  let resolveBegin!: (id:string)=>void;
  mocks.begin.mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveBegin=resolve;}));
  mocks.generate.mockImplementation(async sent => heicSample(sent,{
    image_details:{...heicSample(sent).image_details,current_jpeg_quality:sent.image_options.jpeg_quality},
  }));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  const latest = {...heicRequest,image_options:{...heicRequest.image_options,jpeg_quality:84}};
  view.rerender(<SettingsPreview request={latest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());

  expect(mocks.begin).toHaveBeenCalledTimes(1);
  await act(async()=>resolveBegin("11111111-1111-4111-8111-111111111111"));
  await screen.findByRole("button",{name:"Current quality 84"});
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].image_options.jpeg_quality).toBe(84);
});

it("serializes close and reopen behind cleanup of a pending HEIC session", async () => {
  let resolveBegin!: (id:string)=>void;
  mocks.begin
    .mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveBegin=resolve;}))
    .mockResolvedValueOnce("22222222-2222-4222-8222-222222222222");
  mocks.generate.mockImplementation(async sent => heicSample(sent));
  render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  fireEvent.click(screen.getByRole("button",{name:"Cancel preview"}));
  fireEvent.click(await enabledPreview());
  expect(mocks.begin).toHaveBeenCalledTimes(1);

  await act(async()=>resolveBegin("11111111-1111-4111-8111-111111111111"));
  await waitFor(()=>expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111"));
  await screen.findByText("Embedded camera preview · 512 × 384");
  expect(mocks.begin).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[0][0].preview_session_id).toBe("22222222-2222-4222-8222-222222222222");
});

it("serializes a source replacement behind cleanup of its pending HEIC session", async () => {
  let resolveBegin!: (id:string)=>void;
  mocks.begin
    .mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveBegin=resolve;}))
    .mockResolvedValueOnce("22222222-2222-4222-8222-222222222222");
  mocks.generate.mockImplementation(async sent => heicSample(sent));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  view.rerender(<SettingsPreview request={{...heicRequest,input_path:"/camera/other.heic"}} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  expect(mocks.begin).toHaveBeenCalledTimes(1);

  await act(async()=>resolveBegin("11111111-1111-4111-8111-111111111111"));
  await screen.findByText("Embedded camera preview · 512 × 384");
  expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  expect(mocks.begin).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[0][0].input_path).toBe("/camera/other.heic");
});

it("releases a pending HEIC session that resolves after unmount", async () => {
  let resolveBegin!: (id:string)=>void;
  mocks.begin.mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveBegin=resolve;}));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  view.unmount();
  await act(async()=>resolveBegin("11111111-1111-4111-8111-111111111111"));
  await waitFor(()=>expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111"));
  expect(mocks.generate).not.toHaveBeenCalled();
});

it("waits for a late HEIC begin to be released before generating a PNG preview", async () => {
  let resolveBegin!: (id:string)=>void;
  mocks.begin.mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveBegin=resolve;}));
  mocks.generate.mockImplementation(async sent => sample(sent));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  view.rerender(<SettingsPreview request={request}/>);
  fireEvent.click(await enabledPreview());
  expect(mocks.generate).not.toHaveBeenCalled();

  await act(async()=>resolveBegin("11111111-1111-4111-8111-111111111111"));
  await screen.findByAltText("Output sample");
  expect(mocks.release).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].preview_session_id).toBeUndefined();
});

it("waits for established HEIC session release before generating a video preview", async () => {
  let resolveRelease!: ()=>void;
  mocks.generate
    .mockImplementationOnce(async sent => heicSample(sent))
    .mockImplementationOnce(async sent => ({...sent,kind:"video",before_path:null,after_path:"/video.mp4",width:640,height:360,sample_bytes:100,duration_ms:1000}));
  const view = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByText("Embedded camera preview · 512 × 384");
  mocks.release.mockImplementationOnce(()=>new Promise<void>(resolve=>{resolveRelease=resolve;}));

  view.rerender(<SettingsPreview request={{...request,input_path:"/source.mp4",target:"mp4",video_options:null}}/>);
  fireEvent.click(await enabledPreview());
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  await act(async()=>resolveRelease());
  await screen.findByLabelText("Output video sample");
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][0].preview_session_id).toBeUndefined();
});

it("shares the HEIC release barrier across preview instance remounts", async () => {
  let resolveRelease!: ()=>void;
  mocks.generate
    .mockImplementationOnce(async sent => heicSample(sent))
    .mockImplementationOnce(async sent => sample(sent));
  const old = render(<SettingsPreview request={heicRequest} imageSettings={heicSettings}/>);
  fireEvent.click(await enabledPreview());
  await screen.findByText("Embedded camera preview · 512 × 384");
  mocks.release.mockImplementationOnce(()=>new Promise<void>(resolve=>{resolveRelease=resolve;}));
  old.unmount();

  render(<SettingsPreview request={request}/>);
  fireEvent.click(await enabledPreview());
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  await act(async()=>resolveRelease());
  await screen.findByAltText("Output sample");
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[1][0].preview_session_id).toBeUndefined();
});
