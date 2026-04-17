use crate::job::JobKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Columns the History page can sort by. Date sorts on `finished_at`,
/// Size on `result.bytes`, Name on the output file's basename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum HistorySort {
    #[default]
    Date,
    Size,
    Name,
}

/// Persisted preference for how the History page renders. Lives in Settings
/// so the choice survives app restarts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum HistoryViewMode {
    #[default]
    List,
    Grid,
}

/// Filter passed to `QueueStore::list_terminal` — pushes all filtering to
/// SQL rather than walking the in-memory job list, which matters once
/// users accumulate hundreds of rows.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct HistoryFilter {
    pub search: Option<String>,
    pub kind: Option<JobKind>,
    pub sort: HistorySort,
    pub descending: bool,
}

/// Counts per `JobKind` plus a grand total; drives the History filter
/// chips' badges so they reflect the current search without extra
/// round-trips.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct HistoryCounts {
    pub all: u32,
    pub extract: u32,
    pub convert: u32,
    pub pdf: u32,
}
