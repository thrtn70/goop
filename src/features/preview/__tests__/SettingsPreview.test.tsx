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
