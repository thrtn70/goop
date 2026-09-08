import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SettingsPreview from "../SettingsPreview";
const mocks=vi.hoisted(()=>({generate:vi.fn(),cancel:vi.fn().mockResolvedValue(undefined)}));
vi.mock("@/ipc/commands",()=>({api:{preview:mocks}}));
vi.mock("@tauri-apps/api/core",()=>({convertFileSrc:(path:string)=>"asset://"+path}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const request={input_path:"/image.png",target:"jpeg",quality_preset:null,resolution_cap:null,compress_mode:null,metadata_policy:"preserve",subtitle:null,gif_options:null} as const;
it("requests a sample only on demand and cancels when settings change", async()=>{
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const view=render(<SettingsPreview request={request}/>);
  expect(mocks.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  const sent=mocks.generate.mock.calls[0][0];
  view.rerender(<SettingsPreview request={{...request,target:"png"}}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(sent.request_id);
  await act(async()=>resolve({request_id:sent.request_id,source_revision:sent.source_revision,kind:"image",before_path:"/before.png",after_path:"/after.png",sample_bytes:100,width:2,height:2}));
  expect(screen.queryByAltText("Output sample")).toBeNull();
});
it("shows backend limitations and permits another request", async()=>{
  mocks.generate.mockRejectedValue(new Error("Sample preview is unavailable for this source"));
  render(<SettingsPreview request={request}/>);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("unavailable"));
});
it("retains a successful same-settings sample when replacement fails", async()=>{
  mocks.generate.mockImplementationOnce(async(sent)=>({...sent,kind:"image",before_path:"/before.png",after_path:"/after.png",width:2,height:2,sample_bytes:100,duration_ms:null}));
  render(<SettingsPreview request={request}/>);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  await screen.findByAltText("Output sample");
  const original=mocks.generate.mock.calls[0][0].request_id;
  mocks.generate.mockRejectedValueOnce(new Error("Replacement failed"));
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  await screen.findByRole("alert");
  expect(screen.getByAltText("Output sample")).toBeTruthy();
  expect(mocks.cancel).not.toHaveBeenCalledWith(original);
});

const imageSettings = { available:true, reason:null, quality_min:1, quality_max:100, default_quality:75, max_dimension:32768, max_output_pixels:100000000, fit_within:true, upscale:false, preview_original_available:true, preview_fit_within:false, preview_unavailable_reason:"Fit within image samples are not available yet." };
const explicit = {...request,input_path:"/photo.jpg",image_options:{jpeg_quality:30,resize:{kind:"original" as const}}};
const sample = (sent: {request_id:string;source_revision:string}, path = "/after.png") => ({...sent,kind:"image",before_path:"/before.png",after_path:path,width:2,height:2,sample_bytes:100,duration_ms:null});
it.each(["fit", "RAW", "HEIC", "oversized"])("disables %s previews with the engine descriptor reason", (source) => {
  const reason = source === "fit" ? imageSettings.preview_unavailable_reason : `${source} preview is unavailable`;
  const settings = {...imageSettings,preview_original_available:source === "fit",preview_unavailable_reason:reason};
  render(<SettingsPreview imageSettings={settings} request={{...explicit,image_options:{jpeg_quality:90,resize:source === "fit" ? {kind:"fit_within",width:2048,height:2048} : {kind:"original"}}}}/>);
  const button = screen.getByRole("button", {name:"Preview sample"});
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(button);
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("preserves legacy null eligibility even when explicit image controls are unsupported", () => {
  render(<SettingsPreview request={{...request,image_options:null}} imageSettings={{...imageSettings,available:false,preview_original_available:false}}/>);
  expect((screen.getByRole("button", {name:"Preview sample"}) as HTMLButtonElement).disabled).toBe(false);
});
it("cancels pending quality revisions, refuses late results, and sends the latest explicit intent", async () => {
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const view = render(<SettingsPreview request={explicit} imageSettings={imageSettings}/>);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  const old = mocks.generate.mock.calls[0][0];
  const latest = {...explicit,image_options:{...explicit.image_options,jpeg_quality:90}};
  view.rerender(<SettingsPreview request={latest} imageSettings={imageSettings}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(old.request_id);
  mocks.generate.mockImplementationOnce(async sent => sample(sent,"/latest.png"));
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  await screen.findByAltText("Output sample");
  const sent = mocks.generate.mock.calls[1][0];
  expect(sent.image_options).toEqual(latest.image_options);
  expect(sent.source_revision).not.toBe(old.source_revision);
  await act(async()=>resolve(sample(old,"/stale.png")));
  expect(screen.getByAltText("Output sample").getAttribute("src")).toBe("asset:///latest.png");
});
it("releases a displayed sample immediately when dimensions become unavailable", async () => {
  mocks.generate.mockImplementationOnce(async sent => sample(sent));
  const view = render(<SettingsPreview request={explicit} imageSettings={imageSettings}/>);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  await screen.findByAltText("Output sample");
  const sent = mocks.generate.mock.calls[0][0];
  view.rerender(<SettingsPreview request={{...explicit,image_options:{jpeg_quality:30,resize:{kind:"fit_within",width:512,height:512}}}} imageSettings={imageSettings}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(sent.request_id);
  expect(screen.queryByAltText("Output sample")).toBeNull();
  expect((screen.getByRole("button",{name:"Preview sample"}) as HTMLButtonElement).disabled).toBe(true);
});
it("cancels on descriptor invalidation without accepting the pending result", async () => {
  let resolve!: (value:unknown)=>void;
  mocks.generate.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const view = render(<SettingsPreview request={explicit} imageSettings={imageSettings}/>);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  const sent = mocks.generate.mock.calls[0][0];
  view.rerender(<SettingsPreview request={explicit} imageSettings={{...imageSettings,preview_original_available:false,preview_unavailable_reason:"Source now exceeds sample bounds"}}/>);
  expect(mocks.cancel).toHaveBeenCalledWith(sent.request_id);
  await act(async()=>resolve(sample(sent)));
  expect(screen.queryByAltText("Output sample")).toBeNull();
});

it.each([{kind:"copy" as const},{kind:"encode" as const,codec:"hevc" as const,processor:"software" as const,speed:"slow" as const,rate_control:{kind:"constant_quality" as const,crf:31}}])("never requests a legacy sample for explicit video %o", options => {
  render(<SettingsPreview request={{...request,target:"mp4",video_options:options}} videoSettings={{preview_unavailable_reason:"Engine says explicit samples are unavailable"}}/>);
  const button=screen.getByRole("button",{name:"Preview sample"});
  expect(button).toHaveProperty("disabled",true);
  expect(screen.getByText("Engine says explicit samples are unavailable")).toBeTruthy();
  fireEvent.click(button); expect(mocks.generate).not.toHaveBeenCalled();
});
it("keeps Automatic video samples available even when explicit previews are unavailable", async () => {
  mocks.generate.mockImplementationOnce(async sent => ({...sent,kind:"video",before_path:null,after_path:"/video.mp4",width:640,height:360,sample_bytes:100,duration_ms:1000}));
  render(<SettingsPreview request={{...request,input_path:"/source.mp4",target:"mp4",video_options:null}} videoSettings={{preview_unavailable_reason:"Custom unavailable"}}/>);
  fireEvent.click(screen.getByRole("button",{name:"Preview sample"}));
  await screen.findByLabelText("Output video sample");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.generate.mock.calls[0][0].video_options).toBeNull();
});
