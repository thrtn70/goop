import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { Settings, SettingsPatch, Theme } from "@/types";

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.settings
      .get()
      .then(setS)
      .catch((e: unknown) => setErr(formatError(e)));
  }, []);

  async function patch(p: SettingsPatch): Promise<void> {
    try {
      const next = await api.settings.set(p);
      setS(next);

      // Apply theme to document root
      if (p.theme) {
        document.documentElement.className = p.theme === "dark" ? "" : p.theme;
      }
    } catch (e: unknown) {
      setErr(formatError(e));
    }
  }

  if (!s) return <div className="p-6 text-fg-muted" role="status" aria-live="polite">{err ?? "Loading settings..."}</div>;

  return (
    <div className="max-w-xl space-y-6 p-6">
      <h2 className="font-display text-lg font-semibold text-fg">Settings</h2>
      <Field label="Output folder" hint="Where finished downloads land. Drag-and-drop conversions save next to the source file unless you override here.">
        <input
          className="w-full rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          value={s.output_dir}
          onChange={(e) => setS({ ...s, output_dir: e.target.value })}
          onBlur={(e) =>
            void patch({
              output_dir: e.target.value,
              theme: null,
              yt_dlp_last_update_ms: null,
              extract_concurrency: null,
              convert_concurrency: null,
            })
          }
        />
      </Field>
      <Field label="Theme" hint="Controls the app appearance. System follows your OS setting.">
        <select
          className="rounded-md bg-surface-2 p-2 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          value={s.theme}
          onChange={(e) =>
            void patch({
              output_dir: null,
              theme: e.target.value as Theme,
              yt_dlp_last_update_ms: null,
              extract_concurrency: null,
              convert_concurrency: null,
            })
          }
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>
      <Field label="Simultaneous downloads" hint="How many URLs to download at once. Higher is faster but uses more bandwidth. Try 2-4 if things slow down.">
        <input
          type="number"
          min={1}
          max={16}
          className="w-24 rounded-md bg-surface-2 p-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          value={s.extract_concurrency}
          onChange={(e) => setS({ ...s, extract_concurrency: Number(e.target.value) })}
          onBlur={(e) =>
            void patch({
              output_dir: null,
              theme: null,
              yt_dlp_last_update_ms: null,
              extract_concurrency: Number(e.target.value),
              convert_concurrency: null,
            })
          }
        />
      </Field>
      <Field label="Simultaneous processing" hint="How many files to convert or compress at once. More uses extra CPU. Lower this if your computer gets hot or sluggish.">
        <input
          type="number"
          min={1}
          max={16}
          className="w-24 rounded-md bg-surface-2 p-2 text-sm tabular-nums text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
          value={s.convert_concurrency}
          onChange={(e) => setS({ ...s, convert_concurrency: Number(e.target.value) })}
          onBlur={(e) =>
            void patch({
              output_dir: null,
              theme: null,
              yt_dlp_last_update_ms: null,
              extract_concurrency: null,
              convert_concurrency: Number(e.target.value),
            })
          }
        />
      </Field>
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
