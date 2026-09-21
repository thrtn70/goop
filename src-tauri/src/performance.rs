use std::{
    collections::BTreeMap,
    fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const RESPONSIVENESS_SCHEMA_VERSION: u64 = 2;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FRONTEND_BYTES: usize = 6 * 1024 * 1024;
const MAX_PAGE_COMPONENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ACTIONS: usize = 2_048;
const MAX_SETUPS: usize = 256;
const MAX_SPANS: usize = 8_192;
const MAX_EVENTS: usize = 16_384;
const MAX_OBSERVER_ENTRIES: usize = 512;
const MAX_EVENT_ACTION_AGGREGATES: usize = 8_192;
const MAX_RAF_SAMPLES: u64 = 180_000;
const MAX_FACTS: usize = 32;
const MAX_FIELD_BYTES: usize = 64;
const MAX_DRAFT_STORAGE_BYTES: usize = 512 * 1024;
const MAX_COMPLETION_TIMEOUT_MS: u64 = 120_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub struct PerformanceState {
    report_path: Option<PathBuf>,
    started: Instant,
    reported: AtomicBool,
}

impl PerformanceState {
    pub fn new(report_path: Option<PathBuf>, started: Instant) -> Self {
        Self {
            report_path: report_path.filter(|path| path.is_absolute()),
            started,
            reported: AtomicBool::new(false),
        }
    }

    pub fn enabled(&self) -> bool {
        self.report_path.is_some()
    }

    fn ready(&self, initial_data_loaded: bool) -> Result<(), String> {
        let Some(path) = &self.report_path else {
            return Ok(());
        };
        if !initial_data_loaded || self.reported.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let report = serde_json::json!({
            "schema_version": 1,
            "backend_ready_ms": self.started.elapsed().as_secs_f64() * 1000.0,
            "pid": std::process::id(),
        });
        // create_new refuses both existing files and dangling symlinks. The
        // report destination is selected only by the launching environment.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        file.write_all(report.to_string().as_bytes())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn performance_status(state: tauri::State<'_, PerformanceState>) -> bool {
    state.enabled()
}

#[tauri::command]
pub fn performance_ready(
    state: tauri::State<'_, PerformanceState>,
    initial_data_loaded: bool,
) -> Result<(), String> {
    state.ready(initial_data_loaded)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessScenario {
    id: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessWorkload {
    id: String,
    facts: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessDescriptor {
    component_role: String,
    session_id: String,
    sample_id: String,
    page_instance_id: String,
    lane: String,
    scenario: ResponsivenessScenario,
    workload: ResponsivenessWorkload,
    phase: String,
    repetition: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessAction {
    action_id: u64,
    target_id: String,
    event_type: String,
    target_role: String,
    accessible_name: String,
    expected_prior_value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessDraftStorage {
    raw: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessBootstrap {
    initial_path: String,
    draft_storage: Option<ResponsivenessDraftStorage>,
    fail_next_draft_write: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsivenessCompletion {
    kind: String,
    timeout_ms: u64,
    expected_draft_sha256: Option<String>,
    expected_ax_value: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponsivenessRecorderMode {
    #[default]
    Enabled,
    Control,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponsivenessManifest {
    schema_version: u64,
    token: String,
    #[serde(default, rename = "recorderMode")]
    recorder_mode: ResponsivenessRecorderMode,
    descriptor: ResponsivenessDescriptor,
    actions: Vec<ResponsivenessAction>,
    #[serde(rename = "webviewDataStoreId")]
    webview_data_store_id: [u8; 16],
    bootstrap: ResponsivenessBootstrap,
    completion: ResponsivenessCompletion,
}

#[derive(Clone, Debug)]
struct ResponsivenessActivation {
    token: String,
    recorder_mode: ResponsivenessRecorderMode,
    descriptor: ResponsivenessDescriptor,
    actions: Vec<ResponsivenessAction>,
    webview_data_store_id: [u8; 16],
    bootstrap: ResponsivenessBootstrap,
    completion: ResponsivenessCompletion,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsivenessStatus {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorder_mode: Option<ResponsivenessRecorderMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ResponsivenessDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ResponsivenessAction>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webview_data_store_id: Option<[u8; 16]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap: Option<ResponsivenessBootstrap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion: Option<ResponsivenessCompletion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponsivenessMarker {
    pub schema_version: u64,
    pub component_kind: &'static str,
    pub session_id: String,
    pub sample_id: String,
    pub page_instance_id: String,
    pub action_id: Option<u64>,
    pub pid: u32,
    pub native_elapsed_us: u64,
}

pub struct ResponsivenessState {
    activation: Option<ResponsivenessActivation>,
    report_dir: Option<PathBuf>,
    started: Instant,
    ready_written: AtomicBool,
    component_written: AtomicBool,
    next_action_index: Mutex<usize>,
    cleanup_mode: bool,
}

#[derive(Clone, Debug)]
pub struct ResponsivenessCleanupRequest {
    pub data_store_identifier: [u8; 16],
    pub session_id: String,
    pub already_complete: bool,
}

impl ResponsivenessState {
    pub fn from_environment(started: Instant) -> Self {
        Self::from_paths_with_cleanup(
            std::env::var_os("GOOP_RESPONSIVENESS_MANIFEST").map(PathBuf::from),
            std::env::var_os("GOOP_RESPONSIVENESS_REPORT_DIR").map(PathBuf::from),
            started,
            std::env::var_os("GOOP_RESPONSIVENESS_CLEANUP").as_deref()
                == Some(std::ffi::OsStr::new("1")),
        )
    }

    #[cfg(test)]
    fn from_paths(
        manifest_path: Option<PathBuf>,
        report_dir: Option<PathBuf>,
        started: Instant,
    ) -> Self {
        Self::from_paths_with_cleanup(manifest_path, report_dir, started, false)
    }

    fn from_paths_with_cleanup(
        manifest_path: Option<PathBuf>,
        report_dir: Option<PathBuf>,
        started: Instant,
        cleanup_mode: bool,
    ) -> Self {
        let configured = manifest_path
            .zip(report_dir)
            .and_then(|(manifest_path, report_dir)| {
                load_responsiveness_activation(&manifest_path, &report_dir)
                    .ok()
                    .and_then(|activation| {
                        let ownership = if cleanup_mode {
                            validate_cleanup_authority(&activation, &report_dir)
                        } else {
                            ensure_data_store_ownership(&activation, &report_dir)
                        };
                        ownership.ok().map(|()| (activation, report_dir))
                    })
            });
        let (activation, report_dir) = match configured {
            Some((activation, report_dir)) => (Some(activation), Some(report_dir)),
            None => (None, None),
        };
        Self {
            activation,
            report_dir,
            started,
            ready_written: AtomicBool::new(false),
            component_written: AtomicBool::new(false),
            next_action_index: Mutex::new(0),
            cleanup_mode,
        }
    }

    fn status(&self) -> ResponsivenessStatus {
        match &self.activation {
            Some(activation) if !self.cleanup_mode => ResponsivenessStatus {
                enabled: true,
                recorder_mode: Some(activation.recorder_mode),
                descriptor: Some(activation.descriptor.clone()),
                token: Some(activation.token.clone()),
                actions: Some(activation.actions.clone()),
                webview_data_store_id: Some(activation.webview_data_store_id),
                bootstrap: Some(activation.bootstrap.clone()),
                completion: Some(activation.completion.clone()),
            },
            _ => ResponsivenessStatus {
                enabled: false,
                recorder_mode: None,
                descriptor: None,
                token: None,
                actions: None,
                webview_data_store_id: None,
                bootstrap: None,
                completion: None,
            },
        }
    }

    pub fn data_store_identifier(&self) -> Option<[u8; 16]> {
        self.activation
            .as_ref()
            .filter(|_| !self.cleanup_mode)
            .map(|activation| activation.webview_data_store_id)
    }

    pub fn cleanup_mode(&self) -> bool {
        self.cleanup_mode && self.activation.is_some()
    }

    pub fn cleanup_requested(&self) -> bool {
        self.cleanup_mode
    }

    pub fn cleanup_request(&self) -> Option<ResponsivenessCleanupRequest> {
        let activation = self.activation.as_ref().filter(|_| self.cleanup_mode)?;
        let report_dir = self.report_dir.as_ref()?;
        Some(ResponsivenessCleanupRequest {
            data_store_identifier: activation.webview_data_store_id,
            session_id: activation.descriptor.session_id.clone(),
            already_complete: validate_cleanup_success_receipt(activation, report_dir)
                .unwrap_or(false),
        })
    }

    pub fn reconcile_cleanup_success(&self, removed: bool) -> Result<(), String> {
        self.reconcile_cleanup_success_with_hook(removed, || Ok(()))
    }

    fn reconcile_cleanup_success_with_hook<F>(
        &self,
        removed: bool,
        after_receipt: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let request = self
            .cleanup_request()
            .ok_or_else(|| "responsiveness cleanup is not enabled".to_owned())?;
        let report_dir = self
            .report_dir
            .as_ref()
            .ok_or_else(|| "responsiveness cleanup is not enabled".to_owned())?;
        validate_report_directory(report_dir)?;
        let report = serde_json::json!({
            "schema_version": RESPONSIVENESS_SCHEMA_VERSION,
            "component_kind": "data_store_cleanup",
            "session_id": request.session_id,
            "webview_data_store_id": request.data_store_identifier,
            "removed": removed,
            "error_code": null,
            "pid": std::process::id(),
            "native_clock": {
                "domain": "native_monotonic",
                "unit": "us",
                "elapsed_us": self.started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
            }
        });
        let activation = self
            .activation
            .as_ref()
            .ok_or_else(|| "responsiveness cleanup is not enabled".to_owned())?;
        let receipt_path = data_store_cleanup_receipt_path(activation, report_dir);
        if !validate_cleanup_success_receipt(activation, report_dir)? {
            write_create_new_json(&receipt_path, &report)?;
        }
        after_receipt()?;
        remove_data_store_ownership_after_receipt(activation, report_dir)?;
        Ok(())
    }

    fn ready(
        &self,
        page_instance_id: String,
        token: String,
        action_id: Option<u64>,
    ) -> Result<NativeResponsivenessMarker, String> {
        let activation = self.match_recorded_activation(&page_instance_id, &token)?;
        if self.component_written.load(Ordering::Acquire) {
            return Err("responsiveness component is already final".to_owned());
        }
        let mut next = self
            .next_action_index
            .lock()
            .map_err(|_| "responsiveness action state unavailable".to_owned())?;
        if self.component_written.load(Ordering::Acquire) {
            return Err("responsiveness component is already final".to_owned());
        }
        let expected = activation.actions.first().map(|action| action.action_id);
        if *next != 0 || expected != action_id {
            return Err("responsiveness first action mismatch".to_owned());
        }
        if self.ready_written.load(Ordering::Acquire) {
            return Err("responsiveness readiness already recorded".to_owned());
        }
        let marker = self.marker("recorder_ready", action_id, activation);
        let path = self.report_path(&format!("recorder-ready-{page_instance_id}.json"))?;
        write_create_new_json(&path, &marker_file_value(&marker))?;
        self.ready_written.store(true, Ordering::Release);
        *next = usize::from(action_id.is_some());
        Ok(marker)
    }

    fn action_ready(
        &self,
        page_instance_id: String,
        token: String,
        action_id: u64,
    ) -> Result<NativeResponsivenessMarker, String> {
        let activation = self.match_recorded_activation(&page_instance_id, &token)?;
        if self.component_written.load(Ordering::Acquire) {
            return Err("responsiveness component is already final".to_owned());
        }
        if !self.ready_written.load(Ordering::Acquire) {
            return Err("responsiveness recorder is not ready".to_owned());
        }
        let mut next = self
            .next_action_index
            .lock()
            .map_err(|_| "responsiveness action state unavailable".to_owned())?;
        if self.component_written.load(Ordering::Acquire) {
            return Err("responsiveness component is already final".to_owned());
        }
        let expected = activation
            .actions
            .get(*next)
            .ok_or_else(|| "responsiveness action plan is complete".to_owned())?;
        if expected.action_id != action_id {
            return Err("responsiveness action ordinal mismatch".to_owned());
        }
        let marker = self.marker("action_ready", Some(action_id), activation);
        let path =
            self.report_path(&format!("action-ready-{action_id}-{page_instance_id}.json"))?;
        write_create_new_json(&path, &marker_file_value(&marker))?;
        *next += 1;
        Ok(marker)
    }

    fn write_component(
        &self,
        token: String,
        component: Value,
    ) -> Result<NativeResponsivenessMarker, String> {
        let activation = self
            .activation
            .as_ref()
            .ok_or_else(|| "responsiveness instrumentation is disabled".to_owned())?;
        if activation.recorder_mode != ResponsivenessRecorderMode::Enabled {
            return Err("responsiveness recorder is in control mode".to_owned());
        }
        if !constant_time_eq(token.as_bytes(), activation.token.as_bytes()) {
            return Err("responsiveness token mismatch".to_owned());
        }
        let serialized =
            serde_json::to_vec(&component).map_err(|_| "invalid component".to_owned())?;
        if serialized.len() > MAX_FRONTEND_BYTES {
            return Err("responsiveness component exceeds byte limit".to_owned());
        }
        let next = self
            .next_action_index
            .lock()
            .map_err(|_| "responsiveness action state unavailable".to_owned())?;
        let completion = validate_frontend_component(&component, activation, *next)?;
        match (
            self.ready_written.load(Ordering::Acquire),
            completion,
            *next,
        ) {
            (false, FrontendCompletion::Failure, 0) | (true, _, _) => {}
            (false, _, _) => return Err("responsiveness recorder is not ready".to_owned()),
        }
        if self.component_written.load(Ordering::Acquire) {
            return Err("responsiveness component already recorded".to_owned());
        }
        let marker = self.marker("frontend_trace_written", None, activation);
        let report = serde_json::json!({
            "schema_version": RESPONSIVENESS_SCHEMA_VERSION,
            "component_kind": "frontend_page_component",
            "session_id": activation.descriptor.session_id,
            "sample_id": activation.descriptor.sample_id,
            "page_instance_id": activation.descriptor.page_instance_id,
            "component_role": activation.descriptor.component_role,
            "pid": marker.pid,
            "native_clock": {
                "domain": "native_monotonic",
                "unit": "us",
                "elapsed_us": marker.native_elapsed_us
            },
            "frontend_trace": component
        });
        let report_bytes = serde_json::to_vec(&report)
            .map_err(|_| "responsiveness page component could not be serialized".to_owned())?;
        if report_bytes.len() > MAX_PAGE_COMPONENT_BYTES {
            return Err("responsiveness page component exceeds byte limit".to_owned());
        }
        let path = self.report_path(&format!(
            "frontend-{}-{}.json",
            activation.descriptor.component_role, activation.descriptor.page_instance_id
        ))?;
        write_atomic_create_new_bytes(&path, &report_bytes)?;
        self.component_written.store(true, Ordering::Release);
        Ok(marker)
    }

    fn control_ready(
        &self,
        page_instance_id: String,
        token: String,
    ) -> Result<NativeResponsivenessMarker, String> {
        let activation = self.match_control_activation(&page_instance_id, &token)?;
        if self.ready_written.load(Ordering::Acquire) {
            return Err("responsiveness control readiness already recorded".to_owned());
        }
        let marker = self.marker("control_ready", None, activation);
        let path = self.report_path(&format!("control-ready-{page_instance_id}.json"))?;
        write_create_new_json(&path, &marker_file_value(&marker))?;
        self.ready_written.store(true, Ordering::Release);
        Ok(marker)
    }

    fn match_recorded_activation(
        &self,
        page_instance_id: &str,
        token: &str,
    ) -> Result<&ResponsivenessActivation, String> {
        let activation = self.match_activation(page_instance_id, token)?;
        if activation.recorder_mode != ResponsivenessRecorderMode::Enabled {
            return Err("responsiveness recorder is in control mode".to_owned());
        }
        Ok(activation)
    }

    fn match_control_activation(
        &self,
        page_instance_id: &str,
        token: &str,
    ) -> Result<&ResponsivenessActivation, String> {
        let activation = self.match_activation(page_instance_id, token)?;
        if activation.recorder_mode != ResponsivenessRecorderMode::Control {
            return Err("responsiveness recorder control mode is not enabled".to_owned());
        }
        Ok(activation)
    }

    fn match_activation(
        &self,
        page_instance_id: &str,
        token: &str,
    ) -> Result<&ResponsivenessActivation, String> {
        let activation = self
            .activation
            .as_ref()
            .ok_or_else(|| "responsiveness instrumentation is disabled".to_owned())?;
        if !constant_time_eq(token.as_bytes(), activation.token.as_bytes()) {
            return Err("responsiveness token mismatch".to_owned());
        }
        if page_instance_id != activation.descriptor.page_instance_id {
            return Err("responsiveness page identity mismatch".to_owned());
        }
        Ok(activation)
    }

    fn marker(
        &self,
        component_kind: &'static str,
        action_id: Option<u64>,
        activation: &ResponsivenessActivation,
    ) -> NativeResponsivenessMarker {
        NativeResponsivenessMarker {
            schema_version: RESPONSIVENESS_SCHEMA_VERSION,
            component_kind,
            session_id: activation.descriptor.session_id.clone(),
            sample_id: activation.descriptor.sample_id.clone(),
            page_instance_id: activation.descriptor.page_instance_id.clone(),
            action_id,
            pid: std::process::id(),
            native_elapsed_us: self.started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
        }
    }

    fn report_path(&self, file_name: &str) -> Result<PathBuf, String> {
        let report_dir = self
            .report_dir
            .as_ref()
            .ok_or_else(|| "responsiveness instrumentation is disabled".to_owned())?;
        validate_report_directory(report_dir)?;
        Ok(report_dir.join(file_name))
    }
}

#[tauri::command]
pub fn responsiveness_status(state: tauri::State<'_, ResponsivenessState>) -> ResponsivenessStatus {
    state.status()
}

#[tauri::command]
pub fn responsiveness_ready(
    state: tauri::State<'_, ResponsivenessState>,
    page_instance_id: String,
    token: String,
    action_id: Option<u64>,
) -> Result<NativeResponsivenessMarker, String> {
    state.ready(page_instance_id, token, action_id)
}

#[tauri::command]
pub fn responsiveness_control_ready(
    state: tauri::State<'_, ResponsivenessState>,
    page_instance_id: String,
    token: String,
) -> Result<NativeResponsivenessMarker, String> {
    state.control_ready(page_instance_id, token)
}

#[tauri::command]
pub fn responsiveness_action_ready(
    state: tauri::State<'_, ResponsivenessState>,
    page_instance_id: String,
    token: String,
    action_id: u64,
) -> Result<NativeResponsivenessMarker, String> {
    state.action_ready(page_instance_id, token, action_id)
}

#[tauri::command]
pub fn responsiveness_write_component(
    state: tauri::State<'_, ResponsivenessState>,
    token: String,
    component: Value,
) -> Result<NativeResponsivenessMarker, String> {
    state.write_component(token, component)
}

fn load_responsiveness_activation(
    manifest_path: &Path,
    report_dir: &Path,
) -> Result<ResponsivenessActivation, String> {
    if !manifest_path.is_absolute() || !report_dir.is_absolute() {
        return Err("responsiveness paths must be absolute".to_owned());
    }
    validate_canonical_path(manifest_path)?;
    let metadata = fs::symlink_metadata(manifest_path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("responsiveness manifest must be a bounded regular file".to_owned());
    }
    validate_report_directory(report_dir)?;
    let file = fs::File::open(manifest_path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("responsiveness manifest exceeds byte limit".to_owned());
    }
    let manifest: ResponsivenessManifest =
        serde_json::from_slice(&bytes).map_err(|_| "invalid responsiveness manifest".to_owned())?;
    validate_manifest(&manifest)?;
    Ok(ResponsivenessActivation {
        token: manifest.token,
        recorder_mode: manifest.recorder_mode,
        descriptor: manifest.descriptor,
        actions: manifest.actions,
        webview_data_store_id: manifest.webview_data_store_id,
        bootstrap: manifest.bootstrap,
        completion: manifest.completion,
    })
}

fn validate_manifest(manifest: &ResponsivenessManifest) -> Result<(), String> {
    if manifest.schema_version != RESPONSIVENESS_SCHEMA_VERSION {
        return Err("unsupported responsiveness schema".to_owned());
    }
    validate_opaque(&manifest.token, "token")?;
    validate_descriptor(&manifest.descriptor)?;
    if manifest.webview_data_store_id.iter().all(|byte| *byte == 0) {
        return Err("responsiveness data store identifier cannot be all zero".to_owned());
    }
    validate_enum(&manifest.bootstrap.initial_path, &["/extract", "/convert"])?;
    if let Some(storage) = &manifest.bootstrap.draft_storage {
        if storage.raw.len() > MAX_DRAFT_STORAGE_BYTES {
            return Err("responsiveness draft bootstrap exceeds byte limit".to_owned());
        }
        validate_sha256(&storage.sha256)?;
        if format!("{:x}", Sha256::digest(storage.raw.as_bytes())) != storage.sha256 {
            return Err("responsiveness draft bootstrap hash mismatch".to_owned());
        }
    }
    validate_enum(
        &manifest.completion.kind,
        &["actions_and_setups", "recovery"],
    )?;
    if manifest.completion.timeout_ms == 0
        || manifest.completion.timeout_ms > MAX_COMPLETION_TIMEOUT_MS
    {
        return Err("responsiveness completion timeout is invalid".to_owned());
    }
    if let Some(hash) = &manifest.completion.expected_draft_sha256 {
        validate_sha256(hash)?;
    }
    if let Some(value) = &manifest.completion.expected_ax_value {
        validate_bounded_text_allow_empty(value, "expected AX value")?;
    }
    let recovery_without_actions = manifest.actions.is_empty()
        && manifest.descriptor.component_role == "recovery"
        && manifest.completion.kind == "recovery";
    if (!recovery_without_actions && manifest.actions.is_empty())
        || manifest.actions.len() > MAX_ACTIONS
    {
        return Err("responsiveness action count is invalid".to_owned());
    }
    if manifest.completion.kind == "recovery"
        && (manifest.descriptor.component_role != "recovery" || !manifest.actions.is_empty())
    {
        return Err(
            "responsiveness recovery completion has inconsistent role or actions".to_owned(),
        );
    }
    if manifest.completion.kind == "actions_and_setups"
        && manifest.descriptor.component_role == "recovery"
    {
        return Err("responsiveness recovery role requires recovery completion".to_owned());
    }
    for (index, action) in manifest.actions.iter().enumerate() {
        let expected_id = (index + 1) as u64;
        if action.action_id != expected_id {
            return Err("responsiveness action identifiers must be contiguous".to_owned());
        }
        validate_opaque(&action.target_id, "action target")?;
        validate_enum(&action.event_type, &["click", "keydown", "input", "change"])?;
        validate_opaque(&action.target_role, "action target role")?;
        validate_bounded_text(&action.accessible_name, "accessible name")?;
        validate_bounded_text_allow_empty(&action.expected_prior_value, "expected prior value")?;
    }
    Ok(())
}

fn validate_descriptor(descriptor: &ResponsivenessDescriptor) -> Result<(), String> {
    validate_enum(
        &descriptor.component_role,
        &["primary", "pre_quit", "recovery"],
    )?;
    validate_uuid(&descriptor.session_id, "session ID")?;
    validate_opaque(&descriptor.sample_id, "sample ID")?;
    validate_uuid(&descriptor.page_instance_id, "page instance ID")?;
    validate_enum(&descriptor.lane, &["inspection", "draft", "session_memory"])?;
    validate_opaque(&descriptor.scenario.id, "scenario ID")?;
    validate_sha256(&descriptor.scenario.manifest_sha256)?;
    validate_opaque(&descriptor.workload.id, "workload ID")?;
    validate_enum(
        &descriptor.phase,
        &["warmup", "measured", "exploratory_soak"],
    )?;
    if descriptor.repetition > MAX_SAFE_INTEGER {
        return Err("repetition exceeds safe integer limit".to_owned());
    }
    if descriptor.workload.facts.len() > MAX_FACTS {
        return Err("too many workload facts".to_owned());
    }
    for (key, value) in &descriptor.workload.facts {
        validate_opaque(key, "workload fact key")?;
        match value {
            Value::String(value) => validate_bounded_text(value, "workload fact value")?,
            Value::Bool(_) => {}
            Value::Number(number) if is_safe_integer(number) => {}
            _ => return Err("invalid workload fact value".to_owned()),
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FrontendCompletion {
    Success,
    Failure,
}

fn validate_frontend_component(
    component: &Value,
    activation: &ResponsivenessActivation,
    native_action_progress: usize,
) -> Result<FrontendCompletion, String> {
    let descriptor = &activation.descriptor;
    validate_json_scalars(component)?;
    let object = component
        .as_object()
        .ok_or_else(|| "responsiveness component must be an object".to_owned())?;
    require_u64(object, "schema_version", RESPONSIVENESS_SCHEMA_VERSION)?;
    require_str(object, "component_kind", "frontend_trace")?;
    require_str(object, "component_role", &descriptor.component_role)?;
    require_str(object, "session_id", &descriptor.session_id)?;
    require_str(object, "sample_id", &descriptor.sample_id)?;
    require_str(object, "page_instance_id", &descriptor.page_instance_id)?;
    require_str(object, "lane", &descriptor.lane)?;
    require_str(
        object_at(object, "scenario")?,
        "id",
        &descriptor.scenario.id,
    )?;
    require_str(
        object_at(object, "scenario")?,
        "manifest_sha256",
        &descriptor.scenario.manifest_sha256,
    )?;
    require_str(
        object_at(object, "workload")?,
        "id",
        &descriptor.workload.id,
    )?;
    if object_at(object, "workload")?.get("facts")
        != Some(&serde_json::to_value(&descriptor.workload.facts).unwrap())
    {
        return Err("responsiveness workload identity mismatch".to_owned());
    }
    require_str(object, "phase", &descriptor.phase)?;
    require_u64(object, "repetition", descriptor.repetition)?;
    require_str(
        object_at(object, "clock_origin")?,
        "domain",
        "webview_monotonic",
    )?;
    require_str(object_at(object, "clock_origin")?, "unit", "us")?;

    let setups = bounded_array(object, "setups", MAX_SETUPS)?;
    let actions = bounded_array(object, "actions", MAX_ACTIONS)?;
    let events = bounded_array(object, "events", MAX_EVENTS)?;
    let spans = bounded_array(object, "spans", MAX_SPANS)?;
    validate_setups(setups)?;
    validate_actions(actions, &activation.actions)?;
    validate_spans(spans, actions, setups)?;
    validate_events(events, actions, setups, spans)?;

    let timing = object_at(object, "browser_timing")?;
    let event_timing = object_at(timing, "event_timing")?;
    bounded_array(event_timing, "raw", MAX_OBSERVER_ENTRIES)?;
    bounded_array(event_timing, "by_action", MAX_EVENT_ACTION_AGGREGATES)?;
    let long_tasks = object_at(timing, "long_tasks")?;
    bounded_array(long_tasks, "raw", MAX_OBSERVER_ENTRIES)?;
    let raf = object_at(timing, "raf_gaps")?;
    if value_u64(raf.get("count"), "rAF count")? > MAX_RAF_SAMPLES {
        return Err("rAF sample count exceeds limit".to_owned());
    }
    bounded_array(object, "limitations", 2)?;
    let settled = object
        .get("settled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "invalid settled flag".to_owned())?;
    let completion = match (settled, object.get("failure")) {
        (true, Some(Value::Null)) => {
            if actions.len() != activation.actions.len()
                || native_action_progress != activation.actions.len()
            {
                return Err("successful component requires the complete action plan".to_owned());
            }
            if actions
                .iter()
                .any(|record| record.get("state").and_then(Value::as_str) != Some("settled"))
                || setups
                    .iter()
                    .any(|record| record.get("state").and_then(Value::as_str) != Some("settled"))
                || spans
                    .iter()
                    .any(|record| record.get("terminal").and_then(Value::as_str) != Some("ended"))
            {
                return Err("successful component contains non-settled work".to_owned());
            }
            FrontendCompletion::Success
        }
        (false, Some(Value::Object(failure))) => {
            validate_failure_record(failure)?;
            let one_cancelled_unpublished = actions.len() == native_action_progress + 1
                && actions.last().and_then(|record| record.get("state"))
                    == Some(&Value::String("cancelled".to_owned()));
            if actions.len() > native_action_progress && !one_cancelled_unpublished {
                return Err("failure component exceeds native action progress".to_owned());
            }
            FrontendCompletion::Failure
        }
        _ => return Err("component completion and failure are inconsistent".to_owned()),
    };
    Ok(completion)
}

fn validate_failure_record(failure: &Map<String, Value>) -> Result<(), String> {
    if failure.len() != 3
        || !failure.contains_key("code")
        || !failure.contains_key("phase")
        || !failure.contains_key("count")
    {
        return Err("invalid responsiveness failure record".to_owned());
    }
    validate_enum(
        value_str(failure.get("code"), "failure code")?,
        &[
            "observer_init",
            "observer_delivery",
            "frame_schedule",
            "frame_callback",
            "state_transition",
            "capacity_accounting",
            "serialization",
        ],
    )?;
    validate_enum(
        value_str(failure.get("phase"), "failure phase")?,
        &[
            "create",
            "install",
            "action",
            "setup",
            "span",
            "observer",
            "frame",
            "teardown",
            "serialize",
        ],
    )?;
    let count = value_u64(failure.get("count"), "failure count")?;
    if count == 0 || count as usize > MAX_EVENTS {
        return Err("failure count exceeds limit".to_owned());
    }
    Ok(())
}

fn validate_setups(records: &[Value]) -> Result<(), String> {
    for (index, record) in records.iter().enumerate() {
        let object = record
            .as_object()
            .ok_or_else(|| "invalid setup record".to_owned())?;
        if value_u64(object.get("setup_id"), "setup ID")? != (index + 1) as u64 {
            return Err("setup identifiers must be contiguous".to_owned());
        }
        validate_opaque(
            value_str(object.get("target_id"), "setup target")?,
            "setup target",
        )?;
        let state = value_str(object.get("state"), "setup state")?;
        validate_enum(state, &["active", "settled", "cancelled"])?;
        let start = value_u64(object.get("start_us"), "setup start timestamp")?;
        let terminal = optional_u64(object.get("terminal_us"), "setup terminal timestamp")?;
        if (state == "active") != terminal.is_none()
            || terminal.is_some_and(|terminal| terminal < start)
        {
            return Err("invalid setup terminal timestamp for record state".to_owned());
        }
    }
    Ok(())
}

fn validate_actions(records: &[Value], plan: &[ResponsivenessAction]) -> Result<(), String> {
    if records.len() > plan.len() {
        return Err("component contains actions outside the manifest".to_owned());
    }
    for (index, record) in records.iter().enumerate() {
        let object = record
            .as_object()
            .ok_or_else(|| "invalid action record".to_owned())?;
        let action_id = value_u64(object.get("action_id"), "action ID")?;
        if action_id != plan[index].action_id {
            return Err("action identifiers must be contiguous".to_owned());
        }
        if value_str(object.get("target_id"), "action target")? != plan[index].target_id {
            return Err("action target does not match manifest".to_owned());
        }
        let state = value_str(object.get("state"), "action state")?;
        validate_enum(state, &["armed", "active", "settled", "cancelled"])?;
        let armed = value_u64(object.get("armed_us"), "action armed timestamp")?;
        let active = optional_u64(object.get("active_us"), "action active timestamp")?;
        let terminal = optional_u64(object.get("terminal_us"), "action terminal timestamp")?;
        let state_is_valid = match state {
            "armed" => active.is_none() && terminal.is_none(),
            "active" => active.is_some() && terminal.is_none(),
            "settled" => active.is_some() && terminal.is_some(),
            "cancelled" => terminal.is_some(),
            _ => false,
        };
        if !state_is_valid
            || active.is_some_and(|active| active < armed)
            || terminal.is_some_and(|terminal| terminal < active.unwrap_or(armed))
        {
            return Err("invalid action timestamps for record state".to_owned());
        }
    }
    Ok(())
}

fn validate_events(
    records: &[Value],
    actions: &[Value],
    setups: &[Value],
    spans: &[Value],
) -> Result<(), String> {
    const KINDS: &[&str] = &[
        "armed",
        "event_received",
        "handler_start",
        "handler_end",
        "state_visible",
        "double_raf",
        "scenario_settled",
        "inspection_queued",
        "inspection_started",
        "inspection_settled",
        "inspection_delivered",
        "inspection_cancelled",
        "persistence_settled",
    ];
    for (index, record) in records.iter().enumerate() {
        let object = record
            .as_object()
            .ok_or_else(|| "invalid event record".to_owned())?;
        if value_u64(object.get("event_seq"), "event sequence")? != (index + 1) as u64 {
            return Err("event sequence must be contiguous".to_owned());
        }
        let owner = validate_owner(object.get("owner"), actions.len(), setups.len())?;
        validate_enum(value_str(object.get("kind"), "event kind")?, KINDS)?;
        value_u64(object.get("at_us"), "event timestamp")?;
        if let Some(span_id) = optional_u64(object.get("span_id"), "event span ID")? {
            let span = spans
                .get(span_id.saturating_sub(1) as usize)
                .and_then(Value::as_object)
                .ok_or_else(|| "event references an unknown span".to_owned())?;
            let span_owner = validate_owner(span.get("owner"), actions.len(), setups.len())?;
            if owner != span_owner {
                return Err("event and span owners do not match".to_owned());
            }
        }
        validate_nullable_opaque(object.get("subject_id"), "event subject")?;
        validate_nullable_opaque(object.get("correlation_id"), "event correlation")?;
    }
    Ok(())
}

fn validate_spans(records: &[Value], actions: &[Value], setups: &[Value]) -> Result<(), String> {
    const KINDS: &[&str] = &[
        "inspection_queue",
        "inspection_native",
        "inspection_delivery",
        "ipc_round_trip",
        "draft_encode",
        "storage_write",
        "recovery_verification",
    ];
    for (index, record) in records.iter().enumerate() {
        let object = record
            .as_object()
            .ok_or_else(|| "invalid span record".to_owned())?;
        if value_u64(object.get("span_id"), "span ID")? != (index + 1) as u64 {
            return Err("span identifiers must be contiguous".to_owned());
        }
        let owner = validate_owner(object.get("owner"), actions.len(), setups.len())?;
        if let Some(parent_id) = optional_u64(object.get("parent_span_id"), "parent span ID")? {
            if parent_id >= (index + 1) as u64 {
                return Err("span references an unknown parent".to_owned());
            }
            let parent = records[(parent_id - 1) as usize]
                .as_object()
                .ok_or_else(|| "invalid parent span".to_owned())?;
            if validate_owner(parent.get("owner"), actions.len(), setups.len())? != owner {
                return Err("parent and child span owners do not match".to_owned());
            }
        }
        validate_enum(value_str(object.get("kind"), "span kind")?, KINDS)?;
        validate_enum(
            value_str(object.get("terminal"), "span terminal")?,
            &["ended", "cancelled"],
        )?;
        let start = value_u64(object.get("start_us"), "span start timestamp")?;
        let end = value_u64(object.get("end_us"), "span end timestamp")?;
        if end < start {
            return Err("span end precedes its start".to_owned());
        }
        if let Some(action_id) = optional_u64(
            object.get("terminal_cause_action_id"),
            "terminal cause action ID",
        )? {
            if action_id == 0 || action_id as usize > actions.len() {
                return Err("span references an unknown terminal action".to_owned());
            }
        }
        validate_nullable_opaque(object.get("subject_id"), "span subject")?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OwnerRef {
    Action(u64),
    Setup(u64),
}

fn validate_owner(
    value: Option<&Value>,
    action_count: usize,
    setup_count: usize,
) -> Result<OwnerRef, String> {
    let owner = value
        .and_then(Value::as_object)
        .ok_or_else(|| "invalid causal owner".to_owned())?;
    match value_str(owner.get("kind"), "owner kind")? {
        "action" => {
            let id = value_u64(owner.get("action_id"), "owner action ID")?;
            if id == 0 || id as usize > action_count {
                return Err("owner references an unknown action".to_owned());
            }
            Ok(OwnerRef::Action(id))
        }
        "setup" => {
            let id = value_u64(owner.get("setup_id"), "owner setup ID")?;
            if id == 0 || id as usize > setup_count {
                return Err("owner references an unknown setup".to_owned());
            }
            Ok(OwnerRef::Setup(id))
        }
        _ => Err("invalid causal owner kind".to_owned()),
    }
}

fn validate_json_scalars(value: &Value) -> Result<(), String> {
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) if is_safe_integer(number) => Ok(()),
        Value::Number(_) => Err("component contains a non-integer number".to_owned()),
        Value::String(value) => {
            validate_bounded_text(value, "component string")?;
            if value.contains('/') || value.contains('\\') {
                return Err("component contains a path-like string".to_owned());
            }
            Ok(())
        }
        Value::Array(values) => values.iter().try_for_each(validate_json_scalars),
        Value::Object(values) => values.iter().try_for_each(|(key, value)| {
            validate_bounded_text(key, "component field")?;
            validate_json_scalars(value)
        }),
    }
}

fn validate_report_directory(path: &Path) -> Result<(), String> {
    validate_canonical_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("responsiveness report destination must be a regular directory".to_owned());
    }
    Ok(())
}

fn data_store_ownership_path(activation: &ResponsivenessActivation, report_dir: &Path) -> PathBuf {
    report_dir.join(format!(
        "data-store-owned-{}.json",
        activation.descriptor.session_id
    ))
}

fn data_store_ownership_value(activation: &ResponsivenessActivation) -> Value {
    serde_json::json!({
        "schema_version": RESPONSIVENESS_SCHEMA_VERSION,
        "component_kind": "data_store_ownership",
        "session_id": activation.descriptor.session_id,
        "webview_data_store_id": activation.webview_data_store_id
    })
}

fn data_store_cleanup_receipt_path(
    activation: &ResponsivenessActivation,
    report_dir: &Path,
) -> PathBuf {
    report_dir.join(format!(
        "data-store-cleanup-{}.json",
        activation.descriptor.session_id
    ))
}

fn ensure_data_store_ownership(
    activation: &ResponsivenessActivation,
    report_dir: &Path,
) -> Result<(), String> {
    let path = data_store_ownership_path(activation, report_dir);
    let expected = data_store_ownership_value(activation);
    match write_create_new_json(&path, &expected) {
        Ok(()) => Ok(()),
        Err(_) => validate_data_store_ownership(activation, report_dir),
    }
}

fn validate_data_store_ownership(
    activation: &ResponsivenessActivation,
    report_dir: &Path,
) -> Result<(), String> {
    let path = data_store_ownership_path(activation, report_dir);
    validate_canonical_path(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 {
        return Err("invalid data store ownership marker".to_owned());
    }
    let existing: Value = serde_json::from_slice(
        &fs::read(path).map_err(|_| "invalid data store ownership marker".to_owned())?,
    )
    .map_err(|_| "invalid data store ownership marker".to_owned())?;
    if existing != data_store_ownership_value(activation) {
        return Err("data store ownership marker mismatch".to_owned());
    }
    Ok(())
}

fn validate_cleanup_authority(
    activation: &ResponsivenessActivation,
    report_dir: &Path,
) -> Result<(), String> {
    let ownership = data_store_ownership_path(activation, report_dir);
    match fs::symlink_metadata(&ownership) {
        Ok(_) => validate_data_store_ownership(activation, report_dir),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if validate_cleanup_success_receipt(activation, report_dir)? {
                Ok(())
            } else {
                Err("responsiveness cleanup has no ownership authority".to_owned())
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

fn validate_cleanup_success_receipt(
    activation: &ResponsivenessActivation,
    report_dir: &Path,
) -> Result<bool, String> {
    let path = data_store_cleanup_receipt_path(activation, report_dir);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    validate_canonical_path(&path)?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 {
        return Err("invalid data store cleanup receipt".to_owned());
    }
    let value: Value = serde_json::from_slice(
        &fs::read(&path).map_err(|_| "invalid data store cleanup receipt".to_owned())?,
    )
    .map_err(|_| "invalid data store cleanup receipt".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "invalid data store cleanup receipt".to_owned())?;
    const FIELDS: &[&str] = &[
        "schema_version",
        "component_kind",
        "session_id",
        "webview_data_store_id",
        "removed",
        "error_code",
        "pid",
        "native_clock",
    ];
    if object.len() != FIELDS.len() || FIELDS.iter().any(|field| !object.contains_key(*field)) {
        return Err("invalid data store cleanup receipt".to_owned());
    }
    require_u64(object, "schema_version", RESPONSIVENESS_SCHEMA_VERSION)?;
    require_str(object, "component_kind", "data_store_cleanup")?;
    require_str(object, "session_id", &activation.descriptor.session_id)?;
    if object.get("webview_data_store_id")
        != Some(&serde_json::to_value(activation.webview_data_store_id).unwrap())
        || !matches!(object.get("removed"), Some(Value::Bool(_)))
        || object.get("error_code") != Some(&Value::Null)
    {
        return Err("invalid data store cleanup receipt".to_owned());
    }
    value_u64(object.get("pid"), "cleanup PID")?;
    let clock = object_at(object, "native_clock")?;
    if clock.len() != 3 {
        return Err("invalid data store cleanup clock".to_owned());
    }
    require_str(clock, "domain", "native_monotonic")?;
    require_str(clock, "unit", "us")?;
    value_u64(clock.get("elapsed_us"), "cleanup elapsed timestamp")?;
    Ok(true)
}

fn remove_data_store_ownership_after_receipt(
    activation: &ResponsivenessActivation,
    report_dir: &Path,
) -> Result<(), String> {
    if !validate_cleanup_success_receipt(activation, report_dir)? {
        return Err("responsiveness cleanup receipt is missing".to_owned());
    }
    let ownership = data_store_ownership_path(activation, report_dir);
    match fs::symlink_metadata(&ownership) {
        Ok(_) => {
            validate_data_store_ownership(activation, report_dir)?;
            fs::remove_file(&ownership).map_err(|error| error.to_string())?;
            sync_directory(report_dir)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_canonical_path(path: &Path) -> Result<(), String> {
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err("responsiveness paths must be normalized".to_owned());
    }
    if fs::canonicalize(path).map_err(|error| error.to_string())? != path {
        return Err("responsiveness paths must already be canonical".to_owned());
    }
    // These snapshot checks reject every symlink present during validation.
    // Fully eliminating an ancestor-swap race would require directory-relative
    // openat/renameat2 operations that safe std does not expose. The activation
    // contract therefore also requires the harness-owned directory not be
    // writable by an adversary for the lifetime of a run.
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("responsiveness paths may not traverse symlinks".to_owned());
        }
    }
    Ok(())
}

fn marker_file_value(marker: &NativeResponsivenessMarker) -> Value {
    serde_json::json!({
        "schema_version": marker.schema_version,
        "component_kind": marker.component_kind,
        "session_id": marker.session_id,
        "sample_id": marker.sample_id,
        "page_instance_id": marker.page_instance_id,
        "action_id": marker.action_id,
        "pid": marker.pid,
        "native_clock": {
            "domain": "native_monotonic",
            "unit": "us",
            "elapsed_us": marker.native_elapsed_us
        }
    })
}

fn write_create_new_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "report serialization failed".to_owned())?;
    write_atomic_create_new_bytes(path, &bytes)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublicationStage {
    TempSynced,
    Committed,
}

static PUBLICATION_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_atomic_create_new_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_create_new_bytes_with_hook(path, bytes, |_| Ok(()))
}

fn write_atomic_create_new_bytes_with_hook<F>(
    path: &Path,
    bytes: &[u8],
    mut hook: F,
) -> Result<(), String>
where
    F: FnMut(PublicationStage) -> Result<(), String>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "report destination has no parent".to_owned())?;
    validate_report_directory(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "report destination has an invalid file name".to_owned())?;
    let nonce = PUBLICATION_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce));
    let mut publish = || -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        hook(PublicationStage::TempSynced)?;

        // std does not expose openat/renameat2-style directory-relative no-follow
        // operations. Revalidate immediately before the atomic hard-link commit;
        // the harness-owned directory must not be writable by an adversary.
        validate_report_directory(parent)?;
        fs::hard_link(&temp, path).map_err(|error| error.to_string())?;
        if let Err(error) = hook(PublicationStage::Committed) {
            let _ = fs::remove_file(path);
            let _ = sync_directory(parent);
            return Err(error);
        }
        if let Err(error) = sync_directory(parent) {
            let _ = fs::remove_file(path);
            let _ = sync_directory(parent);
            return Err(error);
        }
        Ok(())
    };
    let result = publish();
    let _ = fs::remove_file(&temp);
    if result.is_ok() {
        let _ = sync_directory(parent);
    }
    result
}

fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

fn object_at<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Map<String, Value>, String> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("invalid {field}"))
}

fn bounded_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    max: usize,
) -> Result<&'a [Value], String> {
    let values = object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("invalid {field}"))?;
    if values.len() > max {
        return Err(format!("{field} exceeds count limit"));
    }
    Ok(values)
}

fn require_str(object: &Map<String, Value>, field: &str, expected: &str) -> Result<(), String> {
    if value_str(object.get(field), field)? != expected {
        return Err(format!("{field} mismatch"));
    }
    Ok(())
}

fn require_u64(object: &Map<String, Value>, field: &str, expected: u64) -> Result<(), String> {
    if value_u64(object.get(field), field)? != expected {
        return Err(format!("{field} mismatch"));
    }
    Ok(())
}

fn value_str<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str, String> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("invalid {field}"))
}

fn value_u64(value: Option<&Value>, field: &str) -> Result<u64, String> {
    let value = value
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("invalid {field}"))?;
    if value > MAX_SAFE_INTEGER {
        return Err(format!("{field} exceeds safe integer limit"));
    }
    Ok(value)
}

fn optional_u64(value: Option<&Value>, field: &str) -> Result<Option<u64>, String> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(value) => value_u64(Some(value), field).map(Some),
        None => Err(format!("missing {field}")),
    }
}

fn validate_nullable_opaque(value: Option<&Value>, field: &str) -> Result<(), String> {
    match value {
        Some(Value::Null) => Ok(()),
        Some(Value::String(value)) => validate_opaque(value, field),
        _ => Err(format!("invalid {field}")),
    }
}

fn validate_opaque(value: &str, field: &str) -> Result<(), String> {
    validate_bounded_text(value, field)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(format!("invalid {field}"));
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_FIELD_BYTES {
        return Err(format!("invalid {field} length"));
    }
    Ok(())
}

fn validate_bounded_text_allow_empty(value: &str, field: &str) -> Result<(), String> {
    if value.len() > MAX_FIELD_BYTES {
        return Err(format!("invalid {field} length"));
    }
    Ok(())
}

fn validate_enum(value: &str, allowed: &[&str]) -> Result<(), String> {
    if !allowed.contains(&value) {
        return Err("invalid closed enum value".to_owned());
    }
    Ok(())
}

fn validate_uuid(value: &str, field: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23) && *byte == b'-'
                || !matches!(index, 8 | 13 | 18 | 23)
                    && byte.is_ascii_hexdigit()
                    && !byte.is_ascii_uppercase()
        })
        || !matches!(bytes[14], b'1'..=b'5')
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    {
        return Err(format!("invalid {field}"));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("invalid manifest hash".to_owned());
    }
    Ok(())
}

