# Design Audit — <date>

> Template for a Goop UI/UX design audit. Copy this file, date it (e.g. `design-audit-2026-04-14.md`), and fill it in when reviewing the React shell, the queue, settings, or any new surface. Track P0/P1/P2 issues through to resolution in PRs.

## What's working
- <observation about a surface or interaction that earns its place>

## Issues

### P0 (crash, data loss, security)
- [ ] <issue — e.g. queue loses in-flight downloads on app quit; user URL leaked in logs; panic on malformed yt-dlp stderr>

### P1 (reliability, UX blocker)
- [ ] <issue — e.g. progress bar stalls at 99% until finalize completes; cancel button does not kill sidecar on Windows; reveal-in-OS fails on Linux Flatpak>

### P2 (polish, consistency)
- [ ] <issue — e.g. inconsistent spacing in queue rows; download-complete toast uses different copy than history row; dark/light mode mismatch on empty state>
