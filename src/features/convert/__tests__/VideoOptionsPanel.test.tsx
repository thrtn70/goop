import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { resetWorkspaceDrafts } from "@/store/workspaceDrafts";
import type { VideoConvertOptions, VideoSettingsCapabilities } from "@/types";
import VideoOptionsPanel from "../VideoOptionsPanel";

const software = {kind:"encode",codec:"h264",processor:"software",speed:"slow",rate_control:{kind:"constant_quality",crf:31},resize:{kind:"original"},frame_rate:{kind:"preserve"}} as const;
const hardware = {kind:"hardware_encode",codec:"h264",hardware_policy:{kind:"required"},rate_control:{kind:"average_bitrate",kbps:6000},resize:{kind:"original"},frame_rate:{kind:"preserve"}} as const;
const capability = {copy:{available:true},encode:{available:true},codecs:[{codec:"h264",encoder:"libx264",available:true,recommended_crf:23}],crf_min:1,crf_max:51,default_crf:23,bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,speeds:["fast","medium","slow"],default_speed:"medium",processor:"software",
  resize:{available:true,min_dimension:2,max_dimension:32768,no_enlargement:true,default:{kind:"original"}},
  frame_rate:{available:true,default:{kind:"preserve"},constant_choices:[]},preview_available:false,
  hardware:{available:true,codec:"h264",bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,
    resize:{available:true,min_dimension:2,max_dimension:32768,no_enlargement:true,default:{kind:"original"}},frame_rate:{available:true,default:{kind:"preserve"},constant_choices:[]}},
} as unknown as VideoSettingsCapabilities;

afterEach(() => { cleanup(); resetWorkspaceDrafts(); });

function Harness({ initial = software as unknown as VideoConvertOptions, caps = capability, changed = vi.fn() }: {
  initial?: VideoConvertOptions | null; caps?: VideoSettingsCapabilities; changed?: (value: VideoConvertOptions | null) => void;
}) {
  const [value,setValue] = useState<VideoConvertOptions | null>(initial);
  return <VideoOptionsPanel file={{target:"mp4",videoOptions:value,videoCapability:caps}} capability={caps} sourceSize={{width:1920,height:1080}}
    onChange={next => { changed(next); setValue(next); }} onOriginalResolution={vi.fn()} onReplaceLegacyResolution={vi.fn()}/>;
}

it("requires deliberate Hardware bitrate entry and restores the exact inactive Software settings", () => {
  const changed = vi.fn();
  render(<Harness changed={changed}/>);
  fireEvent.change(screen.getByRole("combobox",{name:"Processor"}),{target:{value:"hardware_required"}});
  const bitrate = screen.getByRole("textbox",{name:"Hardware bitrate (kbps)"}) as HTMLInputElement;
  expect(bitrate.value).toBe("");
  expect(bitrate.placeholder).toBe("5000");
  expect(bitrate.getAttribute("aria-invalid")).toBe("true");
  expect(screen.queryByRole("combobox",{name:"Speed"})).toBeNull();
  expect(screen.queryByRole("textbox",{name:"CRF"})).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({kind:"hardware_encode",codec:"h264",hardware_policy:{kind:"required"},rate_control:{kind:"average_bitrate",kbps:5000}}));

  fireEvent.change(bitrate,{target:{value:"6000"}});
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({kind:"hardware_encode",rate_control:{kind:"average_bitrate",kbps:6000}}));
  fireEvent.change(screen.getByRole("combobox",{name:"Processor"}),{target:{value:"software"}});
  expect((screen.getByRole("textbox",{name:"CRF"}) as HTMLInputElement).value).toBe("31");
  expect((screen.getByRole("combobox",{name:"Speed"}) as HTMLSelectElement).value).toBe("slow");
});

it("keeps chosen Hardware required visible and blocked after capability loss without resetting it", () => {
  const changed = vi.fn();
  const unavailable = {...capability,hardware:{...capability.hardware!,available:false,reason:"Hardware session unavailable"}} as unknown as VideoSettingsCapabilities;
  render(<Harness initial={hardware as unknown as VideoConvertOptions} caps={unavailable} changed={changed}/>);
  expect((screen.getByRole("combobox",{name:"Processor"}) as HTMLSelectElement).value).toBe("hardware_required");
  expect(screen.getByRole("alert").textContent).toContain("Hardware session unavailable");
  expect(screen.queryByRole("combobox",{name:"Speed"})).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("opens Hardware required from Automatic when Software encoders are unavailable", () => {
  const changed = vi.fn();
  const hardwareOnly = {
    ...capability,
    encode: { available: false, reason: "Software encoder unavailable" },
    codecs: capability.codecs.map(codec => ({ ...codec, available: false })),
  } as VideoSettingsCapabilities;
  render(<Harness initial={null} caps={hardwareOnly} changed={changed}/>);
  fireEvent.change(screen.getByRole("combobox", { name: "Processing" }), { target: { value: "encode" } });
  expect((screen.getByRole("combobox", { name: "Processor" }) as HTMLSelectElement).value).toBe("hardware_required");
  const bitrate = screen.getByRole("textbox", { name: "Hardware bitrate (kbps)" });
  expect((bitrate as HTMLInputElement).value).toBe("");
  expect(bitrate.getAttribute("aria-invalid")).toBe("true");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "hardware_encode", rate_control: { kind: "average_bitrate", kbps: 5000 } }));
});
