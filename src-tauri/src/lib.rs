pub mod commands;
pub mod events;
pub mod state;

use events::TauriSink;
use goop_config as cfg;
use goop_core::{path as gpath, EventSink, GoopError, JobResult};
use goop_extractor::ytdlp::{ExtractRequest, YtDlp};
use goop_queue::{QueueStore, Scheduler, WorkerFn};
use goop_sidecar::BinaryResolver;
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("goop=info,warn")
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let sidecar_dir = app
                .path()
                .resource_dir()
                .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?
                .join("bin");
            let resolver = Arc::new(BinaryResolver::new(sidecar_dir));
            let settings_path = gpath::config_file();
            let settings = cfg::load(&settings_path).unwrap_or_default();
            let store = QueueStore::open(&gpath::data_dir().join("queue.db"))
                .map_err(|e| -> Box<dyn std::error::Error> { format!("queue open: {e}").into() })?;
            let _interrupted = store.reconcile().ok();
            let app_handle = app.handle().clone();
            let sink: Arc<dyn EventSink> = Arc::new(TauriSink(app_handle.clone()));

            let r_for_extract = resolver.clone();
            let sink_for_extract = sink.clone();
            let extract_worker: WorkerFn = Arc::new(move |id, payload, cancel| {
                let r = r_for_extract.clone();
                let s = sink_for_extract.clone();
                Box::pin(async move {
                    let req: ExtractRequest = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad payload: {e}")))?;
                    let yt = YtDlp::new(&r, s);
                    let res = yt.download(id, &req, cancel).await?;
                    Ok(JobResult {
                        output_path: Some(res.output_path),
                        bytes: Some(res.bytes),
                        duration_ms: res.duration_ms,
                    })
                })
            });
            let noop_worker: WorkerFn = Arc::new(|_, _, _| {
                Box::pin(async {
                    Ok(JobResult {
                        output_path: None,
                        bytes: None,
                        duration_ms: 0,
                    })
                })
            });

            let scheduler = Scheduler::new(
                store.clone(),
                sink,
                settings.extract_concurrency,
                settings.convert_concurrency,
                extract_worker,
                noop_worker,
            );
            // Tauri's setup closure runs synchronously outside a Tokio context,
            // so spawn the worker loops on Tauri's own async runtime.
            let s_extract = scheduler.clone();
            tauri::async_runtime::spawn(async move {
                s_extract.run_kind(goop_core::JobKind::Extract).await
            });
            let s_convert = scheduler.clone();
            tauri::async_runtime::spawn(async move {
                s_convert.run_kind(goop_core::JobKind::Convert).await
            });

            app.manage(AppState {
                resolver,
                store,
                scheduler,
                settings: parking_lot::RwLock::new(settings),
                settings_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::extract::extract_probe,
            commands::extract::extract_from_url,
            commands::queue::queue_list,
            commands::queue::queue_cancel,
            commands::queue::queue_clear_completed,
            commands::queue::queue_reveal,
            commands::sidecar::sidecar_status,
            commands::sidecar::sidecar_update_yt_dlp,
            commands::settings::settings_get,
            commands::settings::settings_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
