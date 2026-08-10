//! Generic direct-URL HTTP downloader.
//!
//! This is the final fallback in [`crate::backend::dispatch`]: when neither
//! yt-dlp nor gallery-dl recognises a URL, Goop streams the file itself so
//! "anything with a link" still works. It runs in-process (no child
//! process), reusing the Extract job lane, and emits the same
//! [`ProgressEvent`]s the queue sidebar already renders.
//!
//! Resume foundation: the download streams into a sibling `.part` file and
//! is atomically renamed into place on success, so a partial download never
//! shadows a good file. A re-run resumes via an HTTP `Range` request,
//! validated with `If-Range` against the `ETag`/`Last-Modified` recorded in
//! a small `.meta` sidecar, so a changed remote file restarts cleanly
//! instead of corrupting the partial.
//!
//! Stop semantics: **pause** stops the stream and KEEPS the `.part` +
//! `.meta` — the resumed run walks the validated Range path above.
//! **Cancel** deletes both: the user is done with this URL, and hidden
//! sidecar litter must not outlive the job. Stream/transport failures keep
//! the partial and surface as [`GoopError::Network`] so the retry layer
//! (`crate::retry`) can back off and resume from the same offset.
//!
//! Integrity barrier: HTTPS to the origin plus the atomic-rename of a fully
//! written `.part` — the same posture as the sidecar updater.

use crate::backend::{BackendOutcome, ResultKindTag};
use crate::retry::transient_status;
use crate::ytdlp::{DirectFileInfo, ExtractRequest};
use futures_util::StreamExt;
use goop_core::{EventSink, GoopError, Interrupt, JobId, JobSignals, ProgressEvent};
use percent_encoding::percent_decode_str;
use reqwest::header::{
    HeaderMap, HeaderName, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
    CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use reqwest::{Client, StatusCode};
use sha2::Digest as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-read (per-chunk) idle timeout: the clock resets after each successfully
/// delivered frame, so it aborts a fully stalled connection without capping
/// the total time a large but healthy download may take. A server that
/// trickles bytes slower than this interval will not trip it — a user stop
/// (cancel/pause) is the only bound on total transfer time, by design. A
/// tripped timeout surfaces as a transient `Network` error, so the retry
/// layer resumes the stalled transfer from its partial.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// Throttle progress emits so a fast download doesn't flood the IPC channel.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(300);

fn build_client() -> Result<Client, GoopError> {
    Client::builder()
        .user_agent("goop")
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| GoopError::Queue(format!("direct download: http client: {e}")))
}

/// Reject anything that isn't `http`/`https` before issuing a request, giving a
/// clear error instead of an opaque transport failure and mirroring the
/// https-only posture of the app self-updater.
fn require_http_scheme(url: &str) -> Result<(), GoopError> {
    match url::Url::parse(url).as_ref().map(|u| u.scheme()) {
        Ok("http" | "https") => Ok(()),
        Ok(scheme) => Err(GoopError::Queue(format!(
            "direct download: unsupported URL scheme {scheme:?}; only http and https are supported"
        ))),
        Err(_) => Err(GoopError::Queue("direct download: invalid URL".into())),
    }
}

