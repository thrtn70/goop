import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ConvertActionBar from "../ConvertActionBar";
import type { AudioConvertOptions } from "../audioOptions";
import CompressActionBar from "@/features/compress/CompressActionBar";
const mocks = vi.hoisted(() => ({ save: vi.fn(), enqueue: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
  open: vi.fn(),
}));
vi.mock("@/ipc/commands", () => ({
  api: { convert: { fromFile: mocks.enqueue } },
}));
vi.mock("@/features/presets/PresetSaveDialog", () => ({ default: () => null }));
afterEach(cleanup);
const file = {
  path: "/a.mp4",
  sourceDir: "/",
  target: "mp4" as const,
  gifOptions: null,
  metadataPolicy: "preserve" as const,
  subtitle: null,
  qualityPreset: null,
  resolutionCap: null,
};
for (const tool of ["convert", "compress"] as const) {
  it(`${tool} retains the pending dialog latch across remount and sends its original snapshot`, async () => {
    let resolve!: (path: string) => void;
    mocks.save.mockReset().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mocks.enqueue.mockReset().mockResolvedValue("job");
    const done = vi.fn();
    const view = () =>
      tool === "convert" ? (
        <ConvertActionBar files={[file]} disabled={false} onEnqueued={done} />
      ) : (
        <CompressActionBar
          files={[{ ...file, mode: { kind: "quality", value: 75 } }]}
          disabled={false}
          onEnqueued={done}
        />
      );
    const first = render(view());
    fireEvent.click(
      screen.getByRole("button", { name: /^(Convert|Compress) 1 file$/ }),
    );
    first.unmount();
    render(view());
    const button = screen.getByRole("button", {
      name: /Enqueuing|Choosing/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => resolve("/out.mp4"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0].input_path).toBe("/a.mp4");
  });
}

it("snapshots nested JPEG settings before the destination dialog even if the caller mutates its object", async () => {
  const options = { jpeg_quality: 90, resize: { kind: "fit_within" as const, width: 2048, height: 2048 } };
  let resolve!: (path: string) => void;
  mocks.save.mockReset().mockImplementation(() => new Promise(r => { resolve = r; }));
  mocks.enqueue.mockReset().mockResolvedValue("job");
  const done = vi.fn();
  render(<ConvertActionBar files={[{ ...file, path: "/a.jpg", target: "jpeg", imageOptions: options }]} disabled={false} onEnqueued={done} />);
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  options.jpeg_quality = 30; options.resize.width = 512;
  await act(async () => resolve("/out.jpg"));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_options).toEqual({ jpeg_quality: 90, resize: { kind: "fit_within", width: 2048, height: 2048 } });
});

it("snapshots a nested JPEG alpha background before the destination dialog", async () => {
  const alpha = { kind: "flatten" as const, background: { red: 17, green: 34, blue: 51 } };
  let resolve!: (path: string) => void;
  mocks.save.mockReset().mockImplementation(() => new Promise(r => { resolve = r; }));
  mocks.enqueue.mockReset().mockResolvedValue("job");
  const done = vi.fn();
  render(<ConvertActionBar files={[{
    ...file,
    path: "/a.png",
    target: "jpeg",
    imageColorPolicy: "assume_srgb",
    imageAlphaPolicy: alpha,
  }]} disabled={false} onEnqueued={done} />);
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  alpha.background.red = 200;
  await act(async () => resolve("/out.jpg"));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0].image_alpha_policy).toEqual({
    kind: "flatten",
    background: { red: 17, green: 34, blue: 51 },
  });
});

it("snapshots nested audio settings before the destination dialog", async () => {
  const options: Extract<AudioConvertOptions, { kind: "encode" }> = {
    kind: "encode" as const,
    bitrate: { kind: "target" as const, kbps: 320 },
    channels: { kind: "mono" as const },
    sample_rate: { kind: "exact" as const, hz: 44_100 },
  };
  let resolve!: (path: string) => void;
  mocks.save.mockReset().mockImplementation(() => new Promise(r => { resolve = r; }));
  mocks.enqueue.mockReset().mockResolvedValue("job");
  const done = vi.fn();
  render(<ConvertActionBar files={[{
    ...file,
    path: "/song.wav",
    target: "mp3",
    audioOptions: options,
    audioAvailability: { available: true, reason: null, copyAvailable: true, copyReason: null, encodeAvailable: true, encodeReason: null },
    audioSource: { audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false },
  }]} disabled={false} onEnqueued={done} />);
  fireEvent.click(screen.getByRole("button", { name: "Convert 1 file" }));
  options.bitrate = { kind: "target", kbps: 64 };
  options.channels = { kind: "stereo" };
  options.sample_rate = { kind: "exact", hz: 48_000 };
  await act(async () => resolve("/out.mp3"));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
    quality_preset: null,
    audio_options: {
      kind: "encode",
      bitrate: { kind: "target", kbps: 320 },
      channels: { kind: "mono" },
      sample_rate: { kind: "exact", hz: 44_100 },
    },
  });
});

