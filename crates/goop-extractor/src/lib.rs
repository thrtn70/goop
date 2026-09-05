pub mod backend;
pub mod classify;
mod cleanup;
pub mod debrid;
pub mod direct;
pub mod gallery_dl;
pub mod retry;
pub mod ytdlp;

#[cfg(all(test, unix))]
pub(crate) mod test_fakes;

pub use backend::{
    cleanup_partials_for, dispatch, dispatch_with_update_hook, BackendOutcome, BinaryUpdated,
    ResultKindTag, UpdateHook,
};
pub use classify::{classify, classify_extractor, ExtractorChoice, Source};
pub use cleanup::{
    partial_artifact_hash, sweep_orphaned_partials, PartialSweepFailure, PartialSweepReport,
};
