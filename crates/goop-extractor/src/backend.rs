//! Routing layer that picks between yt-dlp and gallery-dl based on the
//! URL's classifier output, then falls back to the OTHER extractor if
//! the chosen one returns a "no matching extractor" error.
//!
//! `dispatch` is the only thing the IPC layer needs to call. Both
//! backends produce the same `BackendOutcome` shape so the caller can
//! convert to a `JobResult` without caring which extractor ran.

use goop_core::{is_no_matching_extractor, EventSink, GoopError, JobId, JobSignals};
use goop_sidecar::BinaryResolver;
use std::sync::Arc;

use crate::classify::{classify_extractor, ExtractorChoice};
use crate::gallery_dl::GalleryDl;
use crate::retry::{with_retry, RetryPolicy, DEFAULT_RETRY_POLICY};
use crate::ytdlp::{ExtractRequest, YtDlp};

/// Uniform result the IPC layer turns into a `JobResult`. `result_kind`
/// here is the corresponding `goop_core::ResultKind` variant — we keep
/// the dispatch crate decoupled from that enum by stringifying.
#[derive(Debug)]
pub struct BackendOutcome {
    pub output_path: String,
    pub bytes: u64,
    pub duration_ms: u64,
    /// `"file"` for yt-dlp single-file results, `"folder"` for
    /// gallery-dl folder-of-files results.
    pub result_kind: ResultKindTag,
    /// Number of files produced. `1` for `File`; `N` for `Folder`.
    pub file_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultKindTag {
    File,
    Folder,
}

/// Dispatch an extract request: classify the URL, run the chosen
/// extractor, and fall back to the OTHER one on a "no matching
/// extractor" error. Transient network failures are retried with
/// backoff (resuming from partial files); every other failure mode
/// (auth, rate limit on the subprocess paths, unsupported input)
/// propagates on the first attempt.
pub async fn dispatch(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
) -> Result<BackendOutcome, GoopError> {
    dispatch_with_policy(resolver, sink, job_id, req, signals, &DEFAULT_RETRY_POLICY).await
}

/// Test seam: `dispatch` with an injectable retry policy so tests can
/// drive the backoff with millisecond delays against a mock server.
pub(crate) async fn dispatch_with_policy(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    policy: &RetryPolicy,
) -> Result<BackendOutcome, GoopError> {
    with_retry(policy, &signals, &sink, job_id, || {
        dispatch_once(resolver, sink.clone(), job_id, req, signals.clone())
    })
    .await
}

/// One full attempt of the classify → primary → fallback → direct
/// pipeline. The retry wrapper re-runs this whole function, so an
/// attempt that failed transiently mid-fallback re-classifies cleanly.
/// The inner cookie-fallback and cross-extractor retries can't compound
/// with the transient retries: their trigger strings (cookie-DB errors,
/// "Unsupported URL") are disjoint from the transient set.
async fn dispatch_once(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
) -> Result<BackendOutcome, GoopError> {
    // Fast path: the probe already determined this is a plain file neither
    // extractor handles, so skip the two doomed extractor spawns.
    if req.direct {
        return crate::direct::download(sink, job_id, req, signals).await;
    }
    let primary = classify_extractor(&req.url);
    let result = run_one(
        resolver,
        sink.clone(),
        job_id,
        req,
        signals.clone(),
        primary,
    )
    .await;
    match result {
        Ok(outcome) => Ok(outcome),
        Err(err) => {
            // A fired signal (cancel OR pause) suppresses the fallback:
            // the user asked this job to stop, not to try harder.
            if signals.check().is_some() || !is_no_matching_extractor_err(&err) {
                return Err(err);
            }
            let fallback = match primary {
                ExtractorChoice::YtDlp => ExtractorChoice::GalleryDl,
                ExtractorChoice::GalleryDl => ExtractorChoice::YtDlp,
            };
            match run_one(
                resolver,
                sink.clone(),
                job_id,
                req,
                signals.clone(),
                fallback,
            )
            .await
            {
                Ok(outcome) => Ok(outcome),
                Err(err2) => {
                    if signals.check().is_some() || !is_no_matching_extractor_err(&err2) {
                        return Err(err2);
                    }
                    // Neither extractor recognised the URL: stream it directly.
                    crate::direct::download(sink, job_id, req, signals).await
                }
            }
        }
    }
}

async fn run_one(
    resolver: &BinaryResolver,
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    backend: ExtractorChoice,
) -> Result<BackendOutcome, GoopError> {
    match backend {
        ExtractorChoice::YtDlp => {
            let yt = YtDlp::new(resolver, sink);
            let res = yt.download(job_id, req, signals).await?;
            Ok(BackendOutcome {
                output_path: res.output_path,
                bytes: res.bytes,
                duration_ms: res.duration_ms,
                result_kind: ResultKindTag::File,
                file_count: 1,
            })
        }
        ExtractorChoice::GalleryDl => {
            let gd = GalleryDl::new(resolver, sink);
            let res = gd.download(job_id, req, signals).await?;
            Ok(BackendOutcome {
                output_path: res.output_path,
                bytes: res.bytes,
                duration_ms: res.duration_ms,
                result_kind: ResultKindTag::Folder,
                file_count: res.file_count,
            })
        }
    }
}

/// Best-effort removal of every partial-download artifact a run may have
/// left behind for `req`: the direct downloader's hidden `.part`/`.meta`
/// sidecars, recent yt-dlp/gallery-dl `.part`/`.ytdl` files, and the
/// gallery-dl start marker. Used when a paused download is cancelled —
/// pause keeps partials by contract, and the worker that would normally
/// clean up on cancel already returned.
pub fn cleanup_partials_for(req: &ExtractRequest) {
    let expanded = goop_core::path::expand(&req.output_dir);
    let output_dir = std::fs::canonicalize(&expanded).unwrap_or(expanded);
    crate::direct::remove_partials(&output_dir, &req.url);
    crate::ytdlp::cleanup_partials(&output_dir, None);
    crate::gallery_dl::cleanup_run_artifacts(&output_dir, &req.url);
}

fn is_no_matching_extractor_err(err: &GoopError) -> bool {
    match err {
        GoopError::SubprocessFailed { stderr, .. } => is_no_matching_extractor(stderr),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_matching_extractor_err_matches_subprocess_failure() {
        let err = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "ERROR: Unsupported URL: https://example.com".into(),
        };
        assert!(is_no_matching_extractor_err(&err));
    }

    #[test]
    fn no_matching_extractor_err_ignores_other_errors() {
        let err = GoopError::SubprocessFailed {
            binary: "yt-dlp".into(),
            stderr: "HTTPError: 404 Not Found".into(),
        };
        assert!(!is_no_matching_extractor_err(&err));
        let err = GoopError::Cancelled;
        assert!(!is_no_matching_extractor_err(&err));
        // The control-flow and transient variants must never trigger the
        // cross-extractor fallback.
        assert!(!is_no_matching_extractor_err(&GoopError::Paused));
        assert!(!is_no_matching_extractor_err(&GoopError::Network(
            "Unsupported URL in a network message must not count".into()
        )));
    }
}

/// Dispatch tests driven by fake sidecars — shell scripts that reproduce
/// the stderr real yt-dlp / gallery-dl emit. Cheap to point at
/// pathological process behaviour that the real binaries only produce
/// under a race.
///
/// Unix-only: the fakes are `/bin/sh` scripts. The logic under test is
/// platform-independent, so the coverage gap on Windows is acceptable.
#[cfg(all(test, unix))]
mod fake_sidecar_tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;
    use tempfile::TempDir;

