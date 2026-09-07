use goop_converter::{imagemagick_probe::probe_image, preview::PreviewService};
use goop_core::PreviewRequest;
use goop_sidecar::BinaryResolver;
use serde_json::{json, Value};
use std::{
    error::Error,
    path::{Path, PathBuf},
    time::Instant,
};
type AnyError = Box<dyn Error>;
struct Args {
    mode: String,
    input: PathBuf,
    sidecars: PathBuf,
    output: PathBuf,
    count: usize,
    concurrency: usize,
}
impl Args {
    fn parse(v: &[String]) -> Result<Self, AnyError> {
        if v.len() != 7 {
            return Err("expected mode input sidecars output count concurrency".into());
        }
        let count: usize = v[5].parse()?;
        let concurrency: usize = v[6].parse()?;
        if !matches!(v[1].as_str(), "probe" | "preview")
            || !(1..=20).contains(&count)
            || !(1..=4).contains(&concurrency)
            || (v[1] == "preview" && concurrency != 1)
        {
            return Err("invalid mode, count or concurrency".into());
        }
        Ok(Self {
            mode: v[1].clone(),
            input: v[2].clone().into(),
            sidecars: v[3].clone().into(),
            output: v[4].clone().into(),
            count,
            concurrency,
        })
    }
}
fn claim_output(path: &Path) -> std::io::Result<()> {
    // Must be fresh; no adoption or cleanup of someone else's directory.
    std::fs::create_dir(path)
}
fn probe_record(input: &Path, index: usize) -> Value {
    let start = Instant::now();
    let result = probe_image(input);
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(probe) => json!({"index":index,"elapsed_ms":elapsed,"probe":probe}),
        Err(error) => json!({"index":index,"elapsed_ms":elapsed,"error":error.to_string()}),
    }
}
#[tokio::main]
async fn main() -> Result<(), AnyError> {
    let args = Args::parse(&std::env::args().collect::<Vec<_>>())?;
    if !args.input.is_file() {
        return Err("input must be an existing file".into());
    }
    claim_output(&args.output)?;
    let started = Instant::now();
    let mut records = Vec::new();
    if args.mode == "probe" {
        records = std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for worker in 0..args.concurrency {
                let input = &args.input;
                let count = args.count;
                let concurrency = args.concurrency;
                workers.push(scope.spawn(move || {
                    (worker..count)
                        .step_by(concurrency)
                        .map(|i| probe_record(input, i))
                        .collect::<Vec<_>>()
                }));
            }
            let mut all = Vec::new();
            for worker in workers {
                match worker.join() {
                    Ok(rows) => all.extend(rows),
                    Err(_) => all.push(json!({"error":"probe worker panicked"})),
                }
            }
            all
        });
    } else {
        let service = PreviewService::new(args.output.join("samples"));
        let resolver = BinaryResolver::new(args.sidecars.clone());
        for index in 0..args.count {
            let id = format!("measure-{index}");
            let request: PreviewRequest = serde_json::from_value(json!({
                "request_id":id,"input_path":args.input,"source_revision":"1",
                "target":"jpeg","quality_preset":null,"resolution_cap":null,
                "compress_mode":null,"metadata_policy":null,"subtitle":null,
                "gif_options":null,"image_options":null
            }))?;
            let start = Instant::now();
            let result = service.generate(&resolver, request).await;
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            records.push(match result {
                Ok(result) => json!({"index":index,"elapsed_ms":elapsed,"result":result}),
                Err(error) => json!({"index":index,"elapsed_ms":elapsed,"error":error.to_string()}),
            });
            service.cancel(&id);
        }
    }
    let successes = records.iter().filter(|r| r.get("error").is_none()).count();
    let report = json!({"mode":args.mode,"input":args.input,"count":args.count,
        "concurrency":args.concurrency,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
        "successes":successes,"records":records});
    let bytes = serde_json::to_vec_pretty(&report)?;
    std::fs::write(args.output.join("metrics.json"), &bytes)?;
    println!("{}", String::from_utf8(bytes)?);
    if successes != args.count {
        return Err("one or more measurements failed; see metrics".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(mode: &str, count: &str, concurrency: &str) -> Vec<String> {
        [
            "driver",
            mode,
            "input.jpg",
            "sidecars",
            "output",
            count,
            concurrency,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }
    #[test]
    fn rejects_bad_workload_arguments() {
        assert!(Args::parse(&args("probe", "20", "4")).is_ok());
        for (mode, count, concurrency) in [
            ("unknown", "1", "1"),
            ("probe", "0", "1"),
            ("probe", "21", "1"),
            ("probe", "1", "5"),
            ("preview", "1", "2"),
        ] {
            assert!(Args::parse(&args(mode, count, concurrency)).is_err());
        }
    }
    #[test]
    fn never_adopts_existing_output_or_hides_probe_error() {
        let tmp = tempfile::tempdir().unwrap();
        let keep = tmp.path().join("keep");
        std::fs::write(&keep, b"unchanged").unwrap();
        assert!(claim_output(tmp.path()).is_err());
        assert_eq!(std::fs::read(keep).unwrap(), b"unchanged");
        assert!(probe_record(&tmp.path().join("missing.jpg"), 0)
            .get("error")
            .is_some());
    }
}
