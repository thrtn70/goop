import type { AudioExecutionSummary, Job, JobResult, TrackExecutionSummary, TrackTextFact, VideoRationalFact, VideoExecutionSummary, VideoTrackExecutionSummary } from "@/types";

function rational(fact: VideoRationalFact | null | undefined): string | null {
  return fact?.kind === "exact" ? `${fact.numerator}/${fact.denominator}` : null;
}

function rateName(numerator: number, denominator: number): string {
  const names: Record<string, string> = {
    "24000/1001": "23.976",
    "24/1": "24",
    "25/1": "25",
    "30000/1001": "29.97",
    "30/1": "30",
    "50/1": "50",
    "60000/1001": "59.94",
    "60/1": "60",
  };
  return names[`${numerator}/${denominator}`] ?? `${numerator}/${denominator}`;
}

export function videoExecutionText(summary: VideoExecutionSummary): string {
  const codec = summary.video_codec === "h264" ? "H.264" : "HEVC";
  const options = summary.requested;
  const facts = options.kind === "copy" ? ["Video copied (" + codec + ")"] : [
    codec + " · " + (summary.encoder ?? "Encoder unavailable"),
    options.rate_control.kind === "constant_quality" ? "CRF " + options.rate_control.crf : options.rate_control.kbps + " kbps",
    options.speed[0].toUpperCase() + options.speed.slice(1), "Software",
  ];
  if (options.kind === "encode") {
    const resize = summary.requested_resize ?? options.resize;
    if (resize?.kind === "fit_within") {
      facts.push(`Fit within ${resize.width} × ${resize.height} px`);
    } else if (resize?.kind === "original") {
      facts.push("Original dimensions");
    }

    const average = rational(summary.source_average_frame_rate);
    const base = rational(summary.source_base_frame_rate);
    const timeBase = rational(summary.source_time_base);
    const reported = [
      average && `Reported average ${average} fps`,
      base && `base ${base} fps`,
      timeBase && `time base ${timeBase}`,
    ].filter((fact): fact is string => !!fact);
    if (reported.length) facts.push(reported.join(", "));

    const frameRate = summary.requested_frame_rate ?? options.frame_rate;
    if (!frameRate) facts.push("Previous automatic timing");
    else if (frameRate.kind === "preserve") facts.push("Preserve source timing");
    else {
      const resolved = rational(summary.resolved_constant_frame_rate);
      facts.push(`Constant ${rateName(frameRate.numerator, frameRate.denominator)} fps (${resolved ? `resolved ${resolved} fps; ` : ""}frames may be duplicated or dropped)`);
    }
  }
  facts.push((options.kind === "encode" && (summary.requested_resize ?? options.resize) ? "resolved " : "") + summary.width + " × " + summary.height + " px upright");
  facts.push(summary.audio_stream_index == null ? "No audio" : summary.audio_copied ? "Audio copied (" + (summary.audio_codec ?? "codec unavailable") + ")" : summary.audio_codec === "aac" ? "Audio: AAC 192 kbps" : "Audio: " + (summary.audio_codec ?? "codec unavailable"));
  return [...facts, ...summary.notices].join(" · ");
}

export function audioExecutionText(summary: AudioExecutionSummary): string {
  const codec = summary.codec === "aac"
    ? "AAC"
    : summary.codec === "pcm_s16le"
      ? "PCM s16le"
      : summary.codec.toUpperCase();
  const facts = [summary.copied
    ? `Audio copied (${codec})`
    : `Audio encoded (${codec}${summary.encoder ? ` · ${summary.encoder}` : ""})`];
  if (summary.requested.kind === "encode" && summary.requested.bitrate?.kind === "target") {
    facts.push(`Target ${summary.requested.bitrate.kbps} kbps`);
  }
  facts.push(summary.sample_rate_hz % 1_000 === 0
    ? `${summary.sample_rate_hz / 1_000} kHz`
    : `${Number((summary.sample_rate_hz / 1_000).toFixed(1))} kHz`);
  facts.push(summary.channel_layout
    ? `${summary.channels} ${summary.channels === 1 ? "channel" : "channels"} (${summary.channel_layout})`
    : `${summary.channels} ${summary.channels === 1 ? "channel" : "channels"}`);
  if (summary.sample_format) facts.push(`Sample format ${summary.sample_format}`);
  if (summary.bit_depth != null) facts.push(`${summary.bit_depth}-bit`);
  if (summary.reported_bitrate_kbps != null) {
    facts.push(`Reported ${summary.reported_bitrate_kbps} kbps`);
  }
  return [...facts, ...summary.notices].join(" · ");
}