/// Probe a plain file via HTTP so the UI can offer a direct download. Tries
/// `HEAD` first and falls back to a one-byte ranged `GET` for servers that
/// reject `HEAD`. Returns the derived filename, size, content-type, and
/// whether the server supports resuming.
pub async fn probe(url: &str) -> Result<DirectFileInfo, GoopError> {
    require_http_scheme(url)?;
    let client = build_client()?;
    let head = client.head(url).timeout(PROBE_TIMEOUT).send().await;
    let resp = match head {
        Ok(r) if r.status().is_success() => r,
        // Classified the same way the download path classifies its own
        // transport failures. A probe that called everything a `Queue`
        // error left the retry layer above it unable to tell a dropped
        // connection from a 404, so neither was retried.
        _ => client
            .get(url)
            .header(RANGE, "bytes=0-0")
            .timeout(PROBE_TIMEOUT)
            .send()
            .await
            .map_err(|e| classify_reqwest("probe", &e))?,
    };
    if !resp.status().is_success() {
        return Err(status_error(resp.status(), url));
    }
    // A 206 from the ranged-GET fallback proves the server honours ranges
    // even if it omits `Accept-Ranges` (which RFC 9110 does not mandate).
    let is_partial = resp.status() == StatusCode::PARTIAL_CONTENT;
    let headers = resp.headers();
    let resumable = is_partial
        || header_str(headers, ACCEPT_RANGES)
            .map(|v| v.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(false);
    Ok(DirectFileInfo {
        filename: filename_from_headers(headers, url),
        size_bytes: total_size(headers),
        content_type: header_str(headers, CONTENT_TYPE),
        resumable,
    })
}

/// Stream `req.url` directly to `req.output_dir`, resuming a prior `.part`
/// when possible and atomically renaming it into place on success.
pub async fn download(
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
) -> Result<BackendOutcome, GoopError> {
    require_http_scheme(&req.url)?;
    let start = Instant::now();
    let output_dir = PathBuf::from(&req.output_dir);
    let client = build_client()?;

    // Part/meta names are derived from the URL so a retry finds the same
    // partial regardless of the eventual filename, and two different URLs
    // that resolve to the same filename don't share a partial. The debrid
    // path overrides via `resume_key`: its CDN URLs rotate but the
    // original link (plus file id) is stable, so resume keeps working.
    let hash = url_hash(req.resume_key.as_deref().unwrap_or(&req.url));
    let part_path = output_dir.join(format!(".{hash}.goopdl.part"));
    let meta_path = output_dir.join(format!(".{hash}.goopdl.meta"));

    // Entry guard: bounds the stop latency during the request/header
    // phase, where the select loop below isn't polling yet.
    if let Some(int) = signals.check() {
        return Err(finish_interrupt(int, &part_path, &meta_path).await);
    }

    let mut existing_len = tokio::fs::metadata(&part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let validator = if existing_len > 0 {
        read_validator(&meta_path).await
    } else {
        None
    };

    // Resuming is only safe with a stored validator: an `If-Range`-guarded
    // request makes the server send a full `200` if the resource changed, so a
    // stale prefix is never fused onto a new tail. Without a validator we can't
    // detect a changed remote file, so discard the partial and start clean
    // rather than risk silent corruption.
    if existing_len > 0 && validator.is_none() {
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = tokio::fs::remove_file(&meta_path).await;
        existing_len = 0;
    }

    let mut request = client.get(&req.url);
    if existing_len > 0 {
        request = request.header(RANGE, format!("bytes={existing_len}-"));
        if let Some(v) = &validator {
            request = request.header(IF_RANGE, v.clone());
        }
    }
    let resp = request
        .send()
        .await
        .map_err(|e| classify_reqwest("request", &e))?;

    let status = resp.status();
    // Append ONLY when the server resumed from exactly our offset (verified via
    // the 206's Content-Range start). Anything else — a 206 from the wrong/
    // missing offset, a 416, or any partial we can't trust — falls through to a
    // clean unconditioned refetch that overwrites from scratch.
    let (resp, append, resume_from) = if existing_len > 0
        && status == StatusCode::PARTIAL_CONTENT
        && content_range_start(resp.headers()) == Some(existing_len)
    {
        (resp, true, existing_len)
    } else if status == StatusCode::PARTIAL_CONTENT || status == StatusCode::RANGE_NOT_SATISFIABLE {
        // An untrustworthy partial response (wrong/absent Content-Range start)
        // or a 416 (our partial is past the server's size): refetch the whole
        // file unconditionally so we never append misaligned bytes.
        let fresh = client
            .get(&req.url)
            .send()
            .await
            .map_err(|e| classify_reqwest("restart", &e))?;
        if !fresh.status().is_success() {
            return Err(status_error(fresh.status(), &req.url));
        }
        (fresh, false, 0)
    } else if status.is_success() {
        // 200 OK: a full body — no prior partial, or the server sent the whole
        // file (e.g. the If-Range validator changed). Overwrite from the start.
        (resp, false, 0)
    } else {
        return Err(status_error(status, &req.url));
    };

    // Read everything we need from the headers before `bytes_stream` consumes
    // the response. A debrid-supplied hint wins over derivation — TorBox
    // knows the real name while its CDN URL may be opaque.
    let filename = req
        .filename_hint
        .clone()
        .unwrap_or_else(|| filename_from_headers(resp.headers(), &req.url));
    // The direct downloader is the last resort after both extractors shrug,
    // so it is routinely pointed at things that are not files. A login wall
    // or an interstitial answers 200 with HTML, and without this the job
    // "succeeds": an error page lands on disk under the URL's filename and
    // only announces itself when the user opens it.
    //
    // Keyed on the MISMATCH, not on the content type: someone downloading
    // an actual `.html` is getting exactly what they asked for.
    if is_unwanted_html(resp.headers(), &filename) {
        return Err(GoopError::InvalidRequest(
            "The link returned a web page, not a file. It may need a login, \
             or the direct link may have expired."
                .into(),
        ));
    }
    let total = if append {
        content_range_total(resp.headers())
            .or_else(|| header_u64(resp.headers(), CONTENT_LENGTH).map(|cl| resume_from + cl))
    } else {
        total_size(resp.headers())
    };
    if let Some(v) = validator_from_headers(resp.headers()) {
        write_validator(&meta_path, &v).await;
    }

    let mut file = open_part(&part_path, append).await?;

    let mut downloaded = resume_from;
    let mut last_emit = Instant::now();
    emit_progress(&sink, job_id, downloaded, total, start);

    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            biased;
            int = signals.interrupted() => {
                let _ = file.flush().await;
                // Close the handle before finish_interrupt may delete the
                // file — an open handle blocks removal on Windows.
                drop(file);
                return Err(finish_interrupt(int, &part_path, &meta_path).await);
            }
            chunk = stream.next() => match chunk {
                Some(Ok(bytes)) => {
                    file.write_all(&bytes).await.map_err(GoopError::Io)?;
                    downloaded += bytes.len() as u64;
                    if last_emit.elapsed() >= PROGRESS_INTERVAL {
                        emit_progress(&sink, job_id, downloaded, total, start);
                        last_emit = Instant::now();
                    }
                }
                Some(Err(e)) => {
                    let _ = file.flush().await;
                    // Keep the partial: a mid-transfer drop is transient by
                    // nature, and the retry layer resumes from this offset.
                    return Err(GoopError::Network(format!("direct download: stream: {e}")));
                }
                None => break,
            },
        }
    }
    file.flush().await.map_err(GoopError::Io)?;
    let _ = file.sync_all().await;
    drop(file);

    let dest = match unique_dest(&output_dir, &filename) {
        Ok(d) => d,
        Err(e) => {
            // No usable destination name: the finished .part is unreachable,
            // so clean it up rather than leave a hidden orphan behind. (A
            // rename failure below is left alone — the .part is a resume seed.)
            let _ = tokio::fs::remove_file(&part_path).await;
            let _ = tokio::fs::remove_file(&meta_path).await;
            return Err(e);
        }
    };
    tokio::fs::rename(&part_path, &dest)
        .await
        .map_err(GoopError::Io)?;
    let _ = tokio::fs::remove_file(&meta_path).await;
    emit_progress(&sink, job_id, downloaded, total.or(Some(downloaded)), start);

    Ok(BackendOutcome {
        output_path: dest.to_string_lossy().into_owned(),
        bytes: downloaded,
        duration_ms: start.elapsed().as_millis() as u64,
        result_kind: ResultKindTag::File,
        file_count: 1,
    })
}

