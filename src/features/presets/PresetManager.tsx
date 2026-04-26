import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "@/store/appStore";
import { formatError } from "@/ipc/error";
import { api } from "@/ipc/commands";
import type { Preset } from "@/types";
import {
  entriesToPresets,
  parsePresetBundle,
  PresetParseError,
  serializePresets,
} from "./io";

/**
 * Settings → Presets section. Lists saved presets with rename (click the
 * name) and delete (trash icon). Built-ins can be renamed but not deleted
 * so first-launch defaults are always recoverable.
 */
export default function PresetManager() {
  const presets = useAppStore((s) => s.presets);
  const savePreset = useAppStore((s) => s.savePreset);
  const deletePreset = useAppStore((s) => s.deletePreset);
  const loadPresets = useAppStore((s) => s.loadPresets);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportable = presets.filter((p) => !p.is_builtin);

  async function handleExport(): Promise<void> {
    setError(null);
    if (exportable.length === 0) {
      enqueueToast({
        variant: "info",
        title: "Nothing to export",
        detail: "Save a preset on Convert or Compress first.",
      });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const dest = await save({
      title: "Export presets",
      defaultPath: `goop-presets-${today}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!dest) return;
    setBusy(true);
    try {
      await writeTextFile(dest, serializePresets(presets));
      enqueueToast({
        variant: "success",
        title: `Exported ${exportable.length} preset${exportable.length === 1 ? "" : "s"}`,
      });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(): Promise<void> {
    setError(null);
    const picked = await open({
      title: "Import presets",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const raw = await readTextFile(picked);
      const entries = parsePresetBundle(raw);
      if (entries.length === 0) {
        enqueueToast({
          variant: "info",
          title: "No presets found in that file",
        });
        return;
      }
      const fresh = entriesToPresets(entries, presets);
      // Save sequentially so the backend's `created_at` ordering is
      // deterministic and any one failure short-circuits the rest.
      for (const p of fresh) {
        await api.preset.save(p);
      }
      await loadPresets();
      enqueueToast({
        variant: "success",
        title: `Imported ${fresh.length} preset${fresh.length === 1 ? "" : "s"}`,
      });
    } catch (e) {
      const msg =
        e instanceof PresetParseError
          ? `Couldn't read that file — ${e.message}`
          : formatError(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function commitRename(p: Preset) {
    const name = draft.trim();
    if (!name || name === p.name) {
      setEditingId(null);
      return;
    }
    try {
      await savePreset({ ...p, name });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setEditingId(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deletePreset(id);
    } catch (e) {
      setError(formatError(e));
    }
  }

  const actionRow = (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <button
        type="button"
        onClick={() => void handleImport()}
        disabled={busy}
        className="btn-press text-accent transition duration-fast ease-out hover:text-accent-hover disabled:opacity-50"
      >
        Import…
      </button>
      <button
        type="button"
        onClick={() => void handleExport()}
        disabled={busy || exportable.length === 0}
        title={
          exportable.length === 0
            ? "Save a preset first; built-ins are excluded from export."
            : undefined
        }
        className="btn-press text-fg-secondary transition duration-fast ease-out hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        Export…
      </button>
    </div>
  );

  if (presets.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-muted">
          No saved presets yet. Use "Save as preset" on the Convert or Compress page.
        </p>
        {actionRow}
        {error && <p className="text-xs text-error">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-subtle">
        {presets.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2">
            {editingId === p.id ? (
              <input
                autoFocus
                className="flex-1 rounded-md bg-surface-2 px-2 py-1 text-sm text-fg transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename(p);
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="flex-1 text-left text-sm text-fg transition duration-fast ease-out hover:text-accent"
                onClick={() => {
                  setDraft(p.name);
                  setEditingId(p.id);
                }}
                title="Click to rename"
              >
                {p.name}
              </button>
            )}
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
              {p.target}
            </span>
            {p.is_builtin && (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
                Built-in
              </span>
            )}
            <button
              type="button"
              disabled={p.is_builtin}
              onClick={() => void handleDelete(p.id)}
              aria-label={`Delete ${p.name}`}
              title={p.is_builtin ? "Built-in presets can't be deleted" : "Delete preset"}
              className="btn-press rounded-md p-1 text-fg-muted transition duration-fast ease-out enabled:hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 4h8M5.5 4V2.5h3V4M4 4l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3">{actionRow}</div>
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
