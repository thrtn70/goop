use crate::state::AppState;
use goop_core::{
    both_failed, warrants_other_extractor, BothFailed, GoopError, IpcError, Job, JobId, JobKind,
};
use goop_extractor::classify::{classify_extractor, ExtractorChoice};
use goop_extractor::debrid;
use goop_extractor::gallery_dl::GalleryDl;
use goop_extractor::ytdlp::{DebridProbeInfo, DirectFileInfo, ExtractRequest, UrlProbe, YtDlp};
use goop_sidecar::BinaryResolver;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub async fn extract_probe(url: String, state: State<'_, AppState>) -> Result<UrlProbe, IpcError> {
    // Magnet links can't be probed by either extractor and only a debrid
    // service can turn them into HTTP — route straight to the TorBox card.
    if debrid::is_magnet(&url) {
        if state.settings.read().torbox_api_key.is_none() {
            return Err(IpcError::Queue(
                "Magnet links download through TorBox — add your TorBox API key in Settings".into(),
            ));
        }
        return Ok(debrid_url_probe(url, true));
    }
    let cookies = state.settings.read().cookies_from_browser.clone();
    let primary = classify_extractor(&url);
    let err = match probe_with(primary, &state.resolver, &url, cookies.as_deref()).await {
        Ok(probe) => return Ok(probe),
        Err(err) => err,
    };
    // Fall back to the OTHER extractor when the primary either didn't
    // recognise the URL (misclassified, or it straddles both) or was
    // blocked by the site — a 403 describes the request, not the content,
    // so the other extractor may well be let through.
    if !warrants_other_extractor(&err) {
        return Err(err.into());
    }
    let err2 = match probe_with(primary.other(), &state.resolver, &url, cookies.as_deref()).await {
        Ok(probe) => return Ok(probe),
        Err(err2) => err2,
    };
    // Same rule as the download path in `goop_extractor::backend`, so the
    // probe can't promise a direct download the worker won't attempt.
    match both_failed(err, err2) {
        BothFailed::TryDirect => {
            // Neither extractor recognised the URL. If TorBox supports this
            // host, its debrid card beats a "direct download" of what is
            // usually an HTML landing page.
            if let Some(matcher) = state.torbox_hosters().await {
                if matcher.matches(&url) {
                    return Ok(debrid_url_probe(url, false));
                }
            }
            // Otherwise try a plain HTTP probe so the UI can still offer a
            // direct download.
            // Deliberately NOT wrapped in `with_probe_retry`. This leg does a
            // HEAD and then a fallback GET, each bounded by `PROBE_TIMEOUT`
            // (30s), so a black-holed host already costs a minute — and the
            // IPC call cannot be cancelled from the UI, so a second attempt
            // would leave the user staring at a spinner for two. The
            // extractor probes above return in seconds, which is what makes
            // a retry cheap there.
            let info = goop_extractor::direct::probe(&url).await?;
            Ok(direct_url_probe(url, info))
        }
        BothFailed::Surface(e) => Err(e.into()),
    }
}

/// Build a `UrlProbe` for a debrid-routed link. Magnet display names ride
/// in the `dn=` query param; hoster links fall back to the URL itself.
fn debrid_url_probe(url: String, magnet: bool) -> UrlProbe {
    let title = debrid::magnet_display_name(&url).unwrap_or_else(|| {
        if magnet {
            "Magnet link".to_string()
        } else {
            url.clone()
        }
    });
    UrlProbe {
        url,
        title,
        uploader: None,
        duration_secs: None,
        thumbnail_url: None,
        formats: Vec::new(),
        direct: None,
        debrid: Some(DebridProbeInfo { magnet }),
        extractor: None,
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
        debrid: None,
        extractor: None,
    }
}

