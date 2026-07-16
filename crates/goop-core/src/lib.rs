pub mod convert;
pub mod error;
pub mod events;
pub mod history;
pub mod image;
pub mod job;
pub mod metadata;
pub mod path;
pub mod pdf;
pub mod preset;
pub mod process_registry;
pub mod signals;
pub mod update;

pub use convert::{
    CompressMode, ConvertRequest, ConvertResult, GifOptions, GifSizePreset, MetadataPolicy,
    ProbeResult, QualityPreset, ResolutionCap, SourceKind, TargetFormat,
};
pub use error::{
    friendly_message, is_cookie_db_error, is_no_matching_extractor, is_transient_network_stderr,
    GoopError, IpcError,
};
pub use events::{EventSink, ProgressEvent, QueueEvent, SidecarEvent};
pub use history::{HistoryCounts, HistoryFilter, HistorySort, HistoryViewMode};
pub use image::{
    CropRect, IconPlatform, ImageOperation, ResizeMode, WatermarkPosition, WatermarkSpec,
};
pub use job::{Job, JobId, JobKind, JobResult, JobState, ResultKind};
pub use metadata::{
    AudioTags, CoverArt, CoverArtOp, MetadataDomain, MetadataOperation, MetadataView,
    MetadataWriteItem, RawTag,
};
pub use pdf::{
    PageRange, PageRotation, PdfMetadata, PdfOperation, PdfProbeResult, PdfQuality, RotationDegrees,
};
pub use preset::Preset;
pub use process_registry::{NoopRegistry, PidGuard, PidRegistry};
pub use signals::{Interrupt, JobSignals};
pub use update::UpdateInfo;
