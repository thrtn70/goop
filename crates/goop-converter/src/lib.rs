pub mod backend;
pub mod compat;
pub mod encoders;
pub mod ffmpeg;
pub mod imagemagick;
pub mod imagemagick_probe;
pub mod naming;
pub mod probe_json;
pub mod progress;

pub use backend::{backend_for_extension, BackendKind, ConversionBackend};
pub use compat::{decide, Plan};
pub use encoders::{detect as detect_encoders, is_hw_encoder, DetectedEncoders};
pub use ffmpeg::{target_extension, Ffmpeg, FfmpegBackend};
pub use imagemagick::ImageMagickBackend;
pub use naming::{allocate_output_path, stem_of};
pub use probe_json::parse_probe_json;
pub use progress::{ProgressSnapshot, ProgressTracker};
