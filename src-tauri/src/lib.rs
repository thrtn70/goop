pub mod app_update;
pub mod commands;
pub mod events;
pub mod state;
pub mod thumbnail;

use events::TauriSink;
use goop_config as cfg;
use goop_converter::{ConversionBackend, FfmpegBackend, ImageMagickBackend};
use goop_core::{path as gpath, ConvertRequest, EventSink, GoopError, JobResult, PdfOperation};
use goop_extractor::ytdlp::{ExtractRequest, YtDlp};
use goop_pdf::{compress as pdf_compress, merge as pdf_merge, split as pdf_split};
use goop_queue::{QueueStore, Scheduler, WorkerFn};
use goop_sidecar::BinaryResolver;
use state::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use thumbnail::ThumbnailService;

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
            // Tauri's externalBin bundler ships sidecars in the same directory as
            // the app's main executable (Contents/MacOS on macOS; next to the .exe
            // on Windows). Resolve that dir via current_exe so both bundled and
            // dev-mode (PATH fallback) scenarios work without hard-coding OS logic.
            let sidecar_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
                .unwrap_or_else(|| std::path::PathBuf::from("."));
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
            let r_for_convert = resolver.clone();
            let sink_for_convert = sink.clone();
            let convert_worker: WorkerFn = Arc::new(move |id, payload, cancel| {
                let r = r_for_convert.clone();
                let s = sink_for_convert.clone();
                Box::pin(async move {
                    let req: ConvertRequest = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad payload: {e}")))?;
                    let res = if req.target.is_image() {
                        let im = ImageMagickBackend::new(&r, s);
                        im.convert(id, &req, cancel).await?
                    } else {
                        let ffmpeg = FfmpegBackend::new(&r, s);
                        ffmpeg.convert(id, &req, cancel).await?
                    };
                    Ok(JobResult {
                        output_path: Some(res.output_path),
                        bytes: Some(res.bytes),
                        duration_ms: res.duration_ms,
                    })
                })
            });

            // Real PDF worker: deserialize the op, run merge/split on a
            // blocking thread (lopdf is sync), or dispatch compress to the
            // async Ghostscript helper. `JobResult.output_path` for Split
            // points at the output directory since there are N files rather
            // than one — the UI formats the directory reveal-in-OS that way.
            let r_for_pdf = resolver.clone();
            let pdf_worker: WorkerFn = Arc::new(move |_id, payload, cancel| {
                let r = r_for_pdf.clone();
                Box::pin(async move {
                    let op: PdfOperation = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad pdf payload: {e}")))?;
                    let started = std::time::Instant::now();
                    let (output_path, bytes) = match op {
                        PdfOperation::Merge {
                            inputs,
                            output_path,
                        } => {
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                let input_paths: Vec<PathBuf> =
                                    inputs.into_iter().map(PathBuf::from).collect();
                                let input_refs: Vec<&std::path::Path> =
                                    input_paths.iter().map(|p| p.as_path()).collect();
                                pdf_merge::merge(&input_refs, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (Some(out.to_string_lossy().into_owned()), bytes)
                        }
                        PdfOperation::Split {
                            input,
                            ranges,
                            output_dir,
                        } => {
                            let in_path = PathBuf::from(input);
                            let dir = PathBuf::from(output_dir);
                            let dir_for_task = dir.clone();
                            let outputs = tokio::task::spawn_blocking(move || {
                                pdf_split::split(&in_path, &ranges, &dir_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes: u64 = outputs
                                .iter()
                                .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                                .sum();
                            // Report the output directory — the UI reveals
                            // the folder so users see every file produced.
                            (Some(dir.to_string_lossy().into_owned()), Some(bytes))
                        }
                        PdfOperation::Compress {
                            input,
                            output_path,
                            quality,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            pdf_compress::compress(&r, &in_path, &out, quality, cancel)
                                .await
                                .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (Some(out.to_string_lossy().into_owned()), bytes)
                        }
                    };
                    Ok(JobResult {
                        output_path,
                        bytes,
                        duration_ms: started.elapsed().as_millis() as u64,
                    })
                })
            });

            let scheduler = Scheduler::new(
                store.clone(),
                sink,
                settings.extract_concurrency,
                settings.convert_concurrency,
                1,
                extract_worker,
                convert_worker,
                pdf_worker,
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
            let s_pdf = scheduler.clone();
            tauri::async_runtime::spawn(
                async move { s_pdf.run_kind(goop_core::JobKind::Pdf).await },
            );

            let thumbs = ThumbnailService::new(gpath::data_dir());
            app.manage(AppState {
                resolver,
                store,
                scheduler,
                settings: parking_lot::RwLock::new(settings),
                settings_path,
                thumbs,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::convert::convert_probe,
            commands::convert::convert_from_file,
            commands::extract::extract_probe,
            commands::extract::extract_from_url,
            commands::queue::queue_list,
            commands::queue::queue_cancel,
            commands::queue::queue_clear_completed,
            commands::queue::queue_reveal,
            commands::sidecar::sidecar_status,
            commands::sidecar::sidecar_update_yt_dlp,
            commands::sidecar::sidecar_yt_dlp_version,
            commands::sidecar::sidecar_ffmpeg_version,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::preset::preset_list,
            commands::preset::preset_save,
            commands::preset::preset_delete,
            commands::update::check_for_update,
            commands::update::download_update,
            commands::update::open_releases_page,
            commands::pdf::pdf_probe,
            commands::pdf::pdf_run,
            commands::history::history_list,
            commands::history::history_counts,
            commands::thumbnail::thumbnail_get,
            commands::file::file_move_to_trash,
            commands::file::job_forget,
            commands::file::job_forget_many,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
