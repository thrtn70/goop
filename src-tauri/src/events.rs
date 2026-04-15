use goop_core::{EventSink, ProgressEvent, QueueEvent, SidecarEvent};
use tauri::{AppHandle, Emitter};

pub struct TauriSink(pub AppHandle);

impl EventSink for TauriSink {
    fn emit_progress(&self, e: ProgressEvent) {
        let _ = self.0.emit("goop://queue/progress", e);
    }
    fn emit_queue(&self, e: QueueEvent) {
        let _ = self.0.emit("goop://queue/state_changed", e);
    }
    fn emit_sidecar(&self, e: SidecarEvent) {
        match &e {
            SidecarEvent::YtDlpUpdated { .. } => {
                let _ = self.0.emit("goop://sidecar/yt_dlp_updated", &e);
            }
            SidecarEvent::Warning { .. } => {
                let _ = self.0.emit("goop://sidecar/warning", &e);
            }
        }
    }
}
