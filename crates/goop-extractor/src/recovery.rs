//! Durable, private extraction workspaces. Public request fields never carry ownership.
use crate::ytdlp::ExtractRequest;
use goop_core::{GoopError, JobId, JobSignals};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const RECOVERY_PAYLOAD_KEY: &str = "_extract_recovery";
pub type PersistRecovery = Arc<dyn Fn(&RecoveryCheckpoint) -> Result<(), GoopError> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPhase {
    Allocated,
    SourcesComplete,
    OutputVerified,
    Published,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverySource {
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
    pub format_id: String,
    pub ext: String,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryCheckpoint {
    pub version: u32,
    pub job_id: JobId,
    pub root: PathBuf,
    pub workspace: String,
    pub fingerprint: String,
    pub phase: RecoveryPhase,
    pub writer_active: bool,
    pub sources: Vec<RecoverySource>,
    pub title: String,
    pub extractor: String,
    pub upload_date: String,
    pub published_path: Option<PathBuf>,
}

#[derive(Clone)]
pub struct ExtractRecovery {
    state: Arc<Mutex<Option<RecoveryCheckpoint>>>,
    persist: PersistRecovery,
}

fn invalid(message: impl Into<String>) -> GoopError {
    GoopError::Queue(message.into())
}
fn single_component(s: &str) -> bool {
    let mut parts = Path::new(s).components();
    matches!(parts.next(), Some(Component::Normal(_)))
        && parts.next().is_none()
        && !s.contains(['/', '\\', '\0'])
        && s != "."
        && s != ".."
}
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn fingerprint(req: &ExtractRequest) -> Result<String, GoopError> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "url":req.url, "format":req.format, "audio":req.audio_only,
        "template":req.output_template, "cookies":req.cookies_from_browser,
        "backend":"yt-dlp", "protocol":1,
    }))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl ExtractRecovery {
    pub fn new(
        raw: Option<serde_json::Value>,
        persist: PersistRecovery,
    ) -> Result<Self, GoopError> {
        let checkpoint = raw
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| invalid(format!("invalid Extract recovery metadata: {e}")))?;
        Ok(Self {
            state: Arc::new(Mutex::new(checkpoint)),
            persist,
        })
    }
    pub fn ephemeral() -> Self {
        Self::new(None, Arc::new(|_| Ok(()))).expect("empty recovery")
    }
    pub fn checkpoint(&self) -> Option<RecoveryCheckpoint> {
        self.state.lock().expect("recovery lock").clone()
    }
    fn save(&self, checkpoint: RecoveryCheckpoint) -> Result<(), GoopError> {
        (self.persist)(&checkpoint)
            .map_err(|e| invalid(format!("cannot persist Extract recovery: {e}")))?;
        *self.state.lock().expect("recovery lock") = Some(checkpoint);
        Ok(())
    }
    pub fn allocate(
        &self,
        id: JobId,
        req: &ExtractRequest,
    ) -> Result<RecoveryCheckpoint, GoopError> {
        let root = std::fs::canonicalize(goop_core::path::expand(&req.output_dir))?;
        if !root.is_dir() {
            return Err(invalid("Extract output root is not a directory"));
        }
        let fingerprint = fingerprint(req)?;
        if let Some(cp) = self.checkpoint() {
            cp.validate_identity(id, &root, &fingerprint)?;
            cp.owned_directory()?;
            let unconfirmed_complete = cp.sources.is_empty()
                && std::fs::read_dir(cp.owned_directory()?)?.any(|entry| {
                    entry.ok().is_some_and(|entry| {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        name.starts_with("source.")
                            && !name.ends_with(".part")
                            && !name.ends_with(".ytdl")
                    })
                });
            if !cp.writer_active && !unconfirmed_complete {
                if cp.phase == RecoveryPhase::Published {
                    return Err(invalid(
                        "This extraction was already published; its output was preserved",
                    ));
                }
                return Ok(cp);
            }
            // A crashed attempt may still own descendants. Quarantine it without
            // inspecting/killing persisted process ids or touching its files.
            tracing::warn!(workspace = %cp.workspace, "retaining interrupted Extract workspace with uncertain writers");
        }
        let workspace = format!(".goop-extract-{}-{}", id.0, JobId::new().0);
        let path = root.join(&workspace);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        let cp = RecoveryCheckpoint {
            version: 1,
            job_id: id,
            root,
            workspace,
            fingerprint,
            phase: RecoveryPhase::Allocated,
            writer_active: false,
            sources: vec![],
            title: "Download".into(),
            extractor: String::new(),
            upload_date: String::new(),
            published_path: None,
        };
        let mut owner = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join("owner.json"))?;
        use std::io::Write;
        owner.write_all(&serde_json::to_vec(&cp)?)?;
        owner.sync_all()?;
        self.save(cp.clone())?;
        Ok(cp)
    }
    pub fn set_writer(&self, active: bool) -> Result<(), GoopError> {
        let mut cp = self
            .checkpoint()
            .ok_or_else(|| invalid("missing Extract workspace"))?;
        cp.writer_active = active;
        self.save(cp)
    }
    pub async fn capture(
        &self,
        raw: serde_json::Value,
        signals: JobSignals,
    ) -> Result<(), GoopError> {
        let mut cp = self
            .checkpoint()
            .ok_or_else(|| invalid("missing Extract workspace"))?;
        cp = tokio::task::spawn_blocking(move || {
            let dir = cp.owned_directory()?;
            let split = raw.get("requested_formats").and_then(|v| v.as_array());
            let formats: Vec<_> = match split {
                Some(v) if !v.is_empty() && v.len() <= 8 => v.iter().collect(),
                None => vec![&raw],
                _ => return Err(invalid("unsupported completed source manifest")),
            };
            let mut sources = Vec::new();
            for format in formats {
                let text = |key: &str| {
                    format[key]
                        .as_str()
                        .map(String::from)
                        .ok_or_else(|| invalid(format!("completed source missing {key}")))
                };
                let format_id = text("format_id")?;
                let ext = text("ext")?;
                if !token(&format_id) || !token(&ext) {
                    return Err(invalid("unsafe source format identity"));
                }
                let expected = if split.is_some() {
                    format!("source.f{format_id}.{ext}")
                } else {
                    format!("source.{ext}")
                };
                let reported = PathBuf::from(text("filepath")?);
                if reported != dir.join(&expected) {
                    return Err(invalid("unexpected completed source filename"));
                }
                if let Some(merge) = raw.get("__files_to_merge").and_then(|v| v.as_array()) {
                    if merge.len() != split.map_or(1, Vec::len)
                        || !merge
                            .iter()
                            .any(|entry| entry.as_str() == reported.to_str())
                    {
                        return Err(invalid("inconsistent merge source manifest"));
                    }
                } else if split.is_some() {
                    return Err(invalid("missing merge source manifest"));
                }
                let path = cp.file(&expected)?;
                let (bytes, sha256) = hash(&path, &signals)?;
                let source = RecoverySource {
                    relative_path: expected,
                    bytes,
                    sha256,
                    format_id,
                    ext,
                    vcodec: format["vcodec"].as_str().map(String::from),
                    acodec: format["acodec"].as_str().map(String::from),
                    width: format["width"].as_u64(),
                    height: format["height"].as_u64(),
                };
                if sources
                    .iter()
                    .any(|s: &RecoverySource| s.relative_path == source.relative_path)
                {
                    return Err(invalid("duplicate completed source"));
                }
                sources.push(source);
            }
            if !cp.sources.is_empty() {
                for source in &sources {
                    if !cp.sources.iter().any(|old| {
                        old.relative_path == source.relative_path
                            && old.format_id == source.format_id
                            && old.bytes == source.bytes
                            && old.sha256 == source.sha256
                    }) {
                        return Err(invalid("replayed Extract source changed"));
                    }
                }
            } else {
                cp.title = display_name(raw["title"].as_str().unwrap_or("Download"));
                cp.extractor = display_name(raw["extractor"].as_str().unwrap_or(""));
                cp.upload_date = display_name(raw["upload_date"].as_str().unwrap_or(""));
            }
            let proof = dir.join("sources.json");
            if cp.sources.is_empty() {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(proof)?;
                file.write_all(&serde_json::to_vec(&sources)?)?;
                file.sync_all()?;
            } else if cp.sources != sources {
                return Err(invalid("replayed source identity changed"));
            }
            cp.sources = sources;
            cp.phase = RecoveryPhase::SourcesComplete;
            Ok::<_, GoopError>(cp)
        })
        .await
        .map_err(|e| invalid(format!("cannot inspect Extract sources: {e}")))??;
        self.save(cp)
    }
    pub async fn replay(&self, signals: JobSignals) -> Result<Option<PathBuf>, GoopError> {
        let cp = self
            .checkpoint()
            .ok_or_else(|| invalid("missing Extract workspace"))?;
        if cp.sources.is_empty() {
            return Ok(None);
        }
        if cp.writer_active {
            return Err(invalid("Extract sources still have an active writer"));
        }
        tokio::task::spawn_blocking(move || {
            cp.validate_sources(&signals)?;
            let dir = cp.owned_directory()?;
            let formats: Vec<_> = cp.sources.iter().map(|s| serde_json::json!({
                "format_id":s.format_id, "ext":s.ext, "vcodec":s.vcodec, "acodec":s.acodec,
                "width":s.width, "height":s.height,
                // Port zero is invalid as a remote service. Never preserve CDN URLs.
                "url":"http://127.0.0.1:0/completed-source-unavailable",
            })).collect();
            let value = serde_json::json!({"id":"goop", "title":"source", "extractor":"Generic", "extractor_key":"Generic", "formats":formats});
            let path = dir.join(format!("replay-{}.json", JobId::new().0));
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create_new(true).write(true).open(&path)?;
            f.write_all(&serde_json::to_vec(&value)?)?;
            f.sync_all()?;
            Ok(Some(path))
        }).await.map_err(|e| invalid(format!("cannot validate Extract recovery: {e}")))?
    }
    pub fn mark_verified(&self) -> Result<(), GoopError> {
        let mut cp = self
            .checkpoint()
            .ok_or_else(|| invalid("missing Extract workspace"))?;
        if cp.writer_active {
            return Err(invalid("cannot publish while Extract writers remain"));
        }
        cp.phase = RecoveryPhase::OutputVerified;
        self.save(cp)
    }
    pub fn receipt(&self, path: PathBuf) -> Result<(), GoopError> {
        let mut cp = self
            .checkpoint()
            .ok_or_else(|| invalid("missing Extract workspace"))?;
        cp.phase = RecoveryPhase::Published;
        cp.published_path = Some(path);
        self.save(cp)
    }
    pub fn cleanup(&self) -> Result<(), GoopError> {
        if let Some(cp) = self.checkpoint() {
            cp.cleanup()?;
        }
        Ok(())
    }
}
impl RecoveryCheckpoint {
    fn validate_identity(
        &self,
        id: JobId,
        root: &Path,
        fingerprint: &str,
    ) -> Result<(), GoopError> {
        let prefix = format!(".goop-extract-{}-", id.0);
        let suffix = self.workspace.strip_prefix(&prefix).unwrap_or("");
        if self.version != 1
            || self.job_id != id
            || self.root != root
            || self.fingerprint != fingerprint
            || !single_component(&self.workspace)
            || suffix.len() != 36
            || !suffix.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        {
            return Err(invalid(
                "Extract recovery does not match this job and output root",
            ));
        }
        Ok(())
    }
    pub fn owned_directory(&self) -> Result<PathBuf, GoopError> {
        self.validate_identity(self.job_id, &self.root, &self.fingerprint)?;
        if !safe_public_component(&self.title)
            || (!self.extractor.is_empty() && !safe_public_component(&self.extractor))
            || (!self.upload_date.is_empty() && !safe_public_component(&self.upload_date))
        {
            return Err(invalid("unsafe restored Extract display name"));
        }
        let mut path = PathBuf::new();
        for component in self.root.components() {
            path.push(component);
            if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
                return Err(invalid("linked Extract output ancestor"));
            }
        }
        if std::fs::canonicalize(&self.root)? != self.root {
            return Err(invalid("Extract output root changed"));
        }
        let dir = self.root.join(&self.workspace);
        let meta = std::fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.file_type().is_symlink() || std::fs::canonicalize(&dir)? != dir {
            return Err(invalid("invalid Extract workspace"));
        }
        let owner_path = dir.join("owner.json");
        if !std::fs::symlink_metadata(&owner_path)?.is_file() {
            return Err(invalid("invalid Extract workspace owner"));
        }
        let owner: RecoveryCheckpoint = serde_json::from_slice(&std::fs::read(owner_path)?)?;
        if owner.workspace != self.workspace
            || owner.root != self.root
            || owner.job_id != self.job_id
            || owner.fingerprint != self.fingerprint
            || owner.version != 1
        {
            return Err(invalid("Extract workspace ownership mismatch"));
        }
        Ok(dir)
    }
    pub fn file(&self, relative: &str) -> Result<PathBuf, GoopError> {
        if !single_component(relative) {
            return Err(invalid("unsafe Extract artifact path"));
        }
        let path = self.owned_directory()?.join(relative);
        let meta = std::fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.len() == 0 || std::fs::canonicalize(&path)? != path {
            return Err(invalid(
                "Extract artifact is missing, empty or not a regular file",
            ));
        }
        Ok(path)
    }
    pub fn validate_sources(&self, signals: &JobSignals) -> Result<(), GoopError> {
        if self.writer_active || self.sources.is_empty() || self.sources.len() > 8 {
            return Err(invalid("Extract sources are not reusable"));
        }
        let proof_path = self.file("sources.json")?;
        let proof: Vec<RecoverySource> = serde_json::from_slice(&std::fs::read(proof_path)?)?;
        if proof != self.sources {
            return Err(invalid(
                "Extract source identity does not match its owned completion manifest",
            ));
        }
        let split = self.sources.len() > 1;
        for s in &self.sources {
            let expected = if split {
                format!("source.f{}.{}", s.format_id, s.ext)
            } else {
                format!("source.{}", s.ext)
            };
            if !token(&s.format_id) || !token(&s.ext) || s.relative_path != expected {
                return Err(invalid("invalid Extract source identity"));
            }
            let (bytes, digest) = hash(&self.file(&s.relative_path)?, signals)?;
            if bytes != s.bytes || digest != s.sha256 {
                return Err(invalid(
                    "Completed Extract source changed; recovery was stopped",
                ));
            }
        }
        Ok(())
    }
    pub fn cleanup_for(&self, id: JobId, req: &ExtractRequest) -> Result<(), GoopError> {
        let root = std::fs::canonicalize(goop_core::path::expand(&req.output_dir))?;
        self.validate_identity(id, &root, &fingerprint(req)?)?;
        self.cleanup()
    }
    pub fn cleanup(&self) -> Result<(), GoopError> {
        if self.writer_active {
            return Err(invalid(
                "cannot clean Extract workspace with uncertain writers",
            ));
        }
        let candidate = self.root.join(&self.workspace);
        if std::fs::symlink_metadata(&candidate)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(());
        }
        let dir = self.owned_directory()?;
        // Workspaces are flat. Unknown directories and links are never followed.
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if !kind.is_file() && !kind.is_symlink() {
                return Err(invalid("uncertain Extract workspace contents retained"));
            }
        }
        for entry in std::fs::read_dir(&dir)? {
            std::fs::remove_file(entry?.path())?;
        }
        std::fs::remove_dir(dir)?;
        Ok(())
    }
}
pub(crate) fn hash(path: &Path, signals: &JobSignals) -> Result<(u64, String), GoopError> {
    let mut f = std::fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 128 * 1024];
    loop {
        if let Some(int) = signals.check() {
            return Err(int.into());
        }
        let n = f.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        sha.update(&buffer[..n]);
    }
    if bytes == 0 {
        return Err(invalid("empty Extract source"));
    }
    Ok((bytes, format!("{:x}", sha.finalize())))
}
pub(crate) fn safe_public_component(value: &str) -> bool {
    single_component(value)
        && !value
            .chars()
            .any(|c| c.is_control() || ":*?\"<>|%".contains(c))
        && value.trim() == value
        && !value.ends_with('.')
}
fn display_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|%".contains(*c))
        .take(150)
        .collect();
    let name = name.trim().trim_matches('.');
    if name.is_empty() {
        "Download".into()
    } else {
        name.into()
    }
}
