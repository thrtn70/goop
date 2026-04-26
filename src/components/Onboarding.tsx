import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { useAppStore } from "@/store/appStore";
import { formatError } from "@/ipc/error";
import BrandMark from "@/components/BrandMark";

type StepId = "welcome" | "downloads" | "ready";
const STEPS: StepId[] = ["welcome", "downloads", "ready"];

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Phase I first-run onboarding overlay. Three skippable screens. Mounts
 * at Layout level and only renders when `settings.has_seen_onboarding`
 * is `false`. Re-accessible via Settings → About → "Show welcome
 * screen" (which patches the flag back to false).
 */
export default function Onboarding() {
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const [stepIndex, setStepIndex] = useState(0);
  // Direction tracks whether the most recent step change went forward
  // (next button) or back. Drives the slide direction of the entrance
  // animation on the new step. 0 on first mount = "no direction yet"
  // so the welcome screen just fades in.
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  // Synchronous guard against double-invoke (rapid clicks / Enter repeat
  // before React commits the disabled state). `busy` alone is too slow.
  const inflightRef = useRef(false);

  const visible = Boolean(settings && !settings.has_seen_onboarding);

  const finish = useCallback(async (): Promise<void> => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setBusy(true);
    try {
      await patchSettings({ has_seen_onboarding: true });
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't save",
        detail: formatError(e),
      });
    } finally {
      inflightRef.current = false;
      setBusy(false);
    }
  }, [patchSettings, enqueueToast]);

  // Move focus to the primary action whenever the dialog opens or the
  // step changes. WCAG 2.4.3: keyboard focus must move into the dialog
  // when it appears.
  useEffect(() => {
    if (!visible) return;
    primaryButtonRef.current?.focus();
  }, [visible, stepIndex]);

  // Focus trap + Escape dismiss. Tab/Shift+Tab cycle inside the dialog
  // so keyboard users can't fall into the obscured LeftNav. Escape
  // matches the WCAG 2.1 APG modal-dialog pattern.
  useEffect(() => {
    if (!visible) return;
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        void finish();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible, finish]);

  if (!visible || !settings) return null;

  const step = STEPS[stepIndex];

  function next(): void {
    if (stepIndex < STEPS.length - 1) {
      setDirection(1);
      setStepIndex(stepIndex + 1);
    } else {
      void finish();
    }
  }

  function back(): void {
    if (stepIndex > 0) {
      setDirection(-1);
      setStepIndex(stepIndex - 1);
    }
  }

  function skip(): void {
    void finish();
  }

  async function pickFolder(): Promise<void> {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose a default download folder",
      });
      if (typeof picked === "string") {
        await patchSettings({ output_dir: picked });
      }
    } catch (e) {
      enqueueToast({
        variant: "error",
        title: "Couldn't choose folder",
        detail: formatError(e),
      });
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Goop"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/60 px-4"
    >
      <div
        ref={dialogRef}
        className="enter-up flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-subtle bg-surface-1 p-8 shadow-2xl"
      >
        {/* Step content is keyed on the step ID so React remounts the
         *  subtree on every transition. The `slide-in-{dir}` class
         *  picks up the directional slide via CSS keyframes — first
         *  mount uses `enter-up` only (no direction). */}
        <div
          key={step}
          className={clsx(
            direction === 1 && "step-slide-in-right",
            direction === -1 && "step-slide-in-left",
            direction === 0 && "enter-up",
          )}
        >
          {step === "welcome" && (
            <>
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center">
                <BrandMark size={80} />
              </div>
              <h2 className="text-center font-display text-xl font-semibold text-fg">
                Welcome to Goop
              </h2>
              <p className="mt-3 text-center text-sm text-fg-secondary">
                The no-frills way to grab video and audio from links, convert and
                compress media, and slim down PDFs — all in one place.
              </p>
            </>
          )}
          {step === "downloads" && (
            <>
              <h2 className="font-display text-xl font-semibold text-fg">
                Where should downloads go?
              </h2>
              <p className="mt-2 text-sm text-fg-secondary">
                Goop saves downloaded videos and converted files here by default.
                You can change this anytime in Settings.
              </p>
              <div className="mt-5 rounded-lg border border-subtle bg-surface-2 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                  Current folder
                </div>
                {/* Path is keyed so a folder change re-mounts the line
                 *  with a fresh slide-up — feels like the new path
                 *  arrives, vs silently swapping text. */}
                <div
                  key={settings.output_dir}
                  className="path-swap mt-1 truncate font-mono text-xs text-fg"
                  title={settings.output_dir}
                >
                  {settings.output_dir}
                </div>
                <button
                  type="button"
                  onClick={() => void pickFolder()}
                  className="btn-press mt-3 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover"
                >
                  Choose a different folder…
                </button>
              </div>
            </>
          )}
          {step === "ready" && (
            <>
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center">
                <BrandMark size={80} />
              </div>
              <h2 className="text-center font-display text-xl font-semibold text-fg">
                You&apos;re all set
              </h2>
              {/* Each tip enters with a stagger delay so the cascade
               *  reads as "1, 2, 3" rather than "all at once". */}
              <ul className="mt-5 space-y-3 text-sm text-fg-secondary">
                {[
                  <>Paste any link in the bar at the top to download.</>,
                  <>Drop files on Convert or Compress to change formats and shrink size.</>,
                  <>
                    Press <kbd className="rounded bg-surface-2 px-1 font-mono text-[10px]">⌘K</kbd>{" "}
                    for the command palette anytime.
                  </>,
                ].map((tip, i) => (
                  <li
                    key={i}
                    className="enter-stagger flex gap-3"
                    // CSS custom properties pass through React's style
                    // prop at runtime; React.CSSProperties' type doesn't
                    // include them, so we widen with a single cast.
                    style={{ "--i": i + 1 } as React.CSSProperties}
                  >
                    <span className="text-accent">→</span>
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>


        {/* Step indicator */}
        <div className="mt-8 flex items-center justify-center gap-1.5" aria-hidden>
          {STEPS.map((id, i) => (
            <span
              key={id}
              className={clsx(
                "h-1.5 rounded-full transition-all duration-normal ease-out",
                i === stepIndex ? "w-6 bg-accent" : "w-1.5 bg-surface-3",
              )}
            />
          ))}
        </div>

        {/* Action row */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={skip}
            disabled={busy}
            className="text-xs text-fg-muted transition duration-fast ease-out hover:text-fg disabled:opacity-50"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={back}
                disabled={busy}
                className="btn-press rounded-md px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:bg-surface-3 hover:text-fg disabled:opacity-50"
              >
                Back
              </button>
            )}
            <button
              ref={primaryButtonRef}
              type="button"
              onClick={next}
              disabled={busy}
              className="btn-press rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-accent-fg transition duration-fast ease-out hover:bg-accent-hover disabled:opacity-50"
            >
              {step === "ready" ? "Get started" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
