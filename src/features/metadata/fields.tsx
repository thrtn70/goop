import { useId } from "react";

/**
 * Map a form input back to the `AudioTags` field convention
 * (`null` = leave untouched, `""` = clear, `value` = set), given the
 * original value read from the file.
 *
 * - input unchanged from the original  → `null` (no-op)
 * - input emptied (original had value) → `""` (clear)
 * - input changed to a value           → that value (set)
 *
 * Note: an original of `""` is treated the same as an absent (`null`) field —
 * both collapse to "untouched" when the input is blank. Real tags rarely store
 * a literal empty string, so this edge case is benign in practice.
 */
export function diff(input: string, original: string | null): string | null {
  const base = original ?? "";
  if (input === base) return null;
  return input;
}

export function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric";
}

/** Labeled text input matching the PDF metadata form styling. */
export function TextField({ label, value, onChange, placeholder, inputMode }: TextFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs uppercase tracking-wide text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </div>
  );
}
