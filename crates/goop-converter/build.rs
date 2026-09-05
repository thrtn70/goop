fn main() {
    println!("cargo:rerun-if-changed=native/raw.m");
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/raw.m")
            .flag("-fobjc-arc")
            .flag("-fobjc-exceptions")
            .compile("goop_raw");
        for framework in ["Foundation", "CoreImage", "ImageIO", "CoreGraphics"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
