//! `ImageOperation::AppIcon` — generate a folder of platform icon
//! containers and standard PNG sizes from a single source image.
//! Each requested platform gets exactly what its OS expects:
//!
//! * `Macos` → `icon.icns` (the Apple icon container, all sizes from
//!   16 to 1024)
//! * `Windows` → `icon.ico` (16, 32, 48, 256 — the standard Windows
//!   shell sizes)
//! * `Web` → loose `favicon-<size>.png` files at favicon sizes (16,
//!   32, 48, 192, 512)
//!
//! Resampling uses `Lanczos3` (best built-in filter in the `image`
//! crate) at every target size to keep small icons crisp.

use crate::imagemagick::decode_any;
use goop_core::{GoopError, IconPlatform};
use image::imageops::FilterType;
use image::{DynamicImage, RgbaImage};
use std::io::Cursor;
use std::path::{Path, PathBuf};

const FILTER: FilterType = FilterType::Lanczos3;

const MAC_SIZES: &[u32] = &[16, 32, 64, 128, 256, 512, 1024];
const WINDOWS_SIZES: &[u32] = &[16, 32, 48, 256];
const WEB_SIZES: &[u32] = &[16, 32, 48, 192, 512];

/// Generate platform icon containers + PNG sets from `input` into
/// `output_dir`. `platforms` selects which platforms to emit. Returns
/// the list of files written, in writing order.
pub fn app_icon(
    input: &Path,
    output_dir: &Path,
    platforms: &[IconPlatform],
) -> Result<Vec<PathBuf>, GoopError> {
    app_icon_cancellable(
        input,
        output_dir,
        platforms,
        &tokio_util::sync::CancellationToken::new(),
    )
}

pub(crate) fn app_icon_cancellable(
    input: &Path,
    output_dir: &Path,
    platforms: &[IconPlatform],
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Vec<PathBuf>, GoopError> {
    if cancel.is_cancelled() {
        return Err(GoopError::Cancelled);
    }

    if platforms.is_empty() {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "app_icon requires at least one platform".into(),
        });
    }

    let img = decode_any(input)?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: "app_icon: source image has zero dimensions".into(),
        });
    }

    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to create output directory: {e}"),
        })?;
    }

    let mut outputs = Vec::new();
    let mut wrote_mac = false;
    let mut wrote_win = false;
    let mut wrote_web = false;

    for platform in platforms {
        if cancel.is_cancelled() {
            return Err(GoopError::Cancelled);
        }
        // Idempotency: if the caller passes `[Macos, Macos]` we still
        // do it once; the second pass is a no-op rather than an
        // overwrite-and-no-progress confusing result.
        match platform {
            IconPlatform::Macos if !wrote_mac => {
                outputs.push(write_icns(&img, output_dir)?);
                wrote_mac = true;
            }
            IconPlatform::Windows if !wrote_win => {
                outputs.push(write_ico(&img, output_dir)?);
                wrote_win = true;
            }
            IconPlatform::Web if !wrote_web => {
                outputs.extend(write_web_pngs(&img, output_dir)?);
                wrote_web = true;
            }
            _ => {}
        }
    }
    Ok(outputs)
}

fn resample_rgba(img: &DynamicImage, size: u32) -> RgbaImage {
    img.resize_exact(size, size, FILTER).to_rgba8()
}

fn write_icns(img: &DynamicImage, output_dir: &Path) -> Result<PathBuf, GoopError> {
    let mut family = icns::IconFamily::new();
    for &size in MAC_SIZES {
        let rgba = resample_rgba(img, size);
        // icns 0.3's `Image::from_data` takes raw RGBA bytes and the
        // dimensions; the OS code we pick determines the format slot
        // (e.g. ic07 = 128×128, ic08 = 256×256, …). The crate has a
        // helper to pick the OS-code from a freshly built Image.
        let icon = icns::Image::from_data(icns::PixelFormat::RGBA, size, size, rgba.into_raw())
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("icns: failed to build {size}px image: {e}"),
            })?;
        family
            .add_icon(&icon)
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("icns: failed to add {size}px image to family: {e}"),
            })?;
    }
    let out_path = output_dir.join("icon.icns");
    let file = std::fs::File::create(&out_path).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to create icns file: {e}"),
    })?;
    family
        .write(file)
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("icns: write failed: {e}"),
        })?;
    Ok(out_path)
}

