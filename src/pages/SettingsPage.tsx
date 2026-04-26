import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { formatError } from "@/ipc/error";
import { api } from "@/ipc/commands";
import type { Theme } from "@/types";
import { useAppStore } from "@/store/appStore";
import SettingsSection from "@/components/SettingsSection";
import PresetManager from "@/features/presets/PresetManager";
import { useAppVersion } from "@/hooks/useAppVersion";

export default function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const checkForUpdate = useAppStore((s) => s.checkForUpdate);
  const version = useAppVersion();
  const [err, setErr] = useState<string | null>(null);
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const [ytDlpUpdateMsg, setYtDlpUpdateMsg] = useState<string | null>(null);
  const [ytDlpUpdating, setYtDlpUpdating] = useState(false);

  useEffect(() => {
    if (settings?.theme) {
      document.documentElement.className = settings.theme === "dark" ? "" : settings.theme;
    }
  }, [settings?.theme]);

  async function patch(partial: Parameters<typeof patchSettings>[0]): Promise<void> {
    try {
      await patchSettings(partial);
    } catch (e: unknown) {
      setErr(formatError(e));
    }
  }

  async function handleCheckNow() {
    setCheckingForUpdate(true);
    setErr(null);
    try {
      await checkForUpdate();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setCheckingForUpdate(false);
    }
  }

  async function handleYtDlpUpdate() {
    setYtDlpUpdating(true);
    setYtDlpUpdateMsg(null);
    try {
      const status = await api.sidecar.updateYtDlp();
      setYtDlpUpdateMsg(status.message || "yt-dlp is up to date.");
    } catch (e) {
      setYtDlpUpdateMsg(formatError(e));
    } finally {
      setYtDlpUpdating(false);
    }
  }

  async function handleOpenReleases() {
    try {
      await api.update.openReleasesPage();
    } catch (e) {
      setErr(formatError(e));
    }
  }

  async function handleOpenAboutLink(
    target: Parameters<typeof api.update.openAboutLink>[0],
  ): Promise<void> {
    try {
      await api.update.openAboutLink(target);
    } catch (e) {
      setErr(formatError(e));
    }
  }

  if (!settings)
    return (
      <div className="p-6 text-fg-muted" role="status" aria-live="polite">
        {err ?? "Loading settings..."}
      </div>
    );

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="font-display text-lg font-semibold text-fg">Settings</h2>

      <SettingsSection title="General" description="Where things land and how many run at once.">
        <Field
          label="Output folder"
          hint="Where finished downloads land. Drag-and-drop conversions save next to the source file unless you override here."
        >
          <input
            className="w-full rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            defaultValue={settings.output_dir}
            key={settings.output_dir}
            onBlur={(e) => void patch({ output_dir: e.target.value })}
          />
        </Field>
        <Field label="Theme" hint="Controls the app appearance. System follows your OS setting.">
          <select
            className="rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            value={settings.theme}
            onChange={(e) => void patch({ theme: e.target.value as Theme })}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <Field
          label="Simultaneous downloads"
          hint="How many URLs to download at once. Higher is faster but uses more bandwidth."
        >
          <input
            type="number"
            min={1}
            max={16}
            className="w-24 rounded-md bg-surface-2 p-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            defaultValue={settings.extract_concurrency}
            key={`ec-${settings.extract_concurrency}`}
            onBlur={(e) => void patch({ extract_concurrency: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Simultaneous processing"
          hint="How many files to convert or compress at once. Lower this if your computer gets hot or sluggish."
        >
          <input
            type="number"
            min={1}
            max={16}
            className="w-24 rounded-md bg-surface-2 p-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            defaultValue={settings.convert_concurrency}
            key={`cc-${settings.convert_concurrency}`}
            onBlur={(e) => void patch({ convert_concurrency: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Hardware acceleration"
          hint="Use your GPU's video encoder when available (VideoToolbox on Mac, NVENC/QSV/AMF on Windows). Falls back to software automatically if the GPU encode fails."
        >
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={settings.hw_acceleration_enabled}
              onChange={(e) => void patch({ hw_acceleration_enabled: e.target.checked })}
              className="h-4 w-4 rounded border-subtle bg-surface-2 accent-accent"
            />
            <span>Use hardware acceleration when available</span>
          </label>
        </Field>
        <Field
          label="Cookies from browser"
          hint="Use cookies from a logged-in browser to download videos from sites that require an account (Twitter/X, Instagram, etc.). Cookies are read locally and never leave your machine."
        >
          <select
            className="rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            value={settings.cookies_from_browser ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              void patch({ cookies_from_browser: v === "" ? null : v });
            }}
          >
            <option value="">None (off)</option>
            <option value="brave">Brave</option>
            <option value="chrome">Chrome</option>
            <option value="chromium">Chromium</option>
            <option value="edge">Edge</option>
            <option value="firefox">Firefox</option>
            <option value="opera">Opera</option>
            <option value="safari">Safari</option>
            <option value="vivaldi">Vivaldi</option>
            <option value="whale">Whale</option>
          </select>
        </Field>
      </SettingsSection>

      <SettingsSection title="Updates" description="Keep Goop and its sidecars current.">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={settings.auto_check_updates}
            onChange={(e) => void patch({ auto_check_updates: e.target.checked })}
            className="h-4 w-4 rounded border-subtle bg-surface-2 accent-accent"
          />
          <span>Check for updates on launch</span>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleCheckNow()}
            disabled={checkingForUpdate}
            className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checkingForUpdate ? "Checking..." : "Check for updates now"}
          </button>
          <span className="text-xs text-fg-muted">
            {updateInfo
              ? `Goop v${updateInfo.latest_version} is available`
              : "You're running the latest version."}
          </span>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => void handleYtDlpUpdate()}
            disabled={ytDlpUpdating}
            className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ytDlpUpdating ? "Updating..." : "Update yt-dlp"}
          </button>
          {ytDlpUpdateMsg && <span className="text-xs text-fg-muted">{ytDlpUpdateMsg}</span>}
        </div>
      </SettingsSection>

      <SettingsSection title="Presets" description="Named format + quality combinations for Convert and Compress.">
        <PresetManager />
      </SettingsSection>

      <SettingsSection title="About">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
          <dt className="text-fg-muted">Goop</dt>
          <dd className="text-fg tabular-nums">{version.goop}</dd>
          <dt className="text-fg-muted">yt-dlp</dt>
          <dd className="text-fg tabular-nums">{version.ytDlp ?? "-"}</dd>
          <dt className="text-fg-muted">ffmpeg</dt>
          <dd className="text-fg">{version.ffmpeg ?? "-"}</dd>
          <dt className="text-fg-muted">Platform</dt>
          <dd className="text-fg">{version.os}</dd>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => void handleOpenReleases()}
            className="btn-press text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
          >
            Releases →
          </button>
          <button
            type="button"
            onClick={() => void handleOpenAboutLink("repo")}
            className="btn-press text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
          >
            Source on GitHub →
          </button>
          <button
            type="button"
            onClick={() => void handleOpenAboutLink("issues")}
            className="btn-press text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
          >
            Report an issue →
          </button>
          <button
            type="button"
            onClick={() => void handleOpenAboutLink("license")}
            className="btn-press text-xs text-accent transition duration-fast ease-out hover:text-accent-hover"
          >
            License (MIT) →
          </button>
          <button
            type="button"
            onClick={() => void patch({ has_seen_onboarding: false })}
            className="btn-press text-xs text-fg-secondary transition duration-fast ease-out hover:text-fg"
          >
            Show welcome screen
          </button>
        </div>

        <div className="mt-4 border-t border-subtle pt-3">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
            Built on
          </h4>
          <p className="mt-2 text-xs text-fg-secondary">
            Goop ships bundled copies of these excellent open-source tools:
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            <li>
              <button
                type="button"
                onClick={() => void handleOpenAboutLink("yt-dlp")}
                className="btn-press text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                yt-dlp
              </button>
              <span className="text-fg-muted"> — URL extraction and download.</span>
            </li>
            <li>
              <button
                type="button"
                onClick={() => void handleOpenAboutLink("ffmpeg")}
                className="btn-press text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                ffmpeg
              </button>
              <span className="text-fg-muted">
                {" "}
                — media conversion, compression, and audio waveform thumbnails.
              </span>
            </li>
            <li>
              <button
                type="button"
                onClick={() => void handleOpenAboutLink("ghostscript")}
                className="btn-press text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                Ghostscript
              </button>
              <span className="text-fg-muted"> — PDF compression and thumbnail rendering.</span>
            </li>
            <li>
              <button
                type="button"
                onClick={() => void handleOpenAboutLink("tauri")}
                className="btn-press text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                Tauri
              </button>
              <span className="text-fg-muted"> — desktop shell and IPC.</span>
            </li>
          </ul>
        </div>
      </SettingsSection>

      {err && <p className="text-sm text-error">{err}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">{label}</span>
      {hint && <p className="mb-2 text-xs text-fg-muted/70">{hint}</p>}
      {children}
    </label>
  );
}
