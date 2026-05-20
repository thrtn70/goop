import { useCallback, useEffect, useState } from "react";
import SettingsSection from "@/components/SettingsSection";
import { api } from "@/ipc/commands";
import type { IpcLanguagePack } from "@/ipc/commands";
import { formatError } from "@/ipc/error";

function formatMb(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  return `${mb.toFixed(1)} MB`;
}

function sortByName(a: IpcLanguagePack, b: IpcLanguagePack): number {
  return a.display_name.localeCompare(b.display_name);
}

/**
 * Settings → OCR Languages.
 *
 * Lists installed Tesseract language packs (English is bundled and
 * cannot be removed; everything else lives in the writable user data
 * dir and can be removed at will).
 *
 * The "Add language…" expander lists the curated catalog filtered to
 * packs that aren't installed yet, each with a Download button. The
 * download UI mirrors the yt-dlp/gallery-dl pattern: per-code busy
 * flag, message under the button, error toast on failure.
 */
export default function OcrLanguagesSection() {
  const [installed, setInstalled] = useState<IpcLanguagePack[]>([]);
  const [available, setAvailable] = useState<IpcLanguagePack[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  // Per-code state machines, keyed by language code. Empty = idle;
  // "downloading"/"removing"/<message> records the latest action.
  const [busy, setBusy] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [inst, avail] = await Promise.all([
        api.sidecar.tessdataInstalled(),
        api.sidecar.tessdataAvailable(),
      ]);
      setInstalled(inst);
      setAvailable(avail);
    } catch (e) {
      setBusy((prev) => ({ ...prev, _global: formatError(e) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDownload(code: string) {
    setBusy((prev) => ({ ...prev, [code]: "Downloading…" }));
    try {
      await api.sidecar.tessdataDownload(code);
      // Mirror handleRemove: clear the busy entry on success so the
      // refresh below isn't followed by a stale status message for a
      // pack that has now moved into the installed list. Errors keep
      // the entry so the message surfaces.
      setBusy((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
      await refresh();
    } catch (e) {
      setBusy((prev) => ({ ...prev, [code]: formatError(e) }));
    }
  }

  async function handleRemove(code: string) {
    setBusy((prev) => ({ ...prev, [code]: "Removing…" }));
    try {
      await api.sidecar.tessdataRemove(code);
      setBusy((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
      await refresh();
    } catch (e) {
      setBusy((prev) => ({ ...prev, [code]: formatError(e) }));
    }
  }

  const installedCodes = new Set(installed.map((l) => l.code));
  const addable = available
    .filter((l) => !installedCodes.has(l.code))
    .slice()
    .sort(sortByName);

  return (
    <SettingsSection
      title="OCR Languages"
      description="Tesseract language packs. English is bundled; others download on demand."
    >
      <div id="ocr-languages" className="flex flex-col gap-2">
        {loading ? (
          <p className="text-sm text-fg-muted">Loading installed packs…</p>
        ) : installed.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No language packs found. (Even English should be bundled — this is
            unusual; reinstall the app if it persists.)
          </p>
        ) : (
          <ul className="flex flex-col gap-1 rounded-md border border-subtle bg-surface-1 p-2">
            {installed
              .slice()
              .sort(sortByName)
              .map((lang) => (
                <li
                  key={lang.code}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5"
                >
                  <span className="flex-1 text-sm text-fg">
                    {lang.display_name}
                    {lang.bundled && (
                      <span className="ml-2 text-xs text-fg-muted">
                        (bundled)
                      </span>
                    )}
                  </span>
                  <span className="w-20 text-right text-xs tabular-nums text-fg-muted">
                    {formatMb(lang.size_bytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRemove(lang.code)}
                    disabled={lang.bundled || !!busy[lang.code]}
                    className="btn-press rounded-md bg-surface-2 px-3 py-1 text-xs text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Remove ${lang.display_name} language pack`}
                  >
                    {busy[lang.code]?.startsWith("Removing")
                      ? "Removing…"
                      : "Remove"}
                  </button>
                </li>
              ))}
          </ul>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs text-fg-secondary transition duration-fast ease-out hover:text-fg"
          >
            {pickerOpen ? "Cancel" : "Add language…"}
          </button>
          {busy._global && (
            <span className="text-xs text-error">{busy._global}</span>
          )}
        </div>

        {pickerOpen && addable.length > 0 && (
          <ul className="mt-2 flex max-h-72 flex-col gap-1 overflow-auto rounded-md border border-subtle bg-surface-1 p-2">
            {addable.map((lang) => (
              <li
                key={lang.code}
                className="flex items-center gap-3 rounded-md px-2 py-1.5"
              >
                <span className="flex-1 text-sm text-fg">
                  {lang.display_name}
                  <span className="ml-2 text-xs text-fg-muted">
                    {lang.code}
                  </span>
                </span>
                <span className="w-20 text-right text-xs tabular-nums text-fg-muted">
                  ~{formatMb(lang.size_bytes)}
                </span>
                <button
                  type="button"
                  onClick={() => void handleDownload(lang.code)}
                  disabled={!!busy[lang.code]}
                  className="btn-press rounded-md bg-surface-2 px-3 py-1 text-xs text-fg-secondary transition duration-fast ease-out enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy[lang.code]?.startsWith("Downloading")
                    ? "Downloading…"
                    : "Download"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {pickerOpen && addable.length === 0 && (
          <p className="text-sm text-fg-muted">
            Every language from the catalog is already installed.
          </p>
        )}

        {/* Per-language status messages from the most recent action,
            shown beneath the list of installed packs. */}
        {Object.entries(busy)
          .filter(
            ([code, msg]) =>
              code !== "_global" &&
              msg &&
              !msg.startsWith("Downloading") &&
              !msg.startsWith("Removing"),
          )
          .map(([code, msg]) => (
            <p key={`status-${code}`} className="text-xs text-fg-muted">
              {code}: {msg}
            </p>
          ))}
      </div>
    </SettingsSection>
  );
}
