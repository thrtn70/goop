pub mod convert;
pub mod error;
pub mod events;
pub mod history;
pub mod job;
pub mod path;
pub mod pdf;
pub mod preset;
pub mod update;

pub use convert::{
    CompressMode, ConvertRequest, ConvertResult, GifOptions, GifSizePreset, ProbeResult,
    QualityPreset, ResolutionCap, SourceKind, TargetFormat,
};
pub use error::{GoopError, IpcError};
pub use events::{EventSink, ProgressEvent, QueueEvent, SidecarEvent};
pub use history::{HistoryCounts, HistoryFilter, HistorySort, HistoryViewMode};
pub use job::{Job, JobId, JobKind, JobResult, JobState};
pub use pdf::{PageRange, PdfOperation, PdfProbeResult, PdfQuality};
pub use preset::Preset;
pub use update::UpdateInfo;
