use goop_converter::{
    capabilities, detect_encoders, ConversionBackend, DetectedEncoders, FfmpegBackend,
    ImageMagickBackend,
};
use goop_core::{
    ConvertRequest, ConvertResult, EventSink, GoopError, JobId, ProgressEvent, QueueEvent,
    SidecarEvent,
};
use goop_sidecar::BinaryResolver;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    future::Future,
    io::{ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    time::Instant,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const SCHEMA_VERSION: u32 = 1;
const MAX_CONCURRENCY: usize = 16;
const MEMORY_EVIDENCE: &str =
    "not_measured_by_adapter; use external process-tree RSS and /usr/bin/time evidence";
const PATH_SAFETY_LIMITATION: &str = "canonical non-symlink parents are revalidated immediately before use; path-based production backends cannot prevent a filesystem namespace race after that check";

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum WorkloadRequest {
    InspectionBurst {
        schema_version: u32,
        suite_dir: PathBuf,
        sources: Vec<InspectionSource>,
    },
    ConversionBatch {
        schema_version: u32,
        suite_dir: PathBuf,
        concurrency: usize,
        items: Vec<RawConversionItem>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectionSource {
    id: String,
    input_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConversionItem {
    id: String,
    request: Value,
}

#[derive(Debug)]
struct ConversionItem {
    id: String,
    raw_request: Value,
    request: ConvertRequest,
}

#[derive(Debug)]
enum PreparedWorkload {
    InspectionBurst {
        requested_suite_dir: PathBuf,
        suite_dir: PathBuf,
        sources: Vec<InspectionSource>,
    },
    ConversionBatch {
        requested_suite_dir: PathBuf,
        suite_dir: PathBuf,
        concurrency: usize,
        items: Vec<ConversionItem>,
    },
}

impl PreparedWorkload {
    fn suite_dirs(&self) -> (&Path, &Path) {
        match self {
            Self::InspectionBurst {
                requested_suite_dir,
                suite_dir,
                ..
            }
            | Self::ConversionBatch {
                requested_suite_dir,
                suite_dir,
                ..
            } => (requested_suite_dir, suite_dir),
        }
    }
}

#[derive(Debug, Serialize)]
struct WorkloadMetrics {
    schema_version: u32,
    mode: String,
    success: bool,
    aggregate_ms: Option<f64>,
    wall_ms: f64,
    encoder_detection_ms: Option<f64>,
    max_observed_concurrency: Option<usize>,
    items: Vec<Value>,
    memory_evidence: &'static str,
    path_safety_limitation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn validate_schema_version(version: u32) -> Result<(), String> {
    if version == SCHEMA_VERSION {
        Ok(())
    } else {
        Err(format!(
            "unsupported schema_version {version}; expected {SCHEMA_VERSION}"
        ))
    }
}

fn validate_suite_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!(
            "suite_dir is not an existing directory: {}",
            path.display()
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("could not resolve suite_dir {}: {error}", path.display()))
}

fn validate_source(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "source is not an existing file: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_id(id: &str, ids: &mut HashSet<String>) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("item id must not be empty".into());
    }
    if !ids.insert(id.to_owned()) {
        return Err(format!("duplicate item id: {id}"));
    }
    Ok(())
}

fn secure_new_path(
    requested_suite_dir: &Path,
    canonical_suite_dir: &Path,
    requested_path: &Path,
) -> Result<PathBuf, String> {
    if !requested_path.is_absolute() {
        return Err(format!(
            "owned path must be absolute: {}",
            requested_path.display()
        ));
    }
    let relative = requested_path
        .strip_prefix(requested_suite_dir)
        .map_err(|_| {
            format!(
                "owned path must stay under suite_dir {}: {}",
                requested_suite_dir.display(),
                requested_path.display()
            )
        })?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "owned path is not normalized: {}",
            requested_path.display()
        ));
    }
    let relative_parent = relative
        .parent()
        .ok_or_else(|| format!("owned path has no parent: {}", requested_path.display()))?;
    let mut secured_parent = canonical_suite_dir.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(name) = component else {
            return Err(format!(
                "owned path is not normalized: {}",
                requested_path.display()
            ));
        };
        secured_parent.push(name);
        match fs::symlink_metadata(&secured_parent) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "owned path parent is not a real directory: {}",
                        secured_parent.display()
                    ));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if let Err(create_error) = fs::create_dir(&secured_parent) {
                    if create_error.kind() != ErrorKind::AlreadyExists {
                        return Err(format!(
                            "could not create owned directory {}: {create_error}",
                            secured_parent.display()
                        ));
                    }
                }
                let metadata = fs::symlink_metadata(&secured_parent).map_err(|error| {
                    format!(
                        "could not inspect owned directory {}: {error}",
                        secured_parent.display()
                    )
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "owned path parent is not a real directory: {}",
                        secured_parent.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "could not inspect owned directory {}: {error}",
                    secured_parent.display()
                ))
            }
        }
        let resolved = secured_parent.canonicalize().map_err(|error| {
            format!(
                "could not resolve owned directory {}: {error}",
                secured_parent.display()
            )
        })?;
        if resolved != secured_parent || !resolved.starts_with(canonical_suite_dir) {
            return Err(format!(
                "owned path parent escapes suite_dir: {}",
                requested_path.display()
            ));
        }
    }
    let file_name = relative
        .file_name()
        .ok_or_else(|| format!("owned path has no file name: {}", requested_path.display()))?;
    let secured = secured_parent.join(file_name);
    match fs::symlink_metadata(&secured) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(secured),
        Ok(_) => Err(format!("owned path already exists: {}", secured.display())),
        Err(error) => Err(format!(
            "could not inspect owned path {}: {error}",
            secured.display()
        )),
    }
}

fn revalidate_secured_new_path(suite_dir: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("owned path has no parent: {}", path.display()))?;
    let resolved_parent = parent.canonicalize().map_err(|error| {
        format!(
            "could not resolve owned path parent {}: {error}",
            parent.display()
        )
    })?;
    if resolved_parent != parent || !resolved_parent.starts_with(suite_dir) {
        return Err(format!(
            "owned path parent no longer resolves inside suite_dir: {}",
            path.display()
        ));
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(format!("owned path already exists: {}", path.display())),
        Err(error) => Err(format!(
            "could not inspect owned path {}: {error}",
            path.display()
        )),
    }
}

fn secure_metrics_path(
    requested_suite_dir: &Path,
    canonical_suite_dir: &Path,
    requested_path: &Path,
) -> Result<PathBuf, String> {
    secure_new_path(requested_suite_dir, canonical_suite_dir, requested_path)
}

fn reproducible_path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
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

