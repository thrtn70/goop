use crate::backend::ConversionBackend;
use crate::compat::{decide, maybe_apply_hw_h264, Plan};
use crate::encoders::DetectedEncoders;
use crate::naming::{allocate_output_path, stem_of};
use crate::probe_json::parse_probe_json;
use crate::progress::ProgressTracker;
use goop_core::{
    ConvertRequest, ConvertResult, EventSink, GoopError, JobId, PidGuard, PidRegistry, ProbeResult,
    ProgressEvent, TargetFormat,
};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

pub struct FfmpegBackend<'a> {
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
    /// Detected GPU encoders. Pass via `with_encoders` when HW acceleration
    /// is allowed at the application level. `None` means software-only.
    encoders: Option<Arc<DetectedEncoders>>,
    /// User's "Use hardware acceleration" toggle. Honoured only when
    /// `encoders` is also set.
    hw_enabled: bool,
    /// Optional PID registry for pause/resume support (v0.2.0 Phase G). When
    /// set, the spawned ffmpeg child PID is registered immediately after
    /// `cmd.spawn()` and unregistered via RAII guard on every exit path.
    /// `None` disables pause/resume — pause IPC will return JobNotRunning.
    pids: Option<Arc<dyn PidRegistry>>,
}

impl<'a> FfmpegBackend<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self {
            resolver,
            sink,
            encoders: None,
            hw_enabled: false,
            pids: None,
        }
    }

    /// Enable HW encoding consideration. When called, plans for the h.264
    /// family will be rewritten to use the platform's preferred GPU encoder
    /// (if `enabled` is true and the encoder is present in `encoders`).
    pub fn with_encoders(mut self, encoders: Arc<DetectedEncoders>, enabled: bool) -> Self {
        self.encoders = Some(encoders);
        self.hw_enabled = enabled;
        self
    }

    /// Wire up pause/resume support. The scheduler in `goop-queue` provides
    /// `Scheduler::pid_registry()` for this.
    pub fn with_pid_registry(mut self, pids: Arc<dyn PidRegistry>) -> Self {
        self.pids = Some(pids);
        self
    }
}

impl<'a> ConversionBackend for FfmpegBackend<'a> {
    async fn probe(resolver: &BinaryResolver, path: &Path) -> Result<ProbeResult, GoopError> {
        let bin = resolver.resolve("ffprobe")?;
        let out = Command::new(&bin.path)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .kill_on_drop(true)
            .output()
            .await?;
        if !out.status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: "ffprobe".into(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let mut probe = parse_probe_json(&out.stdout)?;
        if probe.file_size == 0 {
            if let Ok(meta) = std::fs::metadata(path) {
                probe.file_size = meta.len();
            }
        }
        Ok(probe)
    }

    async fn convert(
        &self,
        job_id: JobId,
        req: &ConvertRequest,
        cancel: CancellationToken,
    ) -> Result<ConvertResult, GoopError> {
        if cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        let bin = self.resolver.resolve("ffmpeg")?;
        let expanded_input = goop_core::path::expand(&req.input_path);
        let input = match std::fs::canonicalize(&expanded_input) {
            Ok(path) if path.is_file() => path,
            _ => {
                return Err(GoopError::SubprocessFailed {
                    binary: "ffmpeg".into(),
                    stderr: format!("input file does not exist: {}", req.input_path),
                });
            }
        };
        let source_bytes = goop_core::output::source_bytes(std::slice::from_ref(&input))?;
        let probe = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(GoopError::Cancelled),
            probe = FfmpegBackend::probe(self.resolver, &input) => probe?,
        };
        let (mut plan, subtitle_input) = build_plan(req, &probe)?;

        let final_path = resolve_output_path(&req.input_path, &req.output_path, &plan)?;
        let destination = if goop_core::path::expand(&req.output_path).is_dir() {
            goop_core::output::OutputDestination::automatic(
                final_path,
                stem_of(&req.input_path),
                plan.ext.into(),
            )
        } else {
            goop_core::output::OutputDestination::explicit(final_path)
        };
        let staged = goop_core::output::StagedOutput::new(&destination.path)?;
        let output_path = staged.path().to_path_buf();
        let target_bytes = match req.compress_mode {
            Some(goop_core::CompressMode::TargetSizeBytes(n)) => Some(n),
            _ => None,
        };

        // Same effective quality the plan was built with, so the GPU
        // encoder's quality args can't drift from the software ones.
        let quality = effective_quality(req.quality_preset, req.subtitle.as_ref().map(|s| s.mode));
        let hw_encoder = self.maybe_apply_hw(&mut plan, quality);
        let started = std::time::Instant::now();
        let mut current_encoder = hw_encoder;

        let result = self
            .run_ffmpeg(
                &bin.path,
                &input,
                &output_path,
                &plan,
                &subtitle_input,
                &probe,
                job_id,
                current_encoder,
                cancel.clone(),
            )
            .await;

        // HW encoders fail in environments where the GPU/driver is missing
        // or the encoder rejects the source pixel format. Retry once with
        // software in those cases — the user opted in to "use HW when
        // possible", not "fail loudly when HW won't work."
        let result = match result {
            Err(GoopError::SubprocessFailed { binary, stderr })
                if current_encoder.is_some() && !cancel.is_cancelled() =>
            {
                tracing::warn!(
                    encoder = ?current_encoder,
                    "hardware encode failed; retrying with software"
                );
                let _ = std::fs::remove_file(&output_path);
                // Rebuild through the same function so the software retry
                // carries identical subtitle args — deriving it separately
                // is how a soft-muxed track would silently vanish on
                // fallback.
                let Ok((plan_sw, subtitle_sw)) = build_plan(req, &probe) else {
                    // Only reachable if the subtitle file vanished between
                    // the two attempts. Report the encode failure that got
                    // us here rather than that red herring.
                    return Err(GoopError::SubprocessFailed { binary, stderr });
                };
                current_encoder = None;
                self.run_ffmpeg(
                    &bin.path,
                    &input,
                    &output_path,
                    &plan_sw,
                    &subtitle_sw,
                    &probe,
                    job_id,
                    current_encoder,
                    cancel.clone(),
                )
                .await
            }
            other => other,
        };

        let reencoded = result?;
        let published = staged.publish(&destination, target_bytes, false, &cancel)?;
        Ok(ConvertResult {
            source_bytes: Some(source_bytes),
            target_bytes,
            output_path: published.path.to_string_lossy().into_owned(),
            bytes: published.bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            reencoded,
        })
    }
}