/// Takes the resolver rather than the whole `AppState`: it is the only field
/// this needs, and the narrower signature is what lets the retry wiring below
/// be tested against fake sidecars instead of only reasoned about.
async fn probe_with(
    backend: ExtractorChoice,
    resolver: &BinaryResolver,
    url: &str,
    cookies: Option<&str>,
) -> Result<UrlProbe, GoopError> {
    // One quiet retry on a transient failure. A probe is the first thing a
    // URL does, so a single dropped connection currently shows a red card
    // for a link that is perfectly fine — and the only recourse is the Try
    // again button, which does exactly this. Permanent verdicts are not
    // retried, so the worst case is ~1.5s before the same error appears.
    goop_extractor::retry::with_probe_retry(goop_extractor::retry::PROBE_RETRY_DELAY, || async {
        match backend {
            ExtractorChoice::YtDlp => YtDlp::probe(resolver, url, cookies).await,
            ExtractorChoice::GalleryDl => GalleryDl::probe(resolver, url, cookies).await,
        }
    })
    .await
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
    // Internal fields the debrid resolver owns — never trust them from
    // the UI (a tampered payload could smuggle a path via filename_hint).
    req.debrid_item = None;
    req.resume_key = None;
    req.filename_hint = None;
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

/// The retry wiring itself, not just the helper it calls.
///
/// `probe_with` takes a `BinaryResolver` rather than the whole `AppState`
/// precisely so this can exist: the helper being correct and the call site
/// actually using it are two different claims, and only the second one is
/// what a user experiences.
///
/// Unix-only: the fakes are `/bin/sh` scripts.
#[cfg(all(test, unix))]
mod probe_retry_tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// Argv `wait_until_executable` hands a fake to prove it can be run.
    /// `probe_with` passes a URL and yt-dlp flags, so nothing a real run
    /// sends can collide with it.
    const EXEC_PROBE_ARG: &str = "--goop-exec-probe";

    fn write_fake(dir: &std::path::Path, name: &str, body: &str) {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        // The guard answers the probe below and exits before reaching the
        // body, so probing costs nothing but a `/bin/sh` startup.
        write!(
            f,
            "#!/bin/sh\ncase \"$1\" in {EXEC_PROBE_ARG}) exit 0;; esac\n{body}"
        )
        .unwrap();
        drop(f);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        wait_until_executable(&path);
    }

    /// Blocks until `path` can actually be `exec`d, which is not the same
    /// moment as "we finished writing it". Linux refuses to `execve` a
    /// file while any process holds it open for writing (`ETXTBSY`).
    ///
    /// The two tests below both write a fake and then fork one, in
    /// parallel, inside this one test binary — so one test's `File::create`
    /// window can be straddled by the other's spawn, whose child inherits
    /// a copy of the write descriptor and holds it until its own `execve`.
    /// Separate temp dirs do not help: the kernel counts writers per
    /// inode, and the inherited descriptor is a writer on ours.
    ///
    /// This duplicates `goop_extractor::test_fakes`, which carries the
    /// full rationale and the regression test that proves the wait does
    /// anything. A `#[cfg(test)]` module is not importable across crates,
    /// so sharing it would mean exposing it there as a `pub` module behind
    /// a cargo feature this crate asks for in `[dev-dependencies]` — which
    /// would not reach the shipped binary, but would put a public,
    /// feature-gated API on `goop-extractor` for the sake of the two tests
    /// below. It is copied instead. Keep the two in step by hand.
    fn wait_until_executable(path: &std::path::Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut backoff = std::time::Duration::from_millis(1);
        loop {
            let busy = match std::process::Command::new(path)
                .arg(EXEC_PROBE_ARG)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
            {
                Ok(_) => return,
                Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => e,
                Err(e) => panic!("fake {} could not be run at all: {e:?}", path.display()),
            };
            assert!(
                std::time::Instant::now() < deadline,
                "fake {} was still held open for writing after 10s: {busy:?}",
                path.display()
            );
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(std::time::Duration::from_millis(25));
        }
    }

    fn runs(counter: &std::path::Path) -> usize {
        std::fs::read_to_string(counter)
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    /// A dropped connection on the first attempt must not reach the user.
    #[tokio::test]
    async fn probe_with_retries_a_transient_failure() {
        let bins = tempfile::tempdir().unwrap();
        let counter = bins.path().join("runs");
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "echo run >> '{c}'\n\
                 if [ $(wc -l < '{c}') -eq 1 ]; then\n\
                   echo 'ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable' >&2\n\
                   exit 1\n\
                 fi\n\
                 echo '{{\"title\":\"clip\",\"formats\":[]}}'\n\
                 exit 0\n",
                c = counter.display()
            ),
        );
        let resolver = BinaryResolver::new(bins.path().to_path_buf());

        let probe = probe_with(
            ExtractorChoice::YtDlp,
            &resolver,
            "https://example.com/x",
            None,
        )
        .await
        .expect("the second attempt succeeds");

        assert_eq!(probe.title, "clip");
        assert_eq!(runs(&counter), 2, "the call site must be using the retry");
    }

    /// And a permanent verdict must still surface on the first attempt, or
    /// every dead link costs an extra spawn and a wait to say the same thing.
    #[tokio::test]
    async fn probe_with_does_not_retry_a_permanent_failure() {
        let bins = tempfile::tempdir().unwrap();
        let counter = bins.path().join("runs");
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "echo run >> '{c}'\n\
                 echo 'ERROR: [youtube] abc: Private video' >&2\n\
                 exit 1\n",
                c = counter.display()
            ),
        );
        let resolver = BinaryResolver::new(bins.path().to_path_buf());

        let res = probe_with(
            ExtractorChoice::YtDlp,
            &resolver,
            "https://example.com/x",
            None,
        )
        .await;

        assert!(res.is_err());
        assert_eq!(runs(&counter), 1);
    }
}
