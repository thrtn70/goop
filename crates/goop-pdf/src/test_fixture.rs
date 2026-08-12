//! Shared test fixture for the per-op test modules. Each new op module
//! needs a minimal multi-page PDF on disk to exercise its lopdf path;
//! rather than duplicate the fixture builder in every `#[cfg(test)] mod`,
//! it lives here gated behind `#[cfg(test)]`.
#![cfg(test)]

use goop_sidecar::BinaryResolver;
use lopdf::{Dictionary, Document, Object};
use std::path::{Path, PathBuf};

/// This checkout's `src-tauri/bin`, where `scripts/fetch-sidecars.sh` puts the
/// binaries the app actually ships.
pub fn bundled_bin_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/goop-pdf sits two levels below the workspace root")
        .join("src-tauri/bin")
}

/// Where `eng.traineddata` lives, for the OCR paths.
pub fn bundled_tessdata_dir() -> PathBuf {
    bundled_bin_dir().join("tesseract-data")
}

/// Ghostscript's `Resource`/`lib`/`iccprofiles` tree, for `-sGenericResourceDir`.
pub fn bundled_gs_resource_dir() -> PathBuf {
    bundled_bin_dir().join("gs-resources")
}

/// A resolver pointed at plainly-named links to this checkout's sidecars.
///
/// `src-tauri/bin` stores them as `<name>-<target-triple>`, the layout Tauri's
/// bundler consumes, while `BinaryResolver` looks for a bare `<name>` — which
/// is what the packaged app ends up with. A resolver aimed straight at
/// `src-tauri/bin` therefore misses every lookup and falls through to `$PATH`,
/// which on a dev machine is Homebrew. Every `#[ignore]`d test in this crate
/// did exactly that: they were exercising `/opt/homebrew/bin/{mutool,gs,
/// tesseract}` while their names claimed they covered the shipped binaries.
/// Bridging the two layouts is the whole point of this helper.
///
/// Symlinks suffice even for `gs` and `tesseract`, which reach their sibling
/// dylibs through `@loader_path`: dyld resolves the link before expanding it,
/// so the libraries are still found beside the real file. Checked against both
/// binaries rather than assumed — `mutool` is statically linked and never
/// cared either way.
pub fn bundled_resolver(link_dir: &Path) -> BinaryResolver {
    let bin = bundled_bin_dir();
    for name in ["mutool", "gs", "tesseract"] {
        // `BinaryResolver` appends `.exe` on Windows, so the link has to carry
        // it too, or the lookup misses and silently falls back to `$PATH` —
        // the very failure this exists to prevent.
        let (src_name, dst_name) = if cfg!(windows) {
            (
                format!("{name}-{}.exe", current_triple()),
                format!("{name}.exe"),
            )
        } else {
            (format!("{name}-{}", current_triple()), name.to_string())
        };
        let src = bin.join(src_name);
        if src.is_file() {
            // Surfaced rather than discarded. A swallowed error here reappears
            // as `require_bundled` blaming a missing fetch, which sends you
            // looking in the wrong place entirely.
            link(&src, &link_dir.join(dst_name))
                .unwrap_or_else(|e| panic!("linking {} into the test bin dir: {e}", src.display()));
        }
    }
    copy_sibling_dlls(&bin, link_dir);
    BinaryResolver::new(link_dir.to_path_buf())
}

/// Windows resolves an executable's imports from the directory it was loaded
/// from, and has no `@loader_path` equivalent to reach back to the real one.
/// `fetch-sidecars.sh` co-locates gs's and tesseract's DLLs beside the sidecar
/// for exactly that reason, so a copy needs the same neighbours or it fails
/// its import load before `main()` — a non-zero exit with empty stderr, which
/// says nothing about the cause and looks like a broken sidecar.
///
/// `require_bundled` cannot catch this: copying the `.exe` succeeds, so the
/// resolve is legitimately not from `$PATH` and the assertion passes.
#[cfg(windows)]
fn copy_sibling_dlls(bin: &Path, link_dir: &Path) {
    let entries = match std::fs::read_dir(bin) {
        Ok(e) => e,
        Err(e) => panic!("reading {} for sibling DLLs: {e}", bin.display()),
    };
    for entry in entries.flatten() {
        let src = entry.path();
        let is_dll = src
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("dll"));
        if !is_dll {
            continue;
        }
        if let Some(name) = src.file_name() {
            std::fs::copy(&src, link_dir.join(name))
                .unwrap_or_else(|e| panic!("copying {} beside the sidecar: {e}", src.display()));
        }
    }
}

/// Unix loads the siblings through `@loader_path`, which dyld expands against
/// the real file after resolving the symlink, so nothing needs copying.
#[cfg(unix)]
fn copy_sibling_dlls(_bin: &Path, _link_dir: &Path) {}

/// Resolve `name`, insisting it came from the bundle rather than `$PATH`.
///
/// Without this the suite goes green against whatever the machine happens to
/// have installed, which is how a sidecar regression reaches a release: the
/// tests that exist to catch it are testing a different binary.
pub fn require_bundled(resolver: &BinaryResolver, name: &str) -> PathBuf {
    let resolved = resolver
        .resolve(name)
        .unwrap_or_else(|e| panic!("{name} must resolve for this ignored test: {e}"));
    assert!(
        !resolved.source_is_path,
        "expected the bundled {name}, got {} from PATH — run scripts/fetch-sidecars.sh",
        resolved.path.display()
    );
    resolved.path
}

#[cfg(unix)]
fn link(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn link(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::copy(src, dst).map(|_| ())
}

fn current_triple() -> &'static str {
    // Only the two shipping targets need to resolve. Anything else leaves the
    // link dir empty, and `require_bundled` then fails loudly rather than
    // letting a `$PATH` binary stand in.
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

/// Write a minimal valid PDF with `page_count` blank Letter-sized pages
/// to `path`. Each page has a MediaBox of 612×792 points (8.5×11 inches
/// at 72 dpi) and no Contents stream — enough for `lopdf::Document::load`
/// to round-trip page counts and for downstream tests to verify
/// per-page operations.
pub fn write_blank_pdf(path: &Path, page_count: u32) {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut page_ids = Vec::with_capacity(page_count as usize);
    for _ in 0..page_count {
        let page_id = doc.new_object_id();
        let mut page = Dictionary::new();
        page.set("Type", "Page");
        page.set("Parent", pages_id);
        page.set(
            "MediaBox",
            Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
        );
        doc.objects.insert(page_id, Object::Dictionary(page));
        page_ids.push(Object::Reference(page_id));
    }
    let mut pages = Dictionary::new();
    pages.set("Type", "Pages");
    pages.set("Kids", Object::Array(page_ids));
    pages.set("Count", page_count as i64);
    doc.objects.insert(pages_id, Object::Dictionary(pages));
    let catalog_id = doc.new_object_id();
    let mut catalog = Dictionary::new();
    catalog.set("Type", "Catalog");
    catalog.set("Pages", pages_id);
    doc.objects.insert(catalog_id, Object::Dictionary(catalog));
    doc.trailer.set("Root", catalog_id);
    doc.save(path).expect("write fixture PDF");
}
