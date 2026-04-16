import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "@/ipc/commands";

export interface AppVersionInfo {
  goop: string;
  ytDlp: string | null;
  ffmpeg: string | null;
  os: string;
}

const UNKNOWN: AppVersionInfo = { goop: "-", ytDlp: null, ffmpeg: null, os: "-" };

function detectOs(): string {
  if (typeof navigator === "undefined") return "-";
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) {
    const m = ua.match(/Mac OS X ([0-9_]+)/);
    const ver = m?.[1]?.replace(/_/g, ".") ?? "";
    return ver ? `macOS ${ver}` : "macOS";
  }
  if (/Windows NT/.test(ua)) {
    const m = ua.match(/Windows NT ([0-9.]+)/);
    return m?.[1] ? `Windows ${m[1]}` : "Windows";
  }
  return navigator.platform || "-";
}

/**
 * Reads the app's Goop version via Tauri's built-in API (it reads from
 * tauri.conf.json at runtime so we don't need a dedicated IPC command)
 * plus the versions of the bundled sidecars. Used by Settings → About.
 */
export function useAppVersion(): AppVersionInfo {
  const [info, setInfo] = useState<AppVersionInfo>(() => ({ ...UNKNOWN, os: detectOs() }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [goop, ytDlp, ffmpeg] = await Promise.all([
          getVersion().catch(() => UNKNOWN.goop),
          api.sidecar.ytDlpVersion().catch(() => null),
          api.sidecar.ffmpegVersion().catch(() => null),
        ]);
        if (cancelled) return;
        setInfo({ goop, ytDlp, ffmpeg, os: detectOs() });
      } catch {
        /* ignore — keep fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
