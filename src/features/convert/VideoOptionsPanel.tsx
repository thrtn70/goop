import { useEffect, useId } from "react";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import type { VideoConvertOptions, VideoFrameRate, VideoRationalFact, VideoSettingsCapabilities } from "@/types";
import { cloneVideoOptions, videoOptionsError, type VideoDraftFile } from "./videoOptions";

type Encode = Extract<VideoConvertOptions, { kind: "encode" }>;
function useRateField(slot: "Crf" | "Bitrate", numeric: number | undefined, initial: number) {
  const [draft, setDraft] = useWorkspaceDraftState("VideoOptionsPanel." + (slot === "Crf" ? "crf" : "bitrate") + "Draft", String(numeric ?? initial));
  const [applied, setApplied] = useWorkspaceDraftState("VideoOptionsPanel.applied" + slot, String(numeric ?? initial));
  useEffect(() => {
    if (numeric !== undefined && applied !== String(numeric)) { setDraft(String(numeric)); setApplied(String(numeric)); }
  }, [numeric, applied, setDraft, setApplied]);
  return { draft, applied, setDraft, setApplied };
}
function useDimensionField(slot: "Width" | "Height", numeric: number | undefined, initial: number) {
  const key = slot.toLowerCase();
  const [draft, setDraft] = useWorkspaceDraftState(`VideoOptionsPanel.${key}Draft`, String(numeric ?? initial));
  const [applied, setApplied] = useWorkspaceDraftState(`VideoOptionsPanel.applied${slot}`, String(numeric ?? initial));
  useEffect(() => {
    if (numeric !== undefined && applied !== String(numeric)) { setDraft(String(numeric)); setApplied(String(numeric)); }
  }, [numeric, applied, setDraft, setApplied]);
  return { draft, applied, setDraft, setApplied };
}
function rational(fact: VideoRationalFact | null | undefined): string | null {
  return fact?.kind === "exact" ? `${fact.numerator}/${fact.denominator}` : null;
}
function reported(label: string, fact: VideoRationalFact | null | undefined, suffix = "") {
  if (!fact) return null;
  const value = rational(fact);
  return value ? `${label} ${value}${suffix}` : `${label} unavailable`;
}
function rateKey(rate: VideoFrameRate | null | undefined) {
  return rate?.kind === "constant" ? `${rate.numerator}/${rate.denominator}` : rate?.kind ?? "previous";
}
const legacyWidths = { r1080p: 1920, r720p: 1280, r480p: 854 } as const;
function integerDraftInvalid(value: string, min: number, max: number) {
  const numeric = Number(value);
  return !/^\d+$/.test(value) || !Number.isSafeInteger(numeric) || numeric < min || numeric > max;
}

