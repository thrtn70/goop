pub mod backend;
pub mod classify;
pub mod direct;
pub mod gallery_dl;
mod retry;
pub mod ytdlp;

pub use backend::{cleanup_partials_for, dispatch, BackendOutcome, ResultKindTag};
pub use classify::{classify, classify_extractor, ExtractorChoice, Source};
