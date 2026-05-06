import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { formatError } from "@/ipc/error";
import { api } from "@/ipc/commands";
import type { Theme } from "@/types";
import { useAppStore } from "@/store/appStore";
import SettingsSection from "@/components/SettingsSection";
import PresetManager from "@/features/presets/PresetManager";
import { useAppVersion } from "@/hooks/useAppVersion";

const COOKIES_ANCHOR_ID = "cookies-from-browser";

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;

// Empty inputs (Number("") === 0) and non-numeric paste produce values
// that would otherwise round-trip 0 to the backend. Clamp at the UI
// edge so settings can never persist a sub-min concurrency.
function clampConcurrency(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MIN_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(parsed)));
}

export default function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const updateInfo = useAppStore((s) => s.updateInfo);
  const checkForUpdate = useAppStore((s) => s.checkForUpdate);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const version = useAppVersion();
  const [err, setErr] = useState<string | null>(null);
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const [ytDlpUpdateMsg, setYtDlpUpdateMsg] = useState<string | null>(null);
  const [ytDlpUpdating, setYtDlpUpdating] = useState(false);
  const [galleryDlUpdateMsg, setGalleryDlUpdateMsg] = useState<string | null>(null);
  const [galleryDlUpdating, setGalleryDlUpdating] = useState(false);

  useEffect(() => {
    if (settings?.theme) {
      document.documentElement.className = settings.theme === "dark" ? "" : settings.theme;
    }
  }, [settings?.theme]);

  const { hash } = useLocation();
  const settingsLoaded = settings !== null;
  useEffect(() => {
    if (hash !== `#${COOKIES_ANCHOR_ID}` || !settingsLoaded) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(COOKIES_ANCHOR_ID);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const select = el.querySelector("select");
      if (select instanceof HTMLSelectElement) select.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [hash, settingsLoaded]);

  async function patch(partial: Parameters<typeof patchSettings>[0]): Promise<void> {
    try {
      await patchSettings(partial);
    } catch (e: unknown) {
      setErr(formatError(e));
    }
  }

  async function handleNotificationsToggle(enabled: boolean): Promise<void> {
    if (enabled) {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      if (!granted) {
        enqueueToast({
          variant: "info",
          title: "Notifications blocked",
          detail: "Allow Goop to send notifications in your system settings to use this.",
        });
        return;
      }
    }
    await patch({ notifications_enabled: enabled });
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

  async function handleGalleryDlUpdate() {
    setGalleryDlUpdating(true);
    setGalleryDlUpdateMsg(null);
    try {
      const status = await api.sidecar.updateGalleryDl();
      setGalleryDlUpdateMsg(status.message || "gallery-dl is up to date.");
    } catch (e) {
      setGalleryDlUpdateMsg(formatError(e));
    } finally {
      setGalleryDlUpdating(false);
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
        {/* Output folder rendered inline rather than via <Field> because
         *  Field wraps children in a <label> element, and a <button> is
         *  not valid descendant content of a <label> per the HTML spec.
         *  The other Fields wrap inputs/selects/checkboxes (the labelled
         *  controls) and remain unchanged. */}
        <div className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
            Output folder
          </span>
          <p className="mb-2 text-xs text-fg-muted/70">
            Where finished downloads land. Drag-and-drop conversions save
            next to the source file unless you override here.
          </p>
          <div className="flex flex-col gap-2">
            <div
              className="truncate rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-fg"
              title={settings.output_dir}
            >
              {settings.output_dir}
            </div>
            <button
              type="button"
              aria-label="Browse for output folder"
              onClick={async () => {
                try {
                  const picked = await open({
                    directory: true,
                    multiple: false,
                    title: "Choose output folder",
                  });
                  if (typeof picked === "string") {
                    await patch({ output_dir: picked });
                  }
                  // Picker cancelled (returns null) — silent no-op.
                } catch (e) {
                  setErr(formatError(e));
                }
              }}
              className="btn-press self-start rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-2 hover:text-fg"
            >
              Browse…
            </button>
          </div>
        </div>
        <div className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
            Downloads folder (optional)
          </span>
          <p className="mb-2 text-xs text-fg-muted/70">
            Override where URL extracts land. Leave unset to use the
            output folder above for everything.
          </p>
          <div className="flex flex-col gap-2">
            <div
              className="truncate rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-fg"
              title={settings.output_dir_extract ?? "Using output folder"}
            >
              {settings.output_dir_extract ?? (
                <span className="text-fg-muted">Using output folder</span>
              )}
            </div>
            <div className="flex gap-2 self-start">
              <button
                type="button"
                aria-label="Browse for downloads folder"
                onClick={async () => {
                  try {
                    const picked = await open({
                      directory: true,
                      multiple: false,
                      title: "Choose downloads folder",
                    });
                    if (typeof picked === "string") {
                      await patch({ output_dir_extract: picked });
                    }
                  } catch (e) {
                    setErr(formatError(e));
                  }
                }}
                className="btn-press rounded-md bg-surface-3 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-2 hover:text-fg"
              >
                Browse…
              </button>
              {settings.output_dir_extract && (
                <button
                  type="button"
                  onClick={() => void patch({ output_dir_extract: null })}
                  className="btn-press rounded-md px-3 py-1.5 text-xs font-medium text-fg-muted transition duration-fast ease-out hover:text-fg"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
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
            min={MIN_CONCURRENCY}
            max={MAX_CONCURRENCY}
            className="w-24 rounded-md bg-surface-2 p-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            defaultValue={settings.extract_concurrency}
            key={`ec-${settings.extract_concurrency}`}
            onBlur={(e) => void patch({ extract_concurrency: clampConcurrency(e.target.value) })}
          />
        </Field>
        <Field
          label="Simultaneous processing"
          hint="How many files to convert or compress at once. Lower this if your computer gets hot or sluggish."
        >
          <input
            type="number"
            min={MIN_CONCURRENCY}
            max={MAX_CONCURRENCY}
            className="w-24 rounded-md bg-surface-2 p-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            defaultValue={settings.convert_concurrency}
            key={`cc-${settings.convert_concurrency}`}
            onBlur={(e) => void patch({ convert_concurrency: clampConcurrency(e.target.value) })}
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
          label="Notifications"
          hint="Get a system notification when a download or conversion finishes. Only fires when Goop isn't focused. Asks for permission the first time you turn it on."
        >
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={settings.notifications_enabled}
              onChange={(e) => void handleNotificationsToggle(e.target.checked)}
              className="h-4 w-4 rounded border-subtle bg-surface-2 accent-accent"
            />
            <span>Notify me when jobs finish</span>
          </label>
        </Field>
        <div id={COOKIES_ANCHOR_ID}>
          <Field
            label="Cookies from browser"
            hint="Use cookies from a logged-in browser to download videos from sites that require an account (Twitter/X, Instagram, etc.). Cookies are read locally and never leave your machine. If a download fails because the browser's cookie database is locked, Goop retries without cookies automatically — pick a different browser or close it to use cookies."
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
        </div>
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
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => void handleGalleryDlUpdate()}
            disabled={galleryDlUpdating}
            className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {galleryDlUpdating ? "Updating..." : "Update gallery-dl"}
          </button>
          {galleryDlUpdateMsg && (
            <span className="text-xs text-fg-muted">{galleryDlUpdateMsg}</span>
          )}
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
          <dt className="text-fg-muted">gallery-dl</dt>
          <dd className="text-fg tabular-nums">{version.galleryDl ?? "-"}</dd>
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
              <span className="text-fg-muted"> — URL extraction for video and audio.</span>
            </li>
            <li>
              <button
                type="button"
                onClick={() => void handleOpenAboutLink("gallery-dl")}
                className="btn-press text-accent transition duration-fast ease-out hover:text-accent-hover"
              >
                gallery-dl
              </button>
              <span className="text-fg-muted">
                {" "}
                — URL extraction for image hosts (Bunkr, Gofile, Pixeldrain, Imgur, Twitter/X).
              </span>
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