impl<'a> FfmpegBackend<'a> {
    fn maybe_apply_hw(
        &self,
        plan: &mut Plan,
        quality: Option<goop_core::QualityPreset>,
    ) -> Option<&'static str> {
        if !self.hw_enabled {
            return None;
        }
        let encoders = self.encoders.as_deref()?;
        maybe_apply_hw_h264(plan, encoders, quality)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_ffmpeg(
        &self,
        bin_path: &Path,
        input: &Path,
        output_path: &Path,
        plan: &Plan,
        subtitle: &SubtitleInput,
        probe: &ProbeResult,
        job_id: JobId,
        encoder: Option<&'static str>,
        cancel: CancellationToken,
    ) -> Result<bool, GoopError> {
        let mut cmd = Command::new(bin_path);
        cmd.arg("-y");

        // Some plans (e.g., GIF trim) have args that go before -i, separated
        // by the "__INPUT__" sentinel. Split on it.
        let input_idx = plan.args.iter().position(|a| a == "__INPUT__");
        if let Some(idx) = input_idx {
            for a in &plan.args[..idx] {
                cmd.arg(a);
            }
            // A soft-embedded subtitle is a second input. It must follow the
            // main `-i` and precede every output option, which is exactly
            // where the plan's post-input args begin.
            push_inputs(&mut cmd, input, subtitle);
            for a in &plan.args[idx + 1..] {
                cmd.arg(a);
            }
        } else {
            push_inputs(&mut cmd, input, subtitle);
            for a in &plan.args {
                cmd.arg(a);
            }
        }

        if !plan.video_filters.is_empty() {
            cmd.arg("-vf").arg(plan.video_filters.join(","));
        }

        cmd.arg("-progress").arg("pipe:1").arg("-nostats");
        cmd.arg(output_path);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child: Child = cmd.spawn()?;
        // Phase G: register the child PID for pause/resume. The guard
        // unregisters on Drop, covering success, error, cancel, and panic.
        // `_pid_guard = None` when no registry is wired (e.g. tests, or
        // pause/resume disabled at the application level).
        let _pid_guard = self.pids.as_ref().and_then(|reg| {
            child
                .id()
                .map(|pid| PidGuard::new(reg.clone(), job_id, pid))
        });
        // invariant: stdout was requested with Stdio::piped above.
        let stdout = child.stdout.take().expect("stdout was piped");
        // invariant: stderr was requested with Stdio::piped above.
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = stderr;

        let mut tracker = ProgressTracker::new(probe.duration_ms);
        let stage = if plan.reencoded {
            "converting"
        } else {
            "remuxing"
        };
        let mut stderr_bytes = Vec::new();
        let mut error_buffer = [0u8; 4096];
        let mut stdout_done = false;
        let mut stderr_done = false;
        let status = loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(GoopError::Cancelled);
                }
                status = child.wait() => break status?,
                line = out_reader.next_line(), if !stdout_done => {
                    match line? {
                        Some(l) => {
                            if let Some(snap) = tracker.ingest(&l) {
                                self.sink.emit_progress(ProgressEvent {
                                    job_id, percent: snap.percent as f32, eta_secs: snap.eta_secs,
                                    speed_hr: snap.speed_factor.map(|f| format!("{f:.2}x")),
                                    stage: stage.into(), encoder: encoder.map(String::from),
                                });
                            }
                        }
                        None => stdout_done = true,
                    }
                }
                count = err_reader.read(&mut error_buffer), if !stderr_done => {
                    let count = count?;
                    stderr_done = count == 0;
                    append_stderr_tail(&mut stderr_bytes, &error_buffer[..count]);
                }
            }
        };
        // Drain the child's buffered diagnostics without hanging on a descendant
        // that inherited the pipe. The child itself has already been reaped.
        let drain = async {
            while !stderr_done {
                let count = err_reader.read(&mut error_buffer).await?;
                stderr_done = count == 0;
                if stderr_done {
                    break;
                }
                append_stderr_tail(&mut stderr_bytes, &error_buffer[..count]);
            }
            Ok::<(), std::io::Error>(())
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(GoopError::Cancelled),
            _ = tokio::time::timeout(std::time::Duration::from_secs(1), drain) => {},
        }
        let stderr_tail = String::from_utf8_lossy(&stderr_bytes).into_owned();
        if !status.success() {
            let _ = std::fs::remove_file(output_path);
            return Err(GoopError::SubprocessFailed {
                binary: "ffmpeg".into(),
                stderr: stderr_tail,
            });
        }

        // ffmpeg drops undecodable subtitle cues and still exits 0, so this
        // line is the only trace that anything went missing. Encoding
        // detection should have prevented it, but a wrong guess degrades the
        // same silent way — so route it to the UI rather than a log file the
        // user of a packaged app will never open.
        if stderr_tail.contains("Invalid UTF-8 in decoded subtitles") {
            self.sink.emit_sidecar(goop_core::SidecarEvent::Warning {
                code: goop_core::WarningCode::SubtitleCuesDropped,
                message: "Some subtitle lines couldn't be read and are missing from the \
                              output. The subtitle file's character encoding wasn't recognised."
                    .to_string(),
            });
        }

        Ok(plan.reencoded)
    }
}

