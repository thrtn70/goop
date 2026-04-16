import { useState } from "react";
import { useAppStore } from "@/store/appStore";
import { formatError } from "@/ipc/error";

function bytesToMb(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "";
  return `${(b / 1_000_000).toFixed(1)} MB`;
}

export default function UpdateBanner() {
  const updateInfo = useAppStore((s) => s.updateInfo);
  const updateDownload = useAppStore((s) => s.updateDownload);
  const settings = useAppStore((s) => s.settings);
  const dismissUpdate = useAppStore((s) => s.dismissUpdate);
  const startUpdateDownload = useAppStore((s) => s.startUpdateDownload);
  const [error, setError] = useState<string | null>(null);

  if (!updateInfo) return null;
  if (
    settings?.dismissed_update_version &&
    settings.dismissed_update_version === updateInfo.latest_version
  ) {
    return null;
  }

  const downloading = updateDownload?.active ?? false;
  const total = Number(updateInfo.asset_size);
  const percent =
    updateDownload && updateDownload.total > 0
      ? Math.min(100, Math.round((updateDownload.downloaded / updateDownload.total) * 100))
      : 0;

  async function handleDownload() {
    if (!updateInfo) return;
    setError(null);
    try {
      await startUpdateDownload(updateInfo.download_url, Number(updateInfo.asset_size));
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function handleDismiss() {
    if (!updateInfo) return;
    try {
      await dismissUpdate(updateInfo.latest_version);
    } catch {
      /* ignore — worst case banner reappears */
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="enter-up flex items-center gap-3 border-b border-accent-subtle bg-accent-subtle px-4 py-2 text-sm"
    >
      <span className="font-medium text-fg">
        Goop v{updateInfo.latest_version} is available
      </span>
      <span className="text-fg-muted">({bytesToMb(total)})</span>
      <div className="flex-1" />
      {downloading ? (
        <div className="flex items-center gap-2">
          <div
            className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-2"
            aria-label="Download progress"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-accent transition-[width] duration-fast ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-fg-muted">{percent}%</span>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void handleDownload()}
            className="btn-press rounded-md bg-accent px-3 py-1 text-xs font-semibold text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
          >
            Download
          </button>
          <button
            type="button"
            onClick={() => void handleDismiss()}
            className="btn-press text-xs text-fg-muted transition duration-fast ease-out hover:text-fg"
          >
            Dismiss
          </button>
        </>
      )}
      {error && <span className="ml-2 text-xs text-error">{error}</span>}
    </div>
  );
}
