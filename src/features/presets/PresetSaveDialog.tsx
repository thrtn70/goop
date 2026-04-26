import { useEffect, useRef, useState } from "react";
import type { CompressMode, Preset, QualityPreset, ResolutionCap, TargetFormat } from "@/types";
import { useAppStore } from "@/store/appStore";
import { formatError } from "@/ipc/error";

interface PresetSaveDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fields to snapshot into the preset. Omit what the current page doesn't
   * use (e.g. Convert passes quality/resolution, Compress passes
   * compress_mode).
   */
  snapshot: {
    target: TargetFormat;
    quality_preset?: QualityPreset | null;
    resolution_cap?: ResolutionCap | null;
    compress_mode?: CompressMode | null;
  };
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export default function PresetSaveDialog({ open, onClose, snapshot }: PresetSaveDialogProps) {
  const savePreset = useAppStore((s) => s.savePreset);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setBusy(false);
      // Focus on next tick so the element is mounted.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const preset: Preset = {
        id: newId(),
        name: trimmed,
        target: snapshot.target,
        quality_preset: snapshot.quality_preset ?? null,
        resolution_cap: snapshot.resolution_cap ?? null,
        compress_mode: snapshot.compress_mode ?? null,
        is_builtin: false,
        // Rust side ignores client created_at for ordering; the wire IPC
        // boundary converts this Number to i64.
        created_at: Date.now() as unknown as bigint,
      };
      await savePreset(preset);
      onClose();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Save preset"
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="enter-up w-80 rounded-lg bg-surface-1 p-5 shadow-xl">
        <h3 className="font-display text-sm font-semibold text-fg">Save as preset</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Give this combination a name so you can apply it again later.
        </p>
        <input
          ref={inputRef}
          aria-label="Preset name"
          aria-invalid={error ? true : false}
          aria-describedby="preset-name-error"
          className="mt-3 w-full rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          placeholder="e.g. YouTube Upload"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
            if (e.key === "Escape") onClose();
          }}
        />
        <div id="preset-name-error" className="text-xs">
          {error && <p role="alert" className="mt-2 text-error">{error}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-press rounded-md px-3 py-1.5 text-xs text-fg-muted transition duration-fast ease-out hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void handleSave()}
            className="btn-press rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
