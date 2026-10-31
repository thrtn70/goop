import type { ProbeState } from "@/hooks/useProbe";
import type { TargetFormat } from "@/types";

export type BatchKind = "image" | "video" | "audio" | "subtitle";
export type KindCounts = { image: number; video: number; audio: number; subtitle: number; unknown: number };
export type BatchScope = { ids: string[]; kept: KindCounts; pending: boolean };
/** Both action bars' Apply control; null hides it. */
export type ApplyScopeAction = { label: string; title: string; disabledReason: string | null; onApply: () => void };
type ScopeEntry = { id?: string; optionsReady?: boolean };
type ReadyState = Extract<ProbeState, { phase: "ready" }>;

/**
 * The probe calls any file with a video stream "video", embedded cover art
 * included, so tagged MP3/FLAC/M4A would otherwise group with real videos.
 */
export function batchKind(state: ProbeState | undefined): BatchKind | null {
  if (state?.phase !== "ready") return null;
  const kind = state.probe.source_kind;
  if (kind === "image" || kind === "audio" || kind === "subtitle") return kind;
  if (kind !== "video") return null;
  const video = state.probe.video_details?.streams.filter(stream => stream.codec_type === "video") ?? [];
  return video.length > 0 && video.every(stream => stream.attached_pic) ? "audio" : "video";
}

function scope(
  entries: readonly ScopeEntry[],
  states: Readonly<Record<string, ProbeState>>,
  admits: (state: ReadyState) => boolean,
): BatchScope {
  const ids: string[] = [];
  const kept: KindCounts = { image: 0, video: 0, audio: 0, subtitle: 0, unknown: 0 };
  let pending = false;
  for (const entry of entries) {
    const state = entry.id === undefined ? undefined : states[entry.id];
    // A failed inspection is settled, so it never holds the scope open.
    if (!state || state.phase === "probing" || (state.phase === "ready" && entry.optionsReady !== true)) pending = true;
    if (entry.id !== undefined && state?.phase === "ready" && admits(state)) {
      ids.push(entry.id);
      continue;
    }
    kept[batchKind(state) ?? "unknown"] += 1;
  }
  return { ids, kept, pending };
}

export function kindScope(
  entries: readonly ScopeEntry[],
  states: Readonly<Record<string, ProbeState>>,
  kind: BatchKind,
): BatchScope {
  return scope(entries, states, state => batchKind(state) === kind);
}

export function targetScope(
  entries: readonly ScopeEntry[],
  states: Readonly<Record<string, ProbeState>>,
  target: TargetFormat,
): BatchScope {
  return scope(entries, states, state => state.capabilities.targets.some(candidate => candidate.target === target && candidate.available));
}

export function kindCounts(ids: readonly string[], states: Readonly<Record<string, ProbeState>>): KindCounts {
  const counts: KindCounts = { image: 0, video: 0, audio: 0, subtitle: 0, unknown: 0 };
  for (const id of ids) counts[batchKind(states[id]) ?? "unknown"] += 1;
  return counts;
}
