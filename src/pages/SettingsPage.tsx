import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { formatError } from "@/ipc/error";
import type { Theme } from "@/types";
import { useAppStore } from "@/store/appStore";

export default function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Apply theme to document root whenever settings change.
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

  if (!settings)
    return (
      <div className="p-6 text-fg-muted" role="status" aria-live="polite">
        {err ?? "Loading settings..."}
      </div>
    );

  return (
    <div className="max-w-xl space-y-6 p-6">
      <h2 className="font-display text-lg font-semibold text-fg">Settings</h2>
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
        hint="How many URLs to download at once. Higher is faster but uses more bandwidth. Try 2-4 if things slow down."
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
        hint="How many files to convert or compress at once. More uses extra CPU. Lower this if your computer gets hot or sluggish."
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
