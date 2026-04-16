use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgressSnapshot {
    pub percent: f64,
    pub speed_factor: Option<f64>,
    pub eta_secs: Option<u64>,
    pub bytes: Option<u64>,
    pub done: bool,
}

pub fn parse_kv_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let eq = line.find('=')?;
    let k = line[..eq].trim();
    let v = line[eq + 1..].trim();
    if k.is_empty() {
        None
    } else {
        Some((k, v))
    }
}

fn parse_speed(raw: &str) -> Option<f64> {
    let trimmed = raw.trim().trim_end_matches('x').trim();
    if trimmed.is_empty() || trimmed == "N/A" {
        return None;
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v > 0.0)
}

pub struct ProgressTracker {
    duration_ms: u64,
    out_time_ms: u64,
    speed_factor: Option<f64>,
    bytes: Option<u64>,
    last_emit: Option<Instant>,
    min_interval: Duration,
}

impl ProgressTracker {
    pub fn new(duration_ms: u64) -> Self {
        Self {
            duration_ms,
            out_time_ms: 0,
            speed_factor: None,
            bytes: None,
            last_emit: None,
            min_interval: Duration::from_millis(200),
        }
    }

    pub fn ingest(&mut self, line: &str) -> Option<ProgressSnapshot> {
        let (k, v) = parse_kv_line(line)?;
        match k {
            "out_time_ms" | "out_time_us" => {
                if let Ok(us) = v.parse::<u64>() {
                    // ffmpeg historically emits microseconds here despite the "ms" suffix.
                    self.out_time_ms = us / 1000;
                }
                None
            }
            "speed" => {
                self.speed_factor = parse_speed(v);
                None
            }
            "total_size" => {
                self.bytes = v.parse::<u64>().ok();
                None
            }
            "progress" => {
                let done = v == "end";
                if done {
                    return Some(self.snapshot(true));
                }
                let now = Instant::now();
                let should_emit = match self.last_emit {
                    Some(t) => now.duration_since(t) >= self.min_interval,
                    None => true,
                };
                if should_emit {
                    self.last_emit = Some(now);
                    Some(self.snapshot(false))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn snapshot(&self, done: bool) -> ProgressSnapshot {
        let percent = if done {
            100.0
        } else if self.duration_ms == 0 {
            0.0
        } else {
            let raw = (self.out_time_ms as f64 / self.duration_ms as f64) * 100.0;
            raw.clamp(0.0, 99.9)
        };
        let eta_secs = self.eta();
        ProgressSnapshot {
            percent,
            speed_factor: self.speed_factor,
            eta_secs,
            bytes: self.bytes,
            done,
        }
    }

    fn eta(&self) -> Option<u64> {
        let speed = self.speed_factor?;
        if speed <= 0.0 || self.duration_ms == 0 {
            return None;
        }
        let remaining_ms = self.duration_ms.saturating_sub(self.out_time_ms) as f64;
        let secs = (remaining_ms / 1000.0) / speed;
        if secs.is_finite() && secs >= 0.0 {
            Some(secs.round() as u64)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_kv() {
        assert_eq!(parse_kv_line("speed=1.23x"), Some(("speed", "1.23x")));
        assert_eq!(
            parse_kv_line("  progress = end  "),
            Some(("progress", "end"))
        );
    }

    #[test]
    fn rejects_malformed() {
        assert_eq!(parse_kv_line(""), None);
        assert_eq!(parse_kv_line("  "), None);
        assert_eq!(parse_kv_line("no_equals"), None);
        assert_eq!(parse_kv_line("=noval"), None);
    }

    #[test]
    fn speed_parses() {
        assert_eq!(parse_speed("1.23x"), Some(1.23));
        assert_eq!(parse_speed("0.5x"), Some(0.5));
        assert_eq!(parse_speed("N/A"), None);
        assert_eq!(parse_speed(""), None);
    }

    #[test]
    fn midway_emits_and_clamps() {
        let mut t = ProgressTracker::new(10_000);
        t.last_emit = Some(Instant::now() - Duration::from_secs(1));
        assert_eq!(t.ingest("out_time_us=5000000"), None);
        assert_eq!(t.ingest("speed=2.0x"), None);
        assert_eq!(t.ingest("total_size=1048576"), None);
        let snap = t.ingest("progress=continue").expect("emits");
        assert!(!snap.done);
        assert!((snap.percent - 50.0).abs() < 0.1);
        assert_eq!(snap.speed_factor, Some(2.0));
        assert_eq!(snap.bytes, Some(1_048_576));
        assert_eq!(snap.eta_secs, Some(3));
    }

    #[test]
    fn overshoot_clamps_before_end() {
        let mut t = ProgressTracker::new(1_000);
        t.last_emit = Some(Instant::now() - Duration::from_secs(1));
        t.ingest("out_time_us=2000000");
        let snap = t.ingest("progress=continue").unwrap();
        assert!(snap.percent <= 99.9);
    }

    #[test]
    fn end_emits_100() {
        let mut t = ProgressTracker::new(1_000);
        let snap = t.ingest("progress=end").unwrap();
        assert!(snap.done);
        assert_eq!(snap.percent, 100.0);
    }

    #[test]
    fn throttle_elides_rapid_updates() {
        let mut t = ProgressTracker::new(10_000);
        let first = t.ingest("progress=continue");
        let second = t.ingest("progress=continue");
        assert!(first.is_some());
        assert!(second.is_none());
    }

    #[test]
    fn zero_duration_emits_zero_percent() {
        let mut t = ProgressTracker::new(0);
        t.last_emit = Some(Instant::now() - Duration::from_secs(1));
        t.ingest("out_time_us=1000000");
        let snap = t.ingest("progress=continue").unwrap();
        assert_eq!(snap.percent, 0.0);
    }
}