fn parse_and_validate(raw: &[u8]) -> Result<PreparedWorkload, String> {
    let request: WorkloadRequest = serde_json::from_slice(raw)
        .map_err(|error| format!("invalid workload request: {error}"))?;
    match request {
        WorkloadRequest::InspectionBurst {
            schema_version,
            suite_dir,
            sources,
        } => {
            validate_schema_version(schema_version)?;
            let requested_suite_dir = suite_dir;
            let suite_dir = validate_suite_dir(&requested_suite_dir)?;
            if sources.is_empty() {
                return Err("inspection_burst requires at least one source".into());
            }
            let mut ids = HashSet::new();
            for source in &sources {
                validate_id(&source.id, &mut ids)?;
                validate_source(&source.input_path)?;
            }
            Ok(PreparedWorkload::InspectionBurst {
                requested_suite_dir,
                suite_dir,
                sources,
            })
        }
        WorkloadRequest::ConversionBatch {
            schema_version,
            suite_dir,
            concurrency,
            items,
        } => {
            validate_schema_version(schema_version)?;
            if !(1..=MAX_CONCURRENCY).contains(&concurrency) {
                return Err(format!(
                    "concurrency must be between 1 and {MAX_CONCURRENCY}"
                ));
            }
            if items.is_empty() {
                return Err("conversion_batch requires at least one item".into());
            }
            let requested_suite_dir = suite_dir;
            let suite_dir = validate_suite_dir(&requested_suite_dir)?;
            let mut ids = HashSet::new();
            let mut outputs = HashSet::new();
            let mut prepared = Vec::with_capacity(items.len());
            for item in items {
                validate_id(&item.id, &mut ids)?;
                let mut request: ConvertRequest = serde_json::from_value(item.request.clone())
                    .map_err(|error| format!("invalid request for {}: {error}", item.id))?;
                let typed = serde_json::to_value(&request)
                    .map_err(|error| format!("could not roundtrip request {}: {error}", item.id))?;
                meaningful_fields_survive(&item.request, &typed, "")?;
                validate_source(Path::new(&request.input_path))?;
                let output = secure_new_path(
                    &requested_suite_dir,
                    &suite_dir,
                    Path::new(&request.output_path),
                )?;
                if !outputs.insert(reproducible_path_key(&output)) {
                    return Err(format!(
                        "duplicate output path in batch: {}",
                        request.output_path
                    ));
                }
                request.output_path = output.into_os_string().into_string().map_err(|_| {
                    format!("secured output path for {} is not valid UTF-8", item.id)
                })?;
                prepared.push(ConversionItem {
                    id: item.id,
                    raw_request: item.request,
                    request,
                });
            }
            Ok(PreparedWorkload::ConversionBatch {
                requested_suite_dir,
                suite_dir,
                concurrency,
                items: prepared,
            })
        }
    }
}

async fn run_bounded<T, R, F, Fut>(
    items: Vec<T>,
    concurrency: usize,
    worker: F,
) -> (Vec<Result<R, String>>, usize)
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = R> + Send + 'static,
{
    assert!(concurrency > 0);
    let item_count = items.len();
    let mut pending = items.into_iter().enumerate();
    let mut tasks = JoinSet::new();
    let mut active = 0usize;
    let mut max_observed = 0usize;
    let mut results: Vec<Option<Result<R, String>>> =
        std::iter::repeat_with(|| None).take(item_count).collect();
    let mut task_indices = HashMap::new();

    while active < concurrency {
        let Some((index, item)) = pending.next() else {
            break;
        };
        let run = worker.clone();
        let handle = tasks.spawn(async move { (index, run(item).await) });
        task_indices.insert(handle.id(), index);
        active += 1;
        max_observed = max_observed.max(active);
    }

    while let Some(joined) = tasks.join_next_with_id().await {
        match joined {
            Ok((task_id, (index, result))) => {
                task_indices.remove(&task_id);
                results[index] = Some(Ok(result));
            }
            Err(error) => {
                let task_id = error.id();
                if let Some(index) = task_indices.remove(&task_id) {
                    results[index] = Some(Err(format!("workload item task failed: {error}")));
                }
            }
        }
        active -= 1;
        if let Some((next_index, item)) = pending.next() {
            let run = worker.clone();
            let handle = tasks.spawn(async move { (next_index, run(item).await) });
            task_indices.insert(handle.id(), next_index);
            active += 1;
            max_observed = max_observed.max(active);
        }
    }

    (
        results
            .into_iter()
            .map(|result| {
                result.unwrap_or_else(|| Err("workload item did not report a result".into()))
            })
            .collect(),
        max_observed,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceFingerprint {
    bytes: u64,
    sha256: [u8; 32],
}

struct Sha256State {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    bytes: u64,
}

impl Sha256State {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0; 64],
            buffered: 0,
            bytes: 0,
        }
    }

    fn update(&mut self, mut input: &[u8]) {
        self.bytes += input.len() as u64;
        if self.buffered != 0 {
            let take = (64 - self.buffered).min(input.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&input[..take]);
            self.buffered += take;
            input = &input[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }
        while input.len() >= 64 {
            let block: &[u8; 64] = input[..64].try_into().expect("64-byte SHA-256 block");
            self.compress(block);
            input = &input[64..];
        }
        self.buffer[..input.len()].copy_from_slice(input);
        self.buffered = input.len();
    }

    fn finish(mut self) -> [u8; 32] {
        let bit_len = self
            .bytes
            .checked_mul(8)
            .expect("source length fits SHA-256");
        self.buffer[self.buffered] = 0x80;
        self.buffered += 1;
        if self.buffered > 56 {
            self.buffer[self.buffered..].fill(0);
            let block = self.buffer;
            self.compress(&block);
            self.buffer = [0; 64];
            self.buffered = 0;
        }
        self.buffer[self.buffered..56].fill(0);
        self.buffer[56..].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buffer;
        self.compress(&block);
        let mut digest = [0u8; 32];
        for (chunk, value) in digest.chunks_exact_mut(4).zip(self.state) {
            chunk.copy_from_slice(&value.to_be_bytes());
        }
        digest
    }

    fn compress(&mut self, block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut words = [0u32; 64];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes(chunk.try_into().expect("four-byte word"));
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for index in 0..64 {
            let choice = (e & f) ^ ((!e) & g);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }
}

fn hex_digest(digest: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut state = Sha256State::new();
    state.update(bytes);
    hex_digest(&state.finish())
}

fn source_fingerprint(path: &Path) -> Result<SourceFingerprint, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("could not open source {}: {error}", path.display()))?;
    let mut hasher = Sha256State::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read source {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok(SourceFingerprint {
        bytes,
        sha256: hasher.finish(),
    })
}

type Fingerprinter =
    Arc<dyn Fn(&Path) -> Result<SourceFingerprint, String> + Send + Sync + 'static>;
type PhaseObserver = Arc<dyn Fn(EnginePhaseBoundary) + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EnginePhaseBoundary {
    Started,
    Finished,
}

#[derive(Clone)]
struct FingerprintEvidence {
    source_path: PathBuf,
    before: Option<SourceFingerprint>,
    before_ms: f64,
    before_error: Option<String>,
}

struct Fingerprinted<T> {
    item: T,
    evidence: FingerprintEvidence,
}

struct EngineItem {
    metric: Value,
    evidence: FingerprintEvidence,
}

fn pre_fingerprint<T>(
    item: T,
    source_path: PathBuf,
    fingerprinter: &Fingerprinter,
) -> Fingerprinted<T> {
    let started = Instant::now();
    let result = fingerprinter(&source_path);
    let before_ms = started.elapsed().as_secs_f64() * 1000.0;
    let (before, before_error) = match result {
        Ok(fingerprint) => (Some(fingerprint), None),
        Err(error) => (None, Some(error)),
    };
    Fingerprinted {
        item,
        evidence: FingerprintEvidence {
            source_path,
            before,
            before_ms,
            before_error,
        },
    }
}

