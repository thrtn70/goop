import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAudioPlans, useVideoPlan, useVideoPlans } from "../useVideoPlan";
import type { AudioExecutionSummary, ConvertRequest, VideoExecutionSummary } from "@/types";
const { plan, audioPlan } = vi.hoisted(() => ({ plan: vi.fn(), audioPlan: vi.fn() }));
vi.mock("@/ipc/commands", () => ({api:{convert:{videoPlan:plan,audioPlan}}}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
const request: ConvertRequest = {input_path:"/a.mp4",output_path:"",target:"mp4",video_options:{kind:"copy"},quality_preset:null,resolution_cap:null,compress_mode:null,metadata_policy:"preserve",subtitle:null,gif_options:null,batch_id:null};
const summary: VideoExecutionSummary = {requested:{kind:"copy"},video_codec:"h264",video_stream_index:0,audio_copied:false,width:1920,height:1080,notices:[]};
it("debounces, keeps only the latest pending request, and discards stale replies", async () => {
  vi.useFakeTimers();
  const resolvers: ((v:VideoExecutionSummary)=>void)[] = [];
  plan.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  const view = renderHook(({req}) => useVideoPlan(req), {initialProps:{req:request as ConvertRequest|null}});
  await act(async () => vi.advanceTimersByTime(300));
  expect(plan).toHaveBeenCalledTimes(1);
  view.rerender({req:{...request,input_path:"/b.mp4"}});
  await act(async () => vi.advanceTimersByTime(300));
  view.rerender({req:{...request,input_path:"/c.mp4"}});
  await act(async () => vi.advanceTimersByTime(300));
  expect(plan).toHaveBeenCalledTimes(1);
  await act(async () => resolvers[0](summary));
  expect(view.result.current.summary).toBeNull();
  expect(plan).toHaveBeenCalledTimes(2);
  expect(plan.mock.calls[1][0].input_path).toBe("/c.mp4");
  await act(async () => resolvers[1]({...summary,width:640}));
  expect(view.result.current.summary?.width).toBe(640);
  view.rerender({req:null});
  expect(view.result.current.summary).toBeNull();
});
it("retains the native concurrency slot across route retirement and remount", async () => {
  vi.useFakeTimers();
  const resolvers: ((v:VideoExecutionSummary)=>void)[] = [];
  plan.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  const first = renderHook(() => useVideoPlan(request));
  await act(async () => vi.advanceTimersByTime(300));
  first.unmount();
  const next = renderHook(() => useVideoPlan({...request,input_path:"/new.mp4"}));
  await act(async () => vi.advanceTimersByTime(300));
  expect(plan).toHaveBeenCalledTimes(1);
  await act(async () => resolvers[0](summary));
  expect(plan).toHaveBeenCalledTimes(2);
  expect(next.result.current.summary).toBeNull();
  await act(async () => resolvers[1](summary));
  expect(next.result.current.summary).toEqual(summary);
});
it("does not resurrect an old successful plan when returning to a previous request", async () => {
  vi.useFakeTimers(); plan.mockResolvedValue(summary);
  const view = renderHook(({req}) => useVideoPlan(req), {initialProps:{req:request}});
  await act(async () => vi.advanceTimersByTime(300));
  expect(view.result.current.summary).toEqual(summary);
  view.rerender({req:{...request,input_path:"/b.mp4"}});
  view.rerender({req:request});
  expect(view.result.current.summary).toBeNull();
  await act(async () => vi.advanceTimersByTime(300));
});
it("debounces edits before native work and discards retired errors", async () => {
  vi.useFakeTimers();
  let reject!: (error:Error)=>void;
  plan.mockImplementationOnce(() => new Promise((_resolve, fail) => {reject=fail;})).mockResolvedValue(summary);
  const view = renderHook(({req}) => useVideoPlan(req), {initialProps:{req:request}});
  await act(async () => vi.advanceTimersByTime(100));
  view.rerender({req:{...request,input_path:"/b.mp4"}});
  await act(async () => vi.advanceTimersByTime(100));
  expect(plan).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(150));
  expect(plan).toHaveBeenCalledTimes(1);
  view.rerender({req:{...request,input_path:"/c.mp4"}});
  await act(async () => vi.advanceTimersByTime(250));
  await act(async () => reject(new Error("Retired source failed")));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.summary).toEqual(summary);
});

