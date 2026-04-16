use crate::backend::ConversionBackend;
use crate::compat::{decide, Plan};
use crate::naming::{allocate_output_path, stem_of};
use crate::probe_json::parse_probe_json;
use crate::progress::ProgressTracker;
use goop_core::{
    ConvertRequest, ConvertResult, EventSink, GoopError, JobId, ProbeResult, ProgressEvent,
    TargetFormat,
};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

pub struct FfmpegBackend<'a> {
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
}

impl<'a> FfmpegBackend<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self { resolver, sink }
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
        let bin = self.resolver.resolve("ffmpeg")?;
        let input = PathBuf::from(&req.input_path);
        if !input.exists() {
            return Err(GoopError::SubprocessFailed {
                binary: "ffmpeg".into(),
                stderr: format!("input file does not exist: {}", req.input_path),
            });
        }

        let probe = FfmpegBackend::probe(self.resolver, &input).await?;
        let plan = decide(
            req.target,
            probe.video_codec.as_deref(),
            probe.audio_codec.as_deref(),
            req.quality_preset,
            req.resolution_cap,
            req.gif_options.as_ref(),
        );

        let output_path = resolve_output_path(&req.input_path, &req.output_path, &plan)?;

        let mut cmd = Command::new(&bin.path);
        cmd.arg("-y");

        // Some plans (e.g., GIF trim) have args that go before -i, separated
        // by the "__INPUT__" sentinel. Split on it.
        let input_idx = plan.args.iter().position(|a| a == "__INPUT__");
        if let Some(idx) = input_idx {
            for a in &plan.args[..idx] {
                cmd.arg(a);
            }
            cmd.arg("-i").arg(&input);
            for a in &plan.args[idx + 1..] {
                cmd.arg(a);
            }
        } else {
            cmd.arg("-i").arg(&input);
            for a in &plan.args {
                cmd.arg(a);
            }
        }

        // Apply video filters (-vf) if any.
        if !plan.video_filters.is_empty() {
            cmd.arg("-vf").arg(plan.video_filters.join(","));
        }

        cmd.arg("-progress").arg("pipe:1").arg("-nostats");
        cmd.arg(&output_path);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let started = std::time::Instant::now();
        let mut child: Child = cmd.spawn()?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        let mut tracker = ProgressTracker::new(probe.duration_ms);
        let stage = if plan.reencoded {
            "converting"
        } else {
            "remuxing"
        };
        let mut stderr_tail = String::new();

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    let _ = std::fs::remove_file(&output_path);
                    return Err(GoopError::Cancelled);
                }
                line = out_reader.next_line() => {
                    match line? {
                        Some(l) => {
                            if let Some(snap) = tracker.ingest(&l) {
                                self.sink.emit_progress(ProgressEvent {
                                    job_id,
                                    percent: snap.percent as f32,
                                    eta_secs: snap.eta_secs,
                                    speed_hr: snap.speed_factor.map(|f| format!("{f:.2}x")),
                                    stage: stage.into(),
                                });
                            }
                        }
                        None => break,
                    }
                }
                line = err_reader.next_line() => {
                    if let Ok(Some(l)) = line {
                        stderr_tail.push_str(&l);
                        stderr_tail.push('\n');
                        if stderr_tail.len() > 8192 {
                            let drop_to = stderr_tail.len() - 4096;
                            stderr_tail = stderr_tail[drop_to..].to_string();
                        }
                    }
                }
            }
        }

        let status = child.wait().await?;
        if !status.success() {
            let _ = std::fs::remove_file(&output_path);
            return Err(GoopError::SubprocessFailed {
                binary: "ffmpeg".into(),
                stderr: stderr_tail,
            });
        }

        let bytes = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(ConvertResult {
            output_path: output_path.to_string_lossy().into_owned(),
            bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            reencoded: plan.reencoded,
        })
    }
}

/// Backward-compat alias.
pub type Ffmpeg<'a> = FfmpegBackend<'a>;

fn resolve_output_path(
    input_path: &str,
    requested: &str,
    plan: &Plan,
) -> Result<PathBuf, GoopError> {
    let requested_buf = PathBuf::from(requested);
    if requested_buf.is_dir() {
        let stem = stem_of(input_path);
        Ok(allocate_output_path(&requested_buf, &stem, plan.ext))
    } else {
        if let Some(parent) = requested_buf.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        Ok(requested_buf)
    }
}

pub fn target_extension(target: TargetFormat, acodec: Option<&str>) -> &'static str {
    decide(target, None, acodec, None, None, None).ext
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        assert_eq!(out, target);
    }
}
