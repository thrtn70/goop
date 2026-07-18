//! TorBox debrid client and resolve flow.
//!
//! TorBox turns hoster links and magnets into plain CDN URLs; the actual
//! transfer is then handed to the `direct` streamer so progress, pause /
//! resume and auto-retry behave exactly like any other direct download.
//!
//! Error mapping mirrors `direct.rs`: transport failures and retryable
//! HTTP statuses become `GoopError::Network` (fed into the retry layer),
//! everything else is a permanent `GoopError::Queue`. TorBox also reports
//! errors as HTTP 200 with a `success: false` envelope, so both layers
//! are classified here where the structure is still visible.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use goop_core::error::GoopError;
use goop_core::{EventSink, JobId, JobSignals, ProgressEvent};
use serde::Deserialize;

use crate::backend::{BackendOutcome, ResultKindTag};
use crate::retry::transient_status;
use crate::ytdlp::ExtractRequest;

/// Production API base. Tests inject a wiremock URI instead.
pub const TORBOX_API_BASE: &str = "https://api.torbox.app/v1/api";

/// Poll cadence for the not-ready yield loop. TorBox refreshes its own
/// status every ~5s; polling faster only burns rate limit.
pub const POLL_INTERVAL_SECS: u64 = 10;

/// Which TorBox namespace a job talks to. The two APIs are shape-identical
/// apart from the path segment and the id parameter name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebridKind {
    /// `webdl/*` — hoster / premium links.
    Web,
    /// `torrents/*` — magnets.
    Torrent,
}

impl DebridKind {
    fn path(self) -> &'static str {
        match self {
            DebridKind::Web => "webdl",
            DebridKind::Torrent => "torrents",
        }
    }

    fn id_param(self) -> &'static str {
        match self {
            DebridKind::Web => "web_id",
            DebridKind::Torrent => "torrent_id",
        }
    }
}

/// One downloadable file resolved from a debrid item, ready for the
/// direct streamer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFile {
    pub file_id: String,
    pub name: String,
    pub size: Option<u64>,
    pub url: String,
}

/// Outcome of a single readiness check. `NotReady` is the yield signal —
/// the scheduler re-queues the job with a delay instead of blocking a
/// concurrency permit while TorBox fetches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    Ready {
        /// TorBox's name for the item; used as the folder name for
        /// multi-file torrents.
        name: Option<String>,
        files: Vec<ResolvedFile>,
    },
    NotReady {
        /// TorBox's `download_state` verbatim, for the progress stage.
        state: Option<String>,
    },
}

/// `true` for magnet links — the unambiguous auto-route to TorBox.
pub fn is_magnet(url: &str) -> bool {
    let trimmed = url.trim_start();
    trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("magnet:")
}

/// `dn=` display-name from a magnet URI, when present. Used by the probe
/// card so a magnet shows its torrent name instead of the raw URI.
pub fn magnet_display_name(url: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("dn=") {
            let decoded = percent_encoding::percent_decode_str(v)
                .decode_utf8()
                .ok()?
                .replace('+', " ");
            if !decoded.trim().is_empty() {
                return Some(decoded.trim().to_string());
            }
        }
    }
    None
}

/// Domain set from `webdl/hosters`, answering "could TorBox handle this
/// hoster link?" for the fallback gate. Matches the registered domain and
/// any subdomain of it.
#[derive(Debug, Clone, Default)]
pub struct HosterMatcher {
    domains: HashSet<String>,
}

impl HosterMatcher {
    pub fn new(domains: impl IntoIterator<Item = String>) -> Self {
        Self {
            domains: domains
                .into_iter()
                .map(|d| d.to_ascii_lowercase())
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.domains.is_empty()
    }

    pub fn matches(&self, url: &str) -> bool {
        let Some(host) = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        else {
            return false;
        };
        self.domains
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
    }
}

/// Everything the debrid path needs from the host app: credentials and a
/// way to persist the TorBox item handle back into the job payload so
/// poll cycles and app restarts don't re-submit the link.
#[derive(Clone)]
pub struct DebridCtx {
    pub api_base: String,
    pub api_key: String,
    /// Called once, right after the first successful create, with the
    /// item handle (`"torrent:42"` / `"web:abc"`). The host writes it
    /// into the job's stored payload as `debrid_item`.
    pub persist_item: Arc<dyn Fn(&str) + Send + Sync>,
    /// The handle resolved earlier in THIS scheduler pickup. `dispatch`
    /// builds one `DebridCtx` per pickup and the retry loop reuses it
    /// across attempts, but the borrowed `req` still carries the
    /// pre-create value on every attempt. Without this cell, a transient
    /// failure that strikes right after a successful create (e.g. a blip
    /// mid-CDN-download) would send the retry back through the create
    /// branch and mint a SECOND TorBox item for the same link. `run`
    /// consults it before `req.debrid_item`; `remember` fills it.
    pub session_item: Arc<std::sync::Mutex<Option<String>>>,
}

impl DebridCtx {
    /// A fresh session (no handle resolved yet this pickup). Host code
    /// builds it with this; the field is populated by `remember`.
    pub fn session() -> Arc<std::sync::Mutex<Option<String>>> {
        Arc::new(std::sync::Mutex::new(None))
    }

    /// Record a just-created handle both durably (job payload, survives
    /// restart) and in-memory (this pickup's retries skip the create).
    fn remember(&self, formatted: &str) {
        (self.persist_item)(formatted);
        *self.session_item.lock().unwrap_or_else(|e| e.into_inner()) = Some(formatted.to_string());
    }

    /// The handle to reuse this attempt: an in-pickup create wins, then
    /// the payload value from an earlier pickup / restart.
    fn resolved_item(&self, req: &ExtractRequest) -> Option<String> {
        self.session_item
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| req.debrid_item.clone())
    }
}

