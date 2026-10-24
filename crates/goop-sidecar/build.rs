//! Compiles the bundled yt-dlp and gallery-dl versions into the crate.
//!
//! `scripts/fetch-sidecars.sh` pins the releases Goop bundles. The resolver
//! needs the same versions to tell an update-dir copy that is newer than the
//! bundled one from one that is older, so they are read from the script
//! rather than restated here, where a pin bump could leave them behind.

#[path = "src/pins.rs"]
mod pins;

use std::path::PathBuf;

/// The script's variable for each pin, and the env var the crate reads it
/// from with `env!`.
const PINS: [(&str, &str); 2] = [
    ("YT_DLP_VERSION", "GOOP_BUNDLED_YT_DLP_VERSION"),
    ("GALLERY_DL_VERSION", "GOOP_BUNDLED_GALLERY_DL_VERSION"),
];

fn main() {
    let manifest_dir =
        std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let script = PathBuf::from(manifest_dir).join("../../scripts/fetch-sidecars.sh");
    println!("cargo:rerun-if-changed={}", script.display());
    let text = std::fs::read_to_string(&script)
        .unwrap_or_else(|e| panic!("reading {}: {e}", script.display()));
    for (var, env) in PINS {
        let version = pins::read_pin(&text, var).unwrap_or_else(|| {
            panic!(
                "{} must define {var} exactly once, as a quoted version",
                script.display()
            )
        });
        println!("cargo:rustc-env={env}={version}");
    }
}
