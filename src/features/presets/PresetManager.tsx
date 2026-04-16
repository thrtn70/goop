import { useState } from "react";
import { useAppStore } from "@/store/appStore";
import { formatError } from "@/ipc/error";
import type { Preset } from "@/types";

/**
 * Settings → Presets section. Lists saved presets with rename (click the
 * name) and delete (trash icon). Built-ins can be renamed but not deleted
 * so first-launch defaults are always recoverable.
 */
export default function PresetManager() {
  const presets = useAppStore((s) => s.presets);
  const savePreset = useAppStore((s) => s.savePreset);
  const deletePreset = useAppStore((s) => s.deletePreset);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  if (presets.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        No saved presets yet. Use "Save as preset" on the Convert or Compress page.
      </p>
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
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