export default function VideoOptionsPanel({ file, capability, sourceSize, onChange, onOriginalResolution, onReplaceLegacyResolution, onDraftEdit }: {
  file: VideoDraftFile;
  capability?: VideoSettingsCapabilities | null;
  sourceSize?: { width: number; height: number };
  onChange: (options: VideoConvertOptions | null) => void;
  onOriginalResolution: () => void;
  onReplaceLegacyResolution: (options: Encode) => void;
  onDraftEdit?: () => void;
}) {
  const id = useId();
  const value = file.videoOptions ?? null;
  const [saved, setSaved] = useWorkspaceDraftState<Encode | null>("VideoOptionsPanel.savedCustom", null);
  const encode = value?.kind === "encode" ? value : null;
  const crf = useRateField("Crf", encode?.rate_control.kind === "constant_quality" ? encode.rate_control.crf : undefined, saved?.rate_control.kind === "constant_quality" ? saved.rate_control.crf : capability?.default_crf ?? 23);
  const bitrate = useRateField("Bitrate", encode?.rate_control.kind === "average_bitrate" ? encode.rate_control.kbps : undefined, saved?.rate_control.kind === "average_bitrate" ? saved.rate_control.kbps : capability?.default_bitrate_kbps ?? 5000);
  const fit = encode?.resize?.kind === "fit_within" ? encode.resize : null;
  const defaultWidth = Math.min(Math.max(sourceSize?.width ?? 1920, capability?.resize?.min_dimension ?? 2), capability?.resize?.max_dimension ?? 32768);
  const defaultHeight = Math.min(Math.max(sourceSize?.height ?? 1080, capability?.resize?.min_dimension ?? 2), capability?.resize?.max_dimension ?? 32768);
  const width = useDimensionField("Width", fit?.width, defaultWidth);
  const height = useDimensionField("Height", fit?.height, defaultHeight);
  const raw = { crfDraft: crf.draft, appliedCrf: crf.applied, bitrateDraft: bitrate.draft, appliedBitrate: bitrate.applied,
    widthDraft: width.draft, appliedWidth: width.applied, heightDraft: height.draft, appliedHeight: height.applied };
  const problem = videoOptionsError({ ...file, videoCapability: capability, videoDraft: raw });
  const rateInvalid = encode?.rate_control.kind === "constant_quality"
    ? integerDraftInvalid(crf.draft, capability?.crf_min ?? 1, capability?.crf_max ?? 51)
    : encode?.rate_control.kind === "average_bitrate"
      ? integerDraftInvalid(bitrate.draft, capability?.bitrate_min_kbps ?? 100, capability?.bitrate_max_kbps ?? 200000)
      : false;
  const widthInvalid = !!fit && integerDraftInvalid(width.draft, capability?.resize?.min_dimension ?? 2, capability?.resize?.max_dimension ?? 32768);
  const heightInvalid = !!fit && integerDraftInvalid(height.draft, capability?.resize?.min_dimension ?? 2, capability?.resize?.max_dimension ?? 32768);
  function change(options: VideoConvertOptions | null) {
    if (options?.kind === "encode") setSaved(cloneVideoOptions(options) as Encode);
    else if (encode) setSaved(cloneVideoOptions(encode) as Encode);
    onChange(cloneVideoOptions(options));
  }
  const transform = file.resolutionCap != null && file.resolutionCap !== "original";
  const legacyWidth = transform ? legacyWidths[file.resolutionCap as keyof typeof legacyWidths] : null;
  const conflict = !!(file.subtitle || file.gifOptions || file.imageOptions);
  const defaultCodec = capability?.codecs.find(codec => codec.available && codec.codec === "h264") ?? capability?.codecs.find(codec => codec.available);
  function custom() {
    if (saved) { change(saved); return; }
    if (!capability || !defaultCodec) return;
    change({kind:"encode",codec:defaultCodec.codec,rate_control:{kind:"constant_quality",crf:capability.default_crf},speed:capability.default_speed,processor:capability.processor,
      ...(capability.resize?.available && !transform ? {resize: capability.resize.default} : {}),
      ...(capability.frame_rate?.available && capability.frame_rate.default ? {frame_rate: capability.frame_rate.default} : {})});
  }
  function setDimension(field: "width" | "height", text: string) {
    if (!encode || encode.resize?.kind !== "fit_within") return;
    onDraftEdit?.();
    const state = field === "width" ? width : height;
    state.setDraft(text);
    const numeric = Number(text);
    const min = capability?.resize?.min_dimension ?? 2;
    const max = capability?.resize?.max_dimension ?? 32768;
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(numeric) || numeric < min || numeric > max) return;
    state.setApplied(String(numeric));
    change({...encode,resize:{...encode.resize,[field]:numeric}});
  }
  const className = "rounded-md bg-surface-2 px-2 py-1 text-fg focus:outline-none focus:ring-2 focus:ring-accent";
  return <section aria-label="Video settings" className="space-y-3 rounded-md bg-surface-0 p-3 text-xs">
    <label className="flex items-center justify-between gap-2">Processing
      <select aria-label="Processing" className={className} value={value?.kind ?? "automatic"} onChange={e => e.target.value === "encode" ? custom() : change(e.target.value === "copy" ? {kind:"copy"} : null)}>
        <option value="automatic">Automatic</option>
        <option value="copy" disabled={value?.kind !== "copy" && (!capability?.copy.available || transform || conflict)}>Copy streams</option>
        <option value="encode" disabled={value?.kind !== "encode" && (!capability?.encode.available || !defaultCodec || conflict)}>Custom encode</option>
      </select>
    </label>
    {!capability && <p className="text-warning">Explicit video settings require an available MP4, MOV or MKV target. Choose one above or return to Automatic.</p>}
    {capability && !capability.copy.available && <p className="text-fg-muted">Copy streams: {capability.copy.reason}</p>}
    {capability && !capability.encode.available && <p className="text-fg-muted">Custom encode: {capability.encode.reason}</p>}
    {conflict && <p className="text-warning">Remove subtitle, image or GIF settings before using explicit video processing.</p>}
    {transform && <p className="text-warning">Copy streams requires original resolution. <button type="button" className="underline" onClick={onOriginalResolution}>Use original resolution</button></p>}
    {value?.kind === "copy" && <p className="text-fg-secondary">Copies admitted video and audio streams without encoding.</p>}
    {encode && <>
      <label className="flex items-center justify-between gap-2">Codec
        <select aria-label="Codec" className={className} value={encode.codec} onChange={e => change({...encode,codec:e.target.value as Encode["codec"]})}>
          {!capability?.codecs.some(c => c.codec === encode.codec) && <option value={encode.codec}>{encode.codec === "h264" ? "H.264" : "HEVC"} (unavailable)</option>}
          {capability?.codecs.map(codec => <option key={codec.codec} value={codec.codec} disabled={!codec.available}>{codec.codec === "h264" ? "H.264" : "HEVC"}{codec.available ? "" : " (unavailable)"}</option>)}
        </select>
      </label>
      {capability?.codecs.filter(codec => !codec.available).map(codec => <p key={codec.codec} className="text-fg-muted">{codec.codec === "h264" ? "H.264" : "HEVC"}: {codec.reason}</p>)}
      <label className="flex items-center justify-between gap-2">Rate control
        <select aria-label="Rate control" className={className} value={encode.rate_control.kind} onChange={e => change({...encode,rate_control:e.target.value === "constant_quality" ? {kind:"constant_quality",crf:Number(crf.applied)} : {kind:"average_bitrate",kbps:Number(bitrate.applied)}})}>
          <option value="constant_quality">Constant quality</option><option value="average_bitrate">Average bitrate</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">{encode.rate_control.kind === "constant_quality" ? "CRF" : "Bitrate (kbps)"}
        <input type="text" inputMode="numeric" aria-label={encode.rate_control.kind === "constant_quality" ? "CRF" : "Video bitrate (kbps)"} aria-invalid={rateInvalid} aria-describedby={id + "-rate " + id + "-error"} className={className + " w-24 tabular-nums"} value={encode.rate_control.kind === "constant_quality" ? crf.draft : bitrate.draft} onChange={e => {
          onDraftEdit?.();
          const constant = encode.rate_control.kind === "constant_quality";
          const field = constant ? crf : bitrate;
          field.setDraft(e.target.value);
          const numeric = Number(e.target.value);
          const min = constant ? capability?.crf_min ?? 1 : capability?.bitrate_min_kbps ?? 100;
          const max = constant ? capability?.crf_max ?? 51 : capability?.bitrate_max_kbps ?? 200000;
          if (!/^\d+$/.test(e.target.value) || !Number.isSafeInteger(numeric) || numeric < min || numeric > max) return;
          field.setApplied(String(numeric));
          change({...encode,rate_control:constant ? {kind:"constant_quality",crf:numeric} : {kind:"average_bitrate",kbps:numeric}});
        }}/>
      </label>
      <p id={id + "-rate"} className="text-fg-muted">{encode.rate_control.kind === "constant_quality" ? "CRF — lower is higher quality. Whole numbers 1–51." : "Encoder bitrate target, not an exact size guarantee. 100–200000 kbps."}{encode.codec === "hevc" && " HEVC CRF 28 is a starting recommendation; codec quality scales differ."}</p>
      <label className="flex items-center justify-between gap-2">Speed
        <select aria-label="Speed" className={className} value={encode.speed} onChange={e => change({...encode,speed:e.target.value as Encode["speed"]})}>
          {!capability?.speeds.includes(encode.speed) && <option value={encode.speed}>{encode.speed} (unavailable)</option>}
          {capability?.speeds.map(speed => <option key={speed} value={speed}>{speed[0].toUpperCase()+speed.slice(1)}</option>)}
        </select>
      </label>
      <p className="text-fg-muted">Slower presets can improve compression efficiency; output size varies.</p>
      <p className="text-fg-secondary">Processor: Software · Global hardware preference does not change Custom encode.</p>
      {transform ? <div className="space-y-1 rounded-md border border-subtle p-2">
        <p className="text-fg-secondary">Legacy maximum width: {legacyWidth} px</p>
        <button type="button" className="underline" onClick={() => onReplaceLegacyResolution({...encode,resize:{kind:"fit_within",width:legacyWidth ?? Number(width.applied),height:capability?.resize?.max_dimension ?? 32768}})}>Replace with fit-within dimensions</button>
      </div> : <>
        <label className="flex items-center justify-between gap-2">Dimensions
          <select aria-label="Dimensions" className={className} disabled={!capability?.resize?.available} value={encode.resize?.kind ?? "previous"} onChange={e => {
            if (e.target.value === "original") change({...encode,resize:{kind:"original"}});
            else if (e.target.value === "fit_within") change({...encode,resize:{kind:"fit_within",width:Number(width.applied),height:Number(height.applied)}});
          }}>
            {!encode.resize && <option value="previous">Previous automatic dimensions</option>}
            <option value="original">Original</option>
            <option value="fit_within">Fit within</option>
          </select>
        </label>
        {!capability?.resize?.available && <p className="text-fg-muted">Dimensions: {capability?.resize?.reason ?? "Unavailable for this source"}</p>}
        {fit && <>
          <div className="grid grid-cols-2 gap-2">
            <label>Maximum width
              <input type="text" inputMode="numeric" aria-label="Maximum width" aria-invalid={widthInvalid} aria-describedby={id + "-dimensions " + id + "-error"} className={className + " mt-1 w-full tabular-nums"} value={width.draft} onChange={e => setDimension("width", e.target.value)}/>
            </label>
            <label>Maximum height
              <input type="text" inputMode="numeric" aria-label="Maximum height" aria-invalid={heightInvalid} aria-describedby={id + "-dimensions " + id + "-error"} className={className + " mt-1 w-full tabular-nums"} value={height.draft} onChange={e => setDimension("height", e.target.value)}/>
            </label>
          </div>
          <p id={id + "-dimensions"} className="text-fg-muted">Fits inside this box without enlarging, cropping, padding or stretching. The engine preserves aspect ratio and may round down by less than 2 px for encoding.</p>
        </>}
      </>}
      <label className="flex items-center justify-between gap-2">Frame rate
        <select aria-label="Frame rate" className={className} disabled={!capability?.frame_rate?.available} value={rateKey(encode.frame_rate)} onChange={e => {
          if (e.target.value === "preserve") change({...encode,frame_rate:{kind:"preserve"}});
          else {
            const selected = capability?.frame_rate?.constant_choices.find(choice => rateKey(choice.frame_rate) === e.target.value);
            if (selected) change({...encode,frame_rate:{...selected.frame_rate}});
          }
        }}>
          {!encode.frame_rate && <option value="previous">Previous automatic timing</option>}
          <option value="preserve">Preserve source cadence</option>
          {capability?.frame_rate?.constant_choices.map(choice => <option key={rateKey(choice.frame_rate)} value={rateKey(choice.frame_rate)}>{choice.label}</option>)}
        </select>
      </label>
      {!capability?.frame_rate?.available && <p className="text-fg-muted">Frame rate: {capability?.frame_rate?.reason ?? "Source timing is unavailable"}. Custom encode remains available.</p>}
      {capability?.frame_rate && <p className="text-fg-muted">{[
        reported("Reported average", capability.frame_rate.average_frame_rate, " fps"),
        reported("base", capability.frame_rate.base_frame_rate, " fps"),
        reported("time base", capability.frame_rate.time_base),
      ].filter(Boolean).join(", ")}</p>}
      {encode.frame_rate?.kind === "preserve" && <p className="text-fg-secondary">Preserves source presentation timing.</p>}
      {encode.frame_rate?.kind === "constant" && <p className="text-fg-secondary">Frames may be duplicated or dropped; playback speed and audio timing stay unchanged.</p>}
      {!encode.frame_rate && <p className="text-fg-secondary">Previous automatic timing is retained until you choose a timing policy.</p>}
    </>}
    <p id={id + "-error"} className="text-warning">{problem}</p>
  </section>;
}