const row = (id:string, crf=23) => ({id,sourceIdentity:id,request:{...request,input_path:"/"+id+".mp4",video_options:{kind:"encode" as const,codec:"h264" as const,processor:"software" as const,speed:"medium" as const,rate_control:{kind:"constant_quality" as const,crf}}}});
it("plans all current rows serially and invalidates only changed rows", async () => {
  vi.useFakeTimers(); plan.mockResolvedValue(summary);
  const view=renderHook(({rows})=>useVideoPlans(rows),{initialProps:{rows:[row("a"),row("b")]}});
  await act(async()=>vi.advanceTimersByTime(300));
  expect(plan).toHaveBeenCalledTimes(2);
  expect(view.result.current.a.summary).toEqual(summary); expect(view.result.current.b.summary).toEqual(summary);
  view.rerender({rows:[row("a",31),row("b")]});
  expect(view.result.current.a.summary).toBeNull(); expect(view.result.current.b.summary).toEqual(summary);
  await act(async()=>vi.advanceTimersByTime(300)); expect(plan).toHaveBeenCalledTimes(3);
  expect(plan.mock.calls[2][0].input_path).toBe("/a.mp4");
});
it("keeps only each row's latest pending snapshot and retires removed rows", async () => {
  vi.useFakeTimers(); const resolvers: ((v:VideoExecutionSummary)=>void)[]=[];
  plan.mockImplementation(()=>new Promise(resolve=>resolvers.push(resolve)));
  const view=renderHook(({rows})=>useVideoPlans(rows),{initialProps:{rows:[row("a"),row("b"),row("c")]}});
  await act(async()=>vi.advanceTimersByTime(300)); expect(plan).toHaveBeenCalledTimes(1);
  view.rerender({rows:[row("a"),row("b",25),row("c")]}); await act(async()=>vi.advanceTimersByTime(300));
  view.rerender({rows:[row("a"),row("b",31)]}); await act(async()=>vi.advanceTimersByTime(300));
  expect(plan).toHaveBeenCalledTimes(1);
  await act(async()=>resolvers[0](summary));
  expect(plan).toHaveBeenCalledTimes(2); expect(plan.mock.calls[1][0].video_options.rate_control.crf).toBe(31);
  await act(async()=>resolvers[1](summary));
  expect(view.result.current.c).toBeUndefined(); expect(plan).toHaveBeenCalledTimes(2);
});
it("retains one native slot across batch remount and suppresses removed active errors", async () => {
  vi.useFakeTimers(); let reject!: (error:Error)=>void; const resolvers: ((v:VideoExecutionSummary)=>void)[]=[];
  plan.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;})).mockImplementation(()=>new Promise(resolve=>resolvers.push(resolve)));
  const first=renderHook(()=>useVideoPlans([row("a"),row("b")]));
  await act(async()=>vi.advanceTimersByTime(300)); first.unmount();
  const next=renderHook(()=>useVideoPlans([row("c"),row("d")])); await act(async()=>vi.advanceTimersByTime(300));
  expect(plan).toHaveBeenCalledTimes(1);
  await act(async()=>reject(new Error("Retired a failed")));
  expect(plan).toHaveBeenCalledTimes(2); expect(plan.mock.calls[1][0].input_path).toBe("/c.mp4");
  expect(next.result.current.c.error).toBeNull();
  await act(async()=>resolvers[0](summary)); expect(plan).toHaveBeenCalledTimes(3);
  expect(plan.mock.calls[2][0].input_path).toBe("/d.mp4");
  await act(async()=>resolvers[1](summary));
});
it("captures exact nested dimensions and frame timing before deferred planning", async () => {
  vi.useFakeTimers(); plan.mockResolvedValue(summary);
  const nested: ConvertRequest = {...request,video_options:{kind:"encode",codec:"h264",processor:"software",speed:"medium",rate_control:{kind:"constant_quality",crf:23},resize:{kind:"fit_within",width:1280,height:721},frame_rate:{kind:"constant",numerator:24000,denominator:1001}}};
  renderHook(() => useVideoPlan(nested));
  if (nested.video_options?.kind !== "encode" || nested.video_options.resize?.kind !== "fit_within" || nested.video_options.frame_rate?.kind !== "constant") throw new Error("bad fixture");
  nested.video_options.resize.width = 640;
  nested.video_options.frame_rate.numerator = 24;
  await act(async()=>vi.advanceTimersByTime(300));
  expect(plan.mock.calls[0][0].video_options.resize).toEqual({kind:"fit_within",width:1280,height:721});
  expect(plan.mock.calls[0][0].video_options.frame_rate).toEqual({kind:"constant",numerator:24000,denominator:1001});
});

it("shares the bounded planner with source-bound audio requests and owns the binding snapshot", async () => {
  vi.useFakeTimers();
  const audioSummary: AudioExecutionSummary = {
    requested: { kind: "copy" }, encoder: null, codec: "aac", audio_stream_index: 3,
    copied: true, sample_rate_hz: 48_000, channels: 2, channel_layout: "stereo",
    sample_format: null, bit_depth: null, reported_bitrate_kbps: null, notices: [],
  };
  audioPlan.mockResolvedValue(audioSummary);
  const source = { version: 1, canonical_path: "/movie.mkv", size_bytes: "10", modified_unix_ns: "20", inventory: { version: 1, streams: [] } };
  const audioRequest: ConvertRequest = {
    ...request,
    target: "m4a",
    video_options: null,
    audio_options: { kind: "copy" },
    track_options: { kind: "audio", source, stream_index: 3 },
  };
  renderHook(() => useAudioPlans([{ id: "audio", request: audioRequest, sourceIdentity: "audio:1" }]));
  source.modified_unix_ns = "99";
  await act(async () => vi.advanceTimersByTime(300));
  expect(audioPlan).toHaveBeenCalledOnce();
  expect(audioPlan.mock.calls[0][0].track_options.source.modified_unix_ns).toBe("20");
});