    /// Bails out the way a locked or unreadable browser cookie DB does,
    /// but only when `--cookies-from-browser` is on the argv — so the
    /// wrapper's no-cookie retry gets past it. Matches
    /// `goop_core::is_cookie_db_error`.
    const COOKIE_FAIL_WITH_COOKIES: &str = r#"
for a in "$@"; do
  if [ "$a" = "--cookies-from-browser" ]; then
    echo "ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271" >&2
    exit 1
  fi
done
"#;

    /// A successful gallery-dl run: one file into whatever `--directory`
    /// it was handed. That file is what the post-exit scan tallies, so the
    /// run counts as real work rather than "no extractable content".
    ///
    /// The sleep is load-bearing, not padding. `scan_outputs` counts files
    /// whose mtime is at or after a cutoff sampled from a fine-grained
    /// `SystemTime::now()`, while Linux stamps mtimes from the kernel's
    /// coarse clock — a jiffy wide (4ms at the CONFIG_HZ_250 most distro
    /// kernels ship). A file written within a tick of the cutoff can carry
    /// an mtime just behind it and go uncounted, failing the run as "no
    /// extractable content". Real gallery-dl needs a network round-trip
    /// before the first file lands, so only an instantaneous fake can hit
    /// that window.
    ///
    /// The stdout line real gallery-dl prints per file only drives
    /// progress, so it is tolerated failing — the drain fake below has
    /// already closed stdout, and an unguarded `echo` to a closed fd would
    /// put a shell error on stderr, which is the one stream those tests
    /// care about.
    const GALLERY_DL_WRITES_ONE_FILE: &str = r#"
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--directory" ]; then dir="$a"; fi
  prev="$a"
done
sleep 0.05
printf 'x' > "$dir/photo.jpg"
echo "$dir/photo.jpg" 2>/dev/null || true
exit 0
"#;

