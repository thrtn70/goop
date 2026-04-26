import { useEffect } from "react";
import { type AppVersionInfo, useAppStore } from "@/store/appStore";

export type { AppVersionInfo };

const FALLBACK: AppVersionInfo = { goop: "-", ytDlp: null, ffmpeg: null, os: "-" };

/**
 * Return the cached app + sidecar versions from the store. The cache is warmed
 * during app boot (see `bootstrapStoreSubscriptions`), so navigating to
 * Settings → About normally shows filled values immediately. If the cache is
 * empty (e.g. settings opened before boot completed, or Tauri unavailable),
 * this hook triggers a load and re-renders when the data arrives.
 */
export function useAppVersion(): AppVersionInfo {
  const versions = useAppStore((s) => s.versions);
  const loadVersions = useAppStore((s) => s.loadVersions);

  useEffect(() => {
    if (!versions) {
      void loadVersions().catch(() => {
        /* keep FALLBACK if it fails */
      });
    }
  }, [versions, loadVersions]);

  return versions ?? FALLBACK;
}