/// Backward-compat alias.
pub type Ffmpeg<'a> = FfmpegBackend<'a>;

/// What ffmpeg needs in order to read this conversion's subtitle text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SubtitleInput {
    /// Path to open as a second `-i`. `Some` only for soft-embed.
    path: Option<PathBuf>,
    /// The `-sub_charenc` value, applied to whichever input carries the
    /// subtitle text: the second one when `path` is set, the main one
    /// otherwise (a standalone srt↔vtt conversion reads the subtitle as
    /// its only input).
    ///
    /// Burn-in never sets this — it reads the file through the filtergraph,
    /// where an input option would never reach it, so the encoding rides on
    /// the `subtitles=` filter instead.
    charenc: Option<String>,
}

/// Emit the `-i` arguments, placing `-sub_charenc` immediately before the
/// input whose text it describes.
///
/// Position is load-bearing: `-sub_charenc` is an *input* option, and ffmpeg
/// applies it to the next `-i` only. Put it after, and it is silently
/// ignored — which looks exactly like the bug it is meant to fix.
fn push_inputs(cmd: &mut Command, input: &Path, subtitle: &SubtitleInput) {
    match &subtitle.path {
        Some(sub) => {
            cmd.arg("-i").arg(input);
            if let Some(enc) = &subtitle.charenc {
                cmd.arg("-sub_charenc").arg(enc);
            }
            cmd.arg("-i").arg(sub);
        }
        None => {
            if let Some(enc) = &subtitle.charenc {
                cmd.arg("-sub_charenc").arg(enc);
            }
            cmd.arg("-i").arg(input);
        }
    }
}

/// Which quality preset the plan should actually be built with.
///
/// Burn-in has to draw onto decoded frames, so a plan that stream-copies
/// would drop the subtitles without a word. `None` and `Original` both
/// mean "remux when you can", so they are upgraded to `Balanced`; an
/// explicitly chosen preset already re-encodes and is left alone.
fn effective_quality(
    requested: Option<goop_core::QualityPreset>,
    mode: Option<goop_core::SubtitleMode>,
) -> Option<goop_core::QualityPreset> {
    use goop_core::{QualityPreset, SubtitleMode};
    match (mode, requested) {
        (Some(SubtitleMode::BurnIn), None | Some(QualityPreset::Original)) => {
            Some(QualityPreset::Balanced)
        }
        _ => requested,
    }
}

/// Note that the source's own subtitle tracks are being left behind.
///
/// Bitmap subtitles (Blu-ray PGS, DVD) can only be transcoded to other
/// bitmap codecs, so forcing one into a text codec aborts the whole
/// conversion. Skipping them costs a track; aborting costs everything. The
/// loss is invisible in the output, so it is at least worth saying out loud
/// somewhere. `fate` describes what actually becomes of them, which differs
/// between the two call sites.
fn warn_subtitles_not_preserved(codecs: &[String], fate: &str) {
    tracing::warn!(
        codecs = ?codecs,
        fate,
        "source subtitle tracks are not text and can't be rewritten into the target's \
         subtitle codec"
    );
}

/// Note that the source's extra audio tracks are being left behind.
///
/// Reached whenever the plan stream-copies audio the target container has
/// no registered mapping for. Naming those streams anyway would box them
/// under a codec tag that lies about their contents, so they are dropped
/// instead — the same trade the subtitle path makes, and just as invisible
/// in the output, which is why it is at least said out loud somewhere.
///
/// Silent for the ordinary single-track case, which loses nothing, and for
/// targets that hold one audio stream by definition — an MP3 or a GIF was
/// never going to carry a film's commentary track, so saying so on every
/// such conversion would be noise rather than news.
fn warn_audio_not_preserved(target: TargetFormat, codecs: &[String]) {
    if codecs.len() < 2 || !crate::subtitle::holds_multiple_audio_streams(target) {
        return;
    }
    tracing::warn!(
        codecs = ?codecs,
        target = ?target,
        "source has multiple audio tracks but the target container can't \
         stream-copy all of them; keeping only the first"
    );
}