/// Persisted handle for a TorBox item. `Queued` means TorBox accepted the
/// link but parked it in its own fetch queue (active-download limit) — no
/// pollable item exists yet, only a queue entry.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ItemHandle {
    Active(DebridKind, String),
    Queued(DebridKind, String),
}

fn parse_item(s: &str) -> Option<ItemHandle> {
    if let Some(id) = s.strip_prefix("torrent-queued:") {
        return Some(ItemHandle::Queued(DebridKind::Torrent, id.to_string()));
    }
    if let Some(id) = s.strip_prefix("web-queued:") {
        return Some(ItemHandle::Queued(DebridKind::Web, id.to_string()));
    }
    if let Some(id) = s.strip_prefix("torrent:") {
        return Some(ItemHandle::Active(DebridKind::Torrent, id.to_string()));
    }
    s.strip_prefix("web:")
        .map(|id| ItemHandle::Active(DebridKind::Web, id.to_string()))
}

fn format_item(handle: &ItemHandle) -> String {
    match handle {
        ItemHandle::Active(DebridKind::Torrent, id) => format!("torrent:{id}"),
        ItemHandle::Active(DebridKind::Web, id) => format!("web:{id}"),
        ItemHandle::Queued(DebridKind::Torrent, id) => format!("torrent-queued:{id}"),
        ItemHandle::Queued(DebridKind::Web, id) => format!("web-queued:{id}"),
    }
}

/// Sanitize one path component of a TorBox-provided name: same character
/// set as `direct::sanitize_filename` (control chars plus the
/// Windows-illegal set), with separators flattened so a component can
/// never traverse.
fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "torbox".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Sanitize a TorBox-relative file path segment-by-segment, dropping empty
/// and dot-only segments so the joined result can never escape its base
/// directory. Multi-file torrents keep their internal folder structure —
/// flattening would let same-named files in different subfolders collide
/// (and the size-based skip check would then silently drop one).
fn sanitize_rel_path(name: &str) -> String {
    let parts: Vec<String> = name
        .split(['/', '\\'])
        .filter(|s| {
            let t = s.trim().trim_matches('.');
            !t.is_empty()
        })
        .map(sanitize_component)
        .collect();
    if parts.is_empty() {
        "torbox".to_string()
    } else {
        parts.join("/")
    }
}

/// Run one dispatch cycle of a debrid job: ensure the item exists on
/// TorBox, check readiness once, and either download every resolved file
/// through the direct streamer or yield with `WaitingExternal` so the
/// scheduler parks the job without holding a permit.
pub async fn run(
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    ctx: &DebridCtx,
) -> Result<BackendOutcome, GoopError> {
    let start = Instant::now();
    let client = TorBoxClient::new(&ctx.api_base, &ctx.api_key);

    // One create per link, ever, per handle state: a fresh job creates and
    // persists the handle; a queued handle is only re-created once TorBox's
    // own queue releases it. The RESOLVED handle — the in-pickup cell first,
    // then the persisted payload — owns the create, never the retry loop, so
    // poll cycles and post-create transient retries can't hammer the
    // rate-limited create endpoints (see `DebridCtx::session_item`).
    let (kind, id) = match ctx.resolved_item(req).as_deref().and_then(parse_item) {
        Some(ItemHandle::Active(kind, id)) => (kind, id),
        Some(ItemHandle::Queued(kind, qid)) => {
            if client.queued_still_pending(kind, &qid).await? {
                return Err(yield_waiting(
                    &sink,
                    job_id,
                    "waiting on TorBox (queued for a slot)".to_string(),
                ));
            }
            // The queue entry is gone: TorBox promoted it to an active
            // item. Re-submitting the same link returns that item's id
            // (and cannot re-queue — a slot was just consumed by it).
            let handle = create_item(&client, &req.url).await?;
            ctx.remember(&format_item(&handle));
            match handle {
                ItemHandle::Active(kind, id) => (kind, id),
                ItemHandle::Queued(..) => {
                    return Err(yield_waiting(
                        &sink,
                        job_id,
                        "waiting on TorBox (queued for a slot)".to_string(),
                    ));
                }
            }
        }
        None => {
            let handle = create_item(&client, &req.url).await?;
            ctx.remember(&format_item(&handle));
            match handle {
                ItemHandle::Active(kind, id) => (kind, id),
                ItemHandle::Queued(..) => {
                    return Err(yield_waiting(
                        &sink,
                        job_id,
                        "waiting on TorBox (queued for a slot)".to_string(),
                    ));
                }
            }
        }
    };

    if let Some(int) = signals.check() {
        return Err(match int {
            goop_core::Interrupt::Cancel => GoopError::Cancelled,
            goop_core::Interrupt::Pause => GoopError::Paused,
        });
    }

    match client.check_ready(kind, &id).await? {
        CheckOutcome::NotReady { state } => {
            let stage = match state {
                Some(s) => format!("waiting on TorBox ({s})"),
                None => "waiting on TorBox".to_string(),
            };
            Err(yield_waiting(&sink, job_id, stage))
        }
        CheckOutcome::Ready { name, files } => {
            download_resolved(sink, job_id, req, signals, name, files, start).await
        }
    }
}

/// Emit the waiting stage and build the scheduler yield error.
fn yield_waiting(sink: &Arc<dyn EventSink>, job_id: JobId, stage: String) -> GoopError {
    sink.emit_progress(ProgressEvent {
        job_id,
        percent: 0.0,
        eta_secs: Some(POLL_INTERVAL_SECS),
        speed_hr: None,
        stage,
        encoder: None,
    });
    GoopError::WaitingExternal {
        retry_after_ms: POLL_INTERVAL_SECS * 1000,
    }
}

/// Submit a link to TorBox, returning the resulting handle (active item
/// or a slot-queue entry).
async fn create_item(client: &TorBoxClient, url: &str) -> Result<ItemHandle, GoopError> {
    if is_magnet(url) {
        client.create_torrent(url).await
    } else {
        client.create_web_download(url).await
    }
}

