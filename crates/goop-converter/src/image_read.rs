//! Bounded encoded input capture. Prefixes are for headers, never pixel decoding.
use goop_core::GoopError;
use img_parts::Bytes;
use std::io::Read;

#[derive(Clone, Copy)]
enum EndPolicy {
    Prefix,
    Complete(&'static str),
}

pub(crate) fn read_prefix(
    reader: impl Read,
    limit: u64,
    checkpoint: impl FnMut() -> Result<(), GoopError>,
) -> Result<Bytes, GoopError> {
    read_bounded(reader, limit, EndPolicy::Prefix, checkpoint)
}

pub(crate) fn read_snapshot(
    reader: impl Read,
    limit: u64,
    overflow_message: &'static str,
    checkpoint: impl FnMut() -> Result<(), GoopError>,
) -> Result<Bytes, GoopError> {
    read_bounded(
        reader,
        limit,
        EndPolicy::Complete(overflow_message),
        checkpoint,
    )
}

fn read_bounded(
    mut reader: impl Read,
    limit: u64,
    policy: EndPolicy,
    mut checkpoint: impl FnMut() -> Result<(), GoopError>,
) -> Result<Bytes, GoopError> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        checkpoint()?;
        let remaining = limit.saturating_sub(bytes.len() as u64);
        let request = match policy {
            EndPolicy::Prefix if remaining == 0 => return Ok(bytes.into()),
            EndPolicy::Prefix => remaining.min(chunk.len() as u64) as usize,
            EndPolicy::Complete(_) => (remaining.min((chunk.len() - 1) as u64) + 1) as usize,
        };
        let count = match reader.read(&mut chunk[..request]) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        checkpoint()?;
        if count == 0 {
            return Ok(bytes.into());
        }
        if let EndPolicy::Complete(message) = policy {
            if count as u64 > remaining {
                return Err(GoopError::InvalidRequest(message.into()));
            }
        }
        let required = bytes
            .len()
            .checked_add(count)
            .ok_or_else(|| GoopError::InvalidRequest("Image input size overflow".into()))?;
        if required > bytes.capacity() {
            let capacity = bytes
                .capacity()
                .max(chunk.len())
                .saturating_mul(2)
                .min(usize::try_from(limit).unwrap_or(usize::MAX))
                .max(required);
            bytes
                .try_reserve_exact(capacity - bytes.len())
                .map_err(|_| {
                    GoopError::InvalidRequest("Insufficient memory for bounded image input".into())
                })?;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Read};

    struct Count<R> {
        inner: R,
        consumed: u64,
    }
    impl<R: Read> Read for Count<R> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let n = self.inner.read(out)?;
            self.consumed += n as u64;
            Ok(n)
        }
    }

    #[test]
    fn prefix_stops_without_overflow_read() {
        for limit in [0, 1, 31, 65536, 131072] {
            let mut input = Count {
                inner: io::repeat(7),
                consumed: 0,
            };
            let bytes = read_prefix(&mut input, limit, || Ok(())).unwrap();
            assert_eq!(bytes.len() as u64, limit);
            assert_eq!(input.consumed, limit);
        }
    }

    #[test]
    fn snapshot_stops_growing_stream_at_one_over_limit() {
        for limit in [0, 1, 31, 65536, 131072] {
            let mut input = Count {
                inner: io::repeat(7),
                consumed: 0,
            };
            let error = read_snapshot(&mut input, limit, "too large", || Ok(())).unwrap_err();
            assert!(error.to_string().contains("too large"));
            assert_eq!(input.consumed, limit + 1);
        }
    }

    #[test]
    fn exact_short_and_empty_snapshots_are_accepted() {
        for (input, limit) in [(&b"1234"[..], 4), (&b"12"[..], 4), (&b""[..], 0)] {
            assert_eq!(
                &read_snapshot(input, limit, "too large", || Ok(())).unwrap()[..],
                input
            );
            assert_eq!(&read_prefix(input, limit, || Ok(())).unwrap()[..], input);
        }
    }

    #[test]
    fn checkpoints_cancel_before_and_after_reads() {
        for fail_at in [1, 2, 3, 4] {
            let mut input = Count {
                inner: io::repeat(7),
                consumed: 0,
            };
            let mut calls = 0;
            let result = read_snapshot(&mut input, 1_000_000, "too large", || {
                calls += 1;
                if calls == fail_at {
                    Err(goop_core::GoopError::Cancelled)
                } else {
                    Ok(())
                }
            });
            assert!(matches!(result, Err(goop_core::GoopError::Cancelled)));
            assert_eq!(calls, fail_at);
            assert_eq!(input.consumed, (fail_at / 2) * 65536);
        }
    }

    #[test]
    fn prefix_also_honors_cancellation_and_deadlines() {
        let mut input = Count {
            inner: io::repeat(7),
            consumed: 0,
        };
        let error = read_prefix(&mut input, 1024, || {
            Err(goop_core::GoopError::InvalidRequest("timed out".into()))
        })
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert_eq!(input.consumed, 0);
    }

    #[test]
    fn interrupted_reads_retry_and_other_errors_propagate() {
        struct InterruptedOnce {
            interrupted: bool,
            inner: &'static [u8],
        }
        impl Read for InterruptedOnce {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(io::ErrorKind::Interrupted.into());
                }
                self.inner.read(out)
            }
        }
        let bytes = read_snapshot(
            InterruptedOnce {
                interrupted: false,
                inner: b"safe",
            },
            4,
            "too large",
            || Ok(()),
        )
        .unwrap();
        assert_eq!(&bytes[..], b"safe");
        struct Denied;
        impl Read for Denied {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::PermissionDenied.into())
            }
        }
        assert!(matches!(read_snapshot(Denied, 4, "too large", || Ok(())),
            Err(goop_core::GoopError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied));
    }
}