fn is_safe_integer(number: &serde_json::Number) -> bool {
    number
        .as_u64()
        .is_some_and(|value| value <= MAX_SAFE_INTEGER)
        || number
            .as_i64()
            .is_some_and(|value| value >= -(MAX_SAFE_INTEGER as i64))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{fs, path::Path, time::Instant};

    const SESSION_ID: &str = "123e4567-e89b-42d3-a456-426614174000";
    const PAGE_ID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const SAMPLE_ID: &str = "inspection:32:measured:1";
    const TOKEN: &str = "token-1";
    const MANIFEST_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn descriptor() -> Value {
        json!({
            "componentRole": "primary",
            "sessionId": SESSION_ID,
            "sampleId": SAMPLE_ID,
            "pageInstanceId": PAGE_ID,
            "lane": "inspection",
            "scenario": { "id": "inspection-baseline", "manifestSha256": MANIFEST_HASH },
            "workload": { "id": "mixed-32", "facts": { "source_count": 32 } },
            "phase": "measured",
            "repetition": 1
        })
    }

    fn write_manifest(path: &Path) {
        fs::write(
            path,
            serde_json::to_vec(&json!({
                "schema_version": 2,
                "token": TOKEN,
                "descriptor": descriptor(),
                "webviewDataStoreId": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
                "bootstrap": {
                    "initialPath": "/convert",
                    "draftStorage": null,
                    "failNextDraftWrite": false
                },
                "completion": {
                    "kind": "actions_and_setups",
                    "timeoutMs": 40_000,
                    "expectedDraftSha256": null,
                    "expectedAxValue": null
                },
                "actions": [{
                    "actionId": 1,
                    "targetId": "source-1",
                    "eventType": "click",
                    "targetRole": "button",
                    "accessibleName": "Select source-1",
                    "expectedPriorValue": "idle"
                }, {
                    "actionId": 2,
                    "targetId": "source-2",
                    "eventType": "click",
                    "targetRole": "button",
                    "accessibleName": "Select source-2",
                    "expectedPriorValue": "idle"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn component() -> Value {
        json!({
            "schema_version": 2,
            "component_kind": "frontend_trace",
            "component_role": "primary",
            "session_id": SESSION_ID,
            "sample_id": SAMPLE_ID,
            "page_instance_id": PAGE_ID,
            "lane": "inspection",
            "scenario": { "id": "inspection-baseline", "manifest_sha256": MANIFEST_HASH },
            "workload": { "id": "mixed-32", "facts": { "source_count": 32 } },
            "phase": "measured",
            "repetition": 1,
            "clock_origin": { "domain": "webview_monotonic", "unit": "us" },
            "setups": [],
            "actions": [{
                "action_id": 1, "target_id": "source-1", "state": "settled",
                "armed_us": 1, "active_us": 2, "terminal_us": 3
            }, {
                "action_id": 2, "target_id": "source-2", "state": "settled",
                "armed_us": 4, "active_us": 5, "terminal_us": 6
            }],
            "events": [],
            "spans": [],
            "browser_timing": {
                "event_timing": { "supported": false, "raw": [], "aggregate": null, "by_action": [] },
                "long_tasks": { "supported": false, "raw": [], "aggregate": null },
                "raf_gaps": {
                    "count": 0, "max_us": 0,
                    "buckets": {
                        "le_8_334_us": 0, "le_16_667_us": 0, "le_33_334_us": 0,
                        "le_50_000_us": 0, "le_100_000_us": 0, "le_250_000_us": 0,
                        "overflow": 0
                    }
                }
            },
            "dropped_events": 0,
            "late_events": 0,
            "observer_entries_aggregated": 0,
            "limitations": ["event_timing_unsupported", "long_tasks_unsupported"],
            "failure": null,
            "settled": true
        })
    }

    fn failure_component(action_count: usize) -> Value {
        let mut value = component();
        value["actions"] = Value::Array(
            value["actions"]
                .as_array()
                .unwrap()
                .iter()
                .take(action_count)
                .cloned()
                .collect(),
        );
        value["failure"] = json!({
            "code": "state_transition",
            "phase": "action",
            "count": 1
        });
        value["settled"] = json!(false);
        value
    }

    fn enabled_state(dir: &Path) -> ResponsivenessState {
        let root = fs::canonicalize(dir).unwrap();
        let manifest = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest);
        ResponsivenessState::from_paths(Some(manifest), Some(reports), Instant::now())
    }

    fn control_state(dir: &Path) -> ResponsivenessState {
        let root = fs::canonicalize(dir).unwrap();
        let manifest = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest);
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["recorderMode"] = json!("control");
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        ResponsivenessState::from_paths(Some(manifest), Some(reports), Instant::now())
    }

    #[test]
    fn performance_disabled_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = PerformanceState::new(None, Instant::now());
        assert!(!state.enabled());
        state.ready(true).unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[test]
    fn performance_requires_success_and_writes_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ready.json");
        let state = PerformanceState::new(Some(path.clone()), Instant::now());
        state.ready(false).unwrap();
        assert!(!path.exists());
        state.ready(true).unwrap();
        let first = fs::read(&path).unwrap();
        state.ready(true).unwrap();
        assert_eq!(fs::read(path).unwrap(), first);
        let report: serde_json::Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(report["schema_version"], 1);
        assert!(report["backend_ready_ms"].as_f64().unwrap() >= 0.0);
        assert_eq!(report["pid"], std::process::id());
    }
    #[test]
    fn performance_never_replaces_existing_report() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ready.json");
        fs::write(&path, "existing").unwrap();
        let state = PerformanceState::new(Some(path.clone()), Instant::now());
        assert!(state.ready(true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "existing");
    }
    #[test]
    fn performance_relative_path_is_disabled() {
        assert!(!PerformanceState::new(Some("ready.json".into()), Instant::now()).enabled());
    }
    #[cfg(unix)]
    #[test]
    fn performance_does_not_follow_report_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let path = dir.path().join("ready.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(PerformanceState::new(Some(path), Instant::now())
            .ready(true)
            .is_err());
        assert!(!target.exists());
    }

    #[test]
    fn responsiveness_disabled_is_inert() {
        let dir = tempfile::tempdir().unwrap();
        let state = ResponsivenessState::from_paths(None, None, Instant::now());
        assert!(!state.status().enabled);
        assert!(state
            .ready(PAGE_ID.to_owned(), TOKEN.to_owned(), Some(1))
            .is_err());
        assert!(state
            .write_component(TOKEN.to_owned(), component())
            .is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn responsiveness_recorder_mode_defaults_enabled_and_rejects_control_ready() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        let status = serde_json::to_value(state.status()).unwrap();
        assert_eq!(status["recorderMode"], "enabled");
        assert!(state
            .control_ready(PAGE_ID.to_owned(), TOKEN.to_owned())
            .is_err());
        state
            .ready(PAGE_ID.to_owned(), TOKEN.to_owned(), Some(1))
            .unwrap();
    }

    #[test]
    fn responsiveness_control_mode_is_bootstrap_capable_and_recorder_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let state = control_state(dir.path());
        let status = serde_json::to_value(state.status()).unwrap();
        assert_eq!(status["recorderMode"], "control");
        assert_eq!(status["bootstrap"]["initialPath"], "/convert");
        assert_eq!(status["webviewDataStoreId"].as_array().unwrap().len(), 16);
        assert!(state.data_store_identifier().is_some());

        assert!(state
            .ready(PAGE_ID.to_owned(), TOKEN.to_owned(), Some(1))
            .is_err());
        assert!(state
            .action_ready(PAGE_ID.to_owned(), TOKEN.to_owned(), 1)
            .is_err());
        assert!(state
            .write_component(TOKEN.to_owned(), component())
            .is_err());

        let marker = state
            .control_ready(PAGE_ID.to_owned(), TOKEN.to_owned())
            .unwrap();
        assert_eq!(marker.component_kind, "control_ready");
        assert_eq!(marker.action_id, None);
        assert!(state
            .control_ready(PAGE_ID.to_owned(), TOKEN.to_owned())
            .is_err());

        let reports = dir.path().join("reports");
        assert!(reports
            .join(format!("control-ready-{PAGE_ID}.json"))
            .is_file());
        assert!(!reports
            .join(format!("recorder-ready-{PAGE_ID}.json"))
            .exists());
        assert_eq!(
            fs::read_dir(&reports)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("frontend-"))
                .count(),
            0
        );
    }

    #[test]
    fn responsiveness_rejects_unknown_recorder_mode() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let manifest = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest);
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["recorderMode"] = json!("disabled");
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();

        let state = ResponsivenessState::from_paths(Some(manifest), Some(reports), Instant::now());
        assert!(!state.status().enabled);
        assert!(state.data_store_identifier().is_none());
    }

    #[test]
    fn responsiveness_control_mode_preserves_cleanup_authority() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let manifest = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest);
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["recorderMode"] = json!("control");
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();

        let active = ResponsivenessState::from_paths(
            Some(manifest.clone()),
            Some(reports.clone()),
            Instant::now(),
        );
        assert!(active.status().enabled);
        assert!(active.data_store_identifier().is_some());
        let cleanup = ResponsivenessState::from_paths_with_cleanup(
            Some(manifest),
            Some(reports),
            Instant::now(),
            true,
        );
        assert!(cleanup.cleanup_mode());
        assert!(cleanup.cleanup_request().is_some());
    }

    #[test]
    fn responsiveness_requires_absolute_non_symlink_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let relative = ResponsivenessState::from_paths(
            Some("manifest.json".into()),
            Some("reports".into()),
            Instant::now(),
        );
        assert!(!relative.status().enabled);

        #[cfg(unix)]
        {
            let manifest = dir.path().join("manifest.json");
            let target = dir.path().join("actual-manifest.json");
            let reports = dir.path().join("reports");
            fs::create_dir(&reports).unwrap();
            write_manifest(&target);
            std::os::unix::fs::symlink(&target, &manifest).unwrap();
            let state =
                ResponsivenessState::from_paths(Some(manifest), Some(reports), Instant::now());
            assert!(!state.status().enabled);
        }
    }

    #[cfg(unix)]
    #[test]
    fn responsiveness_rejects_symlinked_manifest_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let actual = root.join("actual");
        let alias = root.join("alias");
        fs::create_dir(&actual).unwrap();
        fs::create_dir(actual.join("reports")).unwrap();
        write_manifest(&actual.join("manifest.json"));
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        let state = ResponsivenessState::from_paths(
            Some(alias.join("manifest.json")),
            Some(alias.join("reports")),
            Instant::now(),
        );
        assert!(!state.status().enabled);
    }

    #[test]
    fn responsiveness_rejects_token_identity_schema_and_event_errors() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        assert!(state.status().enabled);
        assert!(state
            .write_component("wrong-token".into(), component())
            .is_err());

        let mut wrong_identity = component();
        wrong_identity["sample_id"] = json!("different:sample");
        assert!(state.write_component(TOKEN.into(), wrong_identity).is_err());

        let mut wrong_schema = component();
        wrong_schema["schema_version"] = json!(1);
        assert!(state.write_component(TOKEN.into(), wrong_schema).is_err());

        let mut malformed_event = component();
        malformed_event["events"] = json!([{
            "event_seq": 1,
            "owner": { "kind": "action", "action_id": 1 },
            "span_id": null,
            "kind": "not_a_real_event",
            "at_us": 1,
            "subject_id": null,
            "correlation_id": null
        }]);
        assert!(state
            .write_component(TOKEN.into(), malformed_event)
            .is_err());

        let mut missing_timestamp = component();
        missing_timestamp["actions"][0]
            .as_object_mut()
            .unwrap()
            .remove("armed_us");
        assert!(state
            .write_component(TOKEN.into(), missing_timestamp)
            .is_err());

        let mut unknown_parent = component();
        unknown_parent["spans"] = json!([{
            "span_id": 1,
            "owner": { "kind": "action", "action_id": 1 },
            "parent_span_id": 2,
            "kind": "ipc_round_trip",
            "subject_id": null,
            "start_us": 1,
            "end_us": 2,
            "terminal": "ended",
            "terminal_cause_action_id": null
        }]);
        assert!(state.write_component(TOKEN.into(), unknown_parent).is_err());
    }

    #[test]
    fn responsiveness_enforces_count_string_and_byte_caps() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());

        let mut too_many_setups = component();
        too_many_setups["setups"] = Value::Array(vec![Value::Null; 257]);
        assert!(state
            .write_component(TOKEN.into(), too_many_setups)
            .is_err());

        let mut long_label = component();
        long_label["workload"]["id"] = json!("x".repeat(65));
        assert!(state.write_component(TOKEN.into(), long_label).is_err());

        let oversized = Value::String("x".repeat(6 * 1024 * 1024 + 1));
        assert!(state.write_component(TOKEN.into(), oversized).is_err());
    }

    #[test]
    fn responsiveness_accepts_the_full_action_plan_and_rejects_one_more() {
        let build_actions = |count: usize| {
            (1..=count)
                .map(|action_id| {
                    json!({
                        "actionId": action_id,
                        "targetId": format!("target-{action_id}"),
                        "eventType": "click",
                        "targetRole": "button",
                        "accessibleName": format!("Action {action_id}"),
                        "expectedPriorValue": ""
                    })
                })
                .collect::<Vec<_>>()
        };
        let create = |count: usize| {
            let dir = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(dir.path()).unwrap();
            let manifest = root.join("manifest.json");
            let reports = root.join("reports");
            fs::create_dir(&reports).unwrap();
            fs::write(
                &manifest,
                serde_json::to_vec(&json!({
                    "schema_version": 2,
                    "token": TOKEN,
                    "descriptor": descriptor(),
                    "webviewDataStoreId": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
                    "bootstrap": {
                        "initialPath": "/convert", "draftStorage": null,
                        "failNextDraftWrite": false
                    },
                    "completion": {
                        "kind": "actions_and_setups", "timeoutMs": 40_000,
                        "expectedDraftSha256": null, "expectedAxValue": null
                    },
                    "actions": build_actions(count)
                }))
                .unwrap(),
            )
            .unwrap();
            let state =
                ResponsivenessState::from_paths(Some(manifest), Some(reports), Instant::now());
            (dir, state)
        };

        let (_accepted_dir, accepted) = create(MAX_ACTIONS);
        assert!(accepted.status().enabled);
        assert_eq!(accepted.status().actions.unwrap().len(), MAX_ACTIONS);

        let (_rejected_dir, rejected) = create(MAX_ACTIONS + 1);
        assert!(!rejected.status().enabled);
    }

    #[test]
    fn responsiveness_validates_bootstrap_and_returns_bounded_completion() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let manifest_path = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest_path);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let raw = "{\"draft\":true}";
        let hash = format!("{:x}", Sha256::digest(raw.as_bytes()));
        manifest["bootstrap"]["draftStorage"] = json!({ "raw": raw, "sha256": hash });
        manifest["bootstrap"]["failNextDraftWrite"] = json!(true);
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let state = ResponsivenessState::from_paths(
            Some(manifest_path.clone()),
            Some(reports.clone()),
            Instant::now(),
        );
        let status = serde_json::to_value(state.status()).unwrap();
        assert_eq!(status["webviewDataStoreId"].as_array().unwrap().len(), 16);
        assert_eq!(status["bootstrap"]["draftStorage"]["raw"], raw);
        assert_eq!(status["completion"]["kind"], "actions_and_setups");
        assert_eq!(state.data_store_identifier().unwrap()[0], 1);

        manifest["bootstrap"]["draftStorage"]["sha256"] = json!(MANIFEST_HASH);
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let invalid =
            ResponsivenessState::from_paths(Some(manifest_path), Some(reports), Instant::now());
        assert!(!invalid.status().enabled);
    }

    #[test]
    fn responsiveness_allows_zero_actions_only_for_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let manifest_path = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest_path);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["descriptor"]["componentRole"] = json!("recovery");
        manifest["actions"] = json!([]);
        manifest["completion"] = json!({
            "kind": "recovery", "timeoutMs": 10_000,
            "expectedDraftSha256": MANIFEST_HASH,
            "expectedAxValue": "https://x.test/a.mp4"
        });
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let state = ResponsivenessState::from_paths(
            Some(manifest_path.clone()),
            Some(reports.clone()),
            Instant::now(),
        );
        assert!(state.status().enabled);
        state.ready(PAGE_ID.into(), TOKEN.into(), None).unwrap();
        let mut recovery = component();
        recovery["component_role"] = json!("recovery");
        recovery["actions"] = json!([]);
        state.write_component(TOKEN.into(), recovery).unwrap();

        manifest["descriptor"]["componentRole"] = json!("primary");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let invalid =
            ResponsivenessState::from_paths(Some(manifest_path), Some(reports), Instant::now());
        assert!(!invalid.status().enabled);
    }

    #[test]
    fn responsiveness_completion_semantics_distinguish_success_and_failure_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).unwrap();

        let mut partial_success = component();
        partial_success["actions"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        assert!(state
            .write_component(TOKEN.into(), partial_success)
            .is_err());

        let mut active_success = component();
        active_success["actions"][1]["state"] = json!("active");
        active_success["actions"][1]["terminal_us"] = Value::Null;
        assert!(state.write_component(TOKEN.into(), active_success).is_err());

        state
            .write_component(TOKEN.into(), failure_component(1))
            .unwrap();
    }

    #[test]
    fn responsiveness_failure_record_is_closed_bounded_and_progress_consistent() {
        let create = || {
            let dir = tempfile::tempdir().unwrap();
            let state = enabled_state(dir.path());
            state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).unwrap();
            (dir, state)
        };

        let (_dir, state) = create();
        assert!(state
            .write_component(TOKEN.into(), failure_component(2))
            .is_err());

        let (_dir, state) = create();
        let mut cancelled_unpublished = failure_component(2);
        cancelled_unpublished["actions"][1]["state"] = json!("cancelled");
        state
            .write_component(TOKEN.into(), cancelled_unpublished)
            .unwrap();

        let (_dir, state) = create();
        let mut zero_count = failure_component(1);
        zero_count["failure"]["count"] = json!(0);
        assert!(state.write_component(TOKEN.into(), zero_count).is_err());

        let (_dir, state) = create();
        let mut open_failure = failure_component(1);
        open_failure["failure"]["detail"] = json!("not allowed");
        assert!(state.write_component(TOKEN.into(), open_failure).is_err());
    }

    #[test]
    fn responsiveness_publishes_only_valid_zero_progress_failures_before_ready() {
        let create = || {
            let dir = tempfile::tempdir().unwrap();
            let state = enabled_state(dir.path());
            (dir, state)
        };

        let (observer_dir, observer_failure) = create();
        observer_failure
            .write_component(TOKEN.into(), failure_component(0))
            .unwrap();
        assert!(observer_failure
            .ready(PAGE_ID.into(), TOKEN.into(), Some(1))
            .is_err());
        assert!(observer_failure
            .write_component(TOKEN.into(), failure_component(0))
            .is_err());
        assert_eq!(
            fs::read_dir(observer_dir.path().join("reports"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("frontend-"))
                .count(),
            1
        );

        let (_initial_arm_dir, initial_arm_failure) = create();
        let mut cancelled_first = failure_component(1);
        cancelled_first["actions"][0]["state"] = json!("cancelled");
        initial_arm_failure
            .write_component(TOKEN.into(), cancelled_first)
            .unwrap();

        let (_success_dir, spoofed_success) = create();
        assert!(spoofed_success
            .write_component(TOKEN.into(), component())
            .is_err());

        let (_prefix_dir, spoofed_prefix) = create();
        assert!(spoofed_prefix
            .write_component(TOKEN.into(), failure_component(1))
            .is_err());
    }

    #[test]
    fn responsiveness_publication_failures_leave_one_shot_state_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        let ready_path = dir
            .path()
            .join("reports")
            .join(format!("recorder-ready-{PAGE_ID}.json"));
        fs::create_dir(&ready_path).unwrap();
        assert!(state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).is_err());
        fs::remove_dir(&ready_path).unwrap();
        state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).unwrap();

        let action_path = dir
            .path()
            .join("reports")
            .join(format!("action-ready-2-{PAGE_ID}.json"));
        fs::create_dir(&action_path).unwrap();
        assert!(state.action_ready(PAGE_ID.into(), TOKEN.into(), 2).is_err());
        fs::remove_dir(&action_path).unwrap();
        state.action_ready(PAGE_ID.into(), TOKEN.into(), 2).unwrap();

        let component_path = dir
            .path()
            .join("reports")
            .join(format!("frontend-primary-{PAGE_ID}.json"));
        fs::create_dir(&component_path).unwrap();
        assert!(state.write_component(TOKEN.into(), component()).is_err());
        fs::remove_dir(&component_path).unwrap();
        state.write_component(TOKEN.into(), component()).unwrap();
    }

    #[test]
    fn atomic_publication_rolls_back_interrupted_commits_and_retries() {
        for interrupted_at in [PublicationStage::TempSynced, PublicationStage::Committed] {
            let dir = tempfile::tempdir().unwrap();
            let path = fs::canonicalize(dir.path()).unwrap().join("final.json");
            assert!(
                write_atomic_create_new_bytes_with_hook(&path, b"payload", |stage| {
                    if stage == interrupted_at {
                        Err("injected publication interruption".to_owned())
                    } else {
                        Ok(())
                    }
                })
                .is_err()
            );
            assert!(!path.exists());
            write_atomic_create_new_bytes(&path, b"payload").unwrap();
            assert_eq!(fs::read(path).unwrap(), b"payload");
        }
    }

    #[test]
    fn responsiveness_cleanup_is_recoverable_across_receipt_and_ownership_phases() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let manifest = root.join("manifest.json");
        let reports = root.join("reports");
        fs::create_dir(&reports).unwrap();
        write_manifest(&manifest);
        let active = ResponsivenessState::from_paths(
            Some(manifest.clone()),
            Some(reports.clone()),
            Instant::now(),
        );
        assert!(active.status().enabled);

        let cleanup = ResponsivenessState::from_paths_with_cleanup(
            Some(manifest.clone()),
            Some(reports.clone()),
            Instant::now(),
            true,
        );
        assert!(cleanup.cleanup_mode());
        assert!(!cleanup.status().enabled);
        assert!(cleanup
            .reconcile_cleanup_success_with_hook(true, || {
                Err("injected ownership finalization failure".to_owned())
            })
            .is_err());
        assert!(reports
            .join(format!("data-store-owned-{SESSION_ID}.json"))
            .exists());

        let resumed = ResponsivenessState::from_paths_with_cleanup(
            Some(manifest.clone()),
            Some(reports.clone()),
            Instant::now(),
            true,
        );
        assert!(resumed.cleanup_request().unwrap().already_complete);
        resumed.reconcile_cleanup_success(false).unwrap();
        let receipt: Value = serde_json::from_slice(
            &fs::read(reports.join(format!("data-store-cleanup-{SESSION_ID}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["removed"], true);
        assert!(receipt.get("bootstrap").is_none());
        assert!(!reports
            .join(format!("data-store-owned-{SESSION_ID}.json"))
            .exists());

        let idempotent = ResponsivenessState::from_paths_with_cleanup(
            Some(manifest.clone()),
            Some(reports.clone()),
            Instant::now(),
            true,
        );
        assert!(idempotent.cleanup_mode());
        assert!(idempotent.cleanup_request().unwrap().already_complete);
        idempotent.reconcile_cleanup_success(false).unwrap();

        let mut changed: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        changed["webviewDataStoreId"][0] = json!(2);
        fs::write(&manifest, serde_json::to_vec(&changed).unwrap()).unwrap();
        let mismatched = ResponsivenessState::from_paths_with_cleanup(
            Some(manifest),
            Some(reports),
            Instant::now(),
            true,
        );
        assert!(mismatched.cleanup_requested());
        assert!(!mismatched.cleanup_mode());
    }

    #[test]
    fn responsiveness_ready_and_component_are_create_new_and_native_stamped() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        let status = state.status();
        assert_eq!(status.token.as_deref(), Some(TOKEN));
        assert_eq!(
            status.descriptor.as_ref().unwrap().page_instance_id,
            PAGE_ID
        );

        let ready = state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).unwrap();
        assert_eq!(ready.component_kind, "recorder_ready");
        assert_eq!(ready.action_id, Some(1));
        assert_eq!(ready.pid, std::process::id());
        assert!(state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).is_err());

        let action_ready = state.action_ready(PAGE_ID.into(), TOKEN.into(), 2).unwrap();
        assert_eq!(action_ready.component_kind, "action_ready");
        assert_eq!(action_ready.action_id, Some(2));
        assert!(state.action_ready(PAGE_ID.into(), TOKEN.into(), 2).is_err());

        let written = state.write_component(TOKEN.into(), component()).unwrap();
        assert_eq!(written.component_kind, "frontend_trace_written");
        assert_eq!(written.pid, std::process::id());
        assert!(state.write_component(TOKEN.into(), component()).is_err());

        let report_path = dir
            .path()
            .join("reports")
            .join(format!("frontend-primary-{PAGE_ID}.json"));
        let report: Value = serde_json::from_slice(&fs::read(report_path).unwrap()).unwrap();
        assert_eq!(report["schema_version"], 2);
        assert_eq!(report["component_kind"], "frontend_page_component");
        assert_eq!(report["pid"], std::process::id());
        assert_eq!(report["native_clock"]["domain"], "native_monotonic");
        assert_eq!(report["frontend_trace"], component());
    }

    #[cfg(unix)]
    #[test]
    fn responsiveness_does_not_follow_component_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).unwrap();
        state.action_ready(PAGE_ID.into(), TOKEN.into(), 2).unwrap();
        let target = dir.path().join("target.json");
        let report_path = dir
            .path()
            .join("reports")
            .join(format!("frontend-primary-{PAGE_ID}.json"));
        std::os::unix::fs::symlink(&target, &report_path).unwrap();
        assert!(state.write_component(TOKEN.into(), component()).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn responsiveness_never_replaces_existing_component() {
        let dir = tempfile::tempdir().unwrap();
        let state = enabled_state(dir.path());
        state.ready(PAGE_ID.into(), TOKEN.into(), Some(1)).unwrap();
        state.action_ready(PAGE_ID.into(), TOKEN.into(), 2).unwrap();
        let report_path = dir
            .path()
            .join("reports")
            .join(format!("frontend-primary-{PAGE_ID}.json"));
        fs::write(&report_path, "existing").unwrap();
        assert!(state.write_component(TOKEN.into(), component()).is_err());
        assert_eq!(fs::read_to_string(report_path).unwrap(), "existing");
    }

    #[test]
    fn shared_jcs_canonical_fixtures_parse_and_match_hashes() {
        // Native validates the shared canonical bytes and hashes only. Final
        // JCS serialization and sample assembly remain harness-owned, so this
        // module intentionally does not implement a second canonicalizer.
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/responsiveness-jcs.json");
        let fixture: Value = serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
        assert_eq!(fixture["schema_version"], 1);
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 2);
        for case in cases {
            let canonical = case["canonical"].as_str().unwrap();
            let _: Value = serde_json::from_str(canonical).unwrap();
            let digest = Sha256::digest(canonical.as_bytes());
            assert_eq!(format!("{digest:x}"), case["sha256"].as_str().unwrap());
        }
    }
}
