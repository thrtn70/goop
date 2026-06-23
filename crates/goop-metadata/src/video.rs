//! Read-only video/container metadata via the already-bundled `ffprobe`.
//!
//! Resolves ffprobe through `BinaryResolver` (bundled first, `$PATH` fallback
//! in dev) and parses its `-print_format json` output into grouped raw tags:
//! container `Format`/`Format Tags`, and per-stream `Stream N`/`Stream N Tags`.

use crate::error_view;
use goop_core::{MetadataDomain, MetadataView, RawTag};
use goop_sidecar::BinaryResolver;
use serde_json::Value;

pub async fn read_video(resolver: &BinaryResolver, path_str: &str) -> MetadataView {
    let domain = MetadataDomain::Video;
    let bin = match resolver.resolve("ffprobe") {
        Ok(b) => b,
        Err(e) => return error_view(path_str, domain, e.to_string()),
    };

    let probe = tokio::process::Command::new(&bin.path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path_str)
        .output();

    // Guard against a corrupt container that makes ffprobe hang.
    let output = match tokio::time::timeout(std::time::Duration::from_secs(15), probe).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return error_view(path_str, domain, format!("ffprobe spawn failed: {e}")),
        Err(_) => return error_view(path_str, domain, "ffprobe timed out".to_string()),
    };
    if !output.status.success() {
        return error_view(
            path_str,
            domain,
            String::from_utf8_lossy(&output.stderr).into_owned(),
        );
    }
    let json: Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => return error_view(path_str, domain, format!("ffprobe json parse: {e}")),
    };

    let mut raw = Vec::new();

    if let Some(fmt) = json.get("format").and_then(Value::as_object) {
        for key in [
            "format_long_name",
            "duration",
            "bit_rate",
            "size",
            "nb_streams",
        ] {
            if let Some(v) = fmt.get(key).and_then(value_to_string) {
                raw.push(RawTag {
                    group: "Format".into(),
                    tag: key.to_string(),
                    value: v,
                });
            }
        }
        push_tags(&mut raw, fmt.get("tags"), "Format Tags");
    }

    if let Some(streams) = json.get("streams").and_then(Value::as_array) {
        for (i, s) in streams.iter().enumerate() {
            let group = format!("Stream {i}");
            for key in [
                "codec_type",
                "codec_name",
                "profile",
                "width",
                "height",
                "pix_fmt",
                "sample_rate",
                "channels",
                "channel_layout",
                "bit_rate",
                "r_frame_rate",
            ] {
                if let Some(v) = s.get(key).and_then(value_to_string) {
                    raw.push(RawTag {
                        group: group.clone(),
                        tag: key.to_string(),
                        value: v,
                    });
                }
            }
            push_tags(&mut raw, s.get("tags"), &format!("{group} Tags"));
        }
    }

    MetadataView {
        path: path_str.to_string(),
        domain,
        audio: None,
        cover_art: None,
        raw,
    }
}

/// Render a JSON scalar (string or number) as a display string. Objects /
/// arrays / nulls are skipped (returns None).
fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Append every scalar entry from a `tags` object under `group`.
fn push_tags(raw: &mut Vec<RawTag>, tags: Option<&Value>, group: &str) {
    if let Some(obj) = tags.and_then(Value::as_object) {
        for (k, v) in obj {
            if let Some(val) = value_to_string(v) {
                raw.push(RawTag {
                    group: group.to_string(),
                    tag: k.clone(),
                    value: val,
                });
            }
        }
    }
}