/// Best-effort remote cancel for a cancelled debrid job: tell TorBox to
/// stop fetching / drop the item so it doesn't keep consuming the
/// account's active-download slots. The caller logs failures — the local
/// cancel must never block on this.
pub async fn remote_cancel(api_base: &str, api_key: &str, item: &str) -> Result<(), GoopError> {
    let client = TorBoxClient::new(api_base, api_key);
    match parse_item(item) {
        Some(ItemHandle::Active(kind, id)) => client.control_delete(kind, &id).await,
        Some(ItemHandle::Queued(kind, qid)) => client.control_queued_delete(kind, &qid).await,
        None => Ok(()),
    }
}

/// Stream every resolved file through the direct downloader. Single files
/// land in the job's output dir like any direct download. Multi-file
/// items keep TorBox's internal folder structure (season/disc subfolders
/// survive, and same-named files in different subfolders can't collide);
/// when the file paths don't already share a common root folder, one is
/// created from the TorBox item name. Files that already exist at their
/// full path with the expected size are skipped so a resumed job doesn't
/// duplicate finished files.
async fn download_resolved(
    sink: Arc<dyn EventSink>,
    job_id: JobId,
    req: &ExtractRequest,
    signals: JobSignals,
    name: Option<String>,
    files: Vec<ResolvedFile>,
    start: Instant,
) -> Result<BackendOutcome, GoopError> {
    let multi = files.len() > 1;
    let out_root = goop_core::path::expand(&req.output_dir);

    // Torrent file paths usually carry the release name as their first
    // segment; reuse it as the folder. Otherwise wrap loose files in a
    // folder named after the item.
    let common_root: Option<String> = files
        .first()
        .and_then(|f| f.name.split('/').next())
        .filter(|root| {
            files.len() > 1
                && files
                    .iter()
                    .all(|f| f.name.split('/').next() == Some(root) && f.name.contains('/'))
        })
        .map(str::to_string);

    let (base, result_dir) = if multi {
        match &common_root {
            Some(root) => (out_root.clone(), out_root.join(root)),
            None => {
                let folder = out_root.join(sanitize_component(name.as_deref().unwrap_or("torbox")));
                (folder.clone(), folder)
            }
        }
    } else {
        (out_root.clone(), out_root)
    };

    let total = files.len() as u32;
    let mut bytes: u64 = 0;
    let mut last_path = result_dir.to_string_lossy().into_owned();

    for (i, f) in files.into_iter().enumerate() {
        if let Some(int) = signals.check() {
            return Err(match int {
                goop_core::Interrupt::Cancel => GoopError::Cancelled,
                goop_core::Interrupt::Pause => GoopError::Paused,
            });
        }

        // `f.name` is a sanitized relative path (see `check_ready`), so
        // this join cannot escape `base`.
        let dest = base.join(&f.name);
        let file_dir = dest.parent().unwrap_or(&base).to_path_buf();
        tokio::fs::create_dir_all(&file_dir).await?;
        let basename = dest
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| f.name.clone());

        if let (Ok(meta), Some(size)) = (tokio::fs::metadata(&dest).await, f.size) {
            if meta.is_file() && meta.len() == size {
                bytes += size;
                continue;
            }
        }

        if multi {
            sink.emit_progress(ProgressEvent {
                job_id,
                percent: (i as f32 / total as f32) * 100.0,
                eta_secs: None,
                speed_hr: None,
                stage: format!("file {}/{total}", i + 1),
                encoder: None,
            });
        }

        // Child request for the direct streamer: CDN URL, stable resume
        // key derived from the original link (+ file id when multi), and
        // the TorBox-provided filename.
        let child = ExtractRequest {
            url: f.url.clone(),
            output_dir: file_dir.to_string_lossy().into_owned(),
            resume_key: Some(if multi {
                format!("{}#{}", req.url, f.file_id)
            } else {
                req.url.clone()
            }),
            filename_hint: Some(basename),
            direct: true,
            debrid: false,
            debrid_item: None,
            ..req.clone()
        };
        let outcome =
            crate::direct::download(sink.clone(), job_id, &child, signals.clone()).await?;
        bytes += outcome.bytes;
        last_path = outcome.output_path;
    }

    Ok(BackendOutcome {
        output_path: if multi {
            result_dir.to_string_lossy().into_owned()
        } else {
            last_path
        },
        bytes,
        duration_ms: start.elapsed().as_millis() as u64,
        result_kind: if multi {
            ResultKindTag::Folder
        } else {
            ResultKindTag::File
        },
        file_count: total,
    })
}

/// Thin TorBox REST client. One instance per resolve/poll call is fine —
/// reqwest pools connections internally.
pub struct TorBoxClient {
    http: reqwest::Client,
    base: String,
    key: String,
}

/// Every TorBox response, success or failure, arrives in this envelope.
#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    data: Option<T>,
}

/// TorBox is inconsistent about id types across endpoints (`torrent_id`
/// is a number, `webdownload_id` a string) — accept either and normalize.
#[derive(Deserialize)]
#[serde(untagged)]
enum IdVal {
    Num(u64),
    Str(String),
}

impl IdVal {
    fn into_string(self) -> String {
        match self {
            IdVal::Num(n) => n.to_string(),
            IdVal::Str(s) => s,
        }
    }
}

#[derive(Deserialize)]
struct CreateData {
    #[serde(default)]
    torrent_id: Option<IdVal>,
    #[serde(default)]
    webdownload_id: Option<IdVal>,
    #[serde(default)]
    queued_id: Option<IdVal>,
}

#[derive(Deserialize)]
struct StatusData {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    download_state: Option<String>,
    #[serde(default)]
    download_present: Option<bool>,
    #[serde(default)]
    download_finished: Option<bool>,
    #[serde(default)]
    files: Option<Vec<FileData>>,
}

#[derive(Deserialize)]
struct FileData {
    id: IdVal,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    short_name: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct HosterData {
    #[serde(default)]
    domains: Vec<String>,
}

impl TorBoxClient {
    pub fn new(base: impl Into<String>, key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client with static config");
        Self {
            http,
            base: base.into(),
            key: key.into(),
        }
    }