fn write_ico(img: &DynamicImage, output_dir: &Path) -> Result<PathBuf, GoopError> {
    let mut icon_dir = ico::IconDir::new(ico::ResourceType::Icon);
    for &size in WINDOWS_SIZES {
        let rgba = resample_rgba(img, size);
        // `IconImage::from_rgba_data` takes the dimensions + raw RGBA
        // bytes; the ico crate handles the BMP / PNG sub-format
        // dispatch (sizes ≥ 256 → PNG, others → BMP).
        let icon = ico::IconImage::from_rgba_data(size, size, rgba.into_raw());
        let entry = ico::IconDirEntry::encode(&icon).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("ico: failed to encode {size}px image: {e}"),
        })?;
        icon_dir.add_entry(entry);
    }
    let out_path = output_dir.join("icon.ico");
    let file = std::fs::File::create(&out_path).map_err(|e| GoopError::SubprocessFailed {
        binary: "image".into(),
        stderr: format!("failed to create ico file: {e}"),
    })?;
    icon_dir
        .write(file)
        .map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("ico: write failed: {e}"),
        })?;
    Ok(out_path)
}

fn write_web_pngs(img: &DynamicImage, output_dir: &Path) -> Result<Vec<PathBuf>, GoopError> {
    let mut out = Vec::with_capacity(WEB_SIZES.len());
    for &size in WEB_SIZES {
        let rgba = resample_rgba(img, size);
        let mut buf: Vec<u8> = Vec::new();
        DynamicImage::ImageRgba8(rgba)
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .map_err(|e| GoopError::SubprocessFailed {
                binary: "image".into(),
                stderr: format!("png encode failed at {size}px: {e}"),
            })?;
        let path = output_dir.join(format!("favicon-{size}.png"));
        std::fs::write(&path, &buf).map_err(|e| GoopError::SubprocessFailed {
            binary: "image".into(),
            stderr: format!("failed to write {}: {e}", path.display()),
        })?;
        out.push(path);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn tmp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static C: AtomicU64 = AtomicU64::new(0);
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let c = C.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("goop-appicon-{label}-{n}-{c}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgba<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgba([x as u8, y as u8, 128, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn cancelled_batch_does_not_start() {
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            app_icon_cancellable(
                Path::new("missing.png"),
                Path::new("unused"),
                &[IconPlatform::Web],
                &cancel
            ),
            Err(GoopError::Cancelled)
        ));
    }
    #[test]
    fn icns_output_has_apple_magic_bytes() {
        let dir = tmp_dir("icns");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 1024, 1024);
        let out_dir = dir.join("out");
        let outs = app_icon(&in_path, &out_dir, &[IconPlatform::Macos]).unwrap();
        assert_eq!(outs.len(), 1);
        let bytes = std::fs::read(&outs[0]).unwrap();
        // .icns starts with the magic "icns" (0x69 0x63 0x6e 0x73).
        assert_eq!(&bytes[0..4], b"icns");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ico_round_trips_through_ico_crate() {
        let dir = tmp_dir("ico");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 512, 512);
        let out_dir = dir.join("out");
        let outs = app_icon(&in_path, &out_dir, &[IconPlatform::Windows]).unwrap();
        assert_eq!(outs.len(), 1);
        let file = std::fs::File::open(&outs[0]).unwrap();
        let dir_parsed = ico::IconDir::read(file).unwrap();
        // We requested 16, 32, 48, 256; the dir should hold those.
        let entries = dir_parsed.entries();
        let widths: Vec<u32> = entries.iter().map(|e| e.width()).collect();
        for expected in [16, 32, 48, 256] {
            assert!(
                widths.contains(&expected),
                "missing {expected}px entry in {widths:?}"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn web_writes_favicon_pngs() {
        let dir = tmp_dir("web");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 1024, 1024);
        let out_dir = dir.join("out");
        let outs = app_icon(&in_path, &out_dir, &[IconPlatform::Web]).unwrap();
        assert_eq!(outs.len(), WEB_SIZES.len());
        for path in &outs {
            assert!(std::fs::metadata(path).unwrap().len() > 0);
            assert_eq!(path.extension().unwrap(), "png");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn all_three_platforms_in_one_call() {
        let dir = tmp_dir("all");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 1024, 1024);
        let out_dir = dir.join("out");
        let outs = app_icon(
            &in_path,
            &out_dir,
            &[
                IconPlatform::Macos,
                IconPlatform::Windows,
                IconPlatform::Web,
            ],
        )
        .unwrap();
        // 1 icns + 1 ico + 5 favicon pngs = 7 outputs total.
        assert_eq!(outs.len(), 2 + WEB_SIZES.len());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_platforms_are_idempotent() {
        let dir = tmp_dir("dupe");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 256, 256);
        let out_dir = dir.join("out");
        let outs = app_icon(
            &in_path,
            &out_dir,
            &[IconPlatform::Macos, IconPlatform::Macos],
        )
        .unwrap();
        assert_eq!(outs.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_platforms_rejected() {
        let dir = tmp_dir("empty");
        let in_path = dir.join("in.png");
        write_test_png(&in_path, 32, 32);
        let err = app_icon(&in_path, &dir, &[]).unwrap_err();
        assert!(err.to_string().contains("at least one"));
    }
}
