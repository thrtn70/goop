import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AudioOptionsPanel from "../AudioOptionsPanel";
import { ConvertSettingsPanel } from "../FileRow";

afterEach(cleanup);

const available = {
  available: true,
  reason: null,
  copyAvailable: true,
  copyReason: null,
  encodeAvailable: true,
  encodeReason: null,
};

it("offers the bounded modes and target-owned MP3 controls", () => {
  const onChange = vi.fn();
  render(<AudioOptionsPanel
    target="mp3"
    value={null}
    availability={available}
    source={{ audioStreamCount: 1, sampleRateHz: 44_100, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false }}
    onChange={onChange}
  />);
  const processing = screen.getByRole("combobox", { name: "Audio processing" });
  expect(screen.getByRole("option", { name: "Automatic" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Copy audio" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Custom encode" })).toBeTruthy();
  expect(screen.getByText(/compatibility decides whether Goop copies or encodes/i)).toBeTruthy();
  expect(screen.getByText(/Source: 44.1 kHz · 2 channels/i)).toBeTruthy();
  fireEvent.change(processing, { target: { value: "encode" } });
  expect(onChange).toHaveBeenLastCalledWith({
    kind: "encode",
    bitrate: { kind: "target", kbps: 192 },
    channels: { kind: "preserve" },
    sample_rate: { kind: "exact", hz: 48_000 },
  });
});

it("explains that Copy cannot change encoding properties", () => {
  render(<AudioOptionsPanel
    target="m4a"
    value={{ kind: "copy" }}
    availability={available}
    source={{ audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false }}
    onChange={vi.fn()}
  />);
  expect(screen.getByText(/bitrate, channels, and sample rate cannot be changed/i)).toBeTruthy();
});