    /// Supported-hoster domains for the fallback gate. Auth optional per
    /// the API; we send the key anyway for the live usage columns.
    pub async fn hosters(&self) -> Result<HosterMatcher, GoopError> {
        let hosters: Vec<HosterData> = self.get(&format!("{}/webdl/hosters", self.base)).await?;
        Ok(HosterMatcher::new(
            hosters.into_iter().flat_map(|h| h.domains),
        ))
    }

    /// Submit a hoster link. A queued-only response (TorBox's own fetch
    /// queue is full) comes back as `ItemHandle::Queued` so the caller
    /// persists it instead of re-submitting on every poll.
    async fn create_web_download(&self, link: &str) -> Result<ItemHandle, GoopError> {
        let data: CreateData = self
            .post_form(
                &format!("{}/webdl/createwebdownload", self.base),
                &[("link", link)],
            )
            .await?;
        if let Some(id) = data.webdownload_id {
            return Ok(ItemHandle::Active(DebridKind::Web, id.into_string()));
        }
        if let Some(qid) = data.queued_id {
            return Ok(ItemHandle::Queued(DebridKind::Web, qid.into_string()));
        }
        Err(GoopError::Queue(
            "TorBox: create web download returned no id".into(),
        ))
    }

    /// Submit a magnet. Same queued-handle contract as
    /// [`Self::create_web_download`].
    async fn create_torrent(&self, magnet: &str) -> Result<ItemHandle, GoopError> {
        let data: CreateData = self
            .post_form(
                &format!("{}/torrents/createtorrent", self.base),
                &[("magnet", magnet)],
            )
            .await?;
        if let Some(id) = data.torrent_id {
            return Ok(ItemHandle::Active(DebridKind::Torrent, id.into_string()));
        }
        if let Some(qid) = data.queued_id {
            return Ok(ItemHandle::Queued(DebridKind::Torrent, qid.into_string()));
        }
        Err(GoopError::Queue(
            "TorBox: create torrent returned no id".into(),
        ))
    }

    /// `true` while the slot-queue entry is still listed under
    /// `getqueued` — i.e. TorBox hasn't promoted the item to an active
    /// download yet.
    async fn queued_still_pending(&self, kind: DebridKind, qid: &str) -> Result<bool, GoopError> {
        #[derive(Deserialize)]
        struct QueuedEntry {
            id: IdVal,
        }
        let entries: Vec<QueuedEntry> = self
            .get(&format!("{}/{}/getqueued", self.base, kind.path()))
            .await?;
        Ok(entries.into_iter().any(|e| e.id.into_string() == qid))
    }

    /// One readiness check. Ready ⇒ every file's CDN URL is resolved and
    /// the result can go straight to the direct streamer.
    pub async fn check_ready(&self, kind: DebridKind, id: &str) -> Result<CheckOutcome, GoopError> {
        let status: StatusData = self
            .get(&format!(
                "{}/{}/mylist?id={}&bypass_cache=true",
                self.base,
                kind.path(),
                id
            ))
            .await?;

        let ready =
            status.download_present.unwrap_or(false) || status.download_finished.unwrap_or(false);
        if !ready {
            return Ok(CheckOutcome::NotReady {
                state: status.download_state,
            });
        }

        let mut files = Vec::new();
        for f in status.files.unwrap_or_default() {
            let file_id = f.id.into_string();
            let url = self.request_link(kind, id, &file_id).await?;
            // Prefer the full relative path (`name`) so multi-file items
            // keep their folder structure; `short_name` is the basename
            // fallback. Either way the value is external input destined
            // for a filesystem join — sanitize per segment.
            let name = sanitize_rel_path(
                &f.name
                    .or(f.short_name)
                    .unwrap_or_else(|| format!("file-{file_id}")),
            );
            files.push(ResolvedFile {
                file_id,
                name,
                size: f.size,
                url,
            });
        }
        if files.is_empty() {
            return Err(GoopError::Queue(
                "TorBox reports the item ready but lists no files".into(),
            ));
        }
        Ok(CheckOutcome::Ready {
            name: status.name,
            files,
        })
    }

    /// Ask TorBox to stop fetching / drop an active item.
    async fn control_delete(&self, kind: DebridKind, id: &str) -> Result<(), GoopError> {
        let path = match kind {
            DebridKind::Web => "controlwebdownload",
            DebridKind::Torrent => "controltorrent",
        };
        let _: serde_json::Value = self
            .post_json(
                &format!("{}/{}/{}", self.base, kind.path(), path),
                &serde_json::json!({ f_id_key(kind): id, "operation": "delete" }),
            )
            .await?;
        Ok(())
    }

    /// Drop an entry from TorBox's slot queue.
    async fn control_queued_delete(&self, kind: DebridKind, qid: &str) -> Result<(), GoopError> {
        let _: serde_json::Value = self
            .post_json(
                &format!("{}/{}/controlqueued", self.base, kind.path()),
                &serde_json::json!({ "queued_id": qid, "operation": "delete" }),
            )
            .await?;
        Ok(())
    }

    /// Generate the temporary CDN URL for one file.
    async fn request_link(
        &self,
        kind: DebridKind,
        id: &str,
        file_id: &str,
    ) -> Result<String, GoopError> {
        // requestdl authenticates via query token, not the Bearer header.
        let url: String = self
            .get(&format!(
                "{}/{}/requestdl?token={}&{}={}&file_id={}",
                self.base,
                kind.path(),
                self.key,
                kind.id_param(),
                id,
                file_id
            ))
            .await?;
        Ok(url)
    }

