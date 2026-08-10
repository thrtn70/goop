pub mod backend;
pub mod classify;
pub mod debrid;
pub mod direct;
pub mod gallery_dl;
pub mod retry;
pub mod ytdlp;

pub use backend::{
    cleanup_partials_for, dispatch, dispatch_with_update_hook, BackendOutcome, BinaryUpdated,
    ResultKindTag, UpdateHook,
};
pub use classify::{classify, classify_extractor, ExtractorChoice, Source};
