//! Camera RAW input: primary full-resolution SDR sRGB pixels on macOS.
//! Other platforms report unavailable support instead of decoding a preview.
use goop_core::{GoopError, ProbeResult};
use image::DynamicImage;
use std::path::Path;

pub fn is_raw_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "dng"
            | "nef"
            | "nrw"
            | "arw"
            | "srf"
            | "sr2"
            | "cr2"
            | "cr3"
            | "crw"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
            | "rwl"
            | "3fr"
            | "fff"
            | "iiq"
    )
}

fn raw_error(message: impl Into<String>) -> GoopError {
    GoopError::SubprocessFailed {
        binary: "RAW".into(),
        stderr: message.into(),
    }
}

pub fn probe_raw(path: &Path) -> Result<ProbeResult, GoopError> {
    #[cfg(target_os = "macos")]
    {
        use goop_core::SourceKind;
        let result = macos::read(path, false)?;
        Ok(ProbeResult {
            duration_ms: 0,
            width: Some(result.width),
            height: Some(result.height),
            video_codec: None,
            audio_codec: None,
            file_size: std::fs::metadata(path)?.len(),
            container: None,
            has_video: false,
            has_audio: false,
            source_kind: SourceKind::Image,
            color_space: Some("sRGB".into()),
            image_format: Some(
                if path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("dng"))
                {
                    "DNG"
                } else {
                    "RAW"
                }
                .into(),
            ),
            has_subtitles: false,
            subtitle_codecs: vec![],
            audio_codecs: vec![],
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(unavailable())
    }
}

pub fn decode_raw(path: &Path) -> Result<DynamicImage, GoopError> {
    #[cfg(target_os = "macos")]
    {
        let result = macos::read(path, true)?;
        result.into_image()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(unavailable())
    }
}

#[cfg(not(target_os = "macos"))]
fn unavailable() -> GoopError {
    raw_error("RAW conversion is available on macOS only. Export the original as TIFF or PNG using your camera software first.")
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, c_int, CStr, CString};
    use std::os::unix::ffi::OsStrExt;

    #[repr(C)]
    pub(super) struct NativeResult {
        pub width: u32,
        pub height: u32,
        pixels: *mut u8,
        length: usize,
        error: [c_char; 512],
    }

    unsafe extern "C" {
        fn goop_raw_read(path: *const c_char, decode: c_int, result: *mut NativeResult) -> c_int;
        fn goop_raw_free(pixels: *mut u8);
    }

    impl Drop for NativeResult {
        fn drop(&mut self) {
            // SAFETY: the bridge gives this result sole ownership of its malloc
            // allocation, and the matching release function accepts null.
            unsafe { goop_raw_free(self.pixels) };
        }
    }

    impl NativeResult {
        pub fn into_image(self) -> Result<DynamicImage, GoopError> {
            let length = (self.width as usize)
                .checked_mul(self.height as usize)
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or_else(|| raw_error("RAW buffer dimensions overflow"))?;
            if self.pixels.is_null() || self.length != length {
                return Err(raw_error("RAW renderer returned an invalid pixel buffer"));
            }
            // SAFETY: successful bridge call returns an initialized allocation
            // of `length` bytes, uniquely owned until this result is dropped.
            let rgba = unsafe { std::slice::from_raw_parts(self.pixels, length) };
            let mut rgb = Vec::new();
            rgb.try_reserve_exact(length / 4 * 3)
                .map_err(|_| raw_error("Insufficient memory for RAW RGB pixels"))?;
            for pixel in rgba.chunks_exact(4) {
                rgb.extend_from_slice(&pixel[..3]);
            }
            image::RgbImage::from_raw(self.width, self.height, rgb)
                .map(DynamicImage::ImageRgb8)
                .ok_or_else(|| raw_error("RAW renderer returned invalid RGB dimensions"))
        }
    }

    pub(super) fn read(path: &Path, decode: bool) -> Result<NativeResult, GoopError> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| raw_error("RAW path contains a NUL byte"))?;
        let mut result = NativeResult {
            width: 0,
            height: 0,
            pixels: std::ptr::null_mut(),
            length: 0,
            error: [0; 512],
        };
        // SAFETY: both pointers are valid for the synchronous call. The bridge
        // contains native exceptions and does not retain the path or result.
        let ok = unsafe { goop_raw_read(path.as_ptr(), i32::from(decode), &mut result) };
        if ok == 0 {
            // SAFETY: bridge diagnostics use snprintf into a zeroed fixed array.
            let error = unsafe { CStr::from_ptr(result.error.as_ptr()) };
            return Err(raw_error(error.to_string_lossy().into_owned()));
        }
        if result.width == 0
            || result.height == 0
            || result.width > 32768
            || result.height > 32768
            || u64::from(result.width) * u64::from(result.height) > 100_000_000
        {
            return Err(raw_error("RAW dimensions exceed the safety limit"));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_case_insensitive_and_exclude_rasters() {
        for ext in ["dng", "DNG", "ArW", "cr3", "nef", "RAF"] {
            assert!(is_raw_extension(ext));
        }
        for ext in ["", "raw", "png", "tiff", "jpg", ".dng"] {
            assert!(!is_raw_extension(ext));
        }
    }

    #[test]
    fn malformed_and_missing_raw_return_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.dng");
        assert!(probe_raw(&path).is_err());
        std::fs::write(&path, b"not a raw image").unwrap();
        assert!(probe_raw(&path).is_err());
        assert!(decode_raw(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"not a raw image");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn nul_path_returns_error_without_entering_native_code() {
        let error = decode_raw(Path::new("bad\0.dng")).unwrap_err();
        assert!(error.to_string().contains("NUL"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unavailable_platform_returns_actionable_error() {
        for error in [
            probe_raw(Path::new("photo.dng")).unwrap_err(),
            decode_raw(Path::new("photo.dng")).unwrap_err(),
        ] {
            let text = error.to_string();
            assert!(text.contains("macOS only"));
            assert!(text.contains("TIFF or PNG"));
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod renderer_tests {
    use super::*;
    use image::GenericImageView;

    // A small Bayer DNG with no preview IFD. The 16-bit quadrants make
    // reflections/rotations observable, independently of camera appearance.
    fn dng(orientation: u16) -> Vec<u8> {
        fn shorts(values: &[u16]) -> Vec<u8> {
            values.iter().flat_map(|n| n.to_le_bytes()).collect()
        }
        fn longs(values: &[u32]) -> Vec<u8> {
            values.iter().flat_map(|n| n.to_le_bytes()).collect()
        }
        let mut tags: Vec<(u16, u16, u32, Vec<u8>)> = vec![
            (254, 4, 1, longs(&[0])),
            (256, 4, 1, longs(&[512])),
            (257, 4, 1, longs(&[384])),
            (258, 3, 1, shorts(&[16])),
            (259, 3, 1, shorts(&[1])),
            (262, 3, 1, shorts(&[32803])),
            (271, 2, 6, b"Goop\0\0".to_vec()),
            (272, 2, 12, b"Test Camera\0".to_vec()),
            (273, 4, 1, longs(&[0])),
            (274, 3, 1, shorts(&[orientation])),
            (277, 3, 1, shorts(&[1])),
            (278, 4, 1, longs(&[384])),
            (279, 4, 1, longs(&[512 * 384 * 2])),
            (284, 3, 1, shorts(&[1])),
            (33421, 3, 2, shorts(&[2, 2])),
            (33422, 1, 4, vec![0, 1, 1, 2]),
            (50706, 1, 4, vec![1, 4, 0, 0]),
            (50707, 1, 4, vec![1, 3, 0, 0]),
            (50708, 2, 12, b"Test Camera\0".to_vec()),
            (50711, 3, 1, shorts(&[1])),
            (50717, 4, 1, longs(&[65535])),
            (50718, 5, 2, longs(&[1, 1, 1, 1])),
            (50719, 4, 2, longs(&[0, 0])),
            (50720, 4, 2, longs(&[512, 384])),
            (
                50721,
                10,
                9,
                longs(&[1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1]),
            ),
            (50728, 5, 3, longs(&[1, 1, 1, 1, 1, 1])),
            (50778, 3, 1, shorts(&[21])),
        ];
        tags.sort_by_key(|tag| tag.0);
        let base = 8 + 2 + tags.len() * 12 + 4;
        let mut tail = Vec::new();
        let mut bytes = b"II\x2a\0\x08\0\0\0".to_vec();
        bytes.extend_from_slice(&(tags.len() as u16).to_le_bytes());
        let mut strip_offset = 0;
        for (tag, kind, count, value) in tags {
            bytes.extend_from_slice(&tag.to_le_bytes());
            bytes.extend_from_slice(&kind.to_le_bytes());
            bytes.extend_from_slice(&count.to_le_bytes());
            if tag == 273 {
                strip_offset = bytes.len();
            }
            if value.len() <= 4 {
                bytes.extend_from_slice(&value);
                bytes.resize(bytes.len() + 4 - value.len(), 0);
            } else {
                bytes.extend_from_slice(&((base + tail.len()) as u32).to_le_bytes());
                tail.extend_from_slice(&value);
                if tail.len() % 2 != 0 {
                    tail.push(0);
                }
            }
        }
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&tail);
        let start = bytes.len() as u32;
        bytes[strip_offset..strip_offset + 4].copy_from_slice(&start.to_le_bytes());
        for y in 0..384 {
            for x in 0..512 {
                let value: [u16; 3] = match (x < 256, y < 192) {
                    (true, true) => [40000, 1000, 1000],
                    (false, true) => [1000, 40000, 1000],
                    (true, false) => [1000, 1000, 40000],
                    (false, false) => [20000, 20000, 20000],
                };
                let channel = match (x % 2, y % 2) {
                    (0, 0) => 0,
                    (1, 1) => 2,
                    _ => 1,
                };
                bytes.extend_from_slice(&value[channel].to_le_bytes());
            }
        }
        bytes
    }

    #[test]
    fn truncated_dng_cannot_succeed_via_metadata_or_preview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("truncated.dng");
        let mut bytes = dng(1);
        bytes.truncate(1024);
        std::fs::write(&path, bytes).unwrap();
        assert!(decode_raw(&path).is_err());
    }

    #[test]
    fn primary_dng_render_preserves_full_size_rgb_original_and_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.dng");
        std::fs::write(&path, dng(1)).unwrap();
        let base = decode_raw(&path).expect("synthetic Bayer DNG must render");
        assert_eq!(base.dimensions(), (512, 384));
        assert_eq!(base.color(), image::ColorType::Rgb8);
        assert_ne!(base.get_pixel(64, 64), base.get_pixel(320, 64));
        assert_ne!(base.get_pixel(64, 64), base.get_pixel(64, 320));
        // All orientation comparisons use the actual rendered pixels, keeping
        // this independent of the camera profile's tone and color processing.
        for orientation in 1..=8 {
            let original = dng(orientation);
            std::fs::write(&path, &original).unwrap();
            let probe = probe_raw(&path).unwrap();
            let rendered = decode_raw(&path).unwrap();
            let mut expected = base.clone();
            expected.apply_orientation(
                image::metadata::Orientation::from_exif(orientation as u8).unwrap(),
            );
            assert_eq!(
                rendered.dimensions(),
                expected.dimensions(),
                "orientation {orientation}"
            );
            assert_eq!(
                (probe.width, probe.height),
                (Some(rendered.width()), Some(rendered.height()))
            );
            for (x, y) in [(64, 64), (320, 64), (64, 320), (320, 320)] {
                assert_eq!(
                    rendered.get_pixel(x, y),
                    expected.get_pixel(x, y),
                    "orientation {orientation} at {x},{y}"
                );
            }
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
    }
}
