import { open } from "@tauri-apps/plugin-dialog";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { SubtitleMode, SubtitleOptions, TargetFormat } from "@/types";

/** Which subtitle modes a target container can accept.
 *
 * Mirrors `soft_codec` / `supports` in `crates/goop-converter/src/subtitle.rs`.
 * The backend rejects unsupported combinations too — this copy exists so the
 * UI can hide or disable controls before the user commits to them. */
export function subtitleSupport(target: TargetFormat): { soft: boolean; burn: boolean } {
  switch (target) {
    case "mp4":
    case "mov":
    case "mkv":
    case "webm":
      return { soft: true, burn: true };
    case "avi":
      return { soft: false, burn: true };
    default:
      return { soft: false, burn: false };
  }
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

interface SubtitleFieldProps {
  subtitle: SubtitleOptions | null;
  onChange: (subtitle: SubtitleOptions | null) => void;
  /** Modes the current target can accept. */
  support: { soft: boolean; burn: boolean };
}

/** Attach an external .srt/.vtt to a video conversion, as a selectable
 * track or burned into the frames. */
export default function SubtitleField({ subtitle, onChange, support }: SubtitleFieldProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);

  async function pickSubtitle() {
    try {
      const picked = await open({
        multiple: false,
        title: "Pick subtitle file",
        filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }],
      });
      if (typeof picked === "string") {
        // Prefer a soft track when the container allows it — it is
        // lossless and the viewer can switch it off.
        onChange({ source_path: picked, mode: support.soft ? "soft" : "burn_in" });
      }
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't open subtitle picker",
        detail: formatError(e),
      });
    }
  }

  if (!subtitle) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-fg-muted">Subtitles:</span>
        <button
          type="button"
          onClick={() => void pickSubtitle()}
          className="btn-press rounded-md bg-surface-2 px-2 py-1 text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg"
        >
          Add file...
        </button>
      </div>
    );
  }

  const modeButton = (mode: SubtitleMode, label: string, enabled: boolean, title: string) => (
    <button
      type="button"
      disabled={!enabled}
      aria-pressed={subtitle.mode === mode}
      onClick={() => onChange({ ...subtitle, mode })}
      title={title}
      className={`btn-press rounded-md px-2 py-1 transition duration-fast ease-out ${
        subtitle.mode === mode
          ? "bg-accent text-accent-fg"
          : enabled
            ? "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
            : "cursor-not-allowed bg-surface-0 text-fg-muted/40"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-fg-muted">Subtitles:</span>
      <span className="max-w-[14rem] truncate text-fg-secondary" title={subtitle.source_path}>
        {basename(subtitle.source_path)}
      </span>
      {modeButton(
        "soft",
        "Soft track",
        support.soft,
        support.soft
          ? "Add as a track the viewer can turn on and off"
          : "This format can't store a subtitle track",
      )}
      {modeButton(
        "burn_in",
        "Burn in",
        support.burn,
        "Draw the subtitles into the video (always re-encodes)",
      )}
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Remove subtitle"
        className="btn-press text-fg-muted transition duration-fast ease-out hover:text-error"
      >
        &times;
      </button>
    </div>
  );
}