    /// Strip the API key from an error before it can propagate. reqwest's
    /// error `Display` echoes the failing URL, and `requestdl` carries the
    /// key as a query param — without this, a transport failure would
    /// persist the key into the job's error message (History + queue DB)
    /// and any log line along the way.
    fn redact(&self, e: GoopError) -> GoopError {
        let scrub = |m: String| m.replace(&self.key, "[redacted]");
        match e {
            GoopError::Network(m) => GoopError::Network(scrub(m)),
            GoopError::Queue(m) => GoopError::Queue(scrub(m)),
            other => other,
        }
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, GoopError> {
        let resp = self
            .http
            .get(url)
            .header("authorization", format!("Bearer {}", self.key))
            .send()
            .await
            .map_err(|e| self.redact(classify_reqwest(e)))?;
        self.decode(resp).await
    }

    async fn post_form<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        form: &[(&str, &str)],
    ) -> Result<T, GoopError> {
        let resp = self
            .http
            .post(url)
            .header("authorization", format!("Bearer {}", self.key))
            .form(form)
            .send()
            .await
            .map_err(|e| self.redact(classify_reqwest(e)))?;
        self.decode(resp).await
    }

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<T, GoopError> {
        let resp = self
            .http
            .post(url)
            .header("authorization", format!("Bearer {}", self.key))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| self.redact(classify_reqwest(e)))?;
        self.decode(resp).await
    }

    async fn decode<T: serde::de::DeserializeOwned>(
        &self,
        resp: reqwest::Response,
    ) -> Result<T, GoopError> {
        let status = resp.status();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| self.redact(classify_reqwest(e)))?;

        // Prefer the envelope's own error report when it parses — TorBox
        // sends structured errors with both 200 and non-2xx statuses.
        if let Ok(env) = serde_json::from_slice::<Envelope<T>>(&bytes) {
            if env.success {
                if let Some(data) = env.data {
                    return Ok(data);
                }
                return Err(GoopError::Queue(
                    "TorBox: success response carried no data".into(),
                ));
            }
            return Err(envelope_error(status, env.error, env.detail));
        }

        if !status.is_success() {
            return Err(status_error(status));
        }
        Err(GoopError::Queue(format!(
            "TorBox: unparseable response ({} bytes)",
            bytes.len()
        )))
    }
}

fn f_id_key(kind: DebridKind) -> &'static str {
    match kind {
        DebridKind::Web => "webdl_id",
        DebridKind::Torrent => "torrent_id",
    }
}

/// Transport-failure classifier — same shape as `direct::classify_reqwest`:
/// non-TLS timeouts and connect failures retry, everything else (TLS,
/// builder, body/decode errors) is permanent.
fn classify_reqwest(e: reqwest::Error) -> GoopError {
    let msg = format!("TorBox: request: {e}");
    let tls = format!("{e:?}")
        .to_ascii_lowercase()
        .contains("certificate");
    if (e.is_timeout() || e.is_connect()) && !tls {
        GoopError::Network(msg)
    } else {
        GoopError::Queue(msg)
    }
}

fn status_error(status: reqwest::StatusCode) -> GoopError {
    let msg = format!("TorBox: HTTP {status}");
    if transient_status(status) {
        GoopError::Network(msg)
    } else {
        GoopError::Queue(msg)
    }
}

