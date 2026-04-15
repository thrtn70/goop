use goop_core::{EventSink, GoopError, JobId, ProgressEvent};
use goop_sidecar::BinaryResolver;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ExtractRequest {
    pub url: String,
    pub output_dir: String,
    pub format: Option<String>, // e.g., "bestaudio[ext=m4a]"
    pub audio_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct ExtractResult {
    pub output_path: String,
    pub bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct UrlProbe {
    pub url: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration_secs: Option<u64>,
    pub thumbnail_url: Option<String>,
    pub formats: Vec<FormatOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct FormatOption {
    pub format_id: String,
    pub ext: String,
    pub resolution: Option<String>,
    pub filesize: Option<u64>,
    pub is_audio_only: bool,
}

pub struct YtDlp<'a> {
    resolver: &'a BinaryResolver,
    sink: Arc<dyn EventSink>,
}

impl<'a> YtDlp<'a> {
    pub fn new(resolver: &'a BinaryResolver, sink: Arc<dyn EventSink>) -> Self {
        Self { resolver, sink }
    }

    /// Probe a URL with `yt-dlp -J` (JSON metadata only, no download).
    /// Sinkless — callable without constructing a `YtDlp` instance.
    pub async fn probe(resolver: &BinaryResolver, url: &str) -> Result<UrlProbe, GoopError> {
        let bin = resolver.resolve("yt-dlp")?;
        let out = Command::new(&bin.path)
            .args(["-J", "--no-warnings", url])
            .output()
            .await?;
        if !out.status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: "yt-dlp".into(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
        Ok(UrlProbe {
            url: url.to_string(),
            title: v["title"].as_str().unwrap_or("").to_string(),
            uploader: v["uploader"].as_str().map(String::from),
            duration_secs: v["duration"].as_u64(),
            thumbnail_url: v["thumbnail"].as_str().map(String::from),
            formats: v["formats"]
                .as_array()
                .map(|fs| fs.iter().filter_map(parse_format).collect())
                .unwrap_or_default(),
        })
    }

    pub async fn download(
        &self,
        job_id: JobId,
        req: &ExtractRequest,
        cancel: CancellationToken,
    ) -> Result<ExtractResult, GoopError> {
        let bin = self.resolver.resolve("yt-dlp")?;
        let out_template = PathBuf::from(&req.output_dir).join("%(title)s.%(ext)s");

        let mut cmd = Command::new(&bin.path);
        cmd.arg("--newline") // each progress line on its own
            .arg("--no-warnings")
            .arg("--continue") // resume .part files on restart
            .arg("-o")
            .arg(&out_template)
            .arg("--print")
            .arg("after_move:filepath");
        if req.audio_only {
            cmd.arg("-x").arg("--audio-format").arg("mp3");
        }
        if let Some(fmt) = &req.format {
            cmd.arg("-f").arg(fmt);
        }
        cmd.arg(&req.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let started = std::time::Instant::now();
        let mut child: Child = cmd.spawn()?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        let mut output_path: Option<String> = None;
        let mut stderr_tail = String::new();

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(GoopError::Cancelled);
                }
                line = out_reader.next_line() => {
                    match line? {
                        Some(l) => {
                            if let Some(ev) = parse_progress(job_id, &l) {
                                self.sink.emit_progress(ev);
                            } else if !l.starts_with('[') && PathBuf::from(&l).exists() {
                                output_path = Some(l);
                            }
                        }
                        None => break,
                    }
                }
                line = err_reader.next_line() => {
                    if let Ok(Some(l)) = line {
                        stderr_tail.push_str(&l);
                        stderr_tail.push('\n');
                    }
                }
            }
        }

        let status = child.wait().await?;
        if !status.success() {
            return Err(GoopError::SubprocessFailed {
                binary: "yt-dlp".into(),
                stderr: stderr_tail,
            });
        }
        let output_path = output_path.ok_or_else(|| GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "no output file reported".into(),
        })?;
        let bytes = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        Ok(ExtractResult {
            output_path,
            bytes,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

fn parse_format(v: &serde_json::Value) -> Option<FormatOption> {
    let id = v["format_id"].as_str()?.to_string();
    let ext = v["ext"].as_str()?.to_string();
    let vcodec = v["vcodec"].as_str().unwrap_or("none");
    Some(FormatOption {
        format_id: id,
        ext,
        resolution: v["resolution"].as_str().map(String::from),
        filesize: v["filesize"].as_u64().or(v["filesize_approx"].as_u64()),
        is_audio_only: vcodec == "none",
    })
}

/// Parse yt-dlp's `--newline` progress line, e.g.
/// `[download]  42.3% of ~1.23MiB at 1.20MiB/s ETA 00:10`
fn parse_progress(job_id: JobId, line: &str) -> Option<ProgressEvent> {
    if !line.starts_with("[download]") {
        return None;
    }
    let pct_re = Regex::new(r"(\d+\.\d+)%").ok()?;
    let speed_re = Regex::new(r"at\s+([\d.]+\s*[KMG]?i?B/s)").ok()?;
    let eta_re = Regex::new(r"ETA\s+(\d{2}:\d{2}(:\d{2})?)").ok()?;
    let pct = pct_re
        .captures(line)?
        .get(1)?
        .as_str()
        .parse::<f32>()
        .ok()?;
    let speed = speed_re
        .captures(line)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    let eta_secs = eta_re
        .captures(line)
        .and_then(|c| c.get(1))
        .and_then(|m| parse_eta(m.as_str()));
    Some(ProgressEvent {
        job_id,
        percent: pct,
        eta_secs,
        speed_hr: speed,
        stage: "downloading".into(),
    })
}

fn parse_eta(s: &str) -> Option<u64> {
    let parts: Vec<u64> = s.split(':').filter_map(|p| p.parse().ok()).collect();
    match parts.len() {
        2 => Some(parts[0] * 60 + parts[1]),
        3 => Some(parts[0] * 3600 + parts[1] * 60 + parts[2]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_download_progress_line() {
        let line = "[download]  42.3% of ~1.23MiB at 1.20MiB/s ETA 00:10";
        let ev = parse_progress(JobId::new(), line).expect("should parse");
        assert!((ev.percent - 42.3).abs() < 0.01);
        assert_eq!(ev.speed_hr.as_deref(), Some("1.20MiB/s"));
        assert_eq!(ev.eta_secs, Some(10));
        assert_eq!(ev.stage, "downloading");
    }

    #[test]
    fn rejects_non_download_lines() {
        assert!(parse_progress(JobId::new(), "[info] Something").is_none());
    }

    #[test]
    fn parse_eta_hours() {
        assert_eq!(parse_eta("01:02:03"), Some(3723));
        assert_eq!(parse_eta("02:05"), Some(125));
    }
}
