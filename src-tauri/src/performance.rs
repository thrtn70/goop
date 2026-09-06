use std::{
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Instant};

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
}
