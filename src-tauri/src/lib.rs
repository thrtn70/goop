pub mod app_update;
pub mod commands;
pub mod events;
pub mod state;
pub mod thumbnail;

use events::TauriSink;
use goop_config as cfg;
use goop_converter::{
    detect_encoders, image_app_icon as image_app_icon_mod, image_crop as image_crop_mod,
    image_recompress as image_recompress_mod, image_resize as image_resize_mod,
    image_rotate as image_rotate_mod, image_watermark as image_watermark_mod, ConversionBackend,
    FfmpegBackend, ImageMagickBackend,
};
use goop_core::{
    path as gpath, ConvertRequest, EventSink, GoopError, ImageOperation, JobResult,
    MetadataOperation, PdfOperation, PidRegistry, ProgressEvent, ResultKind,
};
use goop_extractor::ytdlp::ExtractRequest;
use goop_pdf::{
    compress as pdf_compress, delete_pages as pdf_delete_pages,
    extract_images as pdf_extract_images, extract_pages as pdf_extract_pages,
    extract_text as pdf_extract_text, images_to_pdf as pdf_images_to_pdf,
    insert_blank as pdf_insert_blank, merge as pdf_merge, metadata as pdf_metadata,
    ocr as pdf_ocr_mod, ocr_image as pdf_ocr_image, recognize as pdf_recognize,
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
            // Updated sidecars (currently just gallery-dl, via its Codeberg
            // self-updater) land in a writable app-data dir that the resolver
            // prefers over the read-only bundled copy inside the signed app.
            let resolver = Arc::new(
                BinaryResolver::new(sidecar_dir).with_update_dir(gpath::data_dir().join("bin")),
            );

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
            // Re-queue jobs left in `paused` state from a previous run —
            // except downloads. A paused download's partial files survive on
            // disk, so its Paused row survives the restart too and resumes
            // where it left off when the user asks. Every other kind was a
            // suspended child process that died with the app, so those
            // restart from scratch.
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

            // Shared live settings handle: the extract worker reads the
            // TorBox key per dispatch (so a key added in Settings applies
            // to already-queued jobs) and AppState exposes the same lock
            // to the IPC layer.
            let settings_shared = Arc::new(parking_lot::RwLock::new(settings.clone()));

            let r_for_extract = resolver.clone();
            let sink_for_extract = sink.clone();
            let settings_for_extract = settings_shared.clone();
            let store_for_extract = store.clone();
            let extract_worker: WorkerFn = Arc::new(move |id, payload, signals| {
                let r = r_for_extract.clone();
                let s = sink_for_extract.clone();
                let settings = settings_for_extract.clone();
                let store = store_for_extract.clone();
                Box::pin(async move {
                    let req: ExtractRequest = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad payload: {e}")))?;
                    // Debrid context rides along only when a key is set.
                    // The persist callback writes the TorBox item handle
                    // back into the stored payload so waiting-poll cycles
                    // and app restarts don't re-submit the link.
                    let debrid = settings.read().torbox_api_key.clone().map(|api_key| {
                        let req_for_persist = req.clone();
                        goop_extractor::debrid::DebridCtx {
                            api_base: goop_extractor::debrid::TORBOX_API_BASE.to_string(),
                            api_key,
                            session_item: goop_extractor::debrid::DebridCtx::session(),
                            persist_item: Arc::new(move |item: &str| {
                                let mut r = req_for_persist.clone();
                                r.debrid_item = Some(item.to_string());
                                match serde_json::to_value(&r) {
                                    Ok(v) => {
                                        if let Err(e) = store.update_payload(id, &v) {
                                            tracing::warn!(?id, error = %e, "failed to persist debrid item handle");
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!(?id, error = %e, "failed to serialize debrid payload")
                                    }
                                }
                            }),
                        }
                    });
                    // Route via the dispatcher: it picks yt-dlp or
                    // gallery-dl based on the URL's classifier output and
                    // falls back to the OTHER extractor on a
                    // no-matching-extractor error, retrying transient
                    // network failures with backoff. Downloads honor both
                    // signals: cancel deletes partials, pause keeps them
                    // for resume.
                    let outcome = goop_extractor::dispatch(&r, s, id, &req, signals, debrid).await?;
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
            let convert_worker: WorkerFn = Arc::new(move |id, payload, signals| {
                let r = r_for_convert.clone();
                let s = sink_for_convert.clone();
                let enc = encoders_for_convert.clone();
                let hw = hw_enabled_for_convert.load(Ordering::Relaxed);
                let pids = pids_for_convert.clone();
                Box::pin(async move {
                    // Conversions pause via the PID registry (SIGSTOP on the
                    // ffmpeg child), so only the cancel token threads down.
                    let cancel = signals.cancel;
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
            let tessdata_user_for_pdf = tessdata_user_dir.clone();
            let tessdata_bundled_for_pdf = tessdata_bundled_dir.clone();
            let pdf_worker: WorkerFn = Arc::new(move |id, payload, signals| {
                let r = r_for_pdf.clone();
                let gs_dir = gs_dir_for_pdf.clone();
                let pids = pids_for_pdf.clone();
                let tessdata_user = tessdata_user_for_pdf.clone();
                let tessdata_bundled = tessdata_bundled_for_pdf.clone();
                Box::pin(async move {
                    // External-tool PDF ops pause via the PID registry, so
                    // only the cancel token threads down.
                    let cancel = signals.cancel;
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
                        // Remaining v0.2.4 stubs — replaced in Phases 4-7.
                        // Error messages use the snake_case wire discriminator so log
                        // scrapers can match against the same string they see on the IPC.
                        PdfOperation::ExtractText { input, output_path } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            pdf_extract_text::extract_text(
                                &r,
                                &in_path,
                                &out,
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
                        PdfOperation::ExtractImages {
                            input,
                            output_dir,
                            format,
                            dpi,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out_dir = PathBuf::from(output_dir);
                            let outs = pdf_extract_images::extract_images(
                                &r,
                                &in_path,
                                &out_dir,
                                format,
                                dpi,
                                cancel,
                                Some(pids),
                                Some(id),
                            )
                            .await
                            .map_err(GoopError::from)?;
                            let total_bytes: u64 = outs
                                .iter()
                                .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                                .sum();
                            (
                                Some(out_dir.to_string_lossy().into_owned()),
                                Some(total_bytes),
                                ResultKind::Folder,
                                outs.len() as u32,
                            )
                        }
                        PdfOperation::ImagesToPdf {
                            inputs,
                            output_path,
                        } => {
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                let in_paths: Vec<PathBuf> =
                                    inputs.into_iter().map(PathBuf::from).collect();
                                let refs: Vec<&std::path::Path> =
                                    in_paths.iter().map(|p| p.as_path()).collect();
                                pdf_images_to_pdf::images_to_pdf(&refs, &out_for_task)
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
                        PdfOperation::PdfOcr {
                            input,
                            output_path,
                            lang,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let mut dirs: Vec<&std::path::Path> = vec![tessdata_user.as_path()];
                            if let Some(b) = tessdata_bundled.as_ref() {
                                dirs.push(b.as_path());
                            }
                            pdf_ocr_mod::ocr(
                                &r,
                                &dirs,
                                &in_path,
                                &out,
                                &lang,
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
                        PdfOperation::ImageOcr {
                            inputs,
                            output_path,
                            output_kind,
                            lang,
                        } => {
                            let out = PathBuf::from(output_path);
                            let in_paths: Vec<PathBuf> =
                                inputs.into_iter().map(PathBuf::from).collect();
                            let in_refs: Vec<&std::path::Path> =
                                in_paths.iter().map(|p| p.as_path()).collect();
                            let mut dirs: Vec<&std::path::Path> = vec![tessdata_user.as_path()];
                            if let Some(b) = tessdata_bundled.as_ref() {
                                dirs.push(b.as_path());
                            }
                            pdf_ocr_image::ocr_image(
                                &r,
                                &dirs,
                                &in_refs,
                                &out,
                                output_kind,
                                &lang,
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
                        PdfOperation::RecognizeText {
                            input,
                            output_path,
                            output_kind,
                            lang,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let mut dirs: Vec<&std::path::Path> = vec![tessdata_user.as_path()];
                            if let Some(b) = tessdata_bundled.as_ref() {
                                dirs.push(b.as_path());
                            }
                            let (_out, method) = pdf_recognize::recognize_text(
                                &r,
                                &dirs,
                                &in_path,
                                &out,
                                output_kind,
                                &lang,
                                cancel,
                                Some(pids),
                                Some(id),
                            )
                            .await
                            .map_err(GoopError::from)?;
                            tracing::info!(?method, "recognize_text routed input");
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (
                                Some(out.to_string_lossy().into_owned()),
                                bytes,
                                ResultKind::File,
                                1u32,
                            )
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

            // Phase 4 (v0.2.5) image worker. Rotate + Resize land here.
            // Crop / Watermark / Recompress / AppIcon variants still return a
            // clear "not yet implemented" error so the queue surface signals
            // progress instead of silently succeeding or panicking — they're
            // wired up in Phases 5–7.
            let image_worker: WorkerFn = Arc::new(move |_id, payload, _signals| {
                Box::pin(async move {
                    let op: ImageOperation = serde_json::from_value(payload)
                        .map_err(|e| GoopError::Queue(format!("bad image payload: {e}")))?;
                    let started = std::time::Instant::now();
                    let (output_path, bytes) = match op {
                        ImageOperation::Rotate {
                            input,
                            degrees,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                image_rotate_mod::rotate(&in_path, degrees, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))??;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (Some(out.to_string_lossy().into_owned()), bytes)
                        }
                        ImageOperation::Resize {
                            input,
                            width,
                            height,
                            mode,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                image_resize_mod::resize(
                                    &in_path,
                                    width,
                                    height,
                                    mode,
                                    &out_for_task,
                                )
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))??;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (Some(out.to_string_lossy().into_owned()), bytes)
                        }
                        ImageOperation::Crop {
                            input,
                            rect,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                image_crop_mod::crop(&in_path, rect, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))??;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (Some(out.to_string_lossy().into_owned()), bytes)
                        }
                        ImageOperation::Watermark {
                            input,
                            spec,
                            output_path,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out = PathBuf::from(output_path);
                            let out_for_task = out.clone();
                            tokio::task::spawn_blocking(move || {
                                image_watermark_mod::watermark(&in_path, &spec, &out_for_task)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))??;
                            let bytes = std::fs::metadata(&out).map(|m| m.len()).ok();
                            (Some(out.to_string_lossy().into_owned()), bytes)
                        }
                        ImageOperation::Recompress {
                            inputs,
                            output_dir,
                            quality,
                        } => {
                            let out_dir = PathBuf::from(output_dir);
                            let out_for_task = out_dir.clone();
                            let outputs = tokio::task::spawn_blocking(move || {
                                let in_paths: Vec<PathBuf> =
                                    inputs.into_iter().map(PathBuf::from).collect();
                                let refs: Vec<&std::path::Path> =
                                    in_paths.iter().map(|p| p.as_path()).collect();
                                image_recompress_mod::recompress(&refs, &out_for_task, quality)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))??;
                            let total_bytes: u64 = outputs
                                .iter()
                                .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                                .sum();
                            // Recompress is the first image op to produce
                            // a folder result. Same shape as the PDF
                            // ExtractImages branch above.
                            return Ok(JobResult {
                                output_path: Some(out_dir.to_string_lossy().into_owned()),
                                bytes: Some(total_bytes),
                                duration_ms: started.elapsed().as_millis() as u64,
                                result_kind: ResultKind::Folder,
                                file_count: outputs.len() as u32,
                            });
                        }
                        ImageOperation::AppIcon {
                            input,
                            output_dir,
                            platforms,
                        } => {
                            let in_path = PathBuf::from(input);
                            let out_dir = PathBuf::from(output_dir);
                            let out_for_task = out_dir.clone();
                            let outputs = tokio::task::spawn_blocking(move || {
                                image_app_icon_mod::app_icon(&in_path, &out_for_task, &platforms)
                            })
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))??;
                            let total_bytes: u64 = outputs
                                .iter()
                                .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                                .sum();
                            return Ok(JobResult {
                                output_path: Some(out_dir.to_string_lossy().into_owned()),
                                bytes: Some(total_bytes),
                                duration_ms: started.elapsed().as_millis() as u64,
                                result_kind: ResultKind::Folder,
                                file_count: outputs.len() as u32,
                            });
                        }
                    };
                    Ok(JobResult {
                        output_path,
                        bytes,
                        duration_ms: started.elapsed().as_millis() as u64,
                        result_kind: ResultKind::File,
                        file_count: 1,
                    })
                })
            });

            // Metadata worker (v0.2.9). A batch "Apply" is one job carrying
            // every selected file; we write each in turn (pure-Rust, in-process
            // via goop-metadata) and emit N/total progress so an album-sized
            // batch shows as a single queue row instead of dozens.
            let sink_for_meta = sink.clone();
            let metadata_worker: WorkerFn = Arc::new(move |id, payload, signals| {
                let s = sink_for_meta.clone();
                Box::pin(async move {
                    let MetadataOperation::Write { items, backup } =
                        serde_json::from_value::<MetadataOperation>(payload)
                            .map_err(|e| GoopError::Queue(format!("bad metadata payload: {e}")))?;
                    if items.is_empty() {
                        return Err(GoopError::Queue("metadata write: no files in batch".into()));
                    }
                    let started = std::time::Instant::now();
                    let total = items.len();
                    for (i, item) in items.iter().enumerate() {
                        if signals.cancel.is_cancelled() {
                            return Err(GoopError::Cancelled);
                        }
                        s.emit_progress(ProgressEvent {
                            job_id: id,
                            percent: (i as f32 / total as f32) * 100.0,
                            eta_secs: None,
                            speed_hr: None,
                            stage: format!("Writing tags ({}/{})", i + 1, total),
                            encoder: None,
                        });
                        let it = item.clone();
                        tokio::task::spawn_blocking(move || goop_metadata::write_item(&it, backup))
                            .await
                            .map_err(|e| GoopError::Queue(e.to_string()))?
                            .map_err(GoopError::from)?;
                    }
                    s.emit_progress(ProgressEvent {
                        job_id: id,
                        percent: 100.0,
                        eta_secs: None,
                        speed_hr: None,
                        stage: "Done".into(),
                        encoder: None,
                    });
                    // A single edit reveals the file; a batch reveals the
                    // containing folder with a file-count.
                    let (output_path, result_kind, file_count) = if items.len() == 1 {
                        (Some(items[0].path.clone()), ResultKind::File, 1u32)
                    } else {
                        let folder = items.first().and_then(|it| {
                            std::path::Path::new(&it.path)
                                .parent()
                                .map(|p| p.to_string_lossy().into_owned())
                        });
                        (folder, ResultKind::Folder, items.len() as u32)
                    };
                    Ok(JobResult {
                        output_path,
                        bytes: None,
                        duration_ms: started.elapsed().as_millis() as u64,
                        result_kind,
                        file_count,
                    })
                })
            });

            // Image + Metadata jobs reuse `convert_concurrency` for now: all
            // are CPU/IO-bound, in-process pure-Rust work with similar resource
            // characteristics. A dedicated `image_concurrency` Settings field
            // can land later if user feedback suggests image ops need a
            // distinct budget (e.g. RAW decoding is heavier than typical
            // convert jobs).
            let scheduler = Scheduler::with_pids(
                store.clone(),
                sink,
                settings.extract_concurrency,
                settings.convert_concurrency,
                1,
                settings.convert_concurrency,
                settings.convert_concurrency,
                extract_worker,
                convert_worker,
                pdf_worker,
                image_worker,
                metadata_worker,
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
            let s_image = scheduler.clone();
            tauri::async_runtime::spawn(async move {
                s_image.run_kind(goop_core::JobKind::Image).await
            });
            let s_metadata = scheduler.clone();
            tauri::async_runtime::spawn(async move {
                s_metadata.run_kind(goop_core::JobKind::Metadata).await
            });

            let thumbs = ThumbnailService::new(gpath::data_dir(), gs_resource_dir.clone());
            app.manage(AppState {
                resolver,
                store,
                scheduler,
                settings: settings_shared,
                settings_path,
                thumbs,
                encoders,
                hw_enabled,
                tessdata_user_dir,
                tessdata_bundled_dir,
                torbox_hosters: tokio::sync::OnceCell::new(),
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
            commands::queue::queue_retry,
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
            commands::pdf::recognize_peek_text,
            commands::image::image_run,
            commands::image::image_decoders,
            commands::metadata::metadata_read,
            commands::metadata::metadata_run,
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
