use goop_converter::{
    backend_for_extension, capabilities, detect_encoders, BackendKind, ConversionBackend,
    DetectedEncoders, FfmpegBackend, ImageMagickBackend,
};
use goop_core::{ConvertRequest, EventSink, JobId, ProgressEvent, QueueEvent, SidecarEvent};
use goop_sidecar::BinaryResolver;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

const MAX_ENCODER_OBSERVATIONS: usize = 64;

#[derive(Default)]
struct Sink {
    encoders: Mutex<Vec<Value>>,
}
impl Sink {
    fn observations(&self) -> Vec<Value> {
        self.encoders.lock().unwrap().clone()
    }
}
impl EventSink for Sink {
    fn emit_progress(&self, event: ProgressEvent) {
        let mut values = self.encoders.lock().unwrap();
        let value = json!({"percent":event.percent,"stage":event.stage,"encoder":event.encoder});
        if values.last() != Some(&value) {
            if values.len() == MAX_ENCODER_OBSERVATIONS {
                values.remove(0);
            }
            values.push(value);
        }
    }
    fn emit_queue(&self, _: QueueEvent) {}
    fn emit_sidecar(&self, event: SidecarEvent) {
        if matches!(event, SidecarEvent::Warning { .. }) {
            eprintln!("{}", serde_json::to_string(&event).unwrap());
        }
    }
}

