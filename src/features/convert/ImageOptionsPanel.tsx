import { useEffect, useId } from "react";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import type { ImageConvertOptions, ImageSettingsCapabilities } from "@/types";
import { imageDraftProblem, imageDraftValues } from "./imageOptions";

type ImageOptionsPanelProps = {
  value: ImageConvertOptions | null;
  capability: ImageSettingsCapabilities;
  sourceSize: { width: number; height: number };
  onChange: (value: ImageConvertOptions | null) => void;
  onDraftEdit?: () => void;
  onValidityChange?: (problem: string | null) => void;
};

function useField(name: "Quality" | "Width" | "Height", value: string) {
  const slot = name.charAt(0).toLowerCase() + name.slice(1);
  const [draft, setDraft] = useWorkspaceDraftState(`ImageOptionsPanel.${slot}Draft`, value);
  const [applied, setApplied] = useWorkspaceDraftState(`ImageOptionsPanel.applied${name}`, value);
  useEffect(() => {
    if (applied !== value) { setDraft(value); setApplied(value); }
  }, [applied, value, setDraft, setApplied]);
  return { draft, setDraft, applied, setApplied };
}

export default function ImageOptionsPanel({ value, capability, sourceSize, onChange, onDraftEdit, onValidityChange }: ImageOptionsPanelProps) {
  const id = useId();
  const values = imageDraftValues(value, capability);
  const quality = useField("Quality", values.quality);
  const width = useField("Width", values.width);
  const height = useField("Height", values.height);
  const raw = { qualityDraft: quality.draft, widthDraft: width.draft, heightDraft: height.draft, appliedQuality: quality.applied, appliedWidth: width.applied, appliedHeight: height.applied };
  const problem = imageDraftProblem(value, capability, raw);
  useEffect(() => { onValidityChange?.(problem); }, [onValidityChange, problem]);
  const effective: ImageConvertOptions = value ?? { jpeg_quality: capability.default_quality, resize: { kind: "original" } };
  function edit(field: "quality" | "width" | "height", text: string) {
    onDraftEdit?.();
    const control = field === "quality" ? quality : field === "width" ? width : height;
    control.setDraft(text);
    const number = Number(text);
    const min = field === "quality" ? capability.quality_min : 1;
    const max = field === "quality" ? capability.quality_max : capability.max_dimension;
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max) {
      // Even unfinished text is a material edit of legacy settings. Retain
      // explicit intent if the user changes output before correcting it.
      if (!value) onChange(effective);
      return;
    }
    control.setApplied(String(number));
    if (field === "quality") onChange({ ...effective, jpeg_quality: number });
    else if (effective.resize.kind === "fit_within") onChange({ ...effective, resize: { ...effective.resize, [field]: number } });
  }
  const fit = effective.resize.kind === "fit_within" ? effective.resize : null;
  const scale = fit ? Math.min(1, fit.width / sourceSize.width, fit.height / sourceSize.height) : 1;
  const output = { width: Math.max(1, Math.round(sourceSize.width * scale)), height: Math.max(1, Math.round(sourceSize.height * scale)) };
  const inputClass = "w-24 rounded-md bg-surface-2 px-2 py-1 text-fg tabular-nums focus:outline-none focus:ring-2 focus:ring-accent";
  return <section aria-label="Image settings" className="space-y-3 rounded-md bg-surface-0 p-3 text-xs">
    <h3 className="font-medium text-fg">Image</h3>
    {!value && <p className="text-fg-secondary">Default ({capability.default_quality}), Original size</p>}
    <label className="flex items-center justify-between gap-2">JPEG quality
      <input type="text" inputMode="numeric" aria-label="JPEG quality" aria-describedby={`${id}-quality ${id}-error`} aria-invalid={!!problem} className={inputClass} value={quality.draft} onChange={e => edit("quality", e.target.value)} />
    </label>
    <input type="range" aria-label="JPEG quality slider" min={capability.quality_min} max={capability.quality_max} step={1} value={Math.min(capability.quality_max, Math.max(capability.quality_min, effective.jpeg_quality))} onChange={e => edit("quality", e.target.value)} className="w-full accent-accent" />
    <p id={`${id}-quality`} className="text-fg-muted">Encoder quality, not a percentage of original fidelity. Quality 100 still re-encodes JPEG.</p>
    <label className="flex items-center justify-between gap-2">Dimensions
      <select aria-label="Image dimensions" className="rounded-md bg-surface-2 p-1" value={effective.resize.kind} onChange={e => {
        onDraftEdit?.();
        const defaultBound = Math.min(2048, capability.max_dimension);
        width.setDraft(String(defaultBound)); width.setApplied(String(defaultBound));
        height.setDraft(String(defaultBound)); height.setApplied(String(defaultBound));
        onChange({ ...effective, resize: e.target.value === "original" ? { kind: "original" } : { kind: "fit_within", width: defaultBound, height: defaultBound } });
      }}>
        <option value="original">Original size</option>
        <option value="fit_within" disabled={!capability.fit_within}>Fit within</option>
      </select>
    </label>
    {fit && <div className="flex flex-wrap gap-3">
      <label>Width (px) <input type="text" inputMode="numeric" aria-label="Image width" aria-describedby={`${id}-fit ${id}-error`} aria-invalid={!!problem} className={inputClass} value={width.draft} onChange={e => edit("width", e.target.value)} /></label>
      <label>Height (px) <input type="text" inputMode="numeric" aria-label="Image height" aria-describedby={`${id}-fit ${id}-error`} aria-invalid={!!problem} className={inputClass} value={height.draft} onChange={e => edit("height", e.target.value)} /></label>
    </div>}
    <p id={`${id}-fit`} className="text-fg-muted">Fits within these dimensions; smaller images stay their original size. Aspect ratio is preserved.</p>
    <p id={`${id}-error`} className="text-warning">{problem}</p>
    {!problem && <p className="text-fg-secondary">JPEG · Quality {effective.jpeg_quality} · {output.width} × {output.height} px upright</p>}
  </section>;
}
