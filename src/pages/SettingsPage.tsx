import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { formatError } from "@/ipc/error";
import { api } from "@/ipc/commands";
import type { ExtractNamingScheme, Theme, UpdateStatus } from "@/types";
import { useAppStore } from "@/store/appStore";
import SettingsSection from "@/components/SettingsSection";
import OcrLanguagesSection from "@/components/OcrLanguagesSection";
import ImageFormatsSection from "@/components/ImageFormatsSection";
import PresetManager from "@/features/presets/PresetManager";
import { useAppVersion } from "@/hooks/useAppVersion";

const COOKIES_ANCHOR_ID = "cookies-from-browser";

const NAMING_SCHEMES = ["title", "title_site", "date_title"] as const;
function isExtractNamingScheme(v: string): v is ExtractNamingScheme {
  return (NAMING_SCHEMES as readonly string[]).includes(v);
}

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
  const loadVersions = useAppStore((s) => s.loadVersions);
  const version = useAppVersion();
  const [err, setErr] = useState<string | null>(null);
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);
  const [ytDlpUpdateMsg, setYtDlpUpdateMsg] = useState<string | null>(null);
  const [ytDlpUpdating, setYtDlpUpdating] = useState(false);
  const [galleryDlUpdateMsg, setGalleryDlUpdateMsg] = useState<string | null>(null);
  const [galleryDlUpdating, setGalleryDlUpdating] = useState(false);

  const themeFieldId = useId();
  const namingSchemeFieldId = useId();
  const cookiesFieldId = useId();
  const torboxKeyFieldId = useId();
  const extractConcurrencyFieldId = useId();
  const convertConcurrencyFieldId = useId();

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

  /**
   * True when an update actually swapped the binary, meaning every cached
   * version string for it is now stale. An up-to-date sidecar reports the
   * same version on both sides and needs no re-spawn.
   *
   * Deliberately looser than the backend's `yt_dlp_updated_event` filter,
   * which stays silent when the pre-update version was unreadable because it
   * has no honest `from_version` to report. A null-to-known transition is
   * still a change worth showing, and this is the only path that catches it.
   */
  function didChangeVersion(status: UpdateStatus): boolean {
    return status.new_version !== null && status.new_version !== status.previous_version;
  }

  /**
   * Re-read the sidecar versions into the store so About drops the
   * pre-update value. `force` is required: the cache is warmed during boot,
   * so an unforced load would return the version we just replaced. Runs
   * fire-and-forget — the update itself is already done, and re-spawning
   * every sidecar shouldn't hold the button in its "Updating..." state.
   */
  async function refreshVersions(): Promise<void> {
    try {
      await loadVersions(true);
    } catch {
      /* the update itself succeeded; About refreshes on the next load */
    }
  }

  async function handleYtDlpUpdate() {
    setYtDlpUpdating(true);
    setYtDlpUpdateMsg(null);
    try {
      const status = await api.sidecar.updateYtDlp();
      setYtDlpUpdateMsg(status.message || "yt-dlp is up to date.");
      if (didChangeVersion(status)) void refreshVersions();
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
      if (didChangeVersion(status)) void refreshVersions();
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
        <Field
          label="Output folder"
          hint="Where finished downloads land. Drag-and-drop conversions save next to the source file unless you override here."
        >
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
        </Field>
        <Field
          label="Downloads folder (optional)"
          hint="Override where URL extracts land. Leave unset to use the output folder above for everything."
        >
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
        </Field>
        <Field
          label="Download filename style"
          hint='Choose how URL extracts are named on disk. Examples: "My Video.mp4" · "My Video — youtube.mp4" · "20260505 — My Video.mp4".'
          htmlFor={namingSchemeFieldId}
        >
          <select
            id={namingSchemeFieldId}
            className="rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
            value={settings.extract_naming_scheme}
            onChange={(e) => {
              const v = e.target.value;
              if (isExtractNamingScheme(v)) {
                void patch({ extract_naming_scheme: v });
              }
            }}
          >
            <option value="title">Title</option>
            <option value="title_site">Title — Site</option>
            <option value="date_title">Date — Title</option>
          </select>
        </Field>
        <Field
          label="Theme"
          hint="Controls the app appearance. System follows your OS setting."
          htmlFor={themeFieldId}
        >
          <select
            id={themeFieldId}
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
          htmlFor={extractConcurrencyFieldId}
        >
          <input
            id={extractConcurrencyFieldId}
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
          htmlFor={convertConcurrencyFieldId}
        >
          <input
            id={convertConcurrencyFieldId}
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
            htmlFor={cookiesFieldId}
          >
            <select
              id={cookiesFieldId}
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
        <Field
          label="TorBox API key"
          hint="Unlocks magnet links and premium hoster links via your TorBox account: paste a link, TorBox fetches it, Goop downloads the result. Get the key from torbox.app → Settings → API. Leave empty to turn debrid routing off."
          htmlFor={torboxKeyFieldId}
        >
          <input
            id={torboxKeyFieldId}
            key={`tbk-${settings.torbox_api_key ?? ""}`}
            type="password"
            autoComplete="off"
            placeholder="TorBox API key"
            defaultValue={settings.torbox_api_key ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === (settings.torbox_api_key ?? "")) return;
              void patch({ torbox_api_key: v === "" ? null : v });
            }}
            className="w-full rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          />
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

      <OcrLanguagesSection />

      <ImageFormatsSection />

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
          <dt className="text-fg-muted">Ghostscript</dt>
          <dd className="text-fg tabular-nums">{version.ghostscript ?? "-"}</dd>
          <dt className="text-fg-muted">mutool</dt>
          <dd className="text-fg tabular-nums">{version.mutool ?? "-"}</dd>
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

// `<div>` (not `<label>`) so that:
// (1) checkbox children whose own `<label>` wraps the input don't end
// up nested inside a second `<label>` (invalid HTML, ignored
// `for`/click-to-focus, screen readers may double-announce), and
// (2) buttons are valid descendants — the Output folder field's
// Browse button no longer needs to inline the field structure to
// avoid the spec violation.
//
// When the field has a single focusable control, the caller passes
// `htmlFor` (paired with a matching `id` on the control) so the
// visible text is a real `<label>` and clicking it focuses the
// control. Compound fields (multiple buttons, no single input)
// omit `htmlFor` and the field falls back to a `role="group"` with
// the visible text as a `<span>` — still announced as the group's
// accessible name.
interface FieldProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

function Field({ label, hint, htmlFor, children }: FieldProps) {
  return (
    <div
      className="block"
      {...(htmlFor ? {} : { role: "group", "aria-label": label })}
    >
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          className="mb-1 block text-xs uppercase tracking-wide text-fg-muted"
        >
          {label}
        </label>
      ) : (
        <span className="mb-1 block text-xs uppercase tracking-wide text-fg-muted">
          {label}
        </span>
      )}
      {hint && <p className="mb-2 text-xs text-fg-muted/70">{hint}</p>}
      {children}
    </div>
  );
}