/// Build the ffmpeg plan for `req`, plus the path (if any) that must be
/// opened as a second input.
///
/// Both the first attempt and the hardware→software retry go through here,
/// so the retry can't drift from the original invocation.
fn build_plan(
    req: &ConvertRequest,
    probe: &ProbeResult,
) -> Result<(Plan, SubtitleInput), GoopError> {
    let mode = req.subtitle.as_ref().map(|s| s.mode);

    let mut plan = if let Some(compress) = req.compress_mode {
        crate::compat::decide_compression(
            req.target,
            probe.video_codec.as_deref(),
            probe.audio_codec.as_deref(),
            compress,
            probe.duration_ms,
        )
    } else {
        decide(
            req.target,
            probe.video_codec.as_deref(),
            probe.audio_codec.as_deref(),
            effective_quality(req.quality_preset, mode),
            req.resolution_cap,
            req.gif_options.as_ref(),
        )
    };

    let Some(sub) = req.subtitle.as_ref() else {
        // A standalone srt↔vtt conversion has no *attached* subtitle: the
        // subtitle is the main input. Its encoding still has to be detected,
        // or the conversion drops the very cues that needed it.
        //
        // The source kind is what makes that safe to assume. An identical
        // request shape — no attachment, subtitle target — is also how an
        // embedded track gets extracted from a *container*, and detecting on
        // that would feed a whole media file to the charset guesser and then
        // force its guess onto subtitle text that was already correct UTF-8.
        // Targeting on the container alone turns a byte-perfect extraction
        // into silent mojibake.
        let charenc = (matches!(probe.source_kind, goop_core::SourceKind::Subtitle)
            && matches!(req.target, TargetFormat::Srt | TargetFormat::Vtt))
        .then(|| crate::subtitle::detect_charenc_of_file(&goop_core::path::expand(&req.input_path)))
        .flatten();

        // Nothing attached, but the source may still carry subtitle tracks
        // of its own. Left to ffmpeg's automatic stream selection they are
        // silently thinned to one — and to none for MP4, whose muxer has no
        // default subtitle codec — while the job still reports success.
        //
        // Disjoint from the detection above: no target that takes a soft
        // track is also a subtitle target, so the two never both apply.
        // A bare subtitle file probes as having subtitles too, so without
        // the source-kind check a stray `.srt` aimed at a video container —
        // which "apply to all" and presets can do, since they set the target
        // without consulting each row's own kind — would gain maps for video
        // and audio streams it does not have. The conversion is nonsense
        // either way; this at least keeps it from being nonsense of our
        // making.
        let bare_subtitle_source = matches!(probe.source_kind, goop_core::SourceKind::Subtitle);
        let subtitles_need_maps = !bare_subtitle_source
            && probe.has_subtitles
            && crate::subtitle::supports(req.target, goop_core::SubtitleMode::Soft);

        if subtitles_need_maps {
            if crate::subtitle::can_preserve_existing(&probe.subtitle_codecs) {
                crate::subtitle::preserve_existing_in_plan(
                    &mut plan,
                    req.target,
                    &probe.subtitle_codecs,
                    &probe.audio_codecs,
                );
            } else {
                // No maps at all, so ffmpeg's default handling stays in
                // place: worse than preserving the tracks, far better than
                // failing the job outright.
                //
                // This costs the source's extra *audio* tracks too, since
                // mapping those without also naming `0:s?` would turn a
                // thinned-out subtitle track into no subtitle track at all.
                // Bitmap subtitles are the rarer loss of the two.
                warn_subtitles_not_preserved(&probe.subtitle_codecs, "left as ffmpeg handles them");
            }
        } else if !bare_subtitle_source {
            // No subtitle work to justify a map — but automatic stream
            // selection still keeps exactly one audio stream, so a source
            // with several loses the rest unless they are named. Skipped
            // for a bare `.srt` / `.vtt` for the same reason the subtitle
            // branch is: it has no video or audio streams to map.
            if !crate::subtitle::preserve_audio_in_plan(&mut plan, req.target, &probe.audio_codecs)
            {
                warn_audio_not_preserved(req.target, &probe.audio_codecs);
            }
        }
        return Ok((
            plan,
            SubtitleInput {
                path: None,
                charenc,
            },
        ));
    };

    // Expand but deliberately do NOT canonicalize: on Windows that returns
    // a `\\?\`-prefixed path, which the filter-graph parser can't consume.
    let sub_path = goop_core::path::expand(&sub.source_path);
    if !sub_path.is_file() {
        return Err(GoopError::InvalidRequest(format!(
            "subtitle file does not exist: {}",
            sub.source_path
        )));
    }

    let preserve_existing = crate::subtitle::can_preserve_existing(&probe.subtitle_codecs);
    if sub.mode == goop_core::SubtitleMode::Soft && probe.has_subtitles && !preserve_existing {
        // Here the explicit maps *are* exhaustive, so the source's own
        // tracks really do disappear rather than merely being thinned.
        warn_subtitles_not_preserved(&probe.subtitle_codecs, "not carried over");
    }
    let charenc = crate::subtitle::detect_charenc_of_file(&sub_path);
    let extra_input = crate::subtitle::apply_to_plan(
        &mut plan,
        req.target,
        sub.mode,
        &sub_path,
        preserve_existing,
        charenc.as_deref(),
        &probe.audio_codecs,
    )?;
    Ok((
        plan,
        SubtitleInput {
            path: extra_input,
            // Burn-in already consumed the encoding on the filter. Passing
            // it again as an input option would aim it at the *video*
            // input, where it does nothing useful.
            charenc: match sub.mode {
                goop_core::SubtitleMode::BurnIn => None,
                goop_core::SubtitleMode::Soft => charenc,
            },
        },
    ))
}

