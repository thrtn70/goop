pub mod convert;
pub mod error;
pub mod events;
pub mod job;
pub mod path;

pub use convert::{
    ConvertRequest, ConvertResult, GifOptions, GifSizePreset, ProbeResult, QualityPreset,
    ResolutionCap, SourceKind, TargetFormat,
};
pub use error::{GoopError, IpcError};
pub use events::{EventSink, ProgressEvent, QueueEvent, SidecarEvent};
pub use job::{Job, JobId, JobKind, JobResult, JobState};