/// Cancel: the user is done with this URL — remove the partial and its
/// validator so no hidden litter outlives the job. Pause: keep both; the
/// next run resumes through the validated Range path.
async fn finish_interrupt(int: Interrupt, part_path: &Path, meta_path: &Path) -> GoopError {
    if matches!(int, Interrupt::Cancel) {
        let _ = tokio::fs::remove_file(part_path).await;
        let _ = tokio::fs::remove_file(meta_path).await;
    }
    int.into()
}

/// Best-effort synchronous removal of the URL's `.part` + `.meta`
/// sidecars, for callers outside a running download (cancelling a paused
/// job from the IPC layer).
pub(crate) fn remove_partials(output_dir: &Path, url: &str) {
    let hash = url_hash(url);
    let _ = std::fs::remove_file(output_dir.join(format!(".{hash}.goopdl.part")));
    let _ = std::fs::remove_file(output_dir.join(format!(".{hash}.goopdl.meta")));
}

/// Classify a reqwest transport failure at construction time, where the
/// error kind is still structured. Timeouts and connection failures are
/// transient; TLS trust failures are not — a bad certificate doesn't heal
/// on retry — and everything else (builder errors, redirect loops) stays
/// a plain queue error.
///
/// Deliberate coarseness: DNS failures ride the connect-error bucket, so
/// a typo'd hostname burns the retry budget (~30s) before failing. The
/// side-effect-free retries make that an accepted cost — telling NXDOMAIN
/// apart from a transient resolver failure through reqwest's opaque error
/// chain isn't worth the string-matching fragility.
fn classify_reqwest(context: &str, e: &reqwest::Error) -> GoopError {
    let msg = format!("direct download: {context}: {e}");
    let tls_failure = format!("{e:?}")
        .to_ascii_lowercase()
        .contains("certificate");
    if (e.is_timeout() || e.is_connect()) && !tls_failure {
        GoopError::Network(msg)
    } else {
        GoopError::Queue(msg)
    }
}

/// HTTP failure classified by status: retryable statuses (408/429/5xx —
/// see `retry::transient_status`) become `Network`, the rest stay `Queue`.
/// Message text is identical either way.
/// True when the server sent an HTML document but the download is not
/// supposed to be one.
///
/// `text/html` alone is not the signal — a user saving a web page is
/// entitled to. The pair (HTML body, non-HTML filename) is what says the
/// server answered with something other than what was asked for.
fn is_unwanted_html(headers: &HeaderMap, filename: &str) -> bool {
    let is_html = header_str(headers, CONTENT_TYPE)
        .map(|v| v.to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false);
    if !is_html {
        return false;
    }
    // A `Content-Disposition` filename is the server saying "this is a
    // download, call it this". That is a deliberate statement of intent,
    // where a `text/html` content type is frequently just a default
    // (nginx's `default_type`, an extensionless endpoint) — so the
    // explicit header wins. Narrows the false-positive surface to a URL
    // with no extension, no disposition, AND a mislabelled type.
    if header_str(headers, CONTENT_DISPOSITION)
        .as_deref()
        .and_then(parse_content_disposition_filename)
        .is_some()
    {
        return false;
    }
    let name = filename.to_ascii_lowercase();
    !(name.ends_with(".html") || name.ends_with(".htm"))
}

fn status_error(status: StatusCode, url: &str) -> GoopError {
    let msg = format!("direct download: HTTP {status} for {url}");
    if transient_status(status) {
        GoopError::Network(msg)
    } else {
        GoopError::Queue(msg)
    }
}

async fn open_part(part_path: &Path, append: bool) -> Result<tokio::fs::File, GoopError> {
    if append {
        return tokio::fs::OpenOptions::new()
            .append(true)
            .open(part_path)
            .await
            .map_err(GoopError::Io);
    }
    if let Some(parent) = part_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(GoopError::Io)?;
    }
    tokio::fs::File::create(part_path)
        .await
        .map_err(GoopError::Io)
}

fn emit_progress(
    sink: &Arc<dyn EventSink>,
    job_id: JobId,
    downloaded: u64,
    total: Option<u64>,
    start: Instant,
) {
    let elapsed = start.elapsed().as_secs_f64();
    let bps = if elapsed > 0.0 {
        downloaded as f64 / elapsed
    } else {
        0.0
    };
    let percent = match total {
        Some(t) if t > 0 => ((downloaded as f64 / t as f64) * 100.0).clamp(0.0, 100.0) as f32,
        _ => 0.0,
    };
    let eta_secs = match total {
        Some(t) if t > downloaded && bps > 0.0 => Some(((t - downloaded) as f64 / bps) as u64),
        _ => None,
    };
    sink.emit_progress(ProgressEvent {
        job_id,
        percent,
        eta_secs,
        speed_hr: Some(human_speed(bps)),
        stage: "downloading".into(),
        encoder: None,
    });
}

// --- header helpers --------------------------------------------------------