/// Map a parsed `success: false` envelope. Auth failures get a pointer at
/// the Settings fix; explicitly transient server-side conditions retry;
/// everything else is permanent with TorBox's own words.
fn envelope_error(
    status: reqwest::StatusCode,
    error: Option<String>,
    detail: Option<String>,
) -> GoopError {
    let code = error.unwrap_or_default();
    let detail = detail.unwrap_or_else(|| "no detail".into());
    if matches!(
        code.as_str(),
        "BAD_TOKEN" | "AUTH_ERROR" | "OAUTH_VERIFICATION_ERROR"
    ) {
        return GoopError::Queue(format!(
            "TorBox rejected the API key ({detail}) — check Settings → TorBox API key"
        ));
    }
    if matches!(
        code.as_str(),
        "DATABASE_ERROR" | "UNKNOWN_ERROR" | "SERVER_ERROR" | "RATE_LIMIT" | "TOO_MANY_REQUESTS"
    ) || transient_status(status)
    {
        return GoopError::Network(format!("TorBox: {code}: {detail}"));
    }
    GoopError::Queue(format!("TorBox: {code}: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use goop_core::events::RecordingSink;
    use std::sync::Mutex;
    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ok_body(data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "success": true, "error": null, "detail": "ok", "data": data })
    }

    fn test_req(url: &str, dir: &std::path::Path, item: Option<&str>) -> ExtractRequest {
        ExtractRequest {
            url: url.to_string(),
            output_dir: dir.to_string_lossy().into_owned(),
            format: None,
            audio_only: false,
            cookies_from_browser: None,
            output_template: None,
            direct: false,
            debrid: true,
            debrid_item: item.map(str::to_string),
            resume_key: None,
            filename_hint: None,
        }
    }

    fn ctx_with_recorder(base: String) -> (DebridCtx, Arc<Mutex<Vec<String>>>) {
        let persisted = Arc::new(Mutex::new(Vec::new()));
        let p = persisted.clone();
        let ctx = DebridCtx {
            api_base: base,
            api_key: "k".into(),
            session_item: DebridCtx::session(),
            persist_item: Arc::new(move |item| p.lock().unwrap().push(item.to_string())),
        };
        (ctx, persisted)
    }

    #[tokio::test]
    async fn run_creates_persists_then_yields_while_not_ready() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/torrents/createtorrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!({ "torrent_id": 7, "queued_id": null }),
            )))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                    "id": 7,
                    "name": "slow-fetch",
                    "download_state": "metaDL",
                    "download_present": false,
                    "download_finished": false,
                    "files": [],
                }))),
            )
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let (ctx, persisted) = ctx_with_recorder(server.uri());
        let rec = Arc::new(RecordingSink::new());
        let req = test_req("magnet:?xt=urn:btih:abc", dir.path(), None);

        let err = run(rec.clone(), JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                GoopError::WaitingExternal {
                    retry_after_ms: 10_000
                }
            ),
            "got {err:?}"
        );
        assert_eq!(persisted.lock().unwrap().as_slice(), ["torrent:7"]);
        let stages: Vec<String> = rec
            .progress
            .lock()
            .iter()
            .map(|e| e.stage.clone())
            .collect();
        assert!(
            stages.iter().any(|s| s.contains("waiting on TorBox")),
            "got stages {stages:?}"
        );
    }

    #[tokio::test]
    async fn run_reuses_persisted_item_and_downloads_single_file() {
        let server = MockServer::start().await;
        // No createtorrent mock: a create call would 404 and fail the test.
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                "id": 7,
                "name": "one-file",
                "download_state": "completed",
                "download_present": true,
                "download_finished": true,
                "files": [ { "id": 3, "name": "payload.bin", "short_name": "payload.bin", "size": 10 } ],
            }))))
            .mount(&server)
            .await;
        let cdn = format!("{}/cdn/payload", server.uri());
        Mock::given(method("GET"))
            .and(path("/torrents/requestdl"))
            .and(query_param("torrent_id", "7"))
            .and(query_param("file_id", "3"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(ok_body(serde_json::Value::String(cdn.clone()))),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/cdn/payload"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"helloworld".to_vec()))
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let (ctx, persisted) = ctx_with_recorder(server.uri());
        let rec = Arc::new(RecordingSink::new());
        let req = test_req("magnet:?xt=urn:btih:abc", dir.path(), Some("torrent:7"));

        let outcome = run(rec, JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap();
        assert!(
            persisted.lock().unwrap().is_empty(),
            "no re-create, no re-persist"
        );
        assert_eq!(outcome.bytes, 10);
        assert_eq!(outcome.file_count, 1);
        assert_eq!(outcome.result_kind, ResultKindTag::File);
        let written = std::fs::read(dir.path().join("payload.bin")).unwrap();
        assert_eq!(written, b"helloworld");
    }

    #[tokio::test]
    async fn run_downloads_multi_file_into_named_folder_and_skips_complete_files() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                    "id": 9,
                    "name": "my album",
                    "download_state": "cached",
                    "download_present": true,
                    "download_finished": true,
                    "files": [
                        { "id": 0, "short_name": "a.txt", "size": 4 },
                        { "id": 1, "short_name": "b.txt", "size": 4 },
                    ],
                }))),
            )
            .mount(&server)
            .await;
        for fid in ["0", "1"] {
            let cdn_path = format!("/cdn/{fid}");
            Mock::given(method("GET"))
                .and(path("/torrents/requestdl"))
                .and(query_param("file_id", fid))
                .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                    serde_json::Value::String(format!("{}{cdn_path}", server.uri())),
                )))
                .mount(&server)
                .await;
        }
        // Only file 1 should ever be fetched from the CDN — file 0 already
        // exists on disk with the right size.
        Mock::given(method("GET"))
            .and(path("/cdn/1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"bbbb".to_vec()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/cdn/0"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"aaaa".to_vec()))
            .expect(0)
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let folder = dir.path().join("my album");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("a.txt"), b"aaaa").unwrap();

        let (ctx, _persisted) = ctx_with_recorder(server.uri());
        let rec = Arc::new(RecordingSink::new());
        let req = test_req("magnet:?xt=urn:btih:zzz", dir.path(), Some("torrent:9"));

        let outcome = run(rec, JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap();
        assert_eq!(outcome.result_kind, ResultKindTag::Folder);
        assert_eq!(outcome.file_count, 2);
        assert_eq!(outcome.bytes, 8);
        assert_eq!(std::fs::read(folder.join("b.txt")).unwrap(), b"bbbb");
        assert!(outcome.output_path.ends_with("my album"));
    }

    #[tokio::test]
    async fn multi_file_keeps_subfolders_so_same_basenames_cannot_collide() {
        let server = MockServer::start().await;
        // Season-pack shape: same basename + same size in two subfolders.
        // A flattening implementation would skip the second file silently.
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                    "id": 5,
                    "name": "show",
                    "download_state": "cached",
                    "download_present": true,
                    "download_finished": true,
                    "files": [
                        { "id": 0, "name": "show/s1/ep.mkv", "short_name": "ep.mkv", "size": 4 },
                        { "id": 1, "name": "show/s2/ep.mkv", "short_name": "ep.mkv", "size": 4 },
                    ],
                }))),
            )
            .mount(&server)
            .await;
        for (fid, body) in [("0", b"s1s1".to_vec()), ("1", b"s2s2".to_vec())] {
            Mock::given(method("GET"))
                .and(path("/torrents/requestdl"))
                .and(query_param("file_id", fid))
                .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                    serde_json::Value::String(format!("{}/cdn/{fid}", server.uri())),
                )))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path(format!("/cdn/{fid}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
                .expect(1)
                .mount(&server)
                .await;
        }

        let dir = TempDir::new().unwrap();
        let (ctx, _persisted) = ctx_with_recorder(server.uri());
        let rec = Arc::new(RecordingSink::new());
        let req = test_req("magnet:?xt=urn:btih:show", dir.path(), Some("torrent:5"));

        let outcome = run(rec, JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap();
        assert_eq!(outcome.file_count, 2);
        assert_eq!(outcome.bytes, 8);
        assert_eq!(
            std::fs::read(dir.path().join("show/s1/ep.mkv")).unwrap(),
            b"s1s1"
        );
        assert_eq!(
            std::fs::read(dir.path().join("show/s2/ep.mkv")).unwrap(),
            b"s2s2"
        );
        assert!(outcome.output_path.ends_with("show"));
    }

    #[test]
    fn sanitize_rel_path_neutralizes_traversal_and_hostile_names() {
        assert_eq!(sanitize_rel_path("../../etc/passwd"), "etc/passwd");
        assert_eq!(sanitize_rel_path("a/./b"), "a/b");
        assert_eq!(sanitize_rel_path("a\\b:c*d.txt"), "a/b_c_d.txt");
        assert_eq!(sanitize_rel_path("..."), "torbox");
        assert_eq!(sanitize_rel_path(""), "torbox");
    }

    #[test]
    fn magnet_detection_is_scheme_based() {
        assert!(is_magnet("magnet:?xt=urn:btih:abc"));
        assert!(is_magnet("  MAGNET:?xt=urn:btih:abc"));
        assert!(!is_magnet("https://example.com/magnet:fake"));
        assert!(!is_magnet("http://example.com/file.bin"));
    }

    #[test]
    fn hoster_matcher_matches_domain_and_subdomains_only() {
        let m = HosterMatcher::new(vec!["rapidgator.net".to_string(), "rg.to".to_string()]);
        assert!(m.matches("https://rapidgator.net/file/abc"));
        assert!(m.matches("https://www.RAPIDGATOR.net/file/abc"));
        assert!(m.matches("http://rg.to/x"));
        assert!(!m.matches("https://notrapidgator.net/file"));
        assert!(!m.matches("https://rapidgator.net.evil.com/file"));
        assert!(!m.matches("not a url"));
    }

    #[tokio::test]
    async fn create_torrent_sends_bearer_auth_and_returns_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/torrents/createtorrent"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!({ "torrent_id": 42, "hash": "aa", "queued_id": null }),
            )))
            .expect(1)
            .mount(&server)
            .await;

        let client = TorBoxClient::new(server.uri(), "test-key");
        let handle = client
            .create_torrent("magnet:?xt=urn:btih:abc")
            .await
            .unwrap();
        assert_eq!(handle, ItemHandle::Active(DebridKind::Torrent, "42".into()));
    }

    #[tokio::test]
    async fn create_web_download_accepts_string_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/webdl/createwebdownload"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!({ "webdownload_id": "web-77", "hash": "bb" }),
            )))
            .mount(&server)
            .await;

        let client = TorBoxClient::new(server.uri(), "k");
        let handle = client
            .create_web_download("https://host.example/f")
            .await
            .unwrap();
        assert_eq!(handle, ItemHandle::Active(DebridKind::Web, "web-77".into()));
    }

    #[tokio::test]
    async fn queued_torrent_persists_the_queue_handle_and_never_recreates() {
        let server = MockServer::start().await;
        // Exactly ONE create, ever — subsequent cycles must poll getqueued
        // with the persisted handle instead of re-submitting (createtorrent
        // is rate-limited).
        Mock::given(method("POST"))
            .and(path("/torrents/createtorrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!({ "torrent_id": null, "queued_id": 9 }),
            )))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/torrents/getqueued"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!([ { "id": 9, "magnet": "magnet:?xt=x" } ]),
            )))
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let (ctx, persisted) = ctx_with_recorder(server.uri());
        let rec = Arc::new(RecordingSink::new());

        // Cycle 1: fresh job → create → queued handle persisted → yield.
        let req = test_req("magnet:?xt=x", dir.path(), None);
        let err = run(rec.clone(), JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap_err();
        assert!(
            matches!(err, GoopError::WaitingExternal { .. }),
            "got {err:?}"
        );
        assert_eq!(persisted.lock().unwrap().as_slice(), ["torrent-queued:9"]);

        // Cycle 2: persisted handle, still queued → yield again, NO create.
        let req = test_req("magnet:?xt=x", dir.path(), Some("torrent-queued:9"));
        let err = run(rec.clone(), JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap_err();
        assert!(
            matches!(err, GoopError::WaitingExternal { .. }),
            "got {err:?}"
        );
        let stages: Vec<String> = rec
            .progress
            .lock()
            .iter()
            .map(|e| e.stage.clone())
            .collect();
        assert!(
            stages.iter().any(|s| s.contains("queued for a slot")),
            "got stages {stages:?}"
        );
    }

    #[tokio::test]
    async fn promoted_queued_torrent_recreates_once_and_proceeds() {
        let server = MockServer::start().await;
        // The queue entry is gone → one re-create resolves the active id.
        Mock::given(method("GET"))
            .and(path("/torrents/getqueued"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!([]))))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/torrents/createtorrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!({ "torrent_id": 42, "queued_id": null }),
            )))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                    "id": 42,
                    "name": "promoted",
                    "download_state": "downloading",
                    "download_present": false,
                    "download_finished": false,
                    "files": [],
                }))),
            )
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let (ctx, persisted) = ctx_with_recorder(server.uri());
        let rec = Arc::new(RecordingSink::new());
        let req = test_req("magnet:?xt=x", dir.path(), Some("torrent-queued:9"));

        let err = run(rec, JobId::new(), &req, JobSignals::new(), &ctx)
            .await
            .unwrap_err();
        assert!(
            matches!(err, GoopError::WaitingExternal { .. }),
            "got {err:?}"
        );
        assert_eq!(persisted.lock().unwrap().as_slice(), ["torrent:42"]);
    }

    #[tokio::test]
    async fn transient_failure_after_create_does_not_recreate_on_retry() {
        // Regression: a transient error striking right after a successful
        // create must NOT re-fire createtorrent when the retry loop re-runs
        // `run` with the same `DebridCtx` — otherwise it mints a duplicate
        // TorBox item and leaks an account slot. Two `run` calls sharing one
        // ctx model exactly what `with_retry` does across attempts.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/torrents/createtorrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::json!({ "torrent_id": 100, "queued_id": null }),
            )))
            .expect(1) // exactly one create across BOTH attempts
            .mount(&server)
            .await;
        // Attempt 1: mylist flakes once (503 → transient Network error).
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        // Attempt 2: mylist ready with one file.
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                    "id": 100,
                    "name": "f",
                    "download_state": "cached",
                    "download_present": true,
                    "download_finished": true,
                    "files": [ { "id": 0, "short_name": "f.bin", "size": 4 } ],
                }))),
            )
            .with_priority(5)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/torrents/requestdl"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                serde_json::Value::String(format!("{}/cdn/0", server.uri())),
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/cdn/0"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"data".to_vec()))
            .mount(&server)
            .await;

        let dir = TempDir::new().unwrap();
        let (ctx, persisted) = ctx_with_recorder(server.uri());
        let req = test_req("magnet:?xt=x", dir.path(), None);

        let err = run(
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            &ctx,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, GoopError::Network(_)),
            "attempt 1 should transiently fail, got {err:?}"
        );

        let outcome = run(
            Arc::new(RecordingSink::new()),
            JobId::new(),
            &req,
            JobSignals::new(),
            &ctx,
        )
        .await
        .unwrap();
        assert_eq!(outcome.file_count, 1);
        // Create persisted exactly once; the mock's `.expect(1)` enforces the
        // create-call count when the server drops at end of test.
        assert_eq!(persisted.lock().unwrap().as_slice(), ["torrent:100"]);
    }

    #[tokio::test]
    async fn transport_errors_never_contain_the_api_key() {
        // requestdl carries the key as a query param, and reqwest's error
        // Display echoes the failing URL — the client must scrub it.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let client = TorBoxClient::new(format!("http://127.0.0.1:{port}"), "sekret-key-123");
        let err = client
            .request_link(DebridKind::Torrent, "42", "0")
            .await
            .unwrap_err();
        let msg = format!("{err}");
        assert!(
            !msg.contains("sekret-key-123"),
            "API key leaked into the error message: {msg}"
        );
        assert!(
            msg.contains("[redacted]"),
            "redaction marker missing (URL should still be visible): {msg}"
        );
    }

    #[tokio::test]
    async fn check_ready_yields_not_ready_while_torbox_fetches() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .and(query_param("id", "42"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                    "id": 42,
                    "name": "linux-iso",
                    "download_state": "downloading",
                    "download_present": false,
                    "download_finished": false,
                    "files": [],
                }))),
            )
            .mount(&server)
            .await;

        let client = TorBoxClient::new(server.uri(), "k");
        let out = client.check_ready(DebridKind::Torrent, "42").await.unwrap();
        assert_eq!(
            out,
            CheckOutcome::NotReady {
                state: Some("downloading".into())
            }
        );
    }

    #[tokio::test]
    async fn check_ready_resolves_every_file_via_requestdl() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/torrents/mylist"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!({
                "id": 42,
                "name": "album",
                "download_state": "completed",
                "download_present": true,
                "download_finished": true,
                "files": [
                    { "id": 0, "name": "album/track01.flac", "short_name": "track01.flac", "size": 111 },
                    { "id": 1, "name": "album/track02.flac", "short_name": "track02.flac", "size": 222 },
                ],
            }))))
            .mount(&server)
            .await;
        for fid in ["0", "1"] {
            Mock::given(method("GET"))
                .and(path("/torrents/requestdl"))
                .and(query_param("token", "k"))
                .and(query_param("torrent_id", "42"))
                .and(query_param("file_id", fid))
                .respond_with(ResponseTemplate::new(200).set_body_json(ok_body(
                    serde_json::Value::String(format!("https://cdn.torbox.app/dl/{fid}")),
                )))
                .expect(1)
                .mount(&server)
                .await;
        }

        let client = TorBoxClient::new(server.uri(), "k");
        let out = client.check_ready(DebridKind::Torrent, "42").await.unwrap();
        let CheckOutcome::Ready { name, files } = out else {
            panic!("expected Ready, got {out:?}");
        };
        assert_eq!(name.as_deref(), Some("album"));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "album/track01.flac");
        assert_eq!(files[0].url, "https://cdn.torbox.app/dl/0");
        assert_eq!(files[1].size, Some(222));
    }

    #[tokio::test]
    async fn bad_token_envelope_is_permanent_and_points_at_settings() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/torrents/createtorrent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": false,
                "error": "BAD_TOKEN",
                "detail": "Your token is invalid or has expired.",
                "data": null,
            })))
            .mount(&server)
            .await;

        let client = TorBoxClient::new(server.uri(), "stale");
        let err = client.create_torrent("magnet:?xt=x").await.unwrap_err();
        match err {
            GoopError::Queue(msg) => assert!(msg.contains("API key"), "got: {msg}"),
            other => panic!("expected permanent Queue error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_429_and_500_are_transient_other_4xx_permanent() {
        for (code, want_network) in [(429u16, true), (500, true), (404, false)] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/torrents/mylist"))
                .respond_with(ResponseTemplate::new(code))
                .mount(&server)
                .await;
            let client = TorBoxClient::new(server.uri(), "k");
            let err = client
                .check_ready(DebridKind::Torrent, "1")
                .await
                .unwrap_err();
            match (want_network, &err) {
                (true, GoopError::Network(_)) | (false, GoopError::Queue(_)) => {}
                _ => panic!("HTTP {code}: unexpected mapping {err:?}"),
            }
        }
    }

    #[tokio::test]
    async fn connection_refused_is_transient() {
        // Bind-then-drop a plain listener to get a port nothing serves.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };

        let client = TorBoxClient::new(format!("http://127.0.0.1:{port}"), "k");
        let err = client
            .check_ready(DebridKind::Torrent, "1")
            .await
            .unwrap_err();
        assert!(matches!(err, GoopError::Network(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn hosters_flattens_all_domain_lists() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/webdl/hosters"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(ok_body(serde_json::json!([
                    { "id": 1, "name": "Rapidgator", "domains": ["rapidgator.net", "rg.to"] },
                    { "id": 2, "name": "Other", "domains": ["other.example"] },
                ]))),
            )
            .mount(&server)
            .await;

        let client = TorBoxClient::new(server.uri(), "k");
        let m = client.hosters().await.unwrap();
        assert!(m.matches("https://rg.to/x"));
        assert!(m.matches("https://cdn.other.example/y"));
        assert!(!m.matches("https://unrelated.example/z"));
    }
}
