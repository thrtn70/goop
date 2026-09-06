import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { open } from "@tauri-apps/plugin-dialog";
import { api, imageAppIcon } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { IconPlatform } from "@/types";

interface ImageAppIconFlowProps {
  file: string;
  onDone: () => void;
}

interface PlatformOption {
  value: IconPlatform;
  label: string;
  hint: string;
}

const PLATFORMS: PlatformOption[] = [
  {
    value: "macos",
    label: "macOS",
    hint: "icon.icns (16–1024 px in the standard Apple slots)",
  },
  {
    value: "windows",
    label: "Windows",
    hint: "icon.ico (16, 32, 48, 256)",
  },
  {
    value: "web",
    label: "Web / favicon",
    hint: "favicon-16.png … favicon-512.png loose files",
  },
];

/**
 * One-shot wizard for generating platform icon containers from a
 * single image. Pick the platforms you want, choose an output
 * folder, run. The backend resamples to each platform's standard
 * sizes via Lanczos3 and assembles .icns / .ico containers in
 * pure Rust.
 *
 * The picker requires a square-ish source image; a stretched
 * non-square input will be deformed by the resampler. The UI hints
 * at "Use a square image" but doesn't reject — power users sometimes
 * pass tall logos on purpose and want the squashed result.
 */
function ImageAppIconFlow({ file, onDone }: ImageAppIconFlowProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [selected, setSelected] = useWorkspaceDraftState<Set<IconPlatform>>("ImageAppIconFlow.selected",
    () => new Set<IconPlatform>(["macos", "windows", "web"]),
  );
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("ImageAppIconFlow.error", null);

  function toggle(p: IconPlatform) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  }

  const canApply = !busy && selected.size > 0;

  async function handleApply() {
    if (!canApply) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const dir = await open({
        directory: true,
        title: "Choose output folder for icons",
      });
      const outDir = typeof dir === "string" ? dir : null;
      if (!outDir) {
        return;
      }
      const platforms: IconPlatform[] = PLATFORMS.map((p) => p.value).filter(
        (v) => selected.has(v),
      );
      await api.image.run(imageAppIcon(file, outDir, platforms));
      enqueueToast({ variant: "success", title: "App icon export queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">
        Pick the platforms you need. A square source image gives the best
        result — non-square inputs will be stretched to fit each slot.
      </p>

      <div role="group" aria-label="App icon platforms" className="flex flex-col gap-2">
        {PLATFORMS.map((opt) => {
          const active = selected.has(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(opt.value)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition duration-fast ease-out ${
                active
                  ? "border-accent bg-accent-subtle"
                  : "border-subtle bg-surface-1 hover:border-accent/60"
              }`}
            >
              <span
                className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
                  active ? "border-accent bg-accent" : "border-fg-muted"
                }`}
                aria-hidden="true"
              >
                {active && (
                  <svg
                    viewBox="0 0 16 16"
                    className="h-3 w-3 text-accent-fg"
                    aria-hidden="true"
                  >
                    <path
                      d="M3 8l3 3 7-7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span>
                <span className="block text-sm font-medium text-fg">
                  {opt.label}
                </span>
                <span className="block text-xs text-fg-muted">{opt.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Saving…"
            : selected.size === 0
              ? "Pick at least one platform"
              : `Generate ${selected.size} icon set${selected.size === 1 ? "" : "s"}`}
        </button>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}

export default withWorkspaceDrafts(ImageAppIconFlow, undefined, props => ["source", props.file]);
