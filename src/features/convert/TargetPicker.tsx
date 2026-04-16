import clsx from "clsx";
import type { TargetFormat, ProbeResult } from "@/types";

type TargetGroup = "video" | "audio" | "image";

type TargetOption = {
  value: TargetFormat;
  label: string;
  group: TargetGroup;
};

const TARGETS: TargetOption[] = [
  // Video
  { value: "mp4", label: "MP4", group: "video" },
  { value: "mkv", label: "MKV", group: "video" },
  { value: "webm", label: "WebM", group: "video" },
  { value: "gif", label: "GIF", group: "video" },
  { value: "avi", label: "AVI", group: "video" },
  { value: "mov", label: "MOV", group: "video" },
  // Audio
  { value: "mp3", label: "MP3", group: "audio" },
  { value: "m4a", label: "M4A", group: "audio" },
  { value: "opus", label: "Opus", group: "audio" },
  { value: "wav", label: "WAV", group: "audio" },
  { value: "flac", label: "FLAC", group: "audio" },
  { value: "ogg", label: "OGG", group: "audio" },
  { value: "aac", label: "AAC", group: "audio" },
  { value: "extract_audio_keep_codec", label: "Extract audio", group: "audio" },
  // Image
  { value: "png", label: "PNG", group: "image" },
  { value: "jpeg", label: "JPEG", group: "image" },
  { value: "webp", label: "WebP", group: "image" },
  { value: "bmp", label: "BMP", group: "image" },
];

const GROUP_LABELS: Record<TargetGroup, string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
};

function visibleGroups(probe: ProbeResult): TargetGroup[] {
  if (probe.source_kind === "image") return ["image"];
  const groups: TargetGroup[] = [];
  if (probe.has_video) groups.push("video");
  if (probe.has_audio) groups.push("audio");
  if (groups.length === 0) groups.push("video", "audio");
  return groups;
}

function isAvailable(t: TargetOption, probe: ProbeResult): { ok: boolean; reason?: string } {
  if (t.group === "video" && !probe.has_video) {
    return { ok: false, reason: "No video stream" };
  }
  if (t.group === "audio" && !probe.has_audio) {
    return { ok: false, reason: "No audio stream" };
  }
  if (t.value === "extract_audio_keep_codec" && !probe.has_audio) {
    return { ok: false, reason: "No audio to extract" };
  }
  return { ok: true };
}

export function smartDefault(probe: ProbeResult): TargetFormat {
  if (probe.source_kind === "image") return "png";
  if (!probe.has_video && probe.has_audio) return "extract_audio_keep_codec";
  const vc = probe.video_codec ?? "";
  const ac = probe.audio_codec ?? "";
  const ct = (probe.container ?? "").toLowerCase();
  if (ct.includes("matroska") || ct.includes("mkv")) return "mkv";
  if ((vc === "h264" && ac === "aac") || ct.includes("mp4")) return "mp4";
  return "mp4";
}

interface TargetPickerProps {
  probe: ProbeResult;
  selected: TargetFormat;
  onChange: (t: TargetFormat) => void;
}

export default function TargetPicker({ probe, selected, onChange }: TargetPickerProps) {
  const groups = visibleGroups(probe);

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group}>
          <span className="mb-1 block text-[10px] uppercase text-neutral-500">
            {GROUP_LABELS[group]}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {TARGETS.filter((t) => t.group === group).map((t) => {
              const { ok, reason } = isAvailable(t, probe);
              return (
                <button
                  key={t.value}
                  type="button"
                  disabled={!ok}
                  title={!ok ? reason : undefined}
                  onClick={() => onChange(t.value)}
                  className={clsx(
                    "rounded px-2.5 py-1 text-xs font-medium transition",
                    ok && selected === t.value && "bg-sky-600 text-white",
                    ok && selected !== t.value && "bg-neutral-800 text-neutral-300 hover:bg-neutral-700",
                    !ok && "cursor-not-allowed bg-neutral-900 text-neutral-600",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
