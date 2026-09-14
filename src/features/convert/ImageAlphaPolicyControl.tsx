import { useEffect, useId, useRef, useState } from "react";
import type { ImageAlphaCapabilities, ImageAlphaPolicy, TargetFormat } from "@/types";
import { parseSrgbHex, srgbHex } from "./imageAlphaPolicy";

export default function ImageAlphaPolicyControl({
  value,
  capabilities,
  target = "jpeg",
  onChange,
  onDraftEdit,
  onValidityChange,
}: {
  value: ImageAlphaPolicy | null | undefined;
  capabilities?: ImageAlphaCapabilities | null;
  target?: TargetFormat;
  onChange: (value: ImageAlphaPolicy | null) => void;
  onDraftEdit?: () => void;
  onValidityChange?: (problem: string | null) => void;
}) {
  const valueHex = value ? srgbHex(value.background) : "";
  const [custom, setCustom] = useState(valueHex);
  const [error, setError] = useState<string | null>(null);
  const validity = useRef(onValidityChange);
  validity.current = onValidityChange;
  const errorId = useId();
  const available = target === "jpeg" && (capabilities?.flatten.available ?? false);
  const reason = target !== "jpeg"
    ? "This saved background applies only to JPEG output."
    : capabilities?.flatten.reason
      ?? (capabilities ? capabilities.flatten.summary : "Fresh source inspection is required.");
  const suggested = capabilities ? srgbHex(capabilities.suggested_background) : null;
  const draftProblem = custom === valueHex
    ? null
    : parseSrgbHex(custom)
      ? "Apply the custom background before continuing."
      : "Enter six hexadecimal digits in #RRGGBB form.";
  const status = value
    ? target !== "jpeg" || !capabilities
      ? `Background ${valueHex} saved · inactive for this output`
      : !capabilities.flatten.available
        ? `Background ${valueHex} saved · unavailable for this source`
        : capabilities.source_has_alpha === false
          ? `Background ${valueHex} saved · no transparency found`
          : capabilities.source_has_alpha === true
            ? `Transparency over ${valueHex} · linear sRGB`
            : `Background ${valueHex} saved · applies when transparency is confirmed`
    : null;

  useEffect(() => {
    setCustom(valueHex);
    setError(null);
  }, [valueHex]);

  useEffect(() => {
    validity.current?.(draftProblem);
  }, [draftProblem]);

  useEffect(() => () => validity.current?.(null), []);

  const commit = (background: { red: number; green: number; blue: number }) => {
    if (!available) return;
    onDraftEdit?.();
    setCustom(srgbHex(background));
    setError(null);
    onChange({ kind: "flatten", background });
  };

  const commitCustom = () => {
    const parsed = parseSrgbHex(custom);
    if (!parsed) {
      setError("Enter six hexadecimal digits in #RRGGBB form.");
      return;
    }
    commit(parsed);
  };

  return (
    <fieldset className="mt-3 flex flex-col gap-2 text-xs">
      <legend className="text-fg-muted">JPEG removes transparency</legend>
      <p className="text-fg-secondary">
        {capabilities?.source_has_alpha === false
          ? "This source is opaque; the saved background will apply when transparency is present."
          : "Choose the opaque sRGB background used behind transparent pixels."}
        {suggested ? ` Suggested: ${suggested}.` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {[
          { label: "White", color: { red: 255, green: 255, blue: 255 } },
          { label: "Black", color: { red: 0, green: 0, blue: 0 } },
        ].map(({ label, color }) => {
          const selected = value ? srgbHex(value.background) === srgbHex(color) : false;
          return (
            <button
              key={label}
              type="button"
              disabled={!available}
              aria-pressed={selected}
              onClick={() => commit(color)}
              className={`btn-press rounded-md px-2 py-1 transition duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary enabled:hover:bg-surface-3 enabled:hover:text-fg"
              }`}
            >
              {label}
            </button>
          );
        })}
        <input
          type="color"
          aria-label="Choose custom background color"
          disabled={!available}
          value={valueHex || suggested || "#000000"}
          onChange={(event) => {
            const parsed = parseSrgbHex(event.target.value);
            if (parsed) commit(parsed);
          }}
          className="h-8 w-10 cursor-pointer rounded border border-subtle bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <input
          type="text"
          aria-label="Custom background"
          aria-invalid={error || draftProblem ? true : undefined}
          aria-describedby={error || draftProblem ? errorId : undefined}
          disabled={!available}
          inputMode="text"
          maxLength={7}
          placeholder="#RRGGBB"
          value={custom}
          onChange={(event) => {
            onDraftEdit?.();
            setCustom(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitCustom();
            }
          }}
          onBlur={() => {
            if (custom) commitCustom();
          }}
          className="w-24 rounded-md border border-subtle bg-surface-2 px-2 py-1 text-fg disabled:cursor-not-allowed disabled:opacity-50"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onDraftEdit?.();
              setCustom("");
              setError(null);
              onChange(null);
            }}
            className="rounded-md px-2 py-1 text-fg-secondary hover:text-fg"
          >
            Clear
          </button>
        )}
      </div>
      {!available && <p className="text-warning">{reason}</p>}
      {(error ?? draftProblem) && <p id={errorId} role="alert" className="text-warning">{error ?? draftProblem}</p>}
      {status && !draftProblem && (
        <p className="text-fg-secondary" role="status">
          {status}
        </p>
      )}
    </fieldset>
  );
}
