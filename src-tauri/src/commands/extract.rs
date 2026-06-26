use crate::state::AppState;
use goop_core::{is_no_matching_extractor, GoopError, IpcError, Job, JobId, JobKind};
use goop_extractor::classify::{classify_extractor, ExtractorChoice};
use goop_extractor::gallery_dl::GalleryDl;
use goop_extractor::ytdlp::{DirectFileInfo, ExtractRequest, UrlProbe, YtDlp};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn extract_probe(url: String, state: State<'_, AppState>) -> Result<UrlProbe, IpcError> {
    let cookies = state.settings.read().cookies_from_browser.clone();
    let primary = classify_extractor(&url);
    let result = probe_with(primary, &state, &url, cookies.as_deref()).await;
    match result {
        Ok(probe) => Ok(probe),
        Err(err) if is_unsupported(&err) => {
            // Fall back to the OTHER extractor on a no-matching-extractor
            // error so the user gets a probe even when the primary
            // misclassified or the URL straddles both.
            let fallback = match primary {
                ExtractorChoice::YtDlp => ExtractorChoice::GalleryDl,
                ExtractorChoice::GalleryDl => ExtractorChoice::YtDlp,
            };
            match probe_with(fallback, &state, &url, cookies.as_deref()).await {
                Ok(probe) => Ok(probe),
                Err(err2) if is_unsupported(&err2) => {
                    // Neither extractor recognised the URL — try a plain HTTP
                    // probe so the UI can still offer a direct download.
                    let info = goop_extractor::direct::probe(&url).await?;
                    Ok(direct_url_probe(url, info))
                }
                Err(err2) => Err(err2.into()),
            }
        }
        Err(err) => Err(err.into()),
    }
}

/// Build a `UrlProbe` for a plain file the extractors don't handle. The
/// filename stands in for the title; format choices are empty so the UI
/// renders the simplified "Direct download" card.
fn direct_url_probe(url: String, info: DirectFileInfo) -> UrlProbe {
    UrlProbe {
        url,
        title: info.filename.clone(),
        uploader: None,
        duration_secs: None,
        thumbnail_url: None,
        formats: Vec::new(),
        direct: Some(info),
    }
}

async fn probe_with(
    backend: ExtractorChoice,
    state: &AppState,
    url: &str,
    cookies: Option<&str>,
) -> Result<UrlProbe, GoopError> {
    match backend {
        ExtractorChoice::YtDlp => YtDlp::probe(&state.resolver, url, cookies).await,
        ExtractorChoice::GalleryDl => GalleryDl::probe(&state.resolver, url, cookies).await,
    }
}

fn is_unsupported(err: &GoopError) -> bool {
    match err {
        GoopError::SubprocessFailed { stderr, .. } => is_no_matching_extractor(stderr),
        _ => false,
    }
}

#[tauri::command]
pub async fn extract_from_url(
    mut req: ExtractRequest,
    state: State<'_, AppState>,
) -> Result<JobId, IpcError> {
    // Bake current settings into the request so the worker uses what was
    // active when the job was queued. Mirrors the HW-acceleration pattern
    // and keeps in-flight jobs unaffected by later toggles.
    {
        let s = state.settings.read();
        req.cookies_from_browser = s.cookies_from_browser.clone();
        req.output_template = Some(s.extract_naming_scheme.to_yt_dlp_template().to_string());
    }
    req.output_dir = canonical_dir(&req.output_dir)?;
    let payload = serde_json::to_value(&req).map_err(|e| IpcError::Queue(e.to_string()))?;
    let job = Job::new(JobKind::Extract, payload);
    state.store.insert(&job).map_err(IpcError::from)?;
    Ok(job.id)
}

fn canonical_dir(raw: &str) -> Result<String, IpcError> {
    let expanded = goop_core::path::expand(raw);
    let dir = std::fs::canonicalize(&expanded).map_err(|e| {
        IpcError::Config(format!(
            "output folder is not available: {} ({e})",
            expanded.display()
        ))
    })?;
    if !dir.is_dir() {
        return Err(IpcError::Config(format!(
            "output path is not a folder: {}",
            expanded.display()
        )));
    }
    Ok(path_to_string(dir))
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use goop_config::ExtractNamingScheme;

    /// Drift guard: every variant of `ExtractNamingScheme::to_yt_dlp_template`
    /// must produce a string that the extractor's `KNOWN_TEMPLATES` allowlist
    /// will accept. This test runs in the only crate that can see both
    /// constants (goop-config and goop-extractor are sibling crates with no
    /// direct dep on each other). If a new variant is added in goop-config
    /// and KNOWN_TEMPLATES isn't updated, this test fails. We assert against
    /// the same hardcoded list the extractor uses, so a one-sided edit is
    /// caught from either direction.
    const EXPECTED: &[&str] = &[
        "%(title)s.%(ext)s",
        "%(title)s \u{2014} %(extractor)s.%(ext)s",
        "%(upload_date)s \u{2014} %(title)s.%(ext)s",
    ];

    #[test]
    fn naming_scheme_templates_match_extractor_allowlist() {
        let templates: Vec<&'static str> = [
            ExtractNamingScheme::Title,
            ExtractNamingScheme::TitleSite,
            ExtractNamingScheme::DateTitle,
        ]
        .into_iter()
        .map(|s| s.to_yt_dlp_template())
        .collect();
        assert_eq!(
            templates, EXPECTED,
            "ExtractNamingScheme::to_yt_dlp_template drifted from extractor's KNOWN_TEMPLATES"
        );
    }
}
