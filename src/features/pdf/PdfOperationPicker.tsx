export type PdfOperationKind =
  | "merge"
  | "split"
  | "compress"
  | "reorder"
  | "delete_pages"
  | "rotate"
  | "extract_pages"
  | "insert_blank"
  | "set_metadata"
  | "extract_text"
  | "extract_images"
  | "images_to_pdf"
  | "pdf_ocr"
  | "image_ocr";

interface PdfOperationPickerProps {
  selected: PdfOperationKind;
  onSelect: (kind: PdfOperationKind) => void;
  /** If the user dropped multiple PDFs, only Merge is available —
   *  every other op acts on a single PDF at a time. */
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
    hint: "Slice a PDF into one file per page range",
    multiFileOk: false,
  },
  {
    kind: "extract_pages",
    label: "Extract pages",
    hint: "Pull page ranges into a single new PDF",
    multiFileOk: false,
  },
  {
    kind: "reorder",
    label: "Reorder pages",
    hint: "Drag pages into a new order",
    multiFileOk: false,
  },
  {
    kind: "delete_pages",
    label: "Delete pages",
    hint: "Mark pages to drop, keep the rest",
    multiFileOk: false,
  },
  {
    kind: "rotate",
    label: "Rotate pages",
    hint: "Spin individual pages 90° clockwise",
    multiFileOk: false,
  },
  {
    kind: "insert_blank",
    label: "Insert blank pages",
    hint: "Add blank Letter-sized pages at chosen positions",
    multiFileOk: false,
  },
  {
    kind: "set_metadata",
    label: "Edit metadata",
    hint: "Title, author, subject, keywords",
    multiFileOk: false,
  },
  {
    kind: "compress",
    label: "Compress",
    hint: "Reduce file size via Ghostscript",
    multiFileOk: false,
  },
  {
    kind: "extract_text",
    label: "Extract text",
    hint: "Save the PDF's text layer to a .txt file",
    multiFileOk: false,
  },
  {
    kind: "extract_images",
    label: "Extract images",
    hint: "Export every page as PNG or JPEG",
    multiFileOk: false,
  },
  {
    kind: "images_to_pdf",
    label: "Images to PDF",
    hint: "Combine images into a single PDF, one per page",
    multiFileOk: true,
  },
  {
    kind: "pdf_ocr",
    label: "OCR",
    hint: "Make a scanned PDF searchable",
    multiFileOk: false,
  },
];

export default function PdfOperationPicker({
  selected,
  onSelect,
  multiFile,
}: PdfOperationPickerProps) {
  // Plain <button>s with aria-pressed rather than role="radio" inside
  // role="radiogroup": the ARIA radio pattern requires roving-tabindex
  // + arrow-key handlers (NVDA/JAWS expect ArrowUp/Down to cycle), and
  // we'd rather have a working Tab-and-click pattern than a broken
  // radio-group contract. Visually still a radio-style picker.
  return (
    <div aria-label="PDF operation" className="flex flex-col gap-2">
      {OPTIONS.map((opt) => {
        const disabled = multiFile && !opt.multiFileOk;
        const active = selected === opt.kind;
        return (
          <button
            key={opt.kind}
            type="button"
            aria-pressed={active}
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
              aria-hidden="true"
            >
              {active && (
                <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" aria-hidden="true" />
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
