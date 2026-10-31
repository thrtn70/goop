import type { TrackConvertOptions, TrackPresetPolicy, TrackStreamPolicy } from "@/types";
import { cloneTrackOptions } from "./trackOptions";
import {
  cloneTrackPresetPolicy,
  completeVideoTrackOptions,
  videoTrackPolicyForPreset,
  type VideoTrackFamily,
  type VideoTrackPolicyDraft,
} from "./videoTrackOptions";

/** The track fields of one Convert row. */
export interface RowTracks {
  trackOptions?: TrackConvertOptions | null;
  pendingTrackPolicy?: TrackPresetPolicy | null;
  videoTrackPolicyDraft?: VideoTrackPolicyDraft | null;
}

/** Track fields for applySettings, which keeps them on the row it names as source. */
export interface RestoredTracks {
  trackOptions: TrackConvertOptions | null | undefined;
  pendingTrackPolicy: TrackPresetPolicy | null | undefined;
}

type VideoPolicy = Extract<TrackPresetPolicy, { kind: "video" }>;

/**
 * The track state "Use batch settings" gives a row. A choice names one file's
 * own streams, so Apply keeps it on the source row and leaves the others to
 * choose: those choices stay the row's own. Families the batch copies to every
 * row (keep all, none) come from the batch. The batch's intent is read through
 * its portable policy, so any member gives the same answer.
 */
export function restoredTracks(batch: RowTracks, own: RowTracks, withAudio: boolean): RestoredTracks {
  const policy = videoTrackPolicyForPreset(batch.trackOptions)
    ?? (batch.pendingTrackPolicy?.kind === "video" ? batch.pendingTrackPolicy : null);
  if (policy) return restoredVideoTracks(policy, own);
  if (withAudio && own.trackOptions?.kind === "audio") {
    return { trackOptions: cloneTrackOptions(own.trackOptions), pendingTrackPolicy: null };
  }
  return batch.trackOptions === undefined
    ? { trackOptions: undefined, pendingTrackPolicy: undefined }
    : { trackOptions: null, pendingTrackPolicy: null };
}

function restoredVideoTracks(policy: VideoPolicy, own: RowTracks): RestoredTracks {
  // A pending policy resolves against the row's own inspection in applySettings.
  const pending = { trackOptions: null, pendingTrackPolicy: cloneTrackPresetPolicy(policy) };
  const perFile = (family: VideoTrackFamily) => policy[family].kind === "choose_per_file";
  if (!perFile("audio") && !perFile("subtitles")) return pending;
  const choice = own.trackOptions?.kind === "video" ? own.trackOptions : own.videoTrackPolicyDraft;
  if (!choice) return pending;
  const family = (name: VideoTrackFamily): TrackStreamPolicy => {
    const batchFamily = policy[name];
    if (batchFamily.kind !== "choose_per_file") return { kind: batchFamily.kind };
    const chosen = choice[name];
    return chosen.kind === "choose" ? { kind: "choose", stream_indices: [...chosen.stream_indices] } : { kind: "choose", stream_indices: [] };
  };
  const options = completeVideoTrackOptions({ source: choice.source, audio: family("audio"), subtitles: family("subtitles") });
  return options ? { trackOptions: options, pendingTrackPolicy: null } : pending;
}
