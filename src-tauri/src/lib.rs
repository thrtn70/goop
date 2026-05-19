pub mod app_update;
pub mod commands;
pub mod events;
pub mod state;
pub mod thumbnail;

use events::TauriSink;
use goop_config as cfg;
use goop_converter::{detect_encoders, ConversionBackend, FfmpegBackend, ImageMagickBackend};
use goop_core::{
    path as gpath, ConvertRequest, EventSink, GoopError, JobResult, PdfOperation, PidRegistry,
    ResultKind,
};
use goop_extractor::ytdlp::ExtractRequest;
use goop_pdf::{
    compress as pdf_compress, delete_pages as pdf_delete_pages, extract_pages as pdf_extract_pages,
    insert_blank as pdf_insert_blank, merge as pdf_merge, metadata as pdf_metadata,
    reorder as pdf_reorder, rotate as pdf_rotate, split as pdf_split,
};
use goop_queue::{QueueStore, Scheduler, SchedulerPidRegistry, WorkerFn};
use goop_sidecar::BinaryResolver;
use state::AppState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;
use thumbnail::ThumbnailService;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("goop=info,warn")
        .init();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
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

            // Ghostscript ships its Resource/lib/iccprofiles tree via
            // `bundle.resources` in tauri.conf.json. Resolve the runtime
            // path so the gs invocations can export GS_LIB. `None` in dev
            // builds falls back to gs's compile-time defaults.
            let gs_resource_dir: Option<PathBuf> = app
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join("gs-resources"))
                .filter(|p| p.exists());

            // Tesseract language packs split across two directories:
            //   - tessdata_user_dir: writable, holds user-downloaded packs
            //   - tessdata_bundled_dir: read-only, ships eng.traineddata
            // Phase 6 OCR passes both (in user-first order) to tesseract
            // via --tessdata-dir; the user dir takes precedence so an
            // updated download overrides the bundled file with the same
            // language code.
            let tessdata_user_dir = gpath::data_dir().join("tesseract-data");
            let tessdata_bundled_dir: Option<PathBuf> = app
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join("tesseract-data"))
                .filter(|p| p.exists());
            let settings_path = gpath::config_file();
            let settings = cfg::load(&settings_path).unwrap_or_default();
            let store = QueueStore::open(&gpath::data_dir().join("queue.db"))
                .map_err(|e| -> Box<dyn std::error::Error> { format!("queue open: {e}").into() })?;
            let _interrupted = store.reconcile().ok();
            // Phase G: silently re-queue any jobs left in `paused` state from
            // a previous run. The child process is gone so we restart from
            // scratch; the user already knows the app restarted.
            match store.recover_paused() {
                Ok(0) => {}
                Ok(n) => tracing::info!(count = n, "re-queued paused jobs after restart"),
                Err(e) => tracing::error!(error = %e, "failed to recover paused jobs on boot"),
            }
            let app_handle = app.handle().clone();
            let sink: Arc<dyn EventSink> = Arc::new(TauriSink(app_handle.clone()));

            // Phase G: shared PID registry for pause/resume support. The
            // ffmpeg and Ghostscript workers register their child PIDs into
            // this; the scheduler looks them up to send SIGSTOP/SIGCONT.
            let pid_registry: Arc<dyn PidRegistry> = Arc::new(SchedulerPidRegistry::new());

            let r_for_extract = resolver.clone();
            let sink_for_extract = sink.clone();
            let extract_worker: WorkerFn = Arc::new(move |id, payload, cancel| {
                let r = r_for_extract.clone();
                let s = sink_for_extract.clone();
                Box::pin(async move {
                    let req: ExtractRequest = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad payload: {e}")))?;
                    // Route via the dispatcher: it picks yt-dlp or
                    // gallery-dl based on the URL's classifier output
                    // and falls back to the OTHER extractor on a
                    // no-matching-extractor error.
                    let outcome = goop_extractor::dispatch(&r, s, id, &req, cancel).await?;
                    Ok(JobResult {
                        output_path: Some(outcome.output_path),
                        bytes: Some(outcome.bytes),
                        duration_ms: outcome.duration_ms,
                        result_kind: match outcome.result_kind {
                            goop_extractor::ResultKindTag::File => ResultKind::File,
                            goop_extractor::ResultKindTag::Folder => ResultKind::Folder,
                        },
                        file_count: outcome.file_count,
                    })
                })
            });
            // Detect HW encoders once at startup. Result is shared with the
            // convert worker (read on every job) and AppState (so the
            // Settings UI can show what's available).
            let encoders = Arc::new(tauri::async_runtime::block_on(detect_encoders(&resolver)));
            let hw_enabled = Arc::new(AtomicBool::new(settings.hw_acceleration_enabled));

            let r_for_convert = resolver.clone();
            let sink_for_convert = sink.clone();
            let encoders_for_convert = encoders.clone();
            let hw_enabled_for_convert = hw_enabled.clone();
            let pids_for_convert = pid_registry.clone();
            let convert_worker: WorkerFn = Arc::new(move |id, payload, cancel| {
                let r = r_for_convert.clone();
                let s = sink_for_convert.clone();
                let enc = encoders_for_convert.clone();
                let hw = hw_enabled_for_convert.load(Ordering::Relaxed);
                let pids = pids_for_convert.clone();
                Box::pin(async move {
                    let req: ConvertRequest = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad payload: {e}")))?;
                    let res = if req.target.is_image() {
                        // ImageMagick runs in-process — no child PID, no
                        // pause/resume support (out of scope for Phase G).
                        let im = ImageMagickBackend::new(&r, s);
                        im.convert(id, &req, cancel).await?
                    } else {
                        let ffmpeg = FfmpegBackend::new(&r, s)
                            .with_encoders(enc, hw)
                            .with_pid_registry(pids);
                        ffmpeg.convert(id, &req, cancel).await?
                    };
                    Ok(JobResult {
                        output_path: Some(res.output_path),
                        bytes: Some(res.bytes),
                        duration_ms: res.duration_ms,
                        result_kind: ResultKind::File,
                        file_count: 1,
                    })
                })
            });

            // Real PDF worker: deserialize the op, run merge/split on a
            // blocking thread (lopdf is sync), or dispatch compress to the
            // async Ghostscript helper. `JobResult.output_path` for Split
            // points at the output directory since there are N files rather
            // than one — the UI formats the directory reveal-in-OS that way.
            let r_for_pdf = resolver.clone();
            let gs_dir_for_pdf = gs_resource_dir.clone();
            let pids_for_pdf = pid_registry.clone();
            let pdf_worker: WorkerFn = Arc::new(move |id, payload, cancel| {
                let r = r_for_pdf.clone();
                let gs_dir = gs_dir_for_pdf.clone();
                let pids = pids_for_pdf.clone();
                Box::pin(async move {
                    let op: PdfOperation = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad pdf payload: {e}")))?;
                    let started = std::time::Instant::now();
                    let (output_path, bytes, result_kind, file_count) = match op {
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
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
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
                            // Report the output directory — Folder result_kind
                            // tells the UI to render "Open folder" instead of
                            // "Reveal" and to show the file count.
                            (
                                Some(dir.to_string_lossy().into_owned()),
                                Some(bytes),
                                ResultKind::Folder,
                                outputs.len() as u32,
                            )
                        }
                        PdfOperation::Compress {
                            input,
                            output_path,
                            quality,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            pdf_compress::compress(
                                &r,
                                gs_dir.as_deref(),
                                &in_path,
                                &out,
                                quality,
                                cancel,
                                Some(pids),
                                Some(id),
                            )
                            .await
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        PdfOperation::ExtractPages {
                            input,
                            ranges,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                pdf_extract_pages::extract_pages(&in_path, &ranges, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        PdfOperation::DeletePages {
                            input,
                            pages,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                pdf_delete_pages::delete_pages(&in_path, &pages, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        PdfOperation::InsertBlank {
                            input,
                            positions,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                pdf_insert_blank::insert_blank(&in_path, &positions, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        PdfOperation::SetMetadata {
                            input,
                            metadata,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                pdf_metadata::set_metadata(&in_path, &metadata, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        PdfOperation::Rotate {
                            input,
                            rotations,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                pdf_rotate::rotate(&in_path, &rotations, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        PdfOperation::Reorder {
                            input,
                            order,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                pdf_reorder::reorder(&in_path, &order, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
                        }
                        // Phase 1 stubs — replaced by real impls in Phases 3-7.
                        // Error messages use the snake_case wire discriminator so log
                        // scrapers can match against the same string they see on the IPC.
                        PdfOperation::ExtractText { .. } => {
                            return Err(GoopError::Queue(
                                "extract_text not yet implemented".into(),
                            ));
                        }
                        PdfOperation::ExtractImages { .. } => {
                            return Err(GoopError::Queue(
                                "extract_images not yet implemented".into(),
                            ));
                        }
                        PdfOperation::ImagesToPdf { .. } => {
                            return Err(GoopError::Queue(
                                "images_to_pdf not yet implemented".into(),
                            ));
                        }
                        PdfOperation::PdfOcr { .. } => {
                            return Err(GoopError::Queue("pdf_ocr not yet implemented".into()));
                        }
                        PdfOperation::ImageOcr { .. } => {
                            return Err(GoopError::Queue("image_ocr not yet implemented".into()));
                        }
                    };
                    Ok(JobResult {
                        output_path,
                        bytes,
                        duration_ms: started.elapsed().as_millis() as u64,
                        result_kind,
                        file_count,
                    })
                })
            });

            let scheduler = Scheduler::with_pids(
                store.clone(),
                sink,
                settings.extract_concurrency,
                settings.convert_concurrency,
                1,
                extract_worker,
                convert_worker,
                pdf_worker,
                pid_registry,
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

            let thumbs = ThumbnailService::new(gpath::data_dir(), gs_resource_dir.clone());
            app.manage(AppState {
                resolver,
                store,
                scheduler,
                settings: parking_lot::RwLock::new(settings),
                settings_path,
                thumbs,
                encoders,
                hw_enabled,
                tessdata_user_dir,
                tessdata_bundled_dir,
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
            commands::queue::queue_cancel_many,
            commands::queue::queue_pause,
            commands::queue::queue_resume,
            commands::queue::queue_reorder,
            commands::queue::queue_move_to_top,
            commands::queue::queue_clear_completed,
            commands::queue::queue_completed_since,
            commands::queue::queue_reveal,
            commands::sidecar::sidecar_status,
            commands::sidecar::sidecar_update_yt_dlp,
            commands::sidecar::sidecar_update_gallery_dl,
            commands::sidecar::sidecar_yt_dlp_version,
            commands::sidecar::sidecar_gallery_dl_version,
            commands::sidecar::sidecar_ffmpeg_version,
            commands::sidecar::sidecar_ghostscript_version,
            commands::sidecar::sidecar_mutool_version,
            commands::sidecar::sidecar_tesseract_version,
            commands::sidecar::sidecar_tessdata_installed,
            commands::sidecar::sidecar_tessdata_available,
            commands::sidecar::sidecar_tessdata_download,
            commands::sidecar::sidecar_tessdata_remove,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::preset::preset_list,
            commands::preset::preset_save,
            commands::preset::preset_delete,
            commands::update::check_for_update,
            commands::update::download_update,
            commands::update::open_releases_page,
            commands::update::open_about_link,
            commands::pdf::pdf_probe,
            commands::pdf::pdf_run,
            commands::pdf::pdf_page_thumbs,
            commands::history::history_list,
            commands::history::history_counts,
            commands::thumbnail::thumbnail_get,
            commands::file::file_move_to_trash,
            commands::file::job_forget,
            commands::file::job_forget_many,
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("error while running tauri application: {error}");
    }
}
