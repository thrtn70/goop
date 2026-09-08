import { useEffect, useId } from "react";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import type { VideoConvertOptions, VideoSettingsCapabilities } from "@/types";
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
export default function VideoOptionsPanel({ file, capability, onChange, onOriginalResolution, onDraftEdit }: {
  file: VideoDraftFile;
  capability?: VideoSettingsCapabilities | null;
  onChange: (options: VideoConvertOptions | null) => void;
  onOriginalResolution: () => void;
  onDraftEdit?: () => void;
}) {
  const id = useId();
  const value = file.videoOptions ?? null;
  const [saved, setSaved] = useWorkspaceDraftState<Encode | null>("VideoOptionsPanel.savedCustom", null);
  const encode = value?.kind === "encode" ? value : null;
  const crf = useRateField("Crf", encode?.rate_control.kind === "constant_quality" ? encode.rate_control.crf : undefined, saved?.rate_control.kind === "constant_quality" ? saved.rate_control.crf : capability?.default_crf ?? 23);
  const bitrate = useRateField("Bitrate", encode?.rate_control.kind === "average_bitrate" ? encode.rate_control.kbps : undefined, saved?.rate_control.kind === "average_bitrate" ? saved.rate_control.kbps : capability?.default_bitrate_kbps ?? 5000);
  const raw = { crfDraft: crf.draft, appliedCrf: crf.applied, bitrateDraft: bitrate.draft, appliedBitrate: bitrate.applied };
  const problem = videoOptionsError({ ...file, videoCapability: capability, videoDraft: raw });
  function change(options: VideoConvertOptions | null) {
    if (options?.kind === "encode") setSaved(cloneVideoOptions(options) as Encode);
    else if (encode) setSaved(cloneVideoOptions(encode) as Encode);
    onChange(cloneVideoOptions(options));
  }
  const transform = file.resolutionCap != null && file.resolutionCap !== "original";
  const conflict = !!(file.subtitle || file.gifOptions || file.imageOptions);
  const defaultCodec = capability?.codecs.find(codec => codec.available && codec.codec === "h264") ?? capability?.codecs.find(codec => codec.available);
  function custom() {
    if (saved) { change(saved); return; }
    if (!capability || !defaultCodec) return;
    change({kind:"encode",codec:defaultCodec.codec,rate_control:{kind:"constant_quality",crf:capability.default_crf},speed:capability.default_speed,processor:capability.processor});
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
        <input type="text" inputMode="numeric" aria-label={encode.rate_control.kind === "constant_quality" ? "CRF" : "Video bitrate (kbps)"} aria-invalid={!!problem} aria-describedby={id + "-rate " + id + "-error"} className={className + " w-24 tabular-nums"} value={encode.rate_control.kind === "constant_quality" ? crf.draft : bitrate.draft} onChange={e => {
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
    </>}
    <p id={id + "-error"} className="text-warning">{problem}</p>
  </section>;
}
