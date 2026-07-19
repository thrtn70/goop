pub mod convert;
pub mod error;
pub mod events;
pub mod history;
pub mod image;
pub mod instance;
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
    ProbeResult, QualityPreset, ResolutionCap, SourceKind, SubtitleMode, SubtitleOptions,
    TargetFormat,
};
pub use error::{
    both_failed, friendly_message, is_access_blocked_stderr, is_cookie_db_error,
    is_no_matching_extractor, is_transient_network_stderr, warrants_other_extractor, BothFailed,
    GoopError, IpcError,
};
pub use events::{EventSink, ProgressEvent, QueueEvent, SidecarEvent, WarnOnceSink, WarningCode};
pub use history::{HistoryCounts, HistoryFilter, HistorySort, HistoryViewMode};
pub use image::{
    CropRect, IconPlatform, ImageOperation, ResizeMode, WatermarkPosition, WatermarkSpec,
};
pub use instance::InstanceGuard;
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
