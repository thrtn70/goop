import type { PdfQuality } from "@/types";

interface PdfCompressPickerProps {
  selected: PdfQuality;
  onSelect: (q: PdfQuality) => void;
}

const OPTIONS: { value: PdfQuality; label: string; hint: string }[] = [
  { value: "screen", label: "Screen", hint: "Smallest — 72 dpi images" },
  { value: "ebook", label: "Ebook", hint: "Balanced — ~150 dpi (recommended)" },
  { value: "printer", label: "Printer", hint: "Highest quality — 300 dpi" },
];

export default function PdfCompressPicker({
  selected,
  onSelect,
}: PdfCompressPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="PDF compression preset"
      className="flex flex-wrap gap-2"
    >
      {OPTIONS.map((opt) => {
        const active = selected === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(opt.value)}
            className={`btn-press rounded-md border px-3 py-2 text-left transition duration-fast ease-out ${
              active
                ? "border-accent bg-accent-subtle"
                : "border-subtle bg-surface-1 hover:border-accent/60"
            }`}
          >
            <span className="block text-sm font-medium text-fg">{opt.label}</span>
            <span className="block text-[10px] text-fg-muted">{opt.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