fn finish_fingerprints(items: Vec<EngineItem>, fingerprinter: &Fingerprinter) -> Vec<Value> {
    items
        .into_iter()
        .map(|mut item| {
            item.metric["source_fingerprint_before_ms"] = json!(item.evidence.before_ms);
            let started = Instant::now();
            let after = fingerprinter(&item.evidence.source_path);
            item.metric["source_fingerprint_after_ms"] =
                json!(started.elapsed().as_secs_f64() * 1000.0);
            let source_error = match (item.evidence.before, after) {
                (Some(before), Ok(after)) if after == before => {
                    item.metric["source_sha256"] = json!(hex_digest(&before.sha256));
                    None
                }
                (Some(before), Ok(_)) => {
                    item.metric["source_sha256"] = json!(hex_digest(&before.sha256));
                    Some(format!(
                        "source bytes changed during workload execution: {}",
                        item.evidence.source_path.display()
                    ))
                }
                (Some(before), Err(error)) => {
                    item.metric["source_sha256"] = json!(hex_digest(&before.sha256));
                    Some(error)
                }
                (None, _) => None,
            };
            if let Some(source_error) = source_error {
                item.metric["success"] = json!(false);
                let error = match item.metric.get("error").and_then(Value::as_str) {
                    Some(existing) => format!("{existing}; {source_error}"),
                    None => source_error,
                };
                item.metric["error"] = json!(error);
            }
            item.metric
        })
        .collect()
}

#[derive(Default)]
struct SilentSink;

impl EventSink for SilentSink {
    fn emit_progress(&self, _: ProgressEvent) {}
    fn emit_queue(&self, _: QueueEvent) {}
    fn emit_sidecar(&self, _: SidecarEvent) {}
}

fn failed_item(id: &str, elapsed_ms: Option<f64>, error: String) -> Value {
    json!({
        "id": id,
        "success": false,
        "elapsed_ms": elapsed_ms,
        "error": error,
        "cancelled": Value::Null,
        "start_offset_ms": Value::Null,
        "end_offset_ms": Value::Null,
        "source_fingerprint_before_ms": Value::Null,
        "source_fingerprint_after_ms": Value::Null,
        "admission_ms": Value::Null,
        "process_ms": Value::Null,
        "probe_ms": Value::Null,
    })
}

#[derive(Clone, Copy)]
struct ItemTiming {
    start_offset_ms: f64,
    end_offset_ms: f64,
    admission_ms: Option<f64>,
    process_ms: Option<f64>,
    probe_ms: Option<f64>,
}

impl ItemTiming {
    fn elapsed_ms(self) -> f64 {
        self.end_offset_ms - self.start_offset_ms
    }
}

fn timed_failed_item(id: &str, timing: ItemTiming, cancelled: bool, error: String) -> Value {
    json!({
        "id":id,
        "success":false,
        "elapsed_ms":timing.elapsed_ms(),
        "error":error,
        "cancelled":cancelled,
        "start_offset_ms":timing.start_offset_ms,
        "end_offset_ms":timing.end_offset_ms,
        "source_fingerprint_before_ms":Value::Null,
        "source_fingerprint_after_ms":Value::Null,
        "admission_ms":timing.admission_ms,
        "process_ms":timing.process_ms,
        "probe_ms":timing.probe_ms,
    })
}

struct InspectionEngineItem {
    source: InspectionSource,
    evidence: FingerprintEvidence,
    timing: ItemTiming,
    result: Result<goop_core::ConversionInspection, GoopError>,
}

async fn inspect_engine(
    resolver: &BinaryResolver,
    encoders: &DetectedEncoders,
    engine_epoch: Instant,
    source: Fingerprinted<InspectionSource>,
) -> InspectionEngineItem {
    let Fingerprinted {
        item: source,
        evidence,
    } = source;
    debug_assert!(evidence.before_error.is_none());
    let start_offset_ms = engine_epoch.elapsed().as_secs_f64() * 1000.0;
    let probe_started = Instant::now();
    let result =
        capabilities::inspect_source_with_encoders(resolver, &source.input_path, encoders).await;
    let probe_ms = probe_started.elapsed().as_secs_f64() * 1000.0;
    let end_offset_ms = engine_epoch.elapsed().as_secs_f64() * 1000.0;
    let timing = ItemTiming {
        start_offset_ms,
        end_offset_ms,
        admission_ms: None,
        process_ms: None,
        probe_ms: Some(probe_ms),
    };
    InspectionEngineItem {
        source,
        evidence,
        timing,
        result,
    }
}

fn materialize_inspection(item: InspectionEngineItem) -> EngineItem {
    let InspectionEngineItem {
        source,
        evidence,
        timing,
        result,
    } = item;
    let metric = match result {
        Ok(inspection) => json!({
            "id":source.id,
            "success":true,
            "elapsed_ms":timing.elapsed_ms(),
            "error":Value::Null,
            "cancelled":false,
            "start_offset_ms":timing.start_offset_ms,
            "end_offset_ms":timing.end_offset_ms,
            "source_fingerprint_before_ms":Value::Null,
            "source_fingerprint_after_ms":Value::Null,
            "admission_ms":Value::Null,
            "process_ms":Value::Null,
            "probe_ms":timing.probe_ms,
            "input_path":source.input_path,
            "inspection":inspection,
            "cache_reuse":"not_exposed",
        }),
        Err(error) => {
            let cancelled = matches!(&error, GoopError::Cancelled);
            timed_failed_item(&source.id, timing, cancelled, error.to_string())
        }
    };
    EngineItem { metric, evidence }
}

fn effective_execution(result: &ConvertResult) -> Value {
    json!({
        "audio":result.audio_execution,
        "video":result.video_execution,
        "track":result.track_execution,
        "video_track":result.video_track_execution,
        "image_metadata":result.image_metadata_execution,
        "compression":result.compression_execution,
        "image_alpha":result.image_alpha_execution,
        "reencoded":result.reencoded,
    })
}

struct ConversionAttempt {
    admission_ms: f64,
    process_ms: Option<f64>,
    result: Result<ConvertResult, GoopError>,
}

async fn run_conversion(
    suite_dir: &Path,
    sidecar_dir: &Path,
    encoders: Arc<DetectedEncoders>,
    request: &ConvertRequest,
) -> ConversionAttempt {
    let resolver = BinaryResolver::new(sidecar_dir.to_path_buf());
    let admission_started = Instant::now();
    let admission = match revalidate_secured_new_path(suite_dir, Path::new(&request.output_path)) {
        Ok(()) => {
            capabilities::validate_request_source_with_encoders(&resolver, request, &encoders).await
        }
        Err(error) => Err(GoopError::InvalidRequest(error)),
    };
    let admission_ms = admission_started.elapsed().as_secs_f64() * 1000.0;
    if let Err(error) = admission {
        return ConversionAttempt {
            admission_ms,
            process_ms: None,
            result: Err(error),
        };
    }
    let sink = Arc::new(SilentSink);
    let cancel = CancellationToken::new();
    let process_started = Instant::now();
    let result = if uses_image_backend(request) {
        ImageMagickBackend::new(&resolver, sink)
            .convert(JobId::new(), request, cancel)
            .await
    } else {
        FfmpegBackend::new(&resolver, sink)
            .with_encoders(encoders, false)
            .convert(JobId::new(), request, cancel)
            .await
    };
    ConversionAttempt {
        admission_ms,
        process_ms: Some(process_started.elapsed().as_secs_f64() * 1000.0),
        result,
    }
}

fn uses_image_backend(request: &ConvertRequest) -> bool {
    request.target.is_image()
}

