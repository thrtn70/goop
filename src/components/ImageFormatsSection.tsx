import { useCallback, useEffect, useState } from "react";
import SettingsSection from "@/components/SettingsSection";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { ImageDecoderStatus, MetadataPolicy } from "@/types";

/**
 * Settings → Image Formats.
 *
 * Read-only surface mirroring `OcrLanguagesSection`'s layout. Lists
 * every image format goop supports for decode / encode alongside the
 * underlying provenance (image-crate feature flag, bundled C library
 * version, font for watermark text). Nothing is downloadable — the
 * libs ship inside the installer.
 *
 * The bottom of the section hosts the global default `MetadataPolicy`
 * toggle (Preserve / Strip All) which seeds new FileRow image rows.
 */
export default function ImageFormatsSection() {
  const [status, setStatus] = useState<ImageDecoderStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const policy: MetadataPolicy = settings?.default_metadata_policy ?? "preserve";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.image.decoders();
      setStatus(next);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function setPolicy(next: MetadataPolicy) {
    try {
      await patchSettings({ default_metadata_policy: next });
    } catch (e) {
      setError(formatError(e));
    }
  }

  return (
    <SettingsSection
      title="Image Formats"
      description="Bundled image decoders and encoders. All formats ship inside the installer — no downloads."
    >
      <div id="image-formats" className="flex flex-col gap-3">
        {loading ? (
          <p className="text-sm text-fg-muted">Loading bundled decoders…</p>
        ) : error ? (
          <p className="text-sm text-error">{error}</p>
        ) : status === null ? (
          <p className="text-sm text-fg-muted">No decoder status available.</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1 rounded-md border border-subtle bg-surface-1 p-2">
              {status.formats.map((row) => (
                <li
                  key={row.label}
                  className="flex flex-col gap-0.5 rounded-md px-2 py-1.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-fg">
                      {row.label}
                    </span>
                    <span className="text-xs tabular-nums text-fg-muted">
                      {row.capability}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-fg-muted">
                    <span title={row.extensions.join(", ")}>
                      {row.extensions.map((e) => `.${e}`).join("  ")}
                    </span>
                    <span>{row.provenance}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-fg-muted">
              Watermark font: {status.watermark_font}. {status.coming_soon}
            </p>
          </>
        )}

        <div className="mt-1 flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-fg">
              Default metadata policy
            </span>
            <span className="text-xs text-fg-muted">
              How new image convert / compress rows handle EXIF + ICC by
              default. Per-file overrides on the row always win.
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={policy === "preserve"}
              onClick={() => void setPolicy("preserve")}
              className={`btn-press rounded-md px-3 py-1.5 text-xs transition duration-fast ease-out ${
                policy === "preserve"
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
              }`}
            >
              Preserve
            </button>
            <button
              type="button"
              aria-pressed={policy === "strip_all"}
              onClick={() => void setPolicy("strip_all")}
              className={`btn-press rounded-md px-3 py-1.5 text-xs transition duration-fast ease-out ${
                policy === "strip_all"
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
              }`}
            >
              Strip
            </button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