fn resolve_output_path(
    input_path: &str,
    requested: &str,
    plan: &Plan,
) -> Result<PathBuf, GoopError> {
    let requested_buf = goop_core::path::expand(requested);
    if requested_buf.is_dir() {
        let dir = std::fs::canonicalize(&requested_buf)?;
        let stem = stem_of(input_path);
        Ok(allocate_output_path(&dir, &stem, plan.ext))
    } else {
        if let Some(parent) = requested_buf.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let parent = requested_buf.parent().filter(|p| !p.as_os_str().is_empty());
        let Some(parent) = parent else {
            return Ok(requested_buf);
        };
        let Some(file_name) = requested_buf.file_name() else {
            return Ok(requested_buf);
        };
        Ok(std::fs::canonicalize(parent)?.join(file_name))
    }
}

pub fn target_extension(target: TargetFormat, acodec: Option<&str>) -> &'static str {
    decide(target, None, acodec, None, None, None).ext
}

fn append_stderr_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    tail.extend_from_slice(bytes);
    if tail.len() > 8192 {
        tail.drain(..tail.len() - 8192);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::{QualityPreset, SubtitleMode, SubtitleOptions};
    use std::fs;

    fn req_with(target: TargetFormat, subtitle: Option<SubtitleOptions>) -> ConvertRequest {
        ConvertRequest {
            input_path: "/in.mp4".into(),
            output_path: "/out".into(),
            target,
            quality_preset: None,
            resolution_cap: None,
            gif_options: None,
            compress_mode: None,
            batch_id: None,
            metadata_policy: None,
            subtitle,
        }
    }

    fn probe_h264_aac() -> ProbeResult {
        ProbeResult {
            duration_ms: 1000,
            width: Some(1920),
            height: Some(1080),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            file_size: 1000,
            container: Some("mov,mp4".into()),
            has_video: true,
            has_audio: true,
            source_kind: goop_core::SourceKind::Video,
            color_space: None,
            image_format: None,
            has_subtitles: false,
            subtitle_codecs: vec![],
            // One stream, matching `audio_codec` above. Multi-track cases
            // build on this through `probe_with_audio`.
            audio_codecs: vec!["aac".into()],
        }
    }

    /// `probe_h264_aac`, but carrying the named audio streams in order.
    fn probe_with_audio(codecs: &[&str]) -> ProbeResult {
        ProbeResult {
            audio_codec: codecs.first().map(|c| (*c).to_string()),
            has_audio: !codecs.is_empty(),
            audio_codecs: codecs.iter().map(|c| (*c).to_string()).collect(),
            ..probe_h264_aac()
        }
    }

    #[test]
    fn burn_in_upgrades_a_remuxing_quality_to_an_encoding_one() {
        // `None` / `Original` would remux, which silently drops burn-in.
        for q in [None, Some(QualityPreset::Original)] {
            assert_eq!(
                effective_quality(q, Some(SubtitleMode::BurnIn)),
                Some(QualityPreset::Balanced),
                "{q:?}"
            );
        }
    }

    #[test]
    fn burn_in_respects_an_explicitly_chosen_quality() {
        for q in [QualityPreset::Fast, QualityPreset::Small] {
            assert_eq!(
                effective_quality(Some(q), Some(SubtitleMode::BurnIn)),
                Some(q)
            );
        }
    }

    #[test]
    fn soft_embed_and_no_subtitle_leave_quality_untouched() {
        assert_eq!(effective_quality(None, Some(SubtitleMode::Soft)), None);
        assert_eq!(effective_quality(None, None), None);
        assert_eq!(
            effective_quality(Some(QualityPreset::Original), None),
            Some(QualityPreset::Original)
        );
    }

    #[test]
    fn build_plan_without_a_subtitle_asks_for_no_second_input() {
        let (plan, extra) =
            build_plan(&req_with(TargetFormat::Mp4, None), &probe_h264_aac()).unwrap();
        assert_eq!(extra, SubtitleInput::default());
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    // --- -sub_charenc placement ---------------------------------------
    //
    // The option applies to the *next* `-i` only. Emitted after the input
    // it describes, ffmpeg ignores it silently and cues go on vanishing —
    // the exact bug it exists to fix — so position is pinned here.

    #[test]
    fn charenc_precedes_the_subtitle_input_when_soft_embedding() {
        let mut cmd = Command::new("ffmpeg");
        push_inputs(
            &mut cmd,
            Path::new("/tmp/movie.mp4"),
            &SubtitleInput {
                path: Some(PathBuf::from("/tmp/sub.srt")),
                charenc: Some("windows-1252".into()),
            },
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "-i",
                "/tmp/movie.mp4",
                "-sub_charenc",
                "windows-1252",
                "-i",
                "/tmp/sub.srt",
            ],
            "charenc must sit between the video input and the subtitle input"
        );
    }

    /// `probe_h264_aac`, but the source already carries subtitle streams.
    fn probe_with_subtitles(codecs: &[&str]) -> ProbeResult {
        ProbeResult {
            has_subtitles: !codecs.is_empty(),
            subtitle_codecs: codecs.iter().map(|c| (*c).to_string()).collect(),
            ..probe_h264_aac()
        }
    }

    #[test]
    fn build_plan_carries_existing_subtitles_when_nothing_is_attached() {
        // Regression: with no attached subtitle no maps were emitted at
        // all, so ffmpeg's automatic selection kept one subtitle track for
        // MKV and none for MP4 — while the job still reported success.
        let (plan, extra) = build_plan(
            &req_with(TargetFormat::Mp4, None),
            &probe_with_subtitles(&["subrip", "subrip"]),
        )
        .unwrap();

        assert_eq!(
            extra,
            SubtitleInput::default(),
            "nothing to open as a second input"
        );
        assert_eq!(
            plan.args,
            vec![
                "-c", "copy", "-map", "0:v:0?", "-map", "0:a?", "-map", "0:s?", "-c:s", "mov_text",
            ],
            "the source's lone AAC stream is one MP4 can describe, so the \
             audio map has nothing to narrow for"
        );
    }

    #[test]
    fn charenc_precedes_the_main_input_when_converting_a_subtitle_file() {
        // srt↔vtt: the subtitle is the only input, so the option goes first.
        let mut cmd = Command::new("ffmpeg");
        push_inputs(
            &mut cmd,
            Path::new("/tmp/in.srt"),
            &SubtitleInput {
                path: None,
                charenc: Some("windows-1251".into()),
            },
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["-sub_charenc", "windows-1251", "-i", "/tmp/in.srt"]
        );
    }

    #[test]
    fn utf8_subtitles_add_no_charenc_argument() {
        let mut cmd = Command::new("ffmpeg");
        push_inputs(
            &mut cmd,
            Path::new("/tmp/movie.mp4"),
            &SubtitleInput {
                path: Some(PathBuf::from("/tmp/sub.srt")),
                charenc: None,
            },
        );
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            !args.iter().any(|a| a == "-sub_charenc"),
            "UTF-8 is ffmpeg's default; naming it only adds noise: {args:?}"
        );
    }

    #[test]
    fn burn_in_keeps_the_encoding_on_the_filter_not_the_input() {
        // -sub_charenc would land on the video input and do nothing, so the
        // filter has to carry it instead.
        let sub = tempfile_cp1252("build-plan-burn-charenc");
        let req = req_with(
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: sub.to_string_lossy().into_owned(),
                mode: SubtitleMode::BurnIn,
            }),
        );
        let (plan, extra) = build_plan(&req, &probe_h264_aac()).unwrap();
        assert_eq!(extra.charenc, None, "burn-in must not set an input option");
        assert!(
            plan.video_filters
                .iter()
                .any(|f| f.contains("charenc=windows-1252")),
            "filters: {:?}",
            plan.video_filters
        );
        fs::remove_file(&sub).ok();
    }

    #[test]
    fn extracting_from_a_container_does_not_sniff_the_container() {
        // Extraction shares its request shape with standalone srt↔vtt
        // conversion: no attached subtitle, subtitle target. Only the
        // source kind separates them. Sniffing a container would guess a
        // codepage from binary media and force it onto an embedded track
        // that was already correct UTF-8 — turning a byte-perfect
        // extraction into mojibake, at exit 0.
        let src = tempfile_cp1252("extract-container");
        let mut req = req_with(TargetFormat::Srt, None);
        req.input_path = src.to_string_lossy().into_owned();
        let probe = ProbeResult {
            has_subtitles: true,
            subtitle_codecs: vec!["subrip".into()],
            ..probe_h264_aac()
        };
        assert!(matches!(probe.source_kind, goop_core::SourceKind::Video));

        let (_plan, extra) = build_plan(&req, &probe).unwrap();
        assert_eq!(
            extra.charenc, None,
            "a video container must never be charset-sniffed"
        );
        fs::remove_file(&src).ok();
    }

    #[test]
    fn converting_a_subtitle_file_still_detects_its_encoding() {
        // The other side of the guard above: a genuine subtitle source must
        // still be detected, or srt↔vtt silently drops its accented cues.
        let src = tempfile_cp1252("convert-subtitle-source");
        let mut req = req_with(TargetFormat::Vtt, None);
        req.input_path = src.to_string_lossy().into_owned();
        let probe = ProbeResult {
            source_kind: goop_core::SourceKind::Subtitle,
            has_subtitles: true,
            subtitle_codecs: vec!["subrip".into()],
            ..probe_h264_aac()
        };

        let (_plan, extra) = build_plan(&req, &probe).unwrap();
        assert_eq!(extra.charenc.as_deref(), Some("windows-1252"));
        fs::remove_file(&src).ok();
    }

    #[test]
    fn soft_embed_detects_a_legacy_codepage() {
        let sub = tempfile_cp1252("build-plan-soft-charenc");
        let req = req_with(
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: sub.to_string_lossy().into_owned(),
                mode: SubtitleMode::Soft,
            }),
        );
        let (_plan, extra) = build_plan(&req, &probe_h264_aac()).unwrap();
        assert_eq!(extra.charenc.as_deref(), Some("windows-1252"));
        fs::remove_file(&sub).ok();
    }

    /// A cp1252 subtitle: accented cues plus one ASCII cue, the shape that
    /// makes ffmpeg drop lines while still reporting success.
    fn tempfile_cp1252(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("goop-{tag}-{}.srt", std::process::id()));
        let mut bytes = b"1\n00:00:01,000 --> 00:00:02,000\n".to_vec();
        bytes.extend_from_slice(b"Caf\xE9 \xE0 c\xF4t\xE9 de l'h\xF4tel\n\n");
        bytes.extend_from_slice(b"2\n00:00:03,000 --> 00:00:04,000\nplain ascii\n");
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn build_plan_carries_existing_subtitles_through_a_compression_too() {
        // Compression takes the other branch at the top of `build_plan`,
        // so it needs its own guard against the tracks going missing.
        let mut req = req_with(TargetFormat::Mp4, None);
        req.compress_mode = Some(goop_core::CompressMode::Quality(50));
        let (plan, _) = build_plan(&req, &probe_with_subtitles(&["subrip"])).unwrap();

        assert!(plan.args.iter().any(|a| a == "0:s?"));
        assert!(plan.args.windows(2).any(|w| w == ["-c:s", "mov_text"]));
    }

    #[test]
    fn build_plan_leaves_a_subtitle_free_source_untouched() {
        let (plan, extra) =
            build_plan(&req_with(TargetFormat::Mkv, None), &probe_h264_aac()).unwrap();
        assert_eq!(extra, SubtitleInput::default());
        assert_eq!(
            plan.args,
            vec!["-c", "copy"],
            "one audio stream and no subtitles needs no maps at all"
        );
    }

    // --- Multi-audio sources carrying no subtitles ---------------------
    //
    // Regression: this branch emitted maps only when the source had
    // subtitles, so a multi-audio file with none got no `-map` at all and
    // ffmpeg's automatic selection thinned it to a single track, silently.

    #[test]
    fn build_plan_keeps_every_audio_track_of_a_subtitle_free_source() {
        for target in [TargetFormat::Mkv, TargetFormat::Mp4, TargetFormat::Mov] {
            let (plan, _) =
                build_plan(&req_with(target, None), &probe_with_audio(&["aac", "aac"])).unwrap();
            assert!(
                plan.args.windows(2).any(|w| w == ["-map", "0:a?"]),
                "{target:?} dropped the second audio track: {:?}",
                plan.args
            );
            assert!(
                !plan.args.iter().any(|a| a == "0:s?"),
                "{target:?} invented a subtitle map for a source with none"
            );
        }
    }

    #[test]
    fn build_plan_narrows_the_audio_map_for_a_codec_the_container_cannot_describe() {
        // MP4 has no mapping for Vorbis and boxes it under the `mp4a` (AAC)
        // FourCC rather than refusing, so the track arrives undecodable at
        // exit 0. Dropping it is the lesser loss.
        let (plan, _) = build_plan(
            &req_with(TargetFormat::Mp4, None),
            &probe_with_audio(&["aac", "vorbis"]),
        )
        .unwrap();
        assert_eq!(
            plan.args,
            vec!["-c", "copy"],
            "no maps: ffmpeg's own selection keeps the first track"
        );
    }

    #[test]
    fn build_plan_keeps_every_audio_track_when_matroska_is_the_target() {
        // Matroska identifies codecs by CodecID string, so the codec that
        // MP4 has to drop rides along here untouched.
        let (plan, _) = build_plan(
            &req_with(TargetFormat::Mkv, None),
            &probe_with_audio(&["aac", "vorbis"]),
        )
        .unwrap();
        assert!(plan.args.windows(2).any(|w| w == ["-map", "0:a?"]));
    }

    #[test]
    fn build_plan_keeps_every_audio_track_when_the_plan_re_encodes() {
        // Re-encoding rewrites every mapped stream into the one codec the
        // plan names, so an otherwise unvettable source becomes safe.
        let mut req = req_with(TargetFormat::Mp4, None);
        req.quality_preset = Some(QualityPreset::Fast);
        let (plan, _) = build_plan(&req, &probe_with_audio(&["aac", "vorbis"])).unwrap();
        assert!(plan.args.windows(2).any(|w| w == ["-map", "0:a?"]));
    }

    #[test]
    fn build_plan_adds_no_audio_maps_to_an_audio_only_target() {
        // An MP3 holds one audio stream by definition; mapping `0:a?` into
        // one would ask the muxer for a second stream it cannot write.
        for target in [TargetFormat::Mp3, TargetFormat::Wav, TargetFormat::Flac] {
            let (plan, _) =
                build_plan(&req_with(target, None), &probe_with_audio(&["aac", "aac"])).unwrap();
            assert!(
                !plan.args.iter().any(|a| a == "0:a?" || a == "0:v:0?"),
                "{target:?}: {:?}",
                plan.args
            );
        }
    }

    #[test]
    fn build_plan_adds_no_audio_maps_for_a_single_audio_stream() {
        // Automatic selection already keeps the only track there is, and an
        // explicit map would override ffmpeg's pick of the *best* stream
        // rather than merely the first.
        let (plan, _) = build_plan(
            &req_with(TargetFormat::Mp4, None),
            &probe_with_audio(&["aac"]),
        )
        .unwrap();
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    #[test]
    fn build_plan_leaves_maps_alone_when_bitmap_subtitles_block_them() {
        // A source with PGS subtitles and several audio tracks: naming the
        // audio without also naming `0:s?` would turn a thinned-out
        // subtitle track into no subtitle track at all, so this path stays
        // map-free and both losses stay with ffmpeg's defaults.
        let probe = ProbeResult {
            has_subtitles: true,
            subtitle_codecs: vec!["hdmv_pgs_subtitle".into()],
            ..probe_with_audio(&["aac", "aac"])
        };
        let (plan, _) = build_plan(&req_with(TargetFormat::Mkv, None), &probe).unwrap();
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    #[test]
    fn build_plan_does_not_map_bitmap_subtitles_it_cannot_transcode() {
        // Forcing PGS into a text codec aborts the whole conversion, so the
        // plan must stay map-free and let ffmpeg handle the streams itself.
        let (plan, _) = build_plan(
            &req_with(TargetFormat::Mp4, None),
            &probe_with_subtitles(&["hdmv_pgs_subtitle"]),
        )
        .unwrap();
        assert_eq!(plan.args, vec!["-c", "copy"]);
    }

    #[test]
    fn build_plan_does_not_map_a_bare_subtitle_source_into_a_container() {
        // A `.srt` probes as source_kind Subtitle with has_subtitles true,
        // so it otherwise satisfies the preserve condition and picks up
        // maps for video and audio streams that do not exist. Reachable
        // from the UI via "apply to all" and presets, which set a row's
        // target without consulting its source kind.
        let probe = ProbeResult {
            source_kind: goop_core::SourceKind::Subtitle,
            has_subtitles: true,
            subtitle_codecs: vec!["subrip".into()],
            ..probe_h264_aac()
        };
        let (plan, _) = build_plan(&req_with(TargetFormat::Mp4, None), &probe).unwrap();

        assert!(!plan.args.iter().any(|a| a == "0:s?"));
        assert!(!plan.args.iter().any(|a| a == "0:v:0?"));
    }

    #[test]
    fn build_plan_does_not_map_subtitles_into_an_audio_only_target() {
        let (plan, _) = build_plan(
            &req_with(TargetFormat::Mp3, None),
            &probe_with_subtitles(&["subrip"]),
        )
        .unwrap();
        assert!(!plan.args.iter().any(|a| a == "0:s?"));
        assert!(!plan.args.iter().any(|a| a == "0:v:0?"));
    }

    #[test]
    fn build_plan_soft_embed_returns_the_subtitle_as_a_second_input() {
        let sub = tempfile_srt("build-plan-soft");
        let req = req_with(
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: sub.to_string_lossy().into_owned(),
                mode: SubtitleMode::Soft,
            }),
        );
        let (plan, extra) = build_plan(&req, &probe_h264_aac()).unwrap();
        assert_eq!(extra.path, Some(sub.clone()));
        assert!(plan.args.windows(2).any(|w| w == ["-c:s", "mov_text"]));
        fs::remove_file(&sub).ok();
    }

    #[test]
    fn build_plan_burn_in_forces_an_encode_and_adds_the_filter() {
        let sub = tempfile_srt("build-plan-burn");
        let req = req_with(
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: sub.to_string_lossy().into_owned(),
                mode: SubtitleMode::BurnIn,
            }),
        );
        // Source is h264/aac, which would otherwise remux.
        let (plan, extra) = build_plan(&req, &probe_h264_aac()).unwrap();
        assert_eq!(extra.path, None);
        assert!(plan.reencoded, "burn-in must never stream-copy");
        assert!(plan
            .video_filters
            .iter()
            .any(|f| f.starts_with("subtitles=")));
        fs::remove_file(&sub).ok();
    }

    #[test]
    fn build_plan_rejects_a_missing_subtitle_file() {
        let req = req_with(
            TargetFormat::Mp4,
            Some(SubtitleOptions {
                source_path: "/definitely/not/here.srt".into(),
                mode: SubtitleMode::Soft,
            }),
        );
        let err = build_plan(&req, &probe_h264_aac()).unwrap_err();
        assert!(
            matches!(err, GoopError::InvalidRequest(ref m) if m.contains("not/here.srt")),
            "got {err:?}"
        );
    }

    fn tempfile_srt(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("goop-{tag}-{}.srt", std::process::id()));
        fs::write(&p, "1\n00:00:00,000 --> 00:00:01,000\nhi\n").unwrap();
        p
    }

    #[test]
    fn resolve_treats_dir_as_dir() {
        let dir = std::env::temp_dir().join(format!("goop-resolve-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let plan = decide(TargetFormat::Mp3, None, Some("aac"), None, None, None);
        let out = resolve_output_path("/src/video.mp4", dir.to_str().unwrap(), &plan).unwrap();
        assert_eq!(out.file_name().unwrap(), "video.mp3");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_honors_full_file_path() {
        let plan = decide(
            TargetFormat::Mp4,
            Some("h264"),
            Some("aac"),
            None,
            None,
            None,
        );
        let target = std::env::temp_dir().join("goop-explicit.mp4");
        let out = resolve_output_path("/src/clip.mkv", target.to_str().unwrap(), &plan).unwrap();
        let expected = std::fs::canonicalize(target.parent().unwrap())
            .unwrap()
            .join(target.file_name().unwrap());
        assert_eq!(out, expected);
    }
}