struct ConversionEngineItem {
    item: ConversionItem,
    evidence: FingerprintEvidence,
    timing: ItemTiming,
    result: Result<ConvertResult, GoopError>,
}

async fn convert_engine(
    suite_dir: PathBuf,
    sidecar_dir: PathBuf,
    encoders: Arc<DetectedEncoders>,
    engine_epoch: Instant,
    item: Fingerprinted<ConversionItem>,
) -> ConversionEngineItem {
    let Fingerprinted { item, evidence } = item;
    debug_assert!(evidence.before_error.is_none());
    let start_offset_ms = engine_epoch.elapsed().as_secs_f64() * 1000.0;
    let attempt = run_conversion(&suite_dir, &sidecar_dir, encoders, &item.request).await;
    let end_offset_ms = engine_epoch.elapsed().as_secs_f64() * 1000.0;
    let timing = ItemTiming {
        start_offset_ms,
        end_offset_ms,
        admission_ms: Some(attempt.admission_ms),
        process_ms: attempt.process_ms,
        probe_ms: None,
    };
    ConversionEngineItem {
        item,
        evidence,
        timing,
        result: attempt.result,
    }
}

fn materialize_conversion(item: ConversionEngineItem) -> EngineItem {
    let ConversionEngineItem {
        item,
        evidence,
        timing,
        result,
    } = item;
    let output = Path::new(&item.request.output_path);
    let metric = match result {
        Ok(result) => {
            if result.output_path != item.request.output_path {
                let metric = timed_failed_item(
                    &item.id,
                    timing,
                    false,
                    "conversion result changed the requested output path".into(),
                );
                return EngineItem { metric, evidence };
            }
            let output_bytes = match fs::metadata(output) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(_) => {
                    let metric = timed_failed_item(
                        &item.id,
                        timing,
                        false,
                        "conversion output is not a file".into(),
                    );
                    return EngineItem { metric, evidence };
                }
                Err(error) => {
                    let metric = timed_failed_item(
                        &item.id,
                        timing,
                        false,
                        format!("conversion output is missing: {error}"),
                    );
                    return EngineItem { metric, evidence };
                }
            };
            if output_bytes != result.bytes {
                let metric = timed_failed_item(
                    &item.id,
                    timing,
                    false,
                    format!(
                        "conversion result bytes {} disagree with output bytes {output_bytes}",
                        result.bytes
                    ),
                );
                return EngineItem { metric, evidence };
            }
            json!({
                "id":item.id,
                "success":true,
                "elapsed_ms":timing.elapsed_ms(),
                "error":Value::Null,
                "cancelled":false,
                "start_offset_ms":timing.start_offset_ms,
                "end_offset_ms":timing.end_offset_ms,
                "source_fingerprint_before_ms":Value::Null,
                "source_fingerprint_after_ms":Value::Null,
                "admission_ms":timing.admission_ms,
                "process_ms":timing.process_ms,
                "probe_ms":Value::Null,
                "request":item.raw_request,
                "output_path":item.request.output_path,
                "output_bytes":output_bytes,
                "effective_execution":effective_execution(&result),
                "result":result,
            })
        }
        Err(error) => {
            let cancelled = matches!(&error, GoopError::Cancelled);
            timed_failed_item(&item.id, timing, cancelled, error.to_string())
        }
    };
    EngineItem { metric, evidence }
}

fn engine_span_ms(items: &[Value]) -> Option<f64> {
    let mut start: Option<f64> = None;
    let mut end: Option<f64> = None;
    for item in items {
        let (Some(item_start), Some(item_end)) = (
            item.get("start_offset_ms").and_then(Value::as_f64),
            item.get("end_offset_ms").and_then(Value::as_f64),
        ) else {
            continue;
        };
        start = Some(start.map_or(item_start, |value| value.min(item_start)));
        end = Some(end.map_or(item_end, |value| value.max(item_end)));
    }
    match (start, end) {
        (Some(start), Some(end)) if end >= start => Some(end - start),
        _ => None,
    }
}

fn reliable_engine_span_ms(items: &[Value], join_failed: bool) -> Option<f64> {
    if join_failed {
        None
    } else {
        engine_span_ms(items)
    }
}

async fn execute_workload(workload: PreparedWorkload, sidecar_dir: PathBuf) -> WorkloadMetrics {
    execute_workload_with_fingerprinter(workload, sidecar_dir, Arc::new(source_fingerprint)).await
}

async fn execute_workload_with_fingerprinter(
    workload: PreparedWorkload,
    sidecar_dir: PathBuf,
    fingerprinter: Fingerprinter,
) -> WorkloadMetrics {
    execute_workload_with_hooks(workload, sidecar_dir, fingerprinter, Arc::new(|_| {})).await
}