fn meaningful_fields_survive(raw: &Value, typed: &Value, path: &str) -> Result<(), String> {
    match raw {
        Value::Null => Ok(()),
        Value::Object(fields) => {
            let typed = typed.as_object().ok_or_else(|| {
                format!("request field {path} changed shape during typed roundtrip")
            })?;
            for (name, raw_value) in fields {
                if raw_value.is_null() {
                    continue;
                }
                let field_path = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}.{name}")
                };
                let typed_value = typed.get(name).ok_or_else(|| {
                    format!("request field {field_path} is unsupported by this engine build")
                })?;
                meaningful_fields_survive(raw_value, typed_value, &field_path)?;
            }
            Ok(())
        }
        Value::Array(values) => {
            let typed = typed.as_array().ok_or_else(|| {
                format!("request field {path} changed shape during typed roundtrip")
            })?;
            if values.len() != typed.len() {
                return Err(format!(
                    "request field {path} changed length during typed roundtrip"
                ));
            }
            for (index, value) in values.iter().enumerate() {
                meaningful_fields_survive(value, &typed[index], &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        _ if raw == typed => Ok(()),
        _ => Err(format!(
            "request field {path} changed value during typed roundtrip"
        )),
    }
}

fn inventory_metrics(encoders: &DetectedEncoders) -> Value {
    let names = [
        "libx264",
        "libx265",
        "aac",
        "h264_videotoolbox",
        "hevc_videotoolbox",
        "h264_nvenc",
        "hevc_nvenc",
        "h264_qsv",
        "hevc_qsv",
        "h264_amf",
        "hevc_amf",
    ];
    Value::Array(
        names
            .into_iter()
            .filter(|name| encoders.is_available(name))
            .map(|name| Value::String(name.into()))
            .collect(),
    )
}

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        5,
        "performance_baseline <sidecars> <request.json> <metrics.json> <hardware-enabled>"
    );
    let hardware_enabled: bool = args[4]
        .parse()
        .expect("hardware-enabled must be true or false");
    let raw: Value = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    let req: ConvertRequest = serde_json::from_value(raw.clone()).unwrap();
    let typed = serde_json::to_value(&req).unwrap();
    let resolver = BinaryResolver::new((&args[1]).into());
    let mut metrics = json!({"request":raw,"typed_request":typed,"hardware_enabled":hardware_enabled,"success":false,"phase":"request_roundtrip","sidecars":{}});
    for name in ["ffmpeg", "ffprobe"] {
        if let Ok(bin) = resolver.resolve(name) {
            metrics["sidecars"][name] = json!(bin.path);
        }
    }
    let result = async {
        meaningful_fields_survive(&raw, &typed, "")
            .map_err(goop_core::GoopError::InvalidRequest)?;
        metrics["phase"] = json!("encoder_detection");
        let now = Instant::now();
        let encoders = Arc::new(detect_encoders(&resolver).await);
        metrics["encoder_detection_ms"] = json!(now.elapsed().as_secs_f64() * 1000.0);
        metrics["detected_encoders"] = inventory_metrics(&encoders);
        metrics["phase"] = json!("probe");
        let now = Instant::now();
        let inspection =
            capabilities::inspect_source(&resolver, Path::new(&req.input_path)).await?;
        metrics["probe_ms"] = json!(now.elapsed().as_secs_f64() * 1000.0);
        metrics["probe"] = json!(inspection.probe);
        if raw.get("video_options").is_none_or(Value::is_null) {
            capabilities::validate_request(&req, &inspection.probe)?;
        }
        metrics["phase"] = json!("convert");
        let sink = Arc::new(Sink::default());
        let now = Instant::now();
        let cancel = CancellationToken::new();
        let result = match backend_for_extension(
            Path::new(&req.input_path)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or(""),
        ) {
            BackendKind::Ffmpeg => {
                FfmpegBackend::new(&resolver, sink.clone())
                    .with_encoders(encoders, hardware_enabled)
                    .convert(JobId::new(), &req, cancel)
                    .await
            }
            BackendKind::ImageMagick => {
                ImageMagickBackend::new(&resolver, sink.clone())
                    .convert(JobId::new(), &req, cancel)
                    .await
            }
        };
        metrics["process_ms"] = json!(now.elapsed().as_secs_f64() * 1000.0);
        metrics["encoder_observations"] = json!(sink.observations());
        result
    }
    .await;
    match result {
        Ok(result) => {
            metrics["success"] = json!(true);
            metrics["result"] = json!(result);
        }
        Err(error) => metrics["error"] = json!(error.to_string()),
    }
    std::fs::write(&args[3], serde_json::to_vec_pretty(&metrics).unwrap()).unwrap();
    if metrics["success"] != true {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn progress(percent: f32, encoder: Option<&str>) -> ProgressEvent {
        ProgressEvent {
            job_id: JobId::new(),
            percent,
            eta_secs: None,
            speed_hr: None,
            stage: "converting".into(),
            encoder: encoder.map(str::to_owned),
        }
    }

    #[test]
    fn bounded_observations_retain_final_software_fallback() {
        let sink = Sink::default();
        for percent in 0..=MAX_ENCODER_OBSERVATIONS {
            sink.emit_progress(progress(percent as f32, Some("h264_videotoolbox")));
        }
        sink.emit_progress(progress(0.0, None));
        let observations = sink.observations();
        assert!(observations.len() <= MAX_ENCODER_OBSERVATIONS);
        assert_eq!(observations.last().unwrap()["encoder"], Value::Null);
    }

    #[test]
    fn rejects_meaningful_fields_lost_by_an_older_typed_request() {
        assert!(meaningful_fields_survive(
            &json!({"input_path":"in","video_options":{"kind":"copy"}}),
            &json!({"input_path":"in"}),
            ""
        )
        .is_err());
    }
    #[test]
    fn permits_absent_and_null_additive_fields() {
        let old = json!({"input_path":"in"});
        assert!(meaningful_fields_survive(&json!({"input_path":"in"}), &old, "").is_ok());
        assert!(meaningful_fields_survive(
            &json!({"input_path":"in","video_options":null}),
            &old,
            ""
        )
        .is_ok());
    }
    #[test]
    fn preserves_nested_values_not_only_top_level_keys() {
        assert!(meaningful_fields_survive(
            &json!({"video_options":{"rate":{"crf":23}}}),
            &json!({"video_options":{"rate":{"crf":28}}}),
            ""
        )
        .is_err());
    }
}
