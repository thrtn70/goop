use goop_converter::{
    backend_for_extension, capabilities, BackendKind, ConversionBackend, FfmpegBackend,
    ImageMagickBackend,
};
use goop_core::{ConvertRequest, EventSink, JobId, ProgressEvent, QueueEvent, SidecarEvent};
use goop_sidecar::BinaryResolver;
use std::{path::Path, sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;
struct Sink;
impl EventSink for Sink {
    fn emit_progress(&self, _: ProgressEvent) {}
    fn emit_queue(&self, _: QueueEvent) {}
    fn emit_sidecar(&self, event: SidecarEvent) {
        eprintln!("{}", serde_json::to_string(&event).unwrap());
    }
}
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "performance_baseline <sidecars> <request.json> <metrics.json>"
    );
    let req: ConvertRequest = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    let resolver = BinaryResolver::new((&args[1]).into());
    let mut metrics = serde_json::json!({"request":req,"hardware":"software","success":false,"phase":"probe","sidecars":{}});
    for name in ["ffmpeg", "ffprobe"] {
        if let Ok(bin) = resolver.resolve(name) {
            metrics["sidecars"][name] = serde_json::json!(bin.path);
        }
    }
    let now = Instant::now();
    let inspection = capabilities::inspect_source(&resolver, Path::new(&req.input_path)).await;
    metrics["probe_ms"] = serde_json::json!(now.elapsed().as_secs_f64() * 1000.0);
    let result = async {
        let inspection = inspection?;
        metrics["probe"] = serde_json::json!(inspection.probe);
        capabilities::validate_request(&req, &inspection.probe)?;
        metrics["phase"] = serde_json::json!("convert");
        let now = Instant::now();
        let cancel = CancellationToken::new();
        let result = match backend_for_extension(
            Path::new(&req.input_path)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or(""),
        ) {
            BackendKind::Ffmpeg => {
                FfmpegBackend::new(&resolver, Arc::new(Sink))
                    .convert(JobId::new(), &req, cancel)
                    .await
            }
            BackendKind::ImageMagick => {
                ImageMagickBackend::new(&resolver, Arc::new(Sink))
                    .convert(JobId::new(), &req, cancel)
                    .await
            }
        };
        metrics["process_ms"] = serde_json::json!(now.elapsed().as_secs_f64() * 1000.0);
        result
    }
    .await;
    match result {
        Ok(result) => {
            metrics["success"] = serde_json::json!(true);
            metrics["result"] = serde_json::json!(result);
        }
        Err(error) => metrics["error"] = serde_json::json!(error.to_string()),
    }
    std::fs::write(&args[3], serde_json::to_vec_pretty(&metrics).unwrap()).unwrap();
    if metrics["success"] != true {
        std::process::exit(1);
    }
}
