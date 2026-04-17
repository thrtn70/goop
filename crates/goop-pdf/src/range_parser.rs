use crate::PdfError;
use goop_core::PageRange;

/// Parse a human-readable page range string into concrete `PageRange`s.
///
/// Accepted forms (whitespace tolerant):
/// - `"1"` — single page, 1-indexed
/// - `"1-3"` — inclusive range
/// - `"1-3, 7-10"` or `"1-3,7-10"` — multiple ranges separated by commas
///
/// `total_pages` is used to reject ranges that fall outside the document
/// and must be > 0.
///
/// Errors:
/// - `Range` for empty, zero-page, malformed, or out-of-bounds inputs
pub fn parse_ranges(input: &str, total_pages: u32) -> Result<Vec<PageRange>, PdfError> {
    if total_pages == 0 {
        return Err(PdfError::Range("document has zero pages".into()));
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(PdfError::Range("range string is empty".into()));
    }
    let mut out = Vec::new();
    for segment in trimmed.split(',') {
        let seg = segment.trim();
        if seg.is_empty() {
            return Err(PdfError::Range(format!(
                "empty range segment in \"{input}\""
            )));
        }
        let (start, end) = match seg.split_once('-') {
            Some((a, b)) => (parse_page(a.trim())?, parse_page(b.trim())?),
            None => {
                let p = parse_page(seg)?;
                (p, p)
            }
        };
        if start == 0 || end == 0 {
            return Err(PdfError::Range("pages are 1-indexed".into()));
        }
        if end < start {
            return Err(PdfError::Range(format!(
                "range \"{seg}\" has end before start"
            )));
        }
        if end > total_pages {
            return Err(PdfError::Range(format!(
                "range \"{seg}\" extends past page {total_pages}"
            )));
        }
        out.push(PageRange { start, end });
    }
    Ok(out)
}

fn parse_page(s: &str) -> Result<u32, PdfError> {
    s.parse::<u32>()
        .map_err(|_| PdfError::Range(format!("\"{s}\" is not a number")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_page_parses() {
        assert_eq!(
            parse_ranges("3", 10).unwrap(),
            vec![PageRange { start: 3, end: 3 }]
        );
    }

    #[test]
    fn simple_range_parses() {
        assert_eq!(
            parse_ranges("1-3", 10).unwrap(),
            vec![PageRange { start: 1, end: 3 }]
        );
    }

    #[test]
    fn multiple_ranges_with_whitespace() {
        assert_eq!(
            parse_ranges("1-3, 7-10", 12).unwrap(),
            vec![
                PageRange { start: 1, end: 3 },
                PageRange { start: 7, end: 10 },
            ]
        );
    }

    #[test]
    fn multiple_ranges_without_whitespace() {
        assert_eq!(
            parse_ranges("1-3,7-10", 12).unwrap(),
            vec![
                PageRange { start: 1, end: 3 },
                PageRange { start: 7, end: 10 },
            ]
        );
    }

    #[test]
    fn empty_input_rejected() {
        assert!(parse_ranges("", 10).is_err());
        assert!(parse_ranges("   ", 10).is_err());
    }

    #[test]
    fn zero_total_pages_rejected() {
        assert!(parse_ranges("1", 0).is_err());
    }

    #[test]
    fn reversed_range_rejected() {
        assert!(parse_ranges("3-1", 10).is_err());
    }

    #[test]
    fn out_of_bounds_rejected() {
        assert!(parse_ranges("1-999", 5).is_err());
    }

    #[test]
    fn zero_page_rejected() {
        assert!(parse_ranges("0", 10).is_err());
        assert!(parse_ranges("0-3", 10).is_err());
    }

    #[test]
    fn malformed_strings_rejected() {
        assert!(parse_ranges("abc", 10).is_err());
        assert!(parse_ranges("1-abc", 10).is_err());
        assert!(parse_ranges("1,,3", 10).is_err());
    }

    #[test]
    fn single_range_equal_endpoints_parses() {
        // Equal endpoints are a one-page range, not reversed.
        assert_eq!(
            parse_ranges("3-3", 5).unwrap(),
            vec![PageRange { start: 3, end: 3 }]
        );
    }
}
