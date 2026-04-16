import { useAppStore } from "@/store/appStore";
import type { Preset } from "@/types";

interface PresetChipsProps {
  kind: "convert" | "compress";
  onApply: (preset: Preset) => void;
}

/**
 * Horizontal scrollable chip row. Clicking a chip calls `onApply` with the
 * full preset; the page decides which fields are relevant to its form.
 *
 * On the Compress page we hide presets without a `compress_mode` since
 * they'd be no-ops there. Convert shows every preset.
 */
export default function PresetChips({ kind, onApply }: PresetChipsProps) {
  const presets = useAppStore((s) => s.presets);
  const filtered =
    kind === "compress" ? presets.filter((p) => p.compress_mode !== null) : presets;

  if (filtered.length === 0) return null;

  return (
    <div
      role="list"
      aria-label="Saved presets"
      className="flex gap-2 overflow-x-auto pb-2"
    >
      {filtered.map((p) => (
        <button
          key={p.id}
          type="button"
          role="listitem"
          onClick={() => onApply(p)}
          title={p.name}
          className="btn-press shrink-0 rounded-full border border-subtle bg-surface-1 px-3 py-1 text-xs text-fg-secondary transition duration-fast ease-out hover:border-accent hover:text-accent"
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
