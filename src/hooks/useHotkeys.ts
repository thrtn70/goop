import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { tinykeys } from "tinykeys";
import { NAV_ITEMS } from "@/lib/navItems";
import { isFilePickerRoute } from "@/lib/platform";
import { useAppStore } from "@/store/appStore";

/**
 * Global hotkey wiring (Phase H). Mounted once at Layout level. Bindings
 * use tinykeys' `$mod+...` syntax — `$mod` resolves to Cmd on macOS and
 * Ctrl on Windows automatically.
 *
 * Other hotkeys live where they're scoped:
 *   - `Cmd/Ctrl+J` toggles the queue sidebar (`useQueueHotkey`)
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
      // One binding per nav destination, derived from the same array the nav
      // and the palette render from. Hand-written entries here are what let
      // the numbering drift out of step with the visible order before.
      ...Object.fromEntries(
        NAV_ITEMS.map((item) => [
          `$mod+${item.shortcut}`,
          (e: KeyboardEvent) => {
            e.preventDefault();
            nav(item.to);
          },
        ]),
      ),
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