async fn execute_workload_with_hooks(
    workload: PreparedWorkload,
    sidecar_dir: PathBuf,
    fingerprinter: Fingerprinter,
    phase_observer: PhaseObserver,
) -> WorkloadMetrics {
    let wall_started = Instant::now();
    match workload {
        PreparedWorkload::InspectionBurst {
            requested_suite_dir: _,
            suite_dir: _,
            sources,
        } => {
            let sources: Vec<_> = sources
                .into_iter()
                .map(|source| {
                    let source_path = source.input_path.clone();
                    pre_fingerprint(source, source_path, &fingerprinter)
                })
                .collect();
            let mut completed: Vec<Option<EngineItem>> = std::iter::repeat_with(|| None)
                .take(sources.len())
                .collect();
            let mut ready = Vec::with_capacity(sources.len());
            for (index, source) in sources.into_iter().enumerate() {
                if let Some(error) = source.evidence.before_error.clone() {
                    let mut metric = failed_item(&source.item.id, None, error);
                    metric["cancelled"] = json!(false);
                    completed[index] = Some(EngineItem {
                        metric,
                        evidence: source.evidence,
                    });
                } else {
                    ready.push((index, source));
                }
            }
            let resolver = BinaryResolver::new(sidecar_dir);
            let detection_started = Instant::now();
            let encoders = detect_encoders(&resolver).await;
            let encoder_detection_ms = detection_started.elapsed().as_secs_f64() * 1000.0;
            phase_observer(EnginePhaseBoundary::Started);
            let engine_epoch = Instant::now();
            let mut engine_results = Vec::with_capacity(ready.len());
            for (index, source) in ready {
                engine_results.push((
                    index,
                    inspect_engine(&resolver, &encoders, engine_epoch, source).await,
                ));
            }
            phase_observer(EnginePhaseBoundary::Finished);
            for (index, result) in engine_results {
                completed[index] = Some(materialize_inspection(result));
            }
            let engine_items: Vec<_> = completed
                .into_iter()
                .map(|item| item.expect("every inspection item completed"))
                .collect();
            let metric_values: Vec<_> = engine_items
                .iter()
                .map(|item| item.metric.clone())
                .collect();
            let aggregate_ms = engine_span_ms(&metric_values);
            let items = finish_fingerprints(engine_items, &fingerprinter);
            WorkloadMetrics {
                schema_version: SCHEMA_VERSION,
                mode: "inspection_burst".into(),
                success: items.iter().all(|item| item["success"] == true),
                aggregate_ms,
                wall_ms: wall_started.elapsed().as_secs_f64() * 1000.0,
                encoder_detection_ms: Some(encoder_detection_ms),
                max_observed_concurrency: None,
                items,
                memory_evidence: MEMORY_EVIDENCE,
                path_safety_limitation: PATH_SAFETY_LIMITATION,
                error: None,
            }
        }
        PreparedWorkload::ConversionBatch {
            requested_suite_dir: _,
            suite_dir,
            concurrency,
            items,
        } => {
            let items: Vec<_> = items
                .into_iter()
                .map(|item| {
                    let source_path = PathBuf::from(&item.request.input_path);
                    pre_fingerprint(item, source_path, &fingerprinter)
                })
                .collect();
            let mut completed: Vec<Option<EngineItem>> =
                std::iter::repeat_with(|| None).take(items.len()).collect();
            let mut ready = Vec::with_capacity(items.len());
            for (index, item) in items.into_iter().enumerate() {
                if let Some(error) = item.evidence.before_error.clone() {
                    let mut metric = failed_item(&item.item.id, None, error);
                    metric["cancelled"] = json!(false);
                    completed[index] = Some(EngineItem {
                        metric,
                        evidence: item.evidence,
                    });
                } else {
                    ready.push((index, item));
                }
            }
            let fallbacks: Vec<_> = ready
                .iter()
                .map(|(index, item)| (*index, item.item.id.clone(), item.evidence.clone()))
                .collect();
            let resolver = BinaryResolver::new(sidecar_dir.clone());
            let detection_started = Instant::now();
            let encoders = Arc::new(detect_encoders(&resolver).await);
            let encoder_detection_ms = detection_started.elapsed().as_secs_f64() * 1000.0;
            phase_observer(EnginePhaseBoundary::Started);
            let engine_epoch = Instant::now();
            let (results, max_observed_concurrency) = run_bounded(ready, concurrency, {
                move |(index, item)| {
                    let suite_dir = suite_dir.clone();
                    let sidecar_dir = sidecar_dir.clone();
                    let encoders = encoders.clone();
                    async move {
                        (
                            index,
                            convert_engine(suite_dir, sidecar_dir, encoders, engine_epoch, item)
                                .await,
                        )
                    }
                }
            })
            .await;
            phase_observer(EnginePhaseBoundary::Finished);
            let mut join_failed = false;
            let mut engine_results = Vec::with_capacity(results.len());
            for (ready_index, result) in results.into_iter().enumerate() {
                match result {
                    Ok((index, result)) => engine_results.push((index, result)),
                    Err(error) => {
                        join_failed = true;
                        let (index, id, evidence) = &fallbacks[ready_index];
                        completed[*index] = Some(EngineItem {
                            metric: failed_item(id, None, error),
                            evidence: evidence.clone(),
                        });
                    }
                }
            }
            for (index, result) in engine_results {
                completed[index] = Some(materialize_conversion(result));
            }
            let engine_items: Vec<_> = completed
                .into_iter()
                .map(|item| item.expect("every conversion item completed"))
                .collect();
            let metric_values: Vec<_> = engine_items
                .iter()
                .map(|item| item.metric.clone())
                .collect();
            let aggregate_ms = reliable_engine_span_ms(&metric_values, join_failed);
            let items = finish_fingerprints(engine_items, &fingerprinter);
            WorkloadMetrics {
                schema_version: SCHEMA_VERSION,
                mode: "conversion_batch".into(),
                success: items.iter().all(|item| item["success"] == true),
                aggregate_ms,
                wall_ms: wall_started.elapsed().as_secs_f64() * 1000.0,
                encoder_detection_ms: Some(encoder_detection_ms),
                max_observed_concurrency: Some(max_observed_concurrency),
                items,
                memory_evidence: MEMORY_EVIDENCE,
                path_safety_limitation: PATH_SAFETY_LIMITATION,
                error: None,
            }
        }
    }
}

fn invalid_metrics(mode: String, error: String, wall_ms: f64) -> WorkloadMetrics {
    WorkloadMetrics {
        schema_version: SCHEMA_VERSION,
        mode,
        success: false,
        aggregate_ms: None,
        wall_ms,
        encoder_detection_ms: None,
        max_observed_concurrency: None,
        items: Vec::new(),
        memory_evidence: MEMORY_EVIDENCE,
        path_safety_limitation: PATH_SAFETY_LIMITATION,
        error: Some(error),
    }
}

fn mode_hint(raw: &[u8]) -> String {
    serde_json::from_slice::<Value>(raw)
        .ok()
        .and_then(|value| value.get("mode")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "invalid".into())
}

fn suite_dirs_hint(raw: &[u8]) -> Result<(PathBuf, PathBuf), String> {
    let value: Value =
        serde_json::from_slice(raw).map_err(|error| format!("invalid workload JSON: {error}"))?;
    let requested = value
        .get("suite_dir")
        .and_then(Value::as_str)
        .ok_or_else(|| "workload request must include a string suite_dir".to_string())?;
    let requested = PathBuf::from(requested);
    let canonical = validate_suite_dir(&requested)?;
    Ok((requested, canonical))
}