it("retains invalid bitrate text and explains lossless output truthfully", () => {
  const onChange = vi.fn();
  const onDraftEdit = vi.fn();
  const { rerender } = render(<AudioOptionsPanel
    target="mp3"
    value={{ kind: "encode", bitrate: { kind: "target", kbps: 192 }, channels: { kind: "preserve" }, sample_rate: { kind: "exact", hz: 48_000 } }}
    availability={{ ...available, bitrateChoicesKbps: [64, 96, 128, 160, 192, 256, 320] }}
    source={{ audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false }}
    onChange={onChange}
    onDraftEdit={onDraftEdit}
  />);
  const bitrate = screen.getByRole("combobox", { name: "Audio bitrate" }) as HTMLInputElement;
  fireEvent.change(bitrate, { target: { value: "19x" } });
  expect(bitrate.value).toBe("19x");
  expect(bitrate.getAttribute("aria-invalid")).toBe("true");
  expect(bitrate.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  expect(screen.getByRole("alert").textContent).toMatch(/bitrate must be one of/i);
  expect(onChange).not.toHaveBeenCalled();
  expect(onDraftEdit).toHaveBeenCalledOnce();

  rerender(<AudioOptionsPanel
    target="flac"
    value={{ kind: "encode", bitrate: null, channels: { kind: "preserve" }, sample_rate: { kind: "exact", hz: 48_000 } }}
    availability={{ ...available, bitrateChoicesKbps: [] }}
    source={{ audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: true, hasNonAudioStreams: false }}
    onChange={onChange}
  />);
  expect(screen.getByText(/FLAC is lossless/i)).toBeTruthy();
  expect(screen.queryByText(/Bitrate is an encoder target/i)).toBeNull();
});

it("shows truthful source omissions and blocks ambiguous explicit selection", () => {
  render(<AudioOptionsPanel
    target="flac"
    value={null}
    availability={available}
    source={{ audioStreamCount: 2, sampleRateHz: null, channelCount: null, channelLayoutReported: false, hasNonAudioStreams: true }}
    onChange={vi.fn()}
  />);
  expect(screen.getByText(/exactly one audio track/i)).toBeTruthy();
  expect(screen.getByText(/sample rate was not reported/i)).toBeTruthy();
  expect(screen.getByText(/channel layout was not reported/i)).toBeTruthy();
  expect(screen.getByText(/video, subtitles, and artwork are not included/i)).toBeTruthy();
  expect((screen.getByRole("option", { name: "Copy audio" }) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByRole("option", { name: "Custom encode" }) as HTMLOptionElement).disabled).toBe(true);
  expect(screen.queryByText(/preview/i)).toBeNull();
});

it("explains unavailable modes without hiding an already-restored choice", () => {
  render(<AudioOptionsPanel
    target="aac"
    value={{ kind: "copy" }}
    availability={{ ...available, copyAvailable: false, copyReason: "AAC copy is unavailable for this source codec" }}
    source={{ audioStreamCount: 1, sampleRateHz: 48_000, channelCount: 2, channelLayoutReported: false, hasNonAudioStreams: false }}
    onChange={vi.fn()}
  />);
  expect((screen.getByRole("combobox", { name: "Audio processing" }) as HTMLSelectElement).value).toBe("copy");
  expect(screen.getByText(/AAC copy is unavailable/)).toBeTruthy();
});

it("forwards raw audio edits through the row revision callback", () => {
  const onDraftEdit = vi.fn();
  render(<ConvertSettingsPanel
    path="/song.wav"
    draftIdentity="source-id"
    options={{
      target: "mp3",
      gifOptions: null,
      imageOptions: null,
      videoOptions: null,
      audioOptions: { kind: "encode", bitrate: { kind: "target", kbps: 192 }, channels: { kind: "preserve" }, sample_rate: { kind: "preserve" } },
      metadataPolicy: "preserve",
      subtitle: null,
      qualityPreset: null,
      resolutionCap: null,
    }}
    state={{
      phase: "ready",
      probe: {
        duration_ms: 1_000n,
        width: null,
        height: null,
        video_codec: null,
        audio_codec: "pcm_s16le",
        file_size: 1_024n,
        container: "wav",
        has_video: false,
        has_audio: true,
        source_kind: "audio",
        color_space: null,
        image_format: null,
        has_subtitles: false,
        subtitle_codecs: [],
        audio_codecs: ["pcm_s16le"],
        audio_details: {
          streams: [{ index: 0, codec_name: "pcm_s16le", sample_rate_hz: { kind: "exact", value: 48_000 }, channels: { kind: "exact", value: 2 }, channel_layout: "stereo", time_base: { kind: "exact", numerator: 1, denominator: 48_000 }, duration_ms: 1_000 }],
          has_non_audio_streams: false,
        },
      },
      capabilities: {
        compression: { quality: true, target_size: true, lossless: false, reason: null },
        targets: [{
          target: "mp3",
          available: true,
          reason: null,
          preserves_metadata: false,
          metadata_warning: null,
          audio_settings: {
            copy: { available: false, reason: "Copy requires MP3 source audio" },
            encode: { available: true, reason: null },
            target_codec: "mp3",
            encoder: "libmp3lame",
            bitrate_choices_kbps: [64, 96, 128, 160, 192, 256, 320],
            default_bitrate_kbps: 192,
            channel_choices: [{ kind: "preserve" }, { kind: "mono" }, { kind: "stereo" }],
            default_channels: { kind: "preserve" },
            sample_rate_choices: [{ kind: "preserve" }, { kind: "exact", hz: 44_100 }, { kind: "exact", hz: 48_000 }],
            default_sample_rate: { kind: "preserve" },
          },
        }],
      },
    }}
    onOptionsChange={vi.fn()}
    onDraftEdit={onDraftEdit}
  />);

  fireEvent.change(screen.getByRole("combobox", { name: "Audio bitrate" }), { target: { value: "19x" } });
  expect(onDraftEdit).toHaveBeenCalledOnce();
});