fn header_str(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    headers
        .get(&name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn header_u64(headers: &HeaderMap, name: HeaderName) -> Option<u64> {
    header_str(headers, name).and_then(|v| v.trim().parse::<u64>().ok())
}

/// Total size from a `Content-Range: bytes a-b/total` header, if present.
fn content_range_total(headers: &HeaderMap) -> Option<u64> {
    header_str(headers, CONTENT_RANGE).and_then(|cr| {
        cr.rsplit('/')
            .next()
            .and_then(|t| t.trim().parse::<u64>().ok())
    })
}

/// Start byte from a `Content-Range: bytes start-end/total` header, used to
/// confirm a 206 actually resumed from the offset we requested.
fn content_range_start(headers: &HeaderMap) -> Option<u64> {
    header_str(headers, CONTENT_RANGE).and_then(|cr| {
        cr.trim()
            .strip_prefix("bytes ")
            .and_then(|rest| rest.split('-').next())
            .and_then(|s| s.trim().parse::<u64>().ok())
    })
}

/// Full resource size: prefer `Content-Range` total (set on a ranged
/// response) and fall back to `Content-Length`.
fn total_size(headers: &HeaderMap) -> Option<u64> {
    content_range_total(headers).or_else(|| header_u64(headers, CONTENT_LENGTH))
}

fn validator_from_headers(headers: &HeaderMap) -> Option<String> {
    header_str(headers, ETAG).or_else(|| header_str(headers, LAST_MODIFIED))
}

async fn read_validator(meta_path: &Path) -> Option<String> {
    tokio::fs::read_to_string(meta_path)
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn write_validator(meta_path: &Path, validator: &str) {
    let _ = tokio::fs::write(meta_path, validator).await; // best-effort
}

// --- filename derivation ---------------------------------------------------

fn filename_from_headers(headers: &HeaderMap, url: &str) -> String {
    header_str(headers, CONTENT_DISPOSITION)
        .as_deref()
        .and_then(parse_content_disposition_filename)
        .or_else(|| filename_from_url(url))
        .map(|s| sanitize_filename(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "download".to_string())
}

/// Extract a filename from a `Content-Disposition` value. `filename*`
/// (RFC 5987 percent-encoded) takes precedence over a plain `filename`.
fn parse_content_disposition_filename(value: &str) -> Option<String> {
    for part in value.split(';') {
        let part = part.trim();
        if part.to_ascii_lowercase().starts_with("filename*=") {
            let rest = &part["filename*=".len()..];
            // form: charset'lang'pct-encoded-value
            let encoded = rest.rsplit('\'').next().unwrap_or(rest);
            let decoded = percent_decode_str(encoded).decode_utf8_lossy().to_string();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    for part in value.split(';') {
        let part = part.trim();
        if part.to_ascii_lowercase().starts_with("filename=") {
            let v = part["filename=".len()..].trim().trim_matches('"');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn filename_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.rfind(|s| !s.is_empty())?;
    let decoded = percent_decode_str(last).decode_utf8_lossy().to_string();
    (!decoded.is_empty()).then_some(decoded)
}

/// Reduce an arbitrary name to a safe single path component: drop any
/// directory parts, replace characters illegal on Windows or dangerous in a
/// path, and reject `.`/`..` (which trim to empty).
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    cleaned.trim().trim_matches('.').trim().to_string()
}

/// Non-clobbering destination: `name.ext`, then `name (1).ext`, `name (2).ext`…
/// Errors after exhausting the counter rather than returning a colliding path.
/// Best-effort: the returned path is free at check time, but the subsequent
/// `rename` is not atomic with this check, so two downloads finishing the same
/// instant with the same name could still race (the single Extract job lane
/// makes that practically impossible).
fn unique_dest(dir: &Path, filename: &str) -> Result<PathBuf, GoopError> {
    let base = dir.join(filename);
    if !base.exists() {
        return Ok(base);
    }
    let (stem, ext) = split_stem_ext(filename);
    for n in 1..10_000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(GoopError::Queue(format!(
        "direct download: too many name collisions for {filename:?} in the output folder"
    )))
}

/// Split into `(stem, ext-with-leading-dot)`. A leading dot is kept on the
/// stem (dotfiles aren't treated as all-extension).
fn split_stem_ext(filename: &str) -> (String, String) {
    match filename.rfind('.') {
        Some(i) if i > 0 => (filename[..i].to_string(), filename[i..].to_string()),
        _ => (filename.to_string(), String::new()),
    }
}

pub(crate) fn url_hash(url: &str) -> String {
    let mut h = sha2::Sha256::new();
    h.update(url.as_bytes());
    let full = hex_lower(h.finalize().as_slice());
    full[..16].to_string()
}

fn human_speed(bps: f64) -> String {
    const UNITS: [&str; 4] = ["B/s", "KB/s", "MB/s", "GB/s"];
    let mut v = bps;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.1} {}", UNITS[i])
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use std::sync::Arc;
    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn req(url: &str, dir: &Path) -> ExtractRequest {
        ExtractRequest {
            url: url.to_string(),
            output_dir: dir.to_string_lossy().into_owned(),
            format: None,
            audio_only: false,
            cookies_from_browser: None,
            output_template: None,
            direct: true,
            debrid: false,
            debrid_item: None,
            resume_key: None,
            filename_hint: None,
            extractor_hint: None,
        }
    }

    fn sink() -> Arc<dyn EventSink> {
        Arc::new(RecordingSink::new())
    }

    // ---- pure helpers ----------------------------------------------------

    #[test]
    fn filename_from_url_takes_last_segment() {
        assert_eq!(
            filename_from_url("https://x.test/a/b/file.zip").as_deref(),
            Some("file.zip")
        );
        assert_eq!(
            filename_from_url("https://x.test/a/b/").as_deref(),
            Some("b")
        );
        assert_eq!(filename_from_url("https://x.test/").as_deref(), None);
        assert_eq!(
            filename_from_url("https://x.test/my%20file.bin").as_deref(),
            Some("my file.bin")
        );
    }

    #[test]
    fn content_disposition_prefers_rfc5987() {
        assert_eq!(
            parse_content_disposition_filename(
                "attachment; filename=\"plain.txt\"; filename*=UTF-8''na%C3%AFve.txt"
            )
            .as_deref(),
            Some("naïve.txt")
        );
        assert_eq!(
            parse_content_disposition_filename("attachment; filename=report.pdf").as_deref(),
            Some("report.pdf")
        );
        assert_eq!(parse_content_disposition_filename("inline"), None);
    }

    #[test]
    fn sanitize_strips_paths_and_traversal() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename(".."), "");
        assert_eq!(sanitize_filename("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_filename("  spaced.zip  "), "spaced.zip");
    }

    #[test]
    fn split_stem_ext_handles_dotfiles_and_no_ext() {
        assert_eq!(
            split_stem_ext("a.tar.gz"),
            ("a.tar".to_string(), ".gz".to_string())
        );
        assert_eq!(
            split_stem_ext("noext"),
            ("noext".to_string(), String::new())
        );
        assert_eq!(split_stem_ext(".env"), (".env".to_string(), String::new()));
    }

    #[test]
    fn unique_dest_increments_on_collision() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("f.bin"), b"x").unwrap();
        assert_eq!(
            unique_dest(dir.path(), "f.bin")
                .unwrap()
                .file_name()
                .unwrap(),
            "f (1).bin"
        );
        assert_eq!(
            unique_dest(dir.path(), "g.bin")
                .unwrap()
                .file_name()
                .unwrap(),
            "g.bin"
        );
    }

    #[test]
    fn url_hash_is_stable_and_short() {
        let a = url_hash("https://x.test/file");
        assert_eq!(a.len(), 16);
        assert_eq!(a, url_hash("https://x.test/file"));
        assert_ne!(a, url_hash("https://x.test/other"));
    }

    #[test]
    fn human_speed_scales_units() {
        assert_eq!(human_speed(512.0), "512.0 B/s");
        assert_eq!(human_speed(2048.0), "2.0 KB/s");
        assert_eq!(human_speed(5.0 * 1024.0 * 1024.0), "5.0 MB/s");
    }

    // ---- probe -----------------------------------------------------------

    #[tokio::test]
    async fn probe_reads_headers_via_head() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .and(path("/file.zip"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-length", "1048576")
                    .insert_header("content-type", "application/zip")
                    .insert_header("accept-ranges", "bytes"),
            )
            .mount(&server)
            .await;
        let info = probe(&format!("{}/file.zip", server.uri())).await.unwrap();
        assert_eq!(info.filename, "file.zip");
        assert_eq!(info.size_bytes, Some(1_048_576));
        assert_eq!(info.content_type.as_deref(), Some("application/zip"));
        assert!(info.resumable);
    }

    #[tokio::test]
    async fn probe_falls_back_to_ranged_get_when_head_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("HEAD"))
            .respond_with(ResponseTemplate::new(405))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/data.bin"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 0-0/4096")
                    .set_body_bytes(vec![0u8]),
            )
            .mount(&server)
            .await;
        let info = probe(&format!("{}/data.bin", server.uri())).await.unwrap();
        assert_eq!(info.filename, "data.bin");
        assert_eq!(info.size_bytes, Some(4096));
        // A 206 to the ranged fallback proves range support even without an
        // Accept-Ranges header.
        assert!(info.resumable);
    }

    // ---- download --------------------------------------------------------

    #[tokio::test]
    async fn download_writes_file_and_cleans_up() {
        let server = MockServer::start().await;
        let body = b"hello direct download".to_vec();
        Mock::given(method("GET"))
            .and(path("/song.mp3"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let s = sink();
        let outcome = download(
            s.clone(),
            JobId::new(),
            &req(&format!("{}/song.mp3", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();

        let dest = dir.path().join("song.mp3");
        assert_eq!(outcome.output_path, dest.to_string_lossy());
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(outcome.bytes, body.len() as u64);
        // No leftover part/meta sidecars.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("goopdl"))
            .collect();
        assert!(leftovers.is_empty(), "part/meta should be cleaned up");
    }

    #[tokio::test]
    async fn download_uses_content_disposition_filename() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/d"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-disposition", "attachment; filename=\"real.pdf\"")
                    .set_body_bytes(b"%PDF-1.4".to_vec()),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let outcome = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/d", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert!(outcome.output_path.ends_with("real.pdf"));
    }

    #[tokio::test]
    async fn download_resumes_from_partial_via_range() {
        let server = MockServer::start().await;
        // Server only answers the ranged request for the second half.
        Mock::given(method("GET"))
            .and(path("/big.bin"))
            .and(header("range", "bytes=5-"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 5-9/10")
                    .set_body_bytes(b"world".to_vec()),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let url = format!("{}/big.bin", server.uri());
        // Seed a partial (first 5 bytes) + a matching validator sidecar.
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"hello").unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        let outcome = download(
            sink(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"helloworld");
        assert_eq!(outcome.bytes, 10);
    }

    #[tokio::test]
    async fn download_restarts_when_server_ignores_range() {
        let server = MockServer::start().await;
        // No range matcher: server returns the full body with 200 even though
        // the client sent a Range + If-Range for the seeded (validated) partial
        // — e.g. the validator changed. The partial must be overwritten, not
        // appended to.
        Mock::given(method("GET"))
            .and(path("/x.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"FULLBODY".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let url = format!("{}/x.bin", server.uri());
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"STALE").unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        let outcome = download(
            sink(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"FULLBODY");
    }

    #[tokio::test]
    async fn download_discards_unvalidated_partial_instead_of_appending() {
        let server = MockServer::start().await;
        let url = format!("{}/u.bin", server.uri());
        // If the code wrongly sent a Range for a partial with no validator,
        // this 206 would corrupt the result by appending "APPENDED". The
        // correct behaviour discards the partial, sends no Range, and gets the
        // clean 200 body.
        Mock::given(method("GET"))
            .and(path("/u.bin"))
            .and(header("range", "bytes=5-"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 5-12/13")
                    .set_body_bytes(b"APPENDED".to_vec()),
            )
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/u.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"clean body".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let hash = url_hash(&url);
        // Partial with NO .meta sidecar (server gave no validator last time).
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"STALE").unwrap();

        let outcome = download(
            sink(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"clean body");
    }

    #[tokio::test]
    async fn download_restarts_when_206_offset_mismatches() {
        let server = MockServer::start().await;
        let url = format!("{}/m.bin", server.uri());
        // Server returns 206 but from byte 0, not the requested byte 5. The
        // start mismatch must trigger a clean refetch, not a corrupt append.
        Mock::given(method("GET"))
            .and(path("/m.bin"))
            .and(header("range", "bytes=5-"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 0-9/10")
                    .set_body_bytes(b"0123456789".to_vec()),
            )
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/m.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"0123456789".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"STALE").unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        let outcome = download(
            sink(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        // Exactly the full body, not 15 bytes (stale prefix + body).
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"0123456789");
        assert_eq!(outcome.bytes, 10);
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let dir = TempDir::new().unwrap();
        let err = download(
            sink(),
            JobId::new(),
            &req("ftp://example.com/file.bin", dir.path()),
            JobSignals::new(),
        )
        .await
        .expect_err("ftp must be rejected");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(probe("ftp://example.com/file.bin").await.is_err());
    }

    #[tokio::test]
    async fn download_restarts_on_range_not_satisfiable() {
        let server = MockServer::start().await;
        let url = format!("{}/r.bin", server.uri());
        // Our partial is larger than the server's file: the ranged request
        // gets a 416, and the unconditioned restart returns the real body.
        Mock::given(method("GET"))
            .and(path("/r.bin"))
            .and(header("range", "bytes=20-"))
            .respond_with(ResponseTemplate::new(416))
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/r.bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"fresh body".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let hash = url_hash(&url);
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.part")),
            vec![0u8; 20],
        )
        .unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        let outcome = download(
            sink(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"fresh body");
    }

    #[tokio::test]
    async fn download_cancel_removes_partial_and_meta() {
        // Cancel means "done with this URL": any partial from an earlier
        // pause or failure is deleted rather than left as hidden litter.
        let dir = TempDir::new().unwrap();
        let url = "https://example.com/c.bin".to_string();
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"hello").unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        let signals = JobSignals::new();
        signals.cancel.cancel(); // pre-cancelled: the entry guard fires
        let err = download(sink(), JobId::new(), &req(&url, dir.path()), signals)
            .await
            .expect_err("cancelled download must error");
        assert!(matches!(err, GoopError::Cancelled));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("goopdl"))
            .collect();
        assert!(leftovers.is_empty(), "cancel must delete .part and .meta");
    }

    #[tokio::test]
    async fn download_pause_keeps_partial_and_meta_and_returns_paused() {
        let dir = TempDir::new().unwrap();
        let url = "https://example.com/p.bin".to_string();
        let hash = url_hash(&url);
        let part = dir.path().join(format!(".{hash}.goopdl.part"));
        let meta = dir.path().join(format!(".{hash}.goopdl.meta"));
        std::fs::write(&part, b"hello").unwrap();
        std::fs::write(&meta, "\"etag-1\"").unwrap();

        let signals = JobSignals::new();
        signals.pause.cancel();
        let err = download(sink(), JobId::new(), &req(&url, dir.path()), signals)
            .await
            .expect_err("paused download must yield");
        assert!(matches!(err, GoopError::Paused));
        assert!(part.exists(), "pause keeps the .part for resume");
        assert!(meta.exists(), "pause keeps the validator");
    }

    #[tokio::test]
    async fn pre_fired_cancel_wins_over_pause() {
        let dir = TempDir::new().unwrap();
        let url = "https://example.com/b.bin".to_string();
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"x").unwrap();

        let signals = JobSignals::new();
        signals.pause.cancel();
        signals.cancel.cancel();
        let err = download(sink(), JobId::new(), &req(&url, dir.path()), signals)
            .await
            .expect_err("must stop");
        assert!(matches!(err, GoopError::Cancelled), "cancel outranks pause");
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("goopdl"));
        assert!(!kept, "cancel-wins also means partials are deleted");
    }

    #[tokio::test]
    async fn paused_partial_resumes_via_range_on_second_call() {
        // End-to-end pause -> resume at the file level: the state a pause
        // leaves behind (validated .part) feeds the existing Range path on
        // the next run, with zero resume-specific code.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/file.bin"))
            .and(header("range", "bytes=5-"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 5-9/10")
                    .insert_header("etag", "\"etag-1\"")
                    .set_body_bytes(b"world".to_vec()),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let url = format!("{}/file.bin", server.uri());
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"hello").unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        // First call: pause already requested (the paused state itself).
        let paused = JobSignals::new();
        paused.pause.cancel();
        let err = download(sink(), JobId::new(), &req(&url, dir.path()), paused)
            .await
            .expect_err("paused");
        assert!(matches!(err, GoopError::Paused));

        // Second call (the resume): fresh signals, resumes from offset 5.
        let outcome = download(
            sink(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert_eq!(outcome.bytes, 10);
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"helloworld");
    }

    #[tokio::test]
    async fn connection_refused_is_classified_transient_network() {
        // Bind a port, then drop the listener so connecting is refused.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let dir = TempDir::new().unwrap();
        let err = download(
            sink(),
            JobId::new(),
            &req(&format!("http://127.0.0.1:{port}/x.bin"), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect_err("must fail to connect");
        assert!(
            matches!(err, GoopError::Network(_)),
            "connection refused must be retryable, got {err:?}"
        );
    }

    #[tokio::test]
    async fn http_5xx_is_network_and_4xx_is_queue() {
        for (code, want_network) in [(503u16, true), (404u16, false)] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(code))
                .mount(&server)
                .await;
            let dir = TempDir::new().unwrap();
            let err = download(
                sink(),
                JobId::new(),
                &req(&format!("{}/f.bin", server.uri()), dir.path()),
                JobSignals::new(),
            )
            .await
            .expect_err("must fail");
            match (want_network, &err) {
                (true, GoopError::Network(_)) | (false, GoopError::Queue(_)) => {}
                _ => panic!("HTTP {code}: wrong classification: {err:?}"),
            }
        }
    }

    #[test]
    fn remove_partials_deletes_both_sidecars() {
        let dir = TempDir::new().unwrap();
        let url = "https://example.com/z.bin";
        let hash = url_hash(url);
        let part = dir.path().join(format!(".{hash}.goopdl.part"));
        let meta = dir.path().join(format!(".{hash}.goopdl.meta"));
        std::fs::write(&part, b"x").unwrap();
        std::fs::write(&meta, "v").unwrap();
        remove_partials(dir.path(), url);
        assert!(!part.exists());
        assert!(!meta.exists());
    }

    // ---- dispatch-level auto-retry (direct fast path) ---------------------

    fn tiny_policy() -> crate::retry::RetryPolicy {
        crate::retry::RetryPolicy {
            max_retries: 4,
            base_delay: std::time::Duration::from_millis(1),
            max_delay: std::time::Duration::from_millis(2),
        }
    }

    #[tokio::test]
    async fn transient_503_then_success_resumes_from_offset() {
        let server = MockServer::start().await;
        // First ranged attempt: 503 (consumed once, higher priority)...
        Mock::given(method("GET"))
            .and(path("/big.bin"))
            .and(header("range", "bytes=5-"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        // ...second ranged attempt succeeds. No bare-GET mock is mounted, so
        // a restart-from-zero would 404 and fail the test: every attempt
        // must resume from the partial.
        Mock::given(method("GET"))
            .and(path("/big.bin"))
            .and(header("range", "bytes=5-"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("content-range", "bytes 5-9/10")
                    .insert_header("etag", "\"etag-1\"")
                    .set_body_bytes(b"world".to_vec()),
            )
            .with_priority(2)
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let url = format!("{}/big.bin", server.uri());
        let hash = url_hash(&url);
        std::fs::write(dir.path().join(format!(".{hash}.goopdl.part")), b"hello").unwrap();
        std::fs::write(
            dir.path().join(format!(".{hash}.goopdl.meta")),
            "\"etag-1\"",
        )
        .unwrap();

        let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let outcome = crate::backend::dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req(&url, dir.path()),
            JobSignals::new(),
            &tiny_policy(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(outcome.bytes, 10);
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"helloworld");
        let stages: Vec<String> = rec
            .progress
            .lock()
            .iter()
            .map(|p| p.stage.clone())
            .collect();
        let retries = stages
            .iter()
            .filter(|st| st.starts_with("retrying"))
            .count();
        assert_eq!(retries, 1, "exactly one retry announcement, got {stages:?}");
    }

    #[tokio::test]
    async fn permanent_404_fails_without_retry() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/gone.bin"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1) // verified on server drop: exactly one request
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let err = crate::backend::dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req(&format!("{}/gone.bin", server.uri()), dir.path()),
            JobSignals::new(),
            &tiny_policy(),
            None,
        )
        .await
        .expect_err("404 is permanent");
        assert!(matches!(err, GoopError::Queue(_)));
        assert!(
            rec.progress
                .lock()
                .iter()
                .all(|p| !p.stage.starts_with("retrying")),
            "no retry events for a permanent failure"
        );
    }

    #[tokio::test]
    async fn retry_cap_exhaustion_surfaces_last_error_after_five_requests() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/flaky.bin"))
            .respond_with(ResponseTemplate::new(503))
            .expect(5) // 1 attempt + 4 retries, verified on drop
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let resolver = goop_sidecar::BinaryResolver::new(dir.path().to_path_buf());
        let rec = Arc::new(RecordingSink::new());
        let err = crate::backend::dispatch_with_policy(
            &resolver,
            rec.clone(),
            JobId::new(),
            &req(&format!("{}/flaky.bin", server.uri()), dir.path()),
            JobSignals::new(),
            &tiny_policy(),
            None,
        )
        .await
        .expect_err("budget exhausted");
        assert!(
            matches!(&err, GoopError::Network(m) if m.contains("503")),
            "last error surfaces: {err:?}"
        );
        let retry_events = rec
            .progress
            .lock()
            .iter()
            .filter(|p| p.stage.starts_with("retrying"))
            .count();
        assert_eq!(retry_events, 4);
    }

    #[tokio::test]
    async fn download_handles_chunked_without_content_length() {
        let server = MockServer::start().await;
        // No content-length header set by the template beyond what wiremock
        // adds; body still completes.
        Mock::given(method("GET"))
            .and(path("/stream"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"abcdef".to_vec()))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let outcome = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/stream", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"abcdef");
    }

    // ---- probe failures are classified, not lumped together --------------

    /// A probe that fails on a 503 must read as transient, or the retry
    /// helper above it cannot tell it apart from a 404 and a momentarily
    /// overloaded host looks permanently broken.
    #[tokio::test]
    async fn a_transient_probe_status_is_a_network_error() {
        for status in [408u16, 429, 500, 502, 503, 504] {
            let server = MockServer::start().await;
            Mock::given(method("HEAD"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            let err = probe(&format!("{}/f.zip", server.uri()))
                .await
                .expect_err("the server refuses");
            assert!(
                matches!(err, GoopError::Network(_)),
                "HTTP {status} should be transient, got {err:?}"
            );
        }
    }

    /// And a permanent one must not, or the probe retries something that
    /// will never change and the card just takes longer to appear.
    #[tokio::test]
    async fn a_permanent_probe_status_is_not_a_network_error() {
        for status in [400u16, 401, 403, 404, 410] {
            let server = MockServer::start().await;
            Mock::given(method("HEAD"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            let err = probe(&format!("{}/f.zip", server.uri()))
                .await
                .expect_err("the server refuses");
            assert!(
                !matches!(err, GoopError::Network(_)),
                "HTTP {status} is permanent, got {err:?}"
            );
        }
    }

    /// A transport failure — nothing listening — is the same kind of thing
    /// as a 503 and has to classify the same way. The download path already
    /// treats it so (`classify_reqwest`); the probe used to call everything
    /// a `Queue` error.
    #[tokio::test]
    async fn a_probe_transport_failure_is_a_network_error() {
        // Port 1 on loopback: reserved, and nothing is listening.
        let err = probe("http://127.0.0.1:1/file.zip")
            .await
            .expect_err("nothing is listening");
        assert!(matches!(err, GoopError::Network(_)), "{err:?}");
    }

    // ---- the "that's a web page, not a file" guard -----------------------

    /// The direct downloader is the last resort after both extractors shrug,
    /// so it is routinely pointed at pages that are not files at all. A
    /// login wall or an interstitial answers 200 with HTML, and the result
    /// was a "download" of the error page, named after the URL, that only
    /// announces itself when the user opens it.
    #[tokio::test]
    async fn an_html_page_is_not_downloaded_as_a_file() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/video"))
            .respond_with(
                // `set_body_raw`, not `set_body_string`: the latter forces
                // `Content-Type: text/plain` and would quietly test nothing.
                ResponseTemplate::new(200).set_body_raw(
                    b"<!doctype html><title>Sign in</title>".to_vec(),
                    "text/html; charset=utf-8",
                ),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let err = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/video", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect_err("HTML is not the file that was asked for");

        let msg = err.user_message();
        assert!(
            msg.to_lowercase().contains("web page"),
            "the message has to say what actually happened: {msg}"
        );
        assert!(
            !matches!(err, GoopError::Network(_)),
            "a login wall does not heal on retry: {err:?}"
        );
    }

    /// Someone downloading an actual `.html` file is downloading exactly
    /// what they asked for. The guard keys on the mismatch, not on the
    /// content type alone.
    #[tokio::test]
    async fn an_html_file_the_user_asked_for_still_downloads() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/page.html"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(b"<h1>saved</h1>".to_vec(), "text/html"),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let outcome = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/page.html", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect("an .html file is a legitimate download");
        assert!(outcome.output_path.ends_with("page.html"));
    }

    /// A server that names the file in `Content-Disposition` is stating
    /// intent: this is a download. That beats a `text/html` content type,
    /// which is frequently just a default for an extensionless endpoint.
    #[tokio::test]
    async fn a_named_download_survives_a_mislabelled_content_type() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/download"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-disposition", "attachment; filename=\"clip.mp4\"")
                    .set_body_raw(b"realbytes".to_vec(), "text/html"),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let outcome = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/download", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect("the server said this is a file called clip.mp4");
        assert!(outcome.output_path.ends_with("clip.mp4"));
    }

    /// ⚠️ The remaining false positive, pinned so it is known rather than
    /// discovered. An extensionless URL, no `Content-Disposition`, and a
    /// server that labels a real file `text/html` is rejected. That
    /// combination is much more often a login wall than a file, and the
    /// alternative — saving the interstitial to disk under the URL's name
    /// and finding out on open — is worse. But it is not free.
    #[tokio::test]
    async fn an_extensionless_url_mislabelled_as_html_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/download"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(b"realbytes".to_vec(), "text/html"),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let err = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/download", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect_err("documenting, not endorsing");
        assert!(err.user_message().to_lowercase().contains("web page"));
    }

    /// The message is Goop's own sentence, so it must not arrive wearing
    /// `invalid request:` — the queue row shows `user_message()` verbatim.
    #[tokio::test]
    async fn the_web_page_message_reads_as_a_sentence() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/video"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(b"<html>".to_vec(), "text/html"))
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let err = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/video", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect_err("HTML");
        let msg = err.user_message();
        assert!(
            msg.starts_with("The link returned a web page"),
            "got {msg:?}"
        );
        assert!(!msg.contains("invalid request"), "got {msg:?}");
    }

    /// And a real file is unaffected however the server labels it.
    #[tokio::test]
    async fn a_non_html_content_type_is_untouched() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/clip.mp4"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "video/mp4")
                    .set_body_bytes(b"mp4data".to_vec()),
            )
            .mount(&server)
            .await;
        let dir = TempDir::new().unwrap();
        let outcome = download(
            sink(),
            JobId::new(),
            &req(&format!("{}/clip.mp4", server.uri()), dir.path()),
            JobSignals::new(),
        )
        .await
        .expect("a real file");
        assert_eq!(std::fs::read(&outcome.output_path).unwrap(), b"mp4data");
    }
}