fn write_metrics(suite_dir: &Path, path: &Path, metrics: &WorkloadMetrics) -> Result<(), String> {
    revalidate_secured_new_path(suite_dir, path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("metrics output has no parent: {}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("metrics.json");
    let temporary = (0..32)
        .find_map(|attempt| {
            let candidate = parent.join(format!(".{name}.tmp-{}-{attempt}", std::process::id()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!(
                    "could not create temporary metrics {}: {error}",
                    candidate.display()
                ))),
            }
        })
        .transpose()?
        .ok_or_else(|| "could not allocate a unique temporary metrics file".to_string())?;
    let (temporary, mut file) = temporary;
    let result = (|| {
        let encoded = serde_json::to_vec_pretty(metrics)
            .map_err(|error| format!("could not encode metrics: {error}"))?;
        file.write_all(&encoded)
            .map_err(|error| format!("could not write metrics: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not sync metrics: {error}"))?;
        revalidate_secured_new_path(suite_dir, path)?;
        fs::hard_link(&temporary, path).map_err(|error| {
            format!(
                "could not publish metrics without clobbering {}: {error}",
                path.display()
            )
        })
    })();
    drop(file);
    let cleanup = fs::remove_file(&temporary).map_err(|error| {
        format!(
            "could not clean temporary metrics {}: {error}",
            temporary.display()
        )
    });
    combine_publication_and_cleanup(result, cleanup)
}

fn combine_publication_and_cleanup(
    publication: Result<(), String>,
    cleanup: Result<(), String>,
) -> Result<(), String> {
    match (publication, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
        (Err(error), Err(cleanup_error)) => Err(format!("{error}; {cleanup_error}")),
    }
}

async fn run_paths(sidecar_dir: PathBuf, request_path: PathBuf, metrics_path: PathBuf) -> ExitCode {
    let started = Instant::now();
    let raw = match fs::read(&request_path) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!("could not read request {}: {error}", request_path.display());
            return ExitCode::FAILURE;
        }
    };
    let (hint_requested_suite, hint_suite) = match suite_dirs_hint(&raw) {
        Ok(dirs) => dirs,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let metrics_path = match secure_metrics_path(&hint_requested_suite, &hint_suite, &metrics_path)
    {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let workload = match parse_and_validate(&raw) {
        Ok(workload) => workload,
        Err(error) => {
            let metrics = invalid_metrics(
                mode_hint(&raw),
                error,
                started.elapsed().as_secs_f64() * 1000.0,
            );
            if let Err(write_error) = write_metrics(&hint_suite, &metrics_path, &metrics) {
                eprintln!("{write_error}");
            }
            return ExitCode::FAILURE;
        }
    };
    let (requested_suite, suite) = workload.suite_dirs();
    if requested_suite != hint_requested_suite || suite != hint_suite {
        eprintln!("suite_dir changed during workload parsing");
        return ExitCode::FAILURE;
    }
    let suite = suite.to_path_buf();
    let metrics = execute_workload(workload, sidecar_dir).await;
    if let Err(error) = write_metrics(&suite, &metrics_path, &metrics) {
        eprintln!("{error}");
        return ExitCode::FAILURE;
    }
    if metrics.success {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn run_cli() -> ExitCode {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 4 {
        eprintln!("usage: performance_workload <sidecars> <request.json> <metrics.json>");
        return ExitCode::from(2);
    }
    run_paths(
        PathBuf::from(&args[1]),
        PathBuf::from(&args[2]),
        PathBuf::from(&args[3]),
    )
    .await
}

#[tokio::main]
async fn main() -> ExitCode {
    run_cli().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tempfile::tempdir;

    fn conversion_request(input: &str, output: &str) -> Value {
        json!({
            "input_path": input,
            "output_path": output,
            "target": "jpeg"
        })
    }

    #[test]
    fn rejects_unknown_mode_fields_and_schema_versions() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        fs::write(&source, b"fixture").unwrap();
        let base = json!({
            "schema_version": 1,
            "mode": "inspection_burst",
            "suite_dir": dir.path(),
            "sources": [{"id":"source", "input_path":source}],
        });
        assert!(parse_and_validate(&serde_json::to_vec(&base).unwrap()).is_ok());

        let mut unknown_mode = base.clone();
        unknown_mode["mode"] = json!("inspect");
        assert!(parse_and_validate(&serde_json::to_vec(&unknown_mode).unwrap()).is_err());

        let mut unknown_field = base.clone();
        unknown_field["unexpected"] = json!(true);
        assert!(parse_and_validate(&serde_json::to_vec(&unknown_field).unwrap()).is_err());

        let mut bad_version = base;
        bad_version["schema_version"] = json!(2);
        assert!(parse_and_validate(&serde_json::to_vec(&bad_version).unwrap()).is_err());
    }

    #[test]
    fn rejects_empty_duplicate_ids_and_missing_sources() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        fs::write(&source, b"fixture").unwrap();
        for sources in [
            json!([]),
            json!([{"id":"", "input_path":source}]),
            json!([
                {"id":"same", "input_path":source},
                {"id":"same", "input_path":source}
            ]),
            json!([{"id":"missing", "input_path":dir.path().join("missing.png")}]),
        ] {
            let raw = json!({
                "schema_version":1,
                "mode":"inspection_burst",
                "suite_dir":dir.path(),
                "sources":sources,
            });
            assert!(parse_and_validate(&serde_json::to_vec(&raw).unwrap()).is_err());
        }
    }

    #[test]
    fn rejects_unsafe_concurrency_duplicate_outputs_and_output_escape() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        fs::write(&source, b"fixture").unwrap();
        let output = dir.path().join("outputs/result.jpg");

        for concurrency in [0, MAX_CONCURRENCY + 1] {
            let raw = json!({
                "schema_version":1,
                "mode":"conversion_batch",
                "suite_dir":dir.path(),
                "concurrency":concurrency,
                "items":[{"id":"one","request":conversion_request(source.to_str().unwrap(), output.to_str().unwrap())}],
            });
            assert!(parse_and_validate(&serde_json::to_vec(&raw).unwrap()).is_err());
        }

        let duplicate = json!({
            "schema_version":1,
            "mode":"conversion_batch",
            "suite_dir":dir.path(),
            "concurrency":2,
            "items":[
                {"id":"one","request":conversion_request(source.to_str().unwrap(), output.to_str().unwrap())},
                {"id":"two","request":conversion_request(source.to_str().unwrap(), output.to_str().unwrap())}
            ],
        });
        assert!(parse_and_validate(&serde_json::to_vec(&duplicate).unwrap()).is_err());

        let case_alias = json!({
            "schema_version":1,
            "mode":"conversion_batch",
            "suite_dir":dir.path(),
            "concurrency":2,
            "items":[
                {"id":"upper","request":conversion_request(source.to_str().unwrap(), dir.path().join("A.jpg").to_str().unwrap())},
                {"id":"lower","request":conversion_request(source.to_str().unwrap(), dir.path().join("a.jpg").to_str().unwrap())}
            ],
        });
        assert!(parse_and_validate(&serde_json::to_vec(&case_alias).unwrap()).is_err());

        let escaped = json!({
            "schema_version":1,
            "mode":"conversion_batch",
            "suite_dir":dir.path(),
            "concurrency":1,
            "items":[{"id":"one","request":conversion_request(source.to_str().unwrap(), dir.path().join("../escape.jpg").to_str().unwrap())}],
        });
        assert!(parse_and_validate(&serde_json::to_vec(&escaped).unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_final_and_parent_symlink_output_escapes() {
        use std::os::unix::fs::symlink;

        let suite = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let source = suite.path().join("source.png");
        fs::write(&source, b"fixture").unwrap();

        let dangling = suite.path().join("dangling.jpg");
        symlink(outside.path().join("not-created.jpg"), &dangling).unwrap();
        let request = json!({
            "schema_version":1,"mode":"conversion_batch","suite_dir":suite.path(),"concurrency":1,
            "items":[{"id":"dangling","request":conversion_request(source.to_str().unwrap(), dangling.to_str().unwrap())}]
        });
        assert!(parse_and_validate(&serde_json::to_vec(&request).unwrap()).is_err());

        let linked_parent = suite.path().join("linked-parent");
        symlink(outside.path(), &linked_parent).unwrap();
        let escaped = linked_parent.join("result.jpg");
        let request = json!({
            "schema_version":1,"mode":"conversion_batch","suite_dir":suite.path(),"concurrency":1,
            "items":[{"id":"parent","request":conversion_request(source.to_str().unwrap(), escaped.to_str().unwrap())}]
        });
        assert!(parse_and_validate(&serde_json::to_vec(&request).unwrap()).is_err());
    }

    #[test]
    fn conversion_uses_the_canonical_secured_output_path() {
        let suite = tempdir().unwrap();
        let source = suite.path().join("source.png");
        fs::write(&source, b"fixture").unwrap();
        let requested = suite.path().join("nested/result.jpg");
        let request = json!({
            "schema_version":1,"mode":"conversion_batch","suite_dir":suite.path(),"concurrency":1,
            "items":[{"id":"one","request":conversion_request(source.to_str().unwrap(), requested.to_str().unwrap())}]
        });
        let prepared = parse_and_validate(&serde_json::to_vec(&request).unwrap()).unwrap();
        let PreparedWorkload::ConversionBatch { items, .. } = prepared else {
            panic!("expected conversion batch")
        };
        let secured_parent = Path::new(&items[0].request.output_path);
        assert_eq!(
            secured_parent.parent().unwrap().canonicalize().unwrap(),
            secured_parent.parent().unwrap()
        );
    }

    #[test]
    fn rejects_request_fields_lost_by_typed_deserialization() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source.png");
        fs::write(&source, b"fixture").unwrap();
        let output = dir.path().join("output.jpg");
        let mut request = conversion_request(source.to_str().unwrap(), output.to_str().unwrap());
        request["future_control"] = json!({"enabled":true});
        let raw = json!({
            "schema_version":1,
            "mode":"conversion_batch",
            "suite_dir":dir.path(),
            "concurrency":1,
            "items":[{"id":"one","request":request}],
        });
        assert!(parse_and_validate(&serde_json::to_vec(&raw).unwrap()).is_err());
    }

    #[tokio::test]
    async fn bounded_runner_preserves_order_and_never_exceeds_limit() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (results, observed) = run_bounded((0..8).collect(), 2, {
            let active = active.clone();
            let peak = peak.clone();
            move |item| {
                let active = active.clone();
                let peak = peak.clone();
                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis((8 - item) as u64)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    item
                }
            }
        })
        .await;
        assert_eq!(
            results.into_iter().collect::<Result<Vec<_>, _>>().unwrap(),
            (0..8).collect::<Vec<_>>()
        );
        assert!(peak.load(Ordering::SeqCst) <= 2);
        assert_eq!(observed, peak.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn bounded_runner_reports_panics_without_losing_item_positions() {
        let (results, observed) = run_bounded((0..3).collect(), 2, |item| async move {
            assert_ne!(item, 1, "synthetic worker panic");
            item
        })
        .await;
        assert_eq!(results[0], Ok(0));
        assert!(results[1].as_ref().unwrap_err().contains("task failed"));
        assert_eq!(results[2], Ok(2));
        assert_eq!(observed, 2);
    }

    #[test]
    fn join_failures_use_null_elapsed_time() {
        let item = failed_item("panic", None, "task failed".into());
        assert_eq!(item["elapsed_ms"], Value::Null);
        assert_eq!(
            reliable_engine_span_ms(&[json!({"start_offset_ms":1.0,"end_offset_ms":5.0})], true),
            None
        );
    }

    #[test]
    fn sha256_matches_standard_test_vector() {
        assert_eq!(
            sha256_hex_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn conversion_backend_follows_target_not_input_extension() {
        let image_target: ConvertRequest =
            serde_json::from_value(conversion_request("/tmp/input.mp4", "/tmp/output.jpg"))
                .unwrap();
        let media_target: ConvertRequest = serde_json::from_value(json!({
            "input_path":"/tmp/input.jpg","output_path":"/tmp/output.mp4","target":"mp4"
        }))
        .unwrap();
        assert!(uses_image_backend(&image_target));
        assert!(!uses_image_backend(&media_target));
    }

    #[test]
    fn metrics_publish_requires_suite_containment_and_never_clobbers() {
        let suite = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let canonical = suite.path().canonicalize().unwrap();
        assert!(
            secure_metrics_path(suite.path(), &canonical, &outside.path().join("m.json")).is_err()
        );

        let metrics_path = suite.path().join("metrics.json");
        fs::write(&metrics_path, b"keep me").unwrap();
        let metrics = invalid_metrics("invalid".into(), "failure".into(), 1.0);
        assert!(write_metrics(&canonical, &metrics_path, &metrics).is_err());
        assert_eq!(fs::read(&metrics_path).unwrap(), b"keep me");
    }

    #[test]
    fn metrics_publication_surfaces_cleanup_failures() {
        assert_eq!(
            combine_publication_and_cleanup(Ok(()), Err("cleanup failed".into())),
            Err("cleanup failed".into())
        );
        assert_eq!(
            combine_publication_and_cleanup(
                Err("publish failed".into()),
                Err("cleanup failed".into())
            ),
            Err("publish failed; cleanup failed".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn revalidation_rejects_parent_replaced_by_symlink() {
        use std::os::unix::fs::symlink;

        let suite = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let canonical = suite.path().canonicalize().unwrap();
        let requested = suite.path().join("nested/output.jpg");
        let secured = secure_new_path(suite.path(), &canonical, &requested).unwrap();
        let parent = secured.parent().unwrap();
        fs::remove_dir(parent).unwrap();
        symlink(outside.path(), parent).unwrap();
        assert!(revalidate_secured_new_path(&canonical, &secured).is_err());
    }

    #[tokio::test]
    async fn partial_batch_reports_every_item_once_and_preserves_sources() {
        let dir = tempdir().unwrap();
        let valid = dir.path().join("valid.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([32, 64, 96]))
            .save(&valid)
            .unwrap();
        let invalid = dir.path().join("invalid.png");
        fs::write(&invalid, b"not an image").unwrap();
        let valid_before = fs::read(&valid).unwrap();
        let invalid_before = fs::read(&invalid).unwrap();
        let raw = json!({
            "schema_version":1,
            "mode":"conversion_batch",
            "suite_dir":dir.path(),
            "concurrency":2,
            "items":[
                {"id":"valid","request":conversion_request(valid.to_str().unwrap(), dir.path().join("valid.jpg").to_str().unwrap())},
                {"id":"invalid","request":conversion_request(invalid.to_str().unwrap(), dir.path().join("invalid.jpg").to_str().unwrap())}
            ],
        });
        let prepared = parse_and_validate(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let metrics = execute_workload(prepared, dir.path().to_path_buf()).await;
        assert!(!metrics.success);
        assert_eq!(metrics.items.len(), 2);
        assert_eq!(metrics.items[0]["id"], "valid");
        assert_eq!(metrics.items[1]["id"], "invalid");
        assert_eq!(
            metrics
                .items
                .iter()
                .filter(|item| item["success"] == true)
                .count(),
            1,
            "{:#?}",
            metrics.items
        );
        assert_eq!(
            metrics
                .items
                .iter()
                .filter(|item| item["success"] == false)
                .count(),
            1
        );
        assert_eq!(fs::read(&valid).unwrap(), valid_before);
        assert_eq!(fs::read(&invalid).unwrap(), invalid_before);
        assert!(metrics.max_observed_concurrency.unwrap() <= 2);
        let encoded = serde_json::to_value(&metrics).unwrap();
        assert!(encoded["encoder_detection_ms"].is_number());
        assert!(encoded["wall_ms"].is_number());
        assert!(encoded["aggregate_ms"].is_number());
        assert!(encoded["items"][0]["source_fingerprint_before_ms"].is_number());
        assert!(encoded["items"][0]["source_fingerprint_after_ms"].is_number());
        assert!(encoded["items"][0]["admission_ms"].is_number());
        assert!(encoded["items"][0]["process_ms"].is_number());
        assert!(encoded["items"][0]["start_offset_ms"].is_number());
        assert!(encoded["items"][0]["end_offset_ms"].is_number());
        assert_eq!(encoded["items"][0]["cancelled"], false);
    }

    #[tokio::test]
    async fn inspection_burst_reports_explicit_cache_facts_and_partial_failure() {
        let dir = tempdir().unwrap();
        let valid = dir.path().join("valid.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([16, 32, 48]))
            .save(&valid)
            .unwrap();
        let invalid = dir.path().join("invalid.png");
        fs::write(&invalid, b"not an image").unwrap();
        let valid_before = fs::read(&valid).unwrap();
        let invalid_before = fs::read(&invalid).unwrap();
        let raw = json!({
            "schema_version":1,
            "mode":"inspection_burst",
            "suite_dir":dir.path(),
            "sources":[
                {"id":"valid","input_path":valid},
                {"id":"invalid","input_path":invalid}
            ],
        });
        let prepared = parse_and_validate(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let metrics = execute_workload(prepared, dir.path().to_path_buf()).await;
        assert!(!metrics.success);
        assert_eq!(metrics.max_observed_concurrency, None);
        assert_eq!(metrics.items.len(), 2);
        assert_eq!(metrics.items[0]["id"], "valid");
        assert_eq!(metrics.items[0]["success"], true);
        assert_eq!(metrics.items[0]["cache_reuse"], "not_exposed");
        assert!(metrics.items[0]["probe_ms"].is_number());
        assert!(metrics.items[0]["source_fingerprint_before_ms"].is_number());
        assert!(metrics.items[0]["source_fingerprint_after_ms"].is_number());
        assert!(metrics.items[0]["start_offset_ms"].is_number());
        assert!(metrics.items[0]["end_offset_ms"].is_number());
        assert_eq!(metrics.items[0]["cancelled"], false);
        assert_eq!(metrics.items[1]["id"], "invalid");
        assert_eq!(metrics.items[1]["success"], false);
        assert_eq!(fs::read(&valid).unwrap(), valid_before);
        assert_eq!(fs::read(&invalid).unwrap(), invalid_before);
    }

    #[tokio::test]
    async fn cli_returns_nonzero_and_writes_complete_partial_failure_metrics() {
        let suite = tempdir().unwrap();
        let invalid = suite.path().join("invalid.png");
        fs::write(&invalid, b"not an image").unwrap();
        let request_path = suite.path().join("request.json");
        let metrics_path = suite.path().join("metrics.json");
        let request = json!({
            "schema_version":1,"mode":"conversion_batch","suite_dir":suite.path(),"concurrency":1,
            "items":[{"id":"invalid","request":conversion_request(invalid.to_str().unwrap(), suite.path().join("output.jpg").to_str().unwrap())}]
        });
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();

        let status = run_paths(
            suite.path().to_path_buf(),
            request_path,
            metrics_path.clone(),
        )
        .await;
        assert_eq!(status, ExitCode::FAILURE);
        let metrics: Value = serde_json::from_slice(&fs::read(metrics_path).unwrap()).unwrap();
        assert_eq!(metrics["success"], false);
        assert_eq!(metrics["items"].as_array().unwrap().len(), 1);
        assert_eq!(metrics["items"][0]["id"], "invalid");
        assert_eq!(metrics["items"][0]["success"], false);
        assert!(metrics["memory_evidence"]
            .as_str()
            .unwrap()
            .contains("external process-tree"));
    }

    #[tokio::test]
    async fn cli_refuses_metrics_outside_suite_and_existing_metrics_without_clobber() {
        let suite = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let source = suite.path().join("source.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]))
            .save(&source)
            .unwrap();
        let request_path = suite.path().join("request.json");
        let request = json!({
            "schema_version":1,"mode":"inspection_burst","suite_dir":suite.path(),
            "sources":[{"id":"source","input_path":source}]
        });
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();

        let outside_metrics = outside.path().join("metrics.json");
        assert_eq!(
            run_paths(
                suite.path().to_path_buf(),
                request_path.clone(),
                outside_metrics.clone()
            )
            .await,
            ExitCode::FAILURE
        );
        assert!(!outside_metrics.exists());

        let existing = suite.path().join("metrics.json");
        fs::write(&existing, b"keep me").unwrap();
        assert_eq!(
            run_paths(suite.path().to_path_buf(), request_path, existing.clone()).await,
            ExitCode::FAILURE
        );
        assert_eq!(fs::read(existing).unwrap(), b"keep me");
    }

    #[tokio::test]
    async fn aggregate_excludes_injected_pre_and_post_fingerprint_delays() {
        let suite = tempdir().unwrap();
        let source = suite.path().join("source.png");
        let second = suite.path().join("second.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([5, 10, 15]))
            .save(&source)
            .unwrap();
        image::RgbImage::from_pixel(2, 2, image::Rgb([15, 10, 5]))
            .save(&second)
            .unwrap();
        let request = json!({
            "schema_version":1,"mode":"inspection_burst","suite_dir":suite.path(),
            "sources":[
                {"id":"source","input_path":source},
                {"id":"second","input_path":second}
            ]
        });
        let workload = parse_and_validate(&serde_json::to_vec(&request).unwrap()).unwrap();
        let fingerprint_calls = Arc::new(AtomicUsize::new(0));
        let phase_counts = Arc::new(Mutex::new(Vec::new()));
        let fingerprinter = Arc::new({
            let fingerprint_calls = fingerprint_calls.clone();
            move |path: &Path| {
                fingerprint_calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(50));
                source_fingerprint(path)
            }
        });
        let metrics = execute_workload_with_hooks(
            workload,
            suite.path().to_path_buf(),
            fingerprinter,
            Arc::new({
                let fingerprint_calls = fingerprint_calls.clone();
                let phase_counts = phase_counts.clone();
                move |boundary| {
                    phase_counts
                        .lock()
                        .unwrap()
                        .push((boundary, fingerprint_calls.load(Ordering::SeqCst)));
                }
            }),
        )
        .await;
        let encoded = serde_json::to_value(metrics).unwrap();
        let items = encoded["items"].as_array().unwrap();
        let first_start = items[0]["start_offset_ms"].as_f64().unwrap();
        let last_end = items[1]["end_offset_ms"].as_f64().unwrap();
        let aggregate = encoded["aggregate_ms"].as_f64().unwrap();
        let summed_engine_ms: f64 = items
            .iter()
            .map(|item| item["elapsed_ms"].as_f64().unwrap())
            .sum();
        assert!((aggregate - (last_end - first_start)).abs() < 0.001);
        assert!(aggregate >= summed_engine_ms);
        for item in items {
            assert!(item["source_fingerprint_before_ms"].as_f64().unwrap() >= 50.0);
            assert!(item["source_fingerprint_after_ms"].as_f64().unwrap() >= 50.0);
        }
        assert_eq!(
            *phase_counts.lock().unwrap(),
            vec![
                (EnginePhaseBoundary::Started, 2),
                (EnginePhaseBoundary::Finished, 2)
            ]
        );
        assert_eq!(fingerprint_calls.load(Ordering::SeqCst), 4);
        assert!(encoded["wall_ms"].as_f64().unwrap() >= aggregate + 200.0);
    }

    #[tokio::test]
    async fn pre_fingerprint_failures_do_not_enter_the_bounded_engine_scheduler() {
        let suite = tempdir().unwrap();
        let source = suite.path().join("source.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]))
            .save(&source)
            .unwrap();
        let request = json!({
            "schema_version":1,"mode":"conversion_batch","suite_dir":suite.path(),
            "concurrency":4,
            "items":[{"id":"source","request":conversion_request(
                source.to_str().unwrap(),
                suite.path().join("output.jpg").to_str().unwrap()
            )}]
        });
        let workload = parse_and_validate(&serde_json::to_vec(&request).unwrap()).unwrap();
        let metrics = execute_workload_with_fingerprinter(
            workload,
            suite.path().to_path_buf(),
            Arc::new(|_| Err("injected fingerprint failure".into())),
        )
        .await;
        assert_eq!(metrics.max_observed_concurrency, Some(0));
        assert_eq!(metrics.aggregate_ms, None);
        assert_eq!(metrics.items[0]["start_offset_ms"], Value::Null);
        assert_eq!(metrics.items[0]["success"], false);
    }
}
