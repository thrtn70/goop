# Goop

**A no-frills desktop app for downloading video and audio from URLs.**

Paste a link, pick a format, and Goop handles the rest through a bundled `yt-dlp` with a live queue, progress, and cancel. No accounts, no telemetry, no remote config — it only reaches out to download what you asked for.

![Screenshot placeholder](docs/screenshot.png)

*Screenshot coming in v0.1.1.*

---

## Features (v0.1)

- Paste a video or audio URL, probe it, pick a format, and download.
- Drop files onto the window to queue them.
- Queue sidebar with live progress, speed, and ETA; per-row cancel.
- Reveal finished downloads in the OS file manager.
- Persistent settings (download folder, theme, concurrency) in your OS config dir.
- Light / dark / system theme.
- Supported sites include YouTube, SoundCloud, TikTok, Instagram, Twitter/X, Vimeo, Reddit, and generic HTTP(S) media — anything `yt-dlp` handles.

---

## Requirements

- **Windows 10+** (x64) with WebView2 Runtime (ships with Windows 11; auto-installed on Windows 10 if missing).
- **macOS 13+** on Intel or Apple Silicon.
- ~150 MB disk for the app + bundled sidecars.
- A working network connection *only* when downloading.

---

## Installation

Grab the build for your OS from the [Releases page](https://github.com/thrtn70/goop/releases/latest):

### Windows
1. Download `Goop_<version>_x64_en-US.msi`.
2. Double-click to install.
3. Launch from the Start menu.

### macOS
1. Download `Goop_<version>_aarch64.dmg` (Apple Silicon) or `Goop_<version>_x64.dmg` (Intel).
2. Open the DMG and drag **Goop.app** into `/Applications`.
3. **Run once in Terminal** to clear the Gatekeeper quarantine flag:
   ```bash
   xattr -cr /Applications/Goop.app
   ```
   Goop is not signed with an Apple Developer ID, so macOS will otherwise refuse to launch it.
4. Open Goop from Launchpad or Spotlight.

---

## Tips & Troubleshooting

- **"Goop.app can't be opened because Apple cannot check it for malicious software" (macOS).** Run the `xattr -cr` command in the installation section above.
- **First download is slow or fails immediately.** Goop bundles `yt-dlp` but some sites change their internal APIs frequently. Open **Settings → Check for updates** to self-update the bundled `yt-dlp` to the latest release.
- **Downloads stall or fail with "HTTP 403".** Usually means `yt-dlp` needs an update — same fix as above. If that doesn't help, the host may be blocking data-center IPs or require sign-in (Goop doesn't support authenticated sessions in v0.1).
- **The audio-only checkbox produces video anyway.** Make sure the selected format row has `audio only` in the dropdown, or toggle the "audio only" checkbox and pick "Best (auto)".
- **Progress bar stays at 99% for a while.** Normal for large files — `yt-dlp` is muxing/finalizing. Don't cancel.
- **Windows Defender flags the installer.** The installer is not yet code-signed. Verify the SHA-256 of the `.msi` against the hash on the Releases page, then allow it through SmartScreen.
- **Where does Goop store files?** The default download folder is your OS's standard Downloads directory. Change it in Settings. The queue database and settings file live in your OS config directory under `goop/`.
- **Reporting bugs.** Open a [GitHub issue](https://github.com/thrtn70/goop/issues) with your OS, the exact URL pattern (redact personal info), and a snippet from the log (launch with `RUST_LOG=goop=debug` to get verbose output).

---

## Build from source

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites (Rust 1.80+, Node 20+, platform toolchains), the dev loop, and the contribution process. Built with Tauri 2, Rust, React, TypeScript, and Tailwind.

---

## Roadmap

Planned after v0.1:
- Convert / compress / edit operations (the other verbs in the name).
- Signed macOS builds and a code-signed Windows installer.
- Auto-update for the app shell itself.
- Multi-URL batch paste.

## License

[MIT](LICENSE).
