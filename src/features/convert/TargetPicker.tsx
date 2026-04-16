import clsx from "clsx";
import type { TargetFormat, ProbeResult } from "@/types";

type TargetGroup = "video" | "audio" | "image";

type TargetOption = {
  value: TargetFormat;
  label: string;
  hint: string;
  group: TargetGroup;
};

const TARGETS: TargetOption[] = [
  // Video
  { value: "mp4", label: "MP4", hint: "Best compatibility, works everywhere", group: "video" },
  { value: "mkv", label: "MKV", hint: "Flexible container, great for archiving", group: "video" },
  { value: "webm", label: "WebM", hint: "Optimized for web playback", group: "video" },
  { value: "gif", label: "GIF", hint: "Animated image, no sound", group: "video" },
  { value: "avi", label: "AVI", hint: "Legacy format, large files", group: "video" },
  { value: "mov", label: "MOV", hint: "Apple QuickTime format", group: "video" },
  // Audio
  { value: "mp3", label: "MP3", hint: "Universal audio, good quality", group: "audio" },
  { value: "m4a", label: "M4A", hint: "Apple audio, better quality than MP3", group: "audio" },
  { value: "opus", label: "Opus", hint: "Modern codec, small files", group: "audio" },
  { value: "wav", label: "WAV", hint: "Uncompressed, lossless", group: "audio" },
  { value: "flac", label: "FLAC", hint: "Lossless, smaller than WAV", group: "audio" },
  { value: "ogg", label: "OGG", hint: "Open format, good quality", group: "audio" },
  { value: "aac", label: "AAC", hint: "Modern MP3 alternative", group: "audio" },
  { value: "extract_audio_keep_codec", label: "Extract audio", hint: "Pull audio out as-is, no re-encoding", group: "audio" },
  // Image
  { value: "png", label: "PNG", hint: "Lossless, supports transparency", group: "image" },
  { value: "jpeg", label: "JPEG", hint: "Small files, good for photos", group: "image" },
  { value: "webp", label: "WebP", hint: "Modern format, smallest files", group: "image" },
  { value: "bmp", label: "BMP", hint: "Uncompressed bitmap", group: "image" },
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
  const recommended = smartDefault(probe);

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group}>
          <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
            {GROUP_LABELS[group]}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {TARGETS.filter((t) => t.group === group).map((t) => {
              const { ok, reason } = isAvailable(t, probe);
              const isRecommended = ok && t.value === recommended;
              return (
                <button
                  key={t.value}
                  type="button"
                  disabled={!ok}
                  title={!ok ? reason : isRecommended ? `${t.hint} (recommended)` : t.hint}
                  aria-label={!ok ? `${t.label}, unavailable: ${reason}` : undefined}
                  onClick={() => onChange(t.value)}
                  className={clsx(
                    "btn-press rounded-md px-2.5 py-1 text-xs font-medium transition duration-fast ease-out",
                    ok && selected === t.value && "bg-accent text-accent-fg",
                    ok && selected !== t.value && "bg-surface-2 text-fg-secondary hover:bg-surface-3",
                    !ok && "cursor-not-allowed bg-surface-0 text-fg-muted/40",
                  )}
                >
                  {t.label}
                  {isRecommended && selected !== t.value && (
                    <span aria-hidden="true" className="ml-1 text-[9px] font-normal text-accent">*</span>
                  )}
                </button>
              );
            })}
          </div>
          {TARGETS.some((t) => t.group === group && t.value === recommended) && (
            <p className="mt-1 text-[10px] text-fg-muted/60">* recommended for this file</p>
          )}
        </div>
      ))}
    </div>
  );
}
