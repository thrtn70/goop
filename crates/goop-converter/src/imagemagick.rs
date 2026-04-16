use crate::backend::ConversionBackend;
use crate::imagemagick_probe::parse_identify_output;
use crate::naming::{allocate_output_path, stem_of};
use goop_core::{
    ConvertRequest, ConvertResult, EventSink, GoopError, JobId, ProbeResult, ProgressEvent,
};
use goop_sidecar::BinaryResolver;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub struct ImageMagickBackend<'a> {
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
}

impl<'a> ImageMagickBackend<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self { resolver, sink }
    }
}

impl<'a> ConversionBackend for ImageMagickBackend<'a> {
    async fn probe(resolver: &BinaryResolver, path: &Path) -> Result<ProbeResult, GoopError> {
        let bin = resolver.resolve("magick")?;

        let out = Command::new(&bin.path)
            .arg("identify")
            .arg("-verbose")
            .arg(path)
            .output()
            .await?;

        if !out.status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: "magick".into(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }

        let raw = String::from_utf8_lossy(&out.stdout);
        let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

        parse_identify_output(&raw, file_size)
    }

    async fn convert(
        &self,
        job_id: JobId,
        req: &ConvertRequest,
        cancel: CancellationToken,
    ) -> Result<ConvertResult, GoopError> {
        let bin = self.resolver.resolve("magick")?;
        let input = PathBuf::from(&req.input_path);

        if !input.exists() {
            return Err(GoopError::SubprocessFailed {
                binary: "magick".into(),
                stderr: format!("input file does not exist: {}", req.input_path),
            });
        }

        let output_path = resolve_output_path(&req.input_path, &req.output_path, req)?;

        // Emit 0% progress at start
        self.sink.emit_progress(ProgressEvent {
            job_id,
            percent: 0.0,
            eta_secs: None,
            speed_hr: None,
            stage: "converting".into(),
        });

        let started = std::time::Instant::now();

        let mut child = Command::new(&bin.path)
            .arg(&input)
            .arg(&output_path)
            .spawn()?;

        // Wait for completion or cancellation
        let status = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = std::fs::remove_file(&output_path);
                return Err(GoopError::Cancelled);
            }
            result = child.wait() => result?,
        };

        if !status.success() {
            let _ = std::fs::remove_file(&output_path);
            return Err(GoopError::SubprocessFailed {
                binary: "magick".into(),
                stderr: format!("magick exited with status {status}"),
            });
        }

        let bytes = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // Emit 100% progress on completion
        self.sink.emit_progress(ProgressEvent {
            job_id,
            percent: 100.0,
            eta_secs: Some(0),
            speed_hr: None,
            stage: "converting".into(),
        });

        Ok(ConvertResult {
            output_path: output_path.to_string_lossy().into_owned(),
            bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            reencoded: true,
        })
    }
}

fn resolve_output_path(
    input_path: &str,
    requested: &str,
    req: &ConvertRequest,
) -> Result<PathBuf, GoopError> {
    let requested_buf = PathBuf::from(requested);

    if requested_buf.is_dir() {
        let stem = stem_of(input_path);
        let ext = req.target.extension();
        Ok(allocate_output_path(&requested_buf, &stem, ext))
    } else {
        if let Some(parent) = requested_buf.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        Ok(requested_buf)
    }
}
