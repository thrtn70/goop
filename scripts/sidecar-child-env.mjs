// The whole environment a sidecar runtime check hands its child: a throwaway
// home and the system PATH, and nothing from the caller's environment (no CI
// tokens, proxies, SSL_CERT_* or DYLD_*/LD_* overrides).
//
// Windows needs SystemRoot to start Python and TEMP/TMP for the PyInstaller
// unpack directory; USERPROFILE is what expanduser reads there.
//
// Kept apart from check-yt-dlp-runtime.mjs so tests can exercise the Windows
// branch on any platform without importing a script that runs on import.

import { join } from "node:path";

export function scrubbedEnv(home, { platform = process.platform, env = process.env } = {}) {
  const posix = {
    HOME: home,
    TMPDIR: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
  };
  if (platform !== "win32") return { ...posix, PATH: "/usr/bin:/bin" };
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return {
    ...posix,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    TEMP: home,
    TMP: home,
    SystemRoot: systemRoot,
    PATH: `${systemRoot}\\System32;${systemRoot}`,
  };
}
