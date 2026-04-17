export type PdfOperationKind = "merge" | "split" | "compress";

interface PdfOperationPickerProps {
  selected: PdfOperationKind;
  onSelect: (kind: PdfOperationKind) => void;
  /** If the user dropped multiple PDFs, Split and Compress shouldn't be
   *  available — they act on a single PDF at a time. */
  multiFile: boolean;
}

interface Option {
  kind: PdfOperationKind;
  label: string;
  hint: string;
  multiFileOk: boolean;
}

const OPTIONS: Option[] = [
  { kind: "merge", label: "Merge", hint: "Combine PDFs in order", multiFileOk: true },
  {
    kind: "split",
    label: "Split",
    hint: "Extract page ranges into separate files",
    multiFileOk: false,
  },
  {
    kind: "compress",
    label: "Compress",
    hint: "Reduce file size via Ghostscript",
    multiFileOk: false,
  },
];

export default function PdfOperationPicker({
  selected,
  onSelect,
  multiFile,
}: PdfOperationPickerProps) {
  return (
    <div role="radiogroup" aria-label="PDF operation" className="flex flex-col gap-2">
      {OPTIONS.map((opt) => {
        const disabled = multiFile && !opt.multiFileOk;
        const active = selected === opt.kind;
        return (
          <button
            key={opt.kind}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(opt.kind)}
            className={`flex items-start gap-3 rounded-lg border p-3 text-left transition duration-fast ease-out ${
              active
                ? "border-accent bg-accent-subtle"
                : "border-subtle bg-surface-1 enabled:hover:border-accent/60"
            } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
          >
            <span
              className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                active ? "border-accent bg-accent" : "border-fg-muted"
              }`}
              aria-hidden
            >
              {active && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" aria-hidden />
              )}
            </span>
            <span>
              <span className="block text-sm font-medium text-fg">{opt.label}</span>
              <span className="block text-xs text-fg-muted">
                {opt.hint}
                {disabled && " (drop a single PDF to enable)"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
