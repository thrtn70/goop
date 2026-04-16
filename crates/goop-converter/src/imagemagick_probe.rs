use goop_core::{GoopError, ProbeResult, SourceKind};

/// Parse the output of `magick identify -verbose <path>` into a [`ProbeResult`].
///
/// ImageMagick verbose output is a key-value-ish format with indented lines such as:
///
/// ```text
///   Geometry: 1920x1080+0+0
///   Colorspace: sRGB
///   Mime type: image/png
/// ```
///
/// The caller supplies the file size separately (from `std::fs::metadata`).
pub fn parse_identify_output(raw: &str, file_size: u64) -> Result<ProbeResult, GoopError> {
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut color_space: Option<String> = None;
    let mut mime_type: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();

        if let Some(value) = trimmed.strip_prefix("Geometry:") {
            let value = value.trim();
            // Format: WxH+X+Y — take only the WxH part
            if let Some(dims) = value.split('+').next() {
                let parts: Vec<&str> = dims.split('x').collect();
                if parts.len() == 2 {
                    width = parts[0].trim().parse().ok();
                    height = parts[1].trim().parse().ok();
                }
            }
        } else if let Some(value) = trimmed.strip_prefix("Colorspace:") {
            color_space = Some(value.trim().to_string());
        } else if let Some(value) = trimmed.strip_prefix("Mime type:") {
            mime_type = Some(value.trim().to_string());
        }
    }

    // Derive image_format from the MIME type (e.g. "image/png" -> "png").
    // Falls back to None when the Mime type line is absent.
    let image_format = mime_type
        .as_deref()
        .and_then(|m| m.rsplit('/').next().map(|sub| sub.trim().to_lowercase()));

    Ok(ProbeResult {
        duration_ms: 0,
        width,
        height,
        video_codec: None,
        audio_codec: None,
        file_size,
        container: None,
        has_video: false,
        has_audio: false,
        source_kind: SourceKind::Image,
        color_space,
        image_format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_IDENTIFY: &str = r#"Image: test.png
  Format: PNG (Portable Network Graphics)
  Mime type: image/png
  Class: DirectClass
  Geometry: 1920x1080+0+0
  Resolution: 72x72
  Print size: 26.6667x15
  Units: PixelsPerInch
  Colorspace: sRGB
  Type: TrueColorAlpha
  Base type: Undefined
  Endianness: Undefined
  Depth: 8-bit
  Channel depth:
    red: 8-bit
    green: 8-bit
    blue: 8-bit
    alpha: 1-bit
"#;

    const JPEG_IDENTIFY: &str = r#"Image: photo.jpg
  Format: JPEG (Joint Photographic Experts Group JFIF format)
  Mime type: image/jpeg
  Class: DirectClass
  Geometry: 4032x3024+0+0
  Resolution: 72x72
  Print size: 56x42
  Units: PixelsPerInch
  Colorspace: sRGB
  Type: TrueColor
  Depth: 8-bit
"#;

    #[test]
    fn parses_png_identify() {
        let r = parse_identify_output(PNG_IDENTIFY, 524_288).unwrap();
        assert_eq!(r.width, Some(1920));
        assert_eq!(r.height, Some(1080));
        assert_eq!(r.color_space.as_deref(), Some("sRGB"));
        assert_eq!(r.image_format.as_deref(), Some("png"));
        assert_eq!(r.file_size, 524_288);
        assert_eq!(r.source_kind, SourceKind::Image);
        assert!(!r.has_video);
        assert!(!r.has_audio);
        assert_eq!(r.duration_ms, 0);
    }

    #[test]
    fn parses_jpeg_identify() {
        let r = parse_identify_output(JPEG_IDENTIFY, 2_048_000).unwrap();
        assert_eq!(r.width, Some(4032));
        assert_eq!(r.height, Some(3024));
        assert_eq!(r.color_space.as_deref(), Some("sRGB"));
        assert_eq!(r.image_format.as_deref(), Some("jpeg"));
        assert_eq!(r.file_size, 2_048_000);
        assert_eq!(r.source_kind, SourceKind::Image);
    }

    #[test]
    fn handles_missing_geometry() {
        let raw = "  Colorspace: Gray\n  Mime type: image/bmp\n";
        let r = parse_identify_output(raw, 100).unwrap();
        assert!(r.width.is_none());
        assert!(r.height.is_none());
        assert_eq!(r.color_space.as_deref(), Some("Gray"));
        assert_eq!(r.image_format.as_deref(), Some("bmp"));
    }

    #[test]
    fn handles_missing_mime_type() {
        let raw = "  Geometry: 640x480+0+0\n  Colorspace: CMYK\n";
        let r = parse_identify_output(raw, 50).unwrap();
        assert_eq!(r.width, Some(640));
        assert_eq!(r.height, Some(480));
        assert!(r.image_format.is_none());
        assert_eq!(r.color_space.as_deref(), Some("CMYK"));
    }

    #[test]
    fn handles_empty_input() {
        let r = parse_identify_output("", 0).unwrap();
        assert!(r.width.is_none());
        assert!(r.height.is_none());
        assert!(r.color_space.is_none());
        assert!(r.image_format.is_none());
        assert_eq!(r.source_kind, SourceKind::Image);
    }

    #[test]
    fn geometry_without_offset() {
        // Some older ImageMagick output may lack the +0+0 offset
        let raw = "  Geometry: 800x600\n";
        let r = parse_identify_output(raw, 0).unwrap();
        assert_eq!(r.width, Some(800));
        assert_eq!(r.height, Some(600));
    }
}
