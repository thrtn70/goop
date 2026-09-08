use goop_config::presets;
use goop_core::{path as gpath, GoopError, IpcError, Preset};

fn presets_path() -> std::path::PathBuf {
    gpath::presets_file()
}

/// Keep lock acquisition and the complete file transaction off async workers.
async fn run_preset<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, GoopError> + Send + 'static,
) -> Result<T, IpcError> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| IpcError::Unknown(error.to_string()))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn preset_list() -> Result<Vec<Preset>, IpcError> {
    run_preset(|| presets::load_or_seed(&presets_path())).await
}

#[tauri::command]
pub async fn preset_save(preset: Preset) -> Result<Preset, IpcError> {
    run_preset(move || presets::save_one(&presets_path(), preset)).await
}

#[tauri::command]
pub async fn preset_import(presets: Vec<Preset>) -> Result<Vec<Preset>, IpcError> {
    run_preset(move || presets::import(&presets_path(), presets)).await
}

#[tauri::command]
pub async fn preset_delete(id: String) -> Result<(), IpcError> {
    run_preset(move || presets::delete(&presets_path(), &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_preset_operation_leaves_async_executor_responsive() {
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let operation = tokio::spawn(run_preset(move || {
            let _ = started_tx.send(());
            // A bounded synchronous wait models storage/lock contention. Even a
            // regression that runs inline must finish instead of hanging tests.
            release_rx
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| {
                    GoopError::Config(
                        "Preset operation was not released by the async executor".into(),
                    )
                })?;
            Ok(17)
        }));
        tokio::time::timeout(Duration::from_secs(3), started_rx)
            .await
            .unwrap()
            .unwrap();
        let heartbeat = tokio::spawn(async { 42 });
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(250), heartbeat)
                .await
                .unwrap()
                .unwrap(),
            42
        );
        assert!(
            release_tx.send(()).is_ok(),
            "The preset operation blocked the async executor until its bounded wait expired"
        );
        assert_eq!(operation.await.unwrap().unwrap(), 17);
    }

    #[tokio::test]
    async fn preset_adapter_maps_blocking_join_failure_to_ipc_error() {
        let failure = run_preset::<()>(|| panic!("preset operation failed"))
            .await
            .unwrap_err();
        assert!(
            matches!(failure, IpcError::Unknown(message) if message.contains("preset operation failed"))
        );
    }

    #[tokio::test]
    async fn preset_adapter_preserves_storage_results_and_errors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("presets.json");
        let seed_path = path.clone();
        let seeded = run_preset(move || presets::load_or_seed(&seed_path))
            .await
            .unwrap();
        let mut saved = seeded[0].clone();
        saved.id = "saved".into();
        saved.is_builtin = false;
        let save_path = path.clone();
        let save_value = saved.clone();
        assert_eq!(
            run_preset(move || presets::save_one(&save_path, save_value))
                .await
                .unwrap(),
            saved
        );
        let import_path = path.clone();
        let mut imported = saved.clone();
        imported.id = "imported".into();
        let incoming = vec![imported];
        let expected = incoming.clone();
        assert_eq!(
            run_preset(move || presets::import(&import_path, incoming))
                .await
                .unwrap(),
            expected
        );
        let delete_path = path.clone();
        run_preset(move || presets::delete(&delete_path, "saved"))
            .await
            .unwrap();
        let list_path = path.clone();
        let after = run_preset(move || presets::load_or_seed(&list_path))
            .await
            .unwrap();
        assert_eq!(after.len(), seeded.len() + 1);
        assert!(after.iter().any(|preset| preset.id == "imported"));
        assert!(after.iter().all(|preset| preset.id != "saved"));
        saved.video_options = Some(goop_core::VideoConvertOptions::Copy);
        let failure = run_preset(move || presets::save_one(&path, saved))
            .await
            .unwrap_err();
        assert!(matches!(failure, IpcError::Config(_)));
    }
}