function trackFact(fact: TrackTextFact, fallback: string, normalizeLanguage = false): string {
  if (fact.kind !== "value") return fallback;
  const language: Record<string, string> = { en: "English", eng: "English", es: "Spanish", spa: "Spanish", fr: "French", fra: "French", de: "German", deu: "German", ja: "Japanese", jpn: "Japanese" };
  return normalizeLanguage ? language[fact.value.toLowerCase()] ?? fact.value : fact.value;
}

export function trackExecutionText(summary: TrackExecutionSummary): string {
  const selected = summary.selected;
  const facts = [
    `Track ${selected.index}`,
    trackFact(selected.language, "Language not reported", true),
    trackFact(selected.title, "Title not reported"),
  ];
  if (summary.notices.length) facts.push(...summary.notices);
  else {
    if (summary.dropped_audio.length) {
      facts.push(`${summary.dropped_audio.length} additional audio ${summary.dropped_audio.length === 1 ? "stream" : "streams"} omitted`);
    }
    if (summary.dropped_other.length) {
      facts.push(`${summary.dropped_other.length} non-audio ${summary.dropped_other.length === 1 ? "stream" : "streams"} omitted`);
    }
  }
  return facts.join(" · ");
}

export function videoTrackExecutionText(summary: VideoTrackExecutionSummary): string {
  const facts = summary.retained.map(outcome => {
    const family = outcome.source.codec_type === "audio" ? "Audio" : "Subtitle";
    const processing = outcome.processing.kind === "copied" ? "copied" : `encoded AAC ${outcome.processing.bitrate_kbps} kbps`;
    const sourceTag = trackFact(outcome.source_codec_tag, "source tag not reported");
    const outputCodec = trackFact(outcome.output_codec_name, "codec not reported").toUpperCase();
    const outputTag = trackFact(outcome.output_codec_tag, "tag not reported");
    const language = trackFact(outcome.output_language, "Language not reported", true);
    const title = trackFact(outcome.output_title, "Title not reported");
    const defaultFact = outcome.output_default == null ? "Default not reported" : outcome.output_default ? "Default" : "Not default";
    const forcedFact = outcome.output_forced == null ? "Forced not reported" : outcome.output_forced ? "Forced" : "Not forced";
    return `${family} stream ${outcome.source.index} ${processing} → output ${outcome.output_stream_index} · source tag ${sourceTag} · output ${outputCodec} (${outputTag}) · ${language} · ${title} · ${defaultFact} · ${forcedFact}`;
  });
  if (summary.omitted_audio.length) facts.push(`${summary.omitted_audio.length} audio ${summary.omitted_audio.length === 1 ? "stream" : "streams"} omitted`);
  if (summary.omitted_subtitles.length) facts.push(`${summary.omitted_subtitles.length} subtitle ${summary.omitted_subtitles.length === 1 ? "stream" : "streams"} omitted`);
  return [...facts, ...summary.notices].join(" · ");
}

/** Measured results only; old history entries do not imply zero source bytes. */
export function outputSummary(result: JobResult | null | undefined, job?: Pick<Job, "kind" | "payload">): string | null {
  if (!result) return null;
  const output = result.bytes == null ? null : Number(result.bytes);
  const source = result.source_bytes == null ? null : Number(result.source_bytes);
  const target = result.target_bytes == null ? null : Number(result.target_bytes);
  const measured = output != null && Number.isSafeInteger(output) && output >= 0;
  const facts: string[] = [];
  if (measured && output != null && source != null && Number.isSafeInteger(source) && source > 0) {
    const percent = Math.abs((source - output) / source * 100);
    facts.push(output === source ? "Same size as source" : `${Number(percent.toFixed(1))}% ${output < source ? "smaller" : "larger"} than source`);
  }
  if (measured && output != null && target != null && Number.isSafeInteger(target) && target > 0) {
    facts.push(output <= target ? "Target met" : "Target missed");
  }
  if (result.track_execution) facts.push(trackExecutionText(result.track_execution));
  if (result.video_track_execution) facts.push(videoTrackExecutionText(result.video_track_execution));
  if (result.audio_execution) facts.push(audioExecutionText(result.audio_execution));
  else if (result.video_execution) facts.push(videoExecutionText(result.video_execution));
  else if (!result.track_execution && !result.video_track_execution) {
    if (result.reencoded === false) facts.push("No re-encode reported");
    const payload = job?.payload;
    const target = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.target : null;
    if (job?.kind === "convert" && typeof target === "string" && ["mp4","mov","mkv","webm","avi"].includes(target)) facts.push("Detailed video configuration unavailable");
  }
  return facts.length ? facts.join(" · ") : null;
}
