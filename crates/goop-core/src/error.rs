use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Error)]
pub enum GoopError {
    #[error("sidecar binary not found: {0}")]
    SidecarMissing(String),
    #[error("subprocess failed: {binary}: {stderr}")]
    SubprocessFailed { binary: String, stderr: String },
    #[error("queue store error: {0}")]
    Queue(String),
    #[error("config error: {0}")]
    Config(String),
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Serializable error surface for Tauri IPC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "code", content = "message")]
pub enum IpcError {
    SidecarMissing(String),
    SubprocessFailed(String),
    Queue(String),
    Config(String),
    Cancelled,
    Unknown(String),
}

impl From<GoopError> for IpcError {
    fn from(e: GoopError) -> Self {
        match e {
            GoopError::SidecarMissing(x) => Self::SidecarMissing(x),
            GoopError::SubprocessFailed { binary, stderr } => {
                Self::SubprocessFailed(format!("{binary}: {stderr}"))
            }
            GoopError::Queue(x) => Self::Queue(x),
            GoopError::Config(x) => Self::Config(x),
            GoopError::Cancelled => Self::Cancelled,
            other => Self::Unknown(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goop_error_converts_to_ipc_error() {
        let ge = GoopError::SidecarMissing("ffmpeg".into());
        let ie: IpcError = ge.into();
        assert!(matches!(ie, IpcError::SidecarMissing(ref s) if s == "ffmpeg"));
    }

    #[test]
    fn ipc_error_serializes_with_tag() {
        let ie = IpcError::Cancelled;
        let s = serde_json::to_string(&ie).unwrap();
        assert_eq!(s, r#"{"code":"cancelled"}"#);
    }
}
