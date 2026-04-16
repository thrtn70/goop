import clsx from "clsx";
import type { TargetFormat, ProbeResult } from "@/types";

type TargetOption = {
  value: TargetFormat;
  label: string;
  group: "video" | "audio";
};

const TARGETS: TargetOption[] = [
  { value: "mp4", label: "MP4", group: "video" },
  { value: "mkv", label: "MKV", group: "video" },
  { value: "webm", label: "WebM", group: "video" },
  { value: "mp3", label: "MP3", group: "audio" },
  { value: "m4a", label: "M4A", group: "audio" },
  { value: "opus", label: "Opus", group: "audio" },
  { value: "wav", label: "WAV", group: "audio" },
  { value: "extract_audio_keep_codec", label: "Extract audio", group: "audio" },
];

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
  return (
    <div className="flex flex-wrap gap-1.5">
      {TARGETS.map((t) => {
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
  );
}
