import { describe, expect, it } from "vitest";
import { applyButtonLabel, applyOutcome, applyTooltip, compressSettingsLine, convertSettingsLine, inspectorBatchStatus, noPresetTarget, outputBreakdown, presetOutcome } from "../batchCopy";

const none = { image: 0, video: 0, audio: 0, subtitle: 0, unknown: 0 };
const base = { imageOptions: null, videoOptions: null, audioOptions: undefined, gifOptions: null, metadataPolicy: "preserve", imageColorPolicy: "preserve", qualityPreset: null } as const;
const fit = { jpeg_quality: 80, resize: { kind: "fit_within", width: 2048, height: 2048 } } as const;

describe("convertSettingsLine", () => {
  it.each([
    [{ ...base, target: "jpeg", imageOptions: fit, imageColorPolicy: "convert_to_srgb" }, "→ JPEG · Quality 80 · Fit 2048 × 2048 · sRGB"],
    [{ ...base, target: "jpeg", imageOptions: { jpeg_quality: 90, resize: { kind: "original" } }, metadataPolicy: "remove_personal" }, "→ JPEG · Quality 90 · No personal data"],
    [{ ...base, target: "png", metadataPolicy: "strip_all" }, "→ PNG · No metadata"],
    [{ ...base, target: "webp" }, "→ WebP"],
    [{ ...base, target: "jpeg_xl" }, "→ JXL"],
    [{ ...base, target: "mp4", videoOptions: { kind: "copy" } }, "→ MP4 · Copy video"],
    [{ ...base, target: "mp4", videoOptions: { kind: "encode", codec: "h264", rate_control: { kind: "constant_quality", crf: 23 }, speed: "medium", processor: "software" } }, "→ MP4 · H.264 CRF 23"],
    [{ ...base, target: "mov", videoOptions: { kind: "encode", codec: "hevc", rate_control: { kind: "average_bitrate", kbps: 8000 }, speed: "medium", processor: "software" } }, "→ MOV · HEVC 8000 kbps"],
    [{ ...base, target: "mp4", metadataPolicy: "strip_all", videoOptions: { kind: "hardware_encode", codec: "h264", hardware_policy: "required", rate_control: { kind: "average_bitrate", kbps: 8000 } } }, "→ MP4 · H.264 · Hardware · 8000 kbps"],
    [{ ...base, target: "mp4", qualityPreset: "small" }, "→ MP4 · Small"],
    [{ ...base, target: "mp4" }, "→ MP4 · Automatic settings"],
    [{ ...base, target: "mp3", audioOptions: { kind: "copy" } }, "→ MP3 · Copy audio"],
    [{ ...base, target: "mp3", audioOptions: { kind: "encode", bitrate: { kind: "target", kbps: 192 }, channels: { kind: "stereo" }, sample_rate: { kind: "exact", hz: 44100 } } }, "→ MP3 · 192 kbps · Stereo · 44.1 kHz"],
    [{ ...base, target: "mp3" }, "→ MP3 · Automatic settings"],
    [{ ...base, target: "gif", gifOptions: { size_preset: "medium", trim_start_ms: null, trim_end_ms: null } }, "→ GIF · Medium"],
  ])("%#", (entry, line) => expect(convertSettingsLine(entry as never)).toBe(line));
});

it("describes Compress modes", () => {
  expect(compressSettingsLine({ target: "jpeg", mode: { kind: "quality", value: 75 } })).toBe("→ JPEG · Quality 75");
  expect(compressSettingsLine({ target: "mp4", mode: { kind: "target_size_bytes", value: 26214400n } })).toBe("→ MP4 · Target 25.0 MB");
  expect(compressSettingsLine({ target: "png", mode: { kind: "lossless_reoptimize" } })).toBe("→ PNG · Lossless");
});

it("breaks a batch down by output, largest group first", () => {
  expect(outputBreakdown([{ target: "mp4" }, { target: "jpeg" }, { target: "jpeg" }])).toBe("2 → JPEG · 1 → MP4");
  expect(outputBreakdown([])).toBe("");
});

it("labels Apply by scope", () => {
  expect(applyButtonLabel("image", 12, 12, false)).toBe("Apply to all 12");
  expect(applyButtonLabel("image", 9, 12, false)).toBe("Apply to 9 images");
  expect(applyButtonLabel("video", 2, 12, false)).toBe("Apply to 2 videos");
  expect(applyButtonLabel("audio", 3, 12, false)).toBe("Apply to 3 audio files");
  expect(applyButtonLabel("subtitle", 2, 5, false)).toBe("Apply to 2 subtitle files");
  expect(applyButtonLabel("video", 1, 12, false)).toBeNull();
  expect(applyButtonLabel("image", 1, 3, true)).toBe("Apply to matching files");
  expect(applyTooltip("b.jpg", "image", false)).toBe("Copy b.jpg's settings to every image in the list");
  expect(applyTooltip("b.jpg", "image", true)).toBe("Copy b.jpg's settings to every file in the list");
});

it("reports outcomes in singular and plural", () => {
  expect(applyOutcome(9, "image", { ...none, video: 3 })).toBe("Applied to 9 images. 3 other files kept their settings.");
  expect(applyOutcome(2, "image", { ...none, unknown: 1 })).toBe("Applied to 2 images. 1 other file kept its settings.");
  expect(applyOutcome(12, "image", none)).toBe("Applied to all 12 files.");
  expect(presetOutcome("Web Image", { ...none, image: 9 }, { ...none, video: 3 })).toBe("Applied Web Image to 9 images. 3 videos kept their settings.");
  expect(presetOutcome("Podcast MP3", { ...none, video: 3, audio: 2 }, { ...none, image: 4 })).toBe("Applied Podcast MP3 to 5 files (3 videos, 2 audio files). 4 images kept their settings.");
  expect(presetOutcome("Photo", { ...none, image: 1 }, none)).toBe("Applied Photo to 1 image.");
  expect(presetOutcome("Photo", { ...none, image: 2 }, { ...none, image: 4, unknown: 1 })).toBe("Applied Photo to 2 images. 4 images and 1 file kept their settings.");
  expect(presetOutcome("Photo", { ...none, image: 2 }, { ...none, video: 1 })).toBe("Applied Photo to 2 images. 1 video kept its settings.");
  expect(presetOutcome("Photo", { ...none, image: 2 }, { ...none, subtitle: 1 })).toBe("Applied Photo to 2 images. 1 subtitle file kept its settings.");
  expect(noPresetTarget("webp")).toBe("None of these files can become WebP.");
  expect(inspectorBatchStatus("batch", "Web Image")).toBe("Batch settings from Web Image.");
  expect(inspectorBatchStatus("edited", "Web Image")).toBe("Changed for this file.");
  expect(inspectorBatchStatus(null, "")).toBeNull();
});
