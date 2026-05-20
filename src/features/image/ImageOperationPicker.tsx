/**
 * Operation picker for the Image Workshop route. Mirrors the layout +
 * `aria-pressed` interaction model used by `PdfOperationPicker` so the
 * two surfaces feel like siblings. Multi-file ops mark `multiFileOk`;
 * the consuming page disables single-file ops when more than one image
 * is loaded.
 */

export type ImageOperationKind =
  | "rotate"
  | "resize"
  | "crop"
  | "watermark"
  | "recompress"
  | "app_icon";

interface ImageOperationPickerProps {
  selected: ImageOperationKind;
  onSelect: (kind: ImageOperationKind) => void;
  /** True when the user has more than one image loaded. */
  multiFile: boolean;
}

interface Option {
  kind: ImageOperationKind;
  label: string;
  hint: string;
  multiFileOk: boolean;
  /** Phases 5-7 ops are listed in the picker but disabled with a "coming
   *  soon" tag until their phase lands. Keeps the surface stable across
   *  the release window without lying about availability. */
  comingSoon?: boolean;
}

const OPTIONS: Option[] = [
  {
    kind: "rotate",
    label: "Rotate",
    hint: "Spin 90°, 180°, or 270° clockwise",
    multiFileOk: false,
  },
  {
    kind: "resize",
    label: "Resize",
    hint: "Change pixel dimensions or scale by %",
    multiFileOk: false,
  },
  {
    kind: "crop",
    label: "Crop",
    hint: "Trim to a rectangle with aspect-ratio presets",
    multiFileOk: false,
  },
  {
    kind: "watermark",
    label: "Watermark",
    hint: "Overlay text in a corner of the image",
    multiFileOk: false,
  },
  {
    kind: "recompress",
    label: "Recompress",
    hint: "Re-encode several images at the same quality",
    multiFileOk: true,
  },
  {
    kind: "app_icon",
    label: "App icon",
    hint: ".icns / .ico / favicon PNG set from one source image",
    multiFileOk: false,
  },
];

export default function ImageOperationPicker({
  selected,
  onSelect,
  multiFile,
}: ImageOperationPickerProps) {
  return (
    <div aria-label="Image operation" className="flex flex-col gap-2">
      {OPTIONS.map((opt) => {
        const disabled = (multiFile && !opt.multiFileOk) || opt.comingSoon;
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
                <span
                  className="h-1.5 w-1.5 rounded-full bg-accent-fg"
                  aria-hidden="true"
                />
              )}
            </span>
            <span>
              <span className="block text-sm font-medium text-fg">
                {opt.label}
                {opt.comingSoon && (
                  <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
                    soon
                  </span>
                )}
              </span>
              <span className="block text-xs text-fg-muted">
                {opt.hint}
                {!opt.comingSoon && multiFile && !opt.multiFileOk && (
                  <> (drop a single image to enable)</>
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
