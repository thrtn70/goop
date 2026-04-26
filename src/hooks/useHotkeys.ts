import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { tinykeys } from "tinykeys";
import { isFilePickerRoute } from "@/lib/platform";
import { useAppStore } from "@/store/appStore";

/**
 * Global hotkey wiring (Phase H). Mounted once at Layout level. Bindings
 * use tinykeys' `$mod+...` syntax — `$mod` resolves to Cmd on macOS and
 * Ctrl on Windows automatically.
 *
 * Other hotkeys live where they're scoped:
 *   - `$mod+Shift+Q` toggles the queue sidebar (`useQueueHotkey`)
 *   - `Space` opens Quick View (HistoryGrid / HistoryList row handlers)
 *   - Modal-internal `Escape` is handled by each modal
 */
export function useHotkeys(): void {
  const nav = useNavigate();
  const togglePalette = useAppStore((s) => s.togglePalette);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const requestFocusUrlInput = useAppStore((s) => s.requestFocusUrlInput);
  const requestFilePicker = useAppStore((s) => s.requestFilePicker);

  useEffect(() => {
    const unsubscribe = tinykeys(window, {
      "$mod+k": (e) => {
        e.preventDefault();
        togglePalette();
      },
      "$mod+1": (e) => {
        e.preventDefault();
        nav("/extract");
      },
      "$mod+2": (e) => {
        e.preventDefault();
        nav("/convert");
      },
      "$mod+3": (e) => {
        e.preventDefault();
        nav("/compress");
      },
      "$mod+4": (e) => {
        e.preventDefault();
        nav("/history");
      },
      "$mod+5": (e) => {
        e.preventDefault();
        nav("/settings");
      },
      "$mod+,": (e) => {
        e.preventDefault();
        nav("/settings");
      },
      "$mod+n": (e) => {
        e.preventDefault();
        nav("/extract");
        requestFocusUrlInput();
      },
      "$mod+o": (e) => {
        e.preventDefault();
        // Stay on a file-picker route if already there; otherwise route to
        // /convert as the canonical landing for "open file picker".
        if (!isFilePickerRoute(window.location.pathname)) {
          nav("/convert");
        }
        requestFilePicker();
      },
      Escape: () => {
        // Only act on the palette here. Other modals handle their own Escape.
        if (useAppStore.getState().paletteOpen) {
          setPaletteOpen(false);
        }
      },
    });
    return () => unsubscribe();
  }, [nav, togglePalette, setPaletteOpen, requestFocusUrlInput, requestFilePicker]);
}
