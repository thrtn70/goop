//! Per-job control signals.
//!
//! Every running job gets one [`JobSignals`] from the scheduler. The two
//! tokens carry different contracts:
//!
//! - `cancel` — hard stop. Kill children, delete partial files, return
//!   [`GoopError::Cancelled`].
//! - `pause` — graceful stop. Stop work but KEEP partial files on disk so
//!   a later run can resume, and return [`GoopError::Paused`]. Workers
//!   without pause support simply never poll this token; the scheduler
//!   refuses to fire it for their job kinds.
//!
//! Both tokens are one-shot latches for a single run: a resumed job is
//! re-dispatched with a fresh `JobSignals`.

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::task::Poll;

use tokio_util::sync::CancellationToken;

use crate::GoopError;

/// Control signals threaded from the scheduler into a job worker.
/// Clones share the underlying token state.
#[derive(Clone, Debug, Default)]
pub struct JobSignals {
    /// Hard stop: kill children, delete partials, return `Err(Cancelled)`.
    pub cancel: CancellationToken,
    /// Graceful stop: stop work, keep partials, return `Err(Paused)`.
    pub pause: CancellationToken,
}

/// Which signal fired. Cancel always wins when both have fired — a job
/// the user cancelled must never park as paused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interrupt {
    Cancel,
    Pause,
}

impl JobSignals {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adapter for call sites that only have a cancel token (workers
    /// without pause support, and tests).
    pub fn cancel_only(cancel: CancellationToken) -> Self {
        Self {
            cancel,
            pause: CancellationToken::new(),
        }
    }

    /// Resolves when either token fires. Cancel is polled first so it
    /// wins whenever both are set by the time this future is polled.
    pub async fn interrupted(&self) -> Interrupt {
        let mut cancel = pin!(self.cancel.cancelled());
        let mut pause = pin!(self.pause.cancelled());
        poll_fn(move |cx| {
            if cancel.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Interrupt::Cancel);
            }
            if pause.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Interrupt::Pause);
            }
            Poll::Pending
        })
        .await
    }

    /// Non-blocking check, for guards at function entry and between
    /// pipeline stages. Cancel wins.
    pub fn check(&self) -> Option<Interrupt> {
        if self.cancel.is_cancelled() {
            Some(Interrupt::Cancel)
        } else if self.pause.is_cancelled() {
            Some(Interrupt::Pause)
        } else {
            None
        }
    }
}

impl From<Interrupt> for GoopError {
    fn from(i: Interrupt) -> Self {
        match i {
            Interrupt::Cancel => GoopError::Cancelled,
            Interrupt::Pause => GoopError::Paused,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_returns_none_when_idle_and_pause_when_only_paused() {
        let sig = JobSignals::new();
        assert_eq!(sig.check(), None);
        sig.pause.cancel();
        assert_eq!(sig.check(), Some(Interrupt::Pause));
    }

    #[test]
    fn check_prefers_cancel_when_both_fired() {
        let sig = JobSignals::new();
        sig.pause.cancel();
        sig.cancel.cancel();
        assert_eq!(sig.check(), Some(Interrupt::Cancel));
    }

    #[test]
    fn clone_shares_token_state() {
        let sig = JobSignals::new();
        let clone = sig.clone();
        clone.pause.cancel();
        assert_eq!(sig.check(), Some(Interrupt::Pause));
    }

    #[test]
    fn cancel_only_starts_with_unfired_pause() {
        let tok = CancellationToken::new();
        let sig = JobSignals::cancel_only(tok.clone());
        assert_eq!(sig.check(), None);
        tok.cancel();
        assert_eq!(sig.check(), Some(Interrupt::Cancel));
    }

    #[tokio::test]
    async fn interrupted_prefers_cancel_when_both_fired() {
        let sig = JobSignals::new();
        sig.pause.cancel();
        sig.cancel.cancel();
        assert_eq!(sig.interrupted().await, Interrupt::Cancel);
    }

    #[tokio::test]
    async fn interrupted_resolves_when_pause_fires_later() {
        let sig = JobSignals::new();
        let waiter = sig.clone();
        let handle = tokio::spawn(async move { waiter.interrupted().await });
        tokio::task::yield_now().await;
        sig.pause.cancel();
        assert_eq!(handle.await.unwrap(), Interrupt::Pause);
    }

    #[test]
    fn interrupt_converts_to_the_matching_goop_error() {
        assert!(matches!(
            GoopError::from(Interrupt::Cancel),
            GoopError::Cancelled
        ));
        assert!(matches!(
            GoopError::from(Interrupt::Pause),
            GoopError::Paused
        ));
    }
}