    /// Millisecond backoff, so the retry tests spend no real time waiting.
    /// Shallower than `DEFAULT_RETRY_POLICY` (which allows 4 retries): 2
    /// retries is enough to prove the replay without three extra spawns.
    const FAST_RETRIES: RetryPolicy = RetryPolicy {
        max_retries: 2,
        base_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(1),
    };

    fn write_fake(dir: &std::path::Path, name: &str, body: &str) {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "#!/bin/sh\n{body}").unwrap();
        drop(f);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn request(url: &str, output_dir: &std::path::Path) -> ExtractRequest {
        ExtractRequest {
            url: url.into(),
            output_dir: output_dir.to_string_lossy().into_owned(),
            format: None,
            audio_only: false,
            cookies_from_browser: Some("chrome".into()),
            output_template: None,
            direct: false,
        }
    }

    /// Regression for a stderr drain race, surfaced because these fakes
    /// exit far faster than real yt-dlp / gallery-dl (Python, slow to tear
    /// down). The extractors' output loop is `biased`, so it polls stdout
    /// before stderr; a child whose stdout was already at EOF made it
    /// `break` before stderr had been read even once, losing the message
    /// whole.
    ///
    /// Everything the wrappers decide is a substring test over that
    /// stderr, so dropping it silently disables ALL of: the cookie
    /// fallback, the cross-extractor fallback, the transient retry, and
    /// `friendly_message`. The children here close stdout up front and
    /// write stderr late, which forces the losing interleaving on every
    /// run rather than the ~4% the plain fakes hit.
    #[tokio::test]
    async fn stderr_is_read_even_when_the_child_closes_stdout_first() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // `exec 1>&-` closes stdout before a byte of stderr exists, so the
        // stdout reader reports EOF on its very first poll.
        write_fake(
            bins.path(),
            "yt-dlp",
            &format!(
                "exec 1>&-\nsleep 0.2\n{COOKIE_FAIL_WITH_COOKIES}\
                 echo 'ERROR: Unsupported URL: https://example.com/x' >&2\n\
                 exit 1\n"
            ),
        );
        write_fake(
            bins.path(),
            "gallery-dl",
            &format!(
                "exec 1>&-\nsleep 0.2\n{COOKIE_FAIL_WITH_COOKIES}{GALLERY_DL_WRITES_ONE_FILE}"
            ),
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let req = request("https://example.com/x", out.path());

        let res = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
        )
        .await;

        // Only reachable if yt-dlp's "Unsupported URL" survived to drive
        // the fallback, and gallery-dl's cookie error survived to drive
        // its no-cookie retry.
        assert!(
            res.is_ok(),
            "stderr was dropped, so nothing fell back: {res:?}"
        );
    }

    /// Extractor stderr is not guaranteed UTF-8 — a mojibake title or a
    /// legacy Windows codepage puts undecodable bytes in the middle of an
    /// otherwise readable message. One bad line must not cost us the rest
    /// of it: every routing decision is a substring test over the whole
    /// stderr, so truncating at the first bad byte silently disables the
    /// fallbacks. Here the marker the dispatcher needs sits AFTER the bad
    /// line.
    ///
    /// Reads the verdict off WHICH binary failed rather than off a
    /// successful download: reaching gallery-dl at all is the proof, and
    /// that keeps the test clear of the filesystem entirely.
    #[tokio::test]
    async fn one_undecodable_stderr_line_does_not_swallow_the_rest() {
        let bins = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        // A lone 0xff is not valid UTF-8 in any position.
        write_fake(
            bins.path(),
            "yt-dlp",
            "printf 'ERROR: bad title \\377\\n' >&2\n\
             echo 'ERROR: Unsupported URL: https://example.com/x' >&2\n\
             exit 1\n",
        );
        // Fails with a marker that is neither transient nor a no-match, so
        // it neither retries nor falls through to the direct downloader —
        // it just names itself in the error.
        write_fake(
            bins.path(),
            "gallery-dl",
            "echo 'ERROR: the fallback extractor ran' >&2\nexit 1\n",
        );

        let resolver = BinaryResolver::new(bins.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let mut req = request("https://example.com/x", out.path());
        // Isolate the decode path: no cookies, so nothing else can drive
        // the fallback.
        req.cookies_from_browser = None;

        let err = dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req,
            JobSignals::new(),
            &FAST_RETRIES,
        )
        .await
        .expect_err("the fake gallery-dl always fails");

        // Truncating at the bad line would leave yt-dlp's stderr without
        // "Unsupported URL", so dispatch would surface ITS error instead
        // of ever reaching gallery-dl.
        assert!(
            matches!(&err, GoopError::SubprocessFailed { stderr, .. }
                if stderr.contains("the fallback extractor ran")),
            "yt-dlp's 'Unsupported URL' came after the undecodable line and \
             must still drive the fallback; got {err:?}"
        );
    }
}
