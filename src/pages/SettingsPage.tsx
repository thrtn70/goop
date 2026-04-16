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
    } catch (e: unknown) {
      setErr(formatError(e));
    }
  }

  if (!s) return <div className="p-6">{err ?? "Loading…"}</div>;

  return (
    <div className="space-y-4 p-6 max-w-xl">
      <h2 className="text-lg font-semibold">Settings</h2>
      <Field label="Output folder">
        <input
          className="w-full rounded bg-neutral-800 p-2 text-sm"
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
      <Field label="Theme">
        <select
          className="rounded bg-neutral-800 p-2 text-sm"
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
      <Field label="Extract concurrency">
        <input
          type="number"
          min={1}
          max={16}
          className="w-24 rounded bg-neutral-800 p-2 text-sm"
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
      <Field label="Convert concurrency">
        <input
          type="number"
          min={1}
          max={16}
          className="w-24 rounded bg-neutral-800 p-2 text-sm"
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
      {err && <p className="text-sm text-red-400">{err}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase text-neutral-400">{label}</span>
      {children}
    </label>
  );
}