it("queues mixed audio batches with each file's independent settings", async () => {
  mocks.save.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue("job");
  const done = vi.fn();
  const source = { audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false };
  const availability = { available: true, reason: null, copyAvailable: true, copyReason: null, encodeAvailable: true, encodeReason: null };
  render(<ConvertActionBar files={[
    {
      ...file,
      path: "/music/first.wav",
      target: "mp3",
      audioOptions: { kind: "encode", bitrate: { kind: "target", kbps: 320 }, channels: { kind: "mono" }, sample_rate: { kind: "exact", hz: 44_100 } },
      audioAvailability: availability,
      audioSource: source,
    },
    {
      ...file,
      path: "/music/second.m4a",
      target: "flac",
      audioOptions: { kind: "encode", bitrate: null, channels: { kind: "stereo" }, sample_rate: { kind: "exact", hz: 48_000 } },
      audioAvailability: availability,
      audioSource: source,
    },
  ]} disabled={false} onEnqueued={done} />);

  fireEvent.click(screen.getByRole("button", { name: "Convert 2 files" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  expect(mocks.enqueue.mock.calls.map(([request]) => request.audio_options)).toEqual([
    { kind: "encode", bitrate: { kind: "target", kbps: 320 }, channels: { kind: "mono" }, sample_rate: { kind: "exact", hz: 44_100 } },
    { kind: "encode", bitrate: null, channels: { kind: "stereo" }, sample_rate: { kind: "exact", hz: 48_000 } },
  ]);
});

const selectedTrackFixture = (path: string, index: number) => {
  const track = {
    index,
    codec_type: "audio",
    codec_name: { kind: "value" as const, value: "aac" },
    container_stream_id: { kind: "missing" as const },
    language: { kind: "value" as const, value: "eng" },
    title: { kind: "value" as const, value: index === 1 ? "Main" : "Commentary" },
    disposition: { default: index === 1, forced: false, attached_pic: false, other: {}, malformed: false },
  };
  const source = { version: 1, canonical_path: path, size_bytes: "10", modified_unix_ns: "20", inventory: { version: 1, streams: [track] } };
  return {
    trackOptions: { kind: "audio" as const, source, stream_index: index },
    trackSettings: { source, audio_choices: [{ track, copy: { available: true }, encode: { available: true } }] },
  };
};

it("requires a ready source-bound audio plan before enqueue", () => {
  const selected = selectedTrackFixture("/song.m4a", 1);
  const candidate = {
    ...file,
    path: "/song.m4a",
    target: "m4a" as const,
    audioOptions: { kind: "copy" as const },
    audioAvailability: { available: true, reason: null, copyAvailable: true, copyReason: null, encodeAvailable: true, encodeReason: null },
    audioSource: { audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false },
    ...selected,
  };
  const view = render(<ConvertActionBar files={[{ ...candidate, audioPlanReady: false }]} disabled={false} onEnqueued={() => {}} />);
  expect(screen.getByRole("button", { name: "Convert 1 file" })).toHaveProperty("disabled", true);
  view.rerender(<ConvertActionBar files={[{ ...candidate, audioPlanReady: true }]} disabled={false} onEnqueued={() => {}} />);
  expect(screen.getByRole("button", { name: "Convert 1 file" })).toHaveProperty("disabled", false);
});

it("owns distinct selected bindings before the batch's first await", async () => {
  mocks.enqueue.mockReset().mockResolvedValue("job");
  const first = selectedTrackFixture("/first.mkv", 1);
  const second = selectedTrackFixture("/second.mkv", 3);
  const common = {
    ...file,
    target: "m4a" as const,
    audioOptions: { kind: "copy" as const },
    audioAvailability: { available: true, reason: null, copyAvailable: true, copyReason: null, encodeAvailable: true, encodeReason: null },
    audioSource: { audioStreamCount: 2, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: true },
    audioPlanReady: true,
  };
  render(<ConvertActionBar files={[
    { ...common, path: "/first.mkv", ...first },
    { ...common, path: "/second.mkv", ...second },
  ]} disabled={false} onEnqueued={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Convert 2 files" }));
  first.trackOptions.source.modified_unix_ns = "999";
  second.trackOptions.source.inventory.streams[0].title = { kind: "value", value: "Changed" };
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
  expect(mocks.enqueue.mock.calls.map(([request]) => request.track_options)).toMatchObject([
    { stream_index: 1, source: { canonical_path: "/first.mkv", modified_unix_ns: "20" } },
    { stream_index: 3, source: { canonical_path: "/second.mkv", inventory: { streams: [{ title: { value: "Commentary" } }] } } },
  ]);
});

it("invalid raw audio bitrate blocks enqueue and preset saving", () => {
  mocks.save.mockReset();
  mocks.enqueue.mockReset();
  render(<ConvertActionBar files={[{
    ...file,
    path: "/song.wav",
    target: "mp3",
    audioOptions: { kind: "encode", bitrate: { kind: "target", kbps: 192 }, channels: { kind: "stereo" }, sample_rate: { kind: "exact", hz: 48_000 } },
    audioBitrateDraft: "19x",
    audioAvailability: { available: true, reason: null, copyAvailable: true, copyReason: null, encodeAvailable: true, encodeReason: null },
    audioSource: { audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false },
  }]} disabled={false} onEnqueued={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Convert 1 file" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save as preset" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/bitrate must be one of/i);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("Compress rejects unexpected image settings before opening a destination dialog", async () => {
  mocks.save.mockReset(); mocks.enqueue.mockReset();
  render(<CompressActionBar files={[{ ...file, mode: { kind: "quality", value: 75 }, imageOptions: { jpeg_quality: 90, resize: { kind: "original" } } }]} disabled={false} onEnqueued={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Compress 1 file" }));
  await screen.findByRole("alert");
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
});

const videoCapability = {copy:{available:true},encode:{available:true},codecs:[{codec:"h264" as const,encoder:"libx264",available:true,recommended_crf:23}],crf_min:1,crf_max:51,default_crf:23,bitrate_min_kbps:100,bitrate_max_kbps:200000,default_bitrate_kbps:5000,speeds:["medium" as const],default_speed:"medium" as const,processor:"software" as const,
  resize:{available:true,min_dimension:2,max_dimension:32768,no_enlargement:true,default:{kind:"original" as const}},
  frame_rate:{available:true,default:{kind:"preserve" as const},constant_choices:[{label:"23.976",frame_rate:{kind:"constant" as const,numerator:24000,denominator:1001}}]},preview_available:false};
it("snapshots active raw video controls before Save while retaining dormant Automatic quality", async () => {
  const options = {kind:"encode" as const,codec:"h264" as const,processor:"software" as const,speed:"medium" as const,rate_control:{kind:"constant_quality" as const,crf:23},
    resize:{kind:"fit_within" as const,width:1920,height:1080},frame_rate:{kind:"constant" as const,numerator:24000,denominator:1001}};
  const raw = {crfDraft:"31",widthDraft:"1280",heightDraft:"720"};
  let resolve!: (path:string) => void;
  mocks.save.mockReset().mockImplementation(() => new Promise(r => {resolve=r;}));
  mocks.enqueue.mockReset().mockResolvedValue("job");
  const done = vi.fn();
  render(<ConvertActionBar files={[{...file,qualityPreset:"balanced",videoOptions:options,videoCapability,videoDraft:raw}]} disabled={false} onEnqueued={done}/>);
  fireEvent.click(screen.getByRole("button",{name:"Convert 1 file"}));
  options.rate_control.crf=49; options.resize.width=640; options.frame_rate.numerator=60; raw.crfDraft=""; raw.widthDraft="";
  await act(async () => resolve("/out.mp4"));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({quality_preset:null,video_options:{kind:"encode",rate_control:{kind:"constant_quality",crf:31},
    resize:{kind:"fit_within",width:1280,height:720},frame_rate:{kind:"constant",numerator:24000,denominator:1001}}});
});
it("blank active CRF blocks enqueue and preset saving", () => {
  mocks.save.mockReset(); mocks.enqueue.mockReset();
  render(<ConvertActionBar files={[{...file,videoCapability,videoDraft:{crfDraft:""},videoOptions:{kind:"encode",codec:"h264",processor:"software",speed:"medium",rate_control:{kind:"constant_quality",crf:23}}}]} disabled={false} onEnqueued={vi.fn()}/>);
  expect((screen.getByRole("button",{name:"Convert 1 file"}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button",{name:"Save as preset"}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
});
