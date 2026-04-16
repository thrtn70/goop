import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";

/**
 * Applies the active theme class to <html>.
 *
 * Token CSS is structured as:
 *   :root          → dark theme (default)
 *   :root.light    → light theme overrides
 *   :root.system   → follows OS preference via prefers-color-scheme
 */
export function useTheme(): void {
  const theme = useAppStore((s) => s.settings?.theme ?? "dark");

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "system");

    if (theme === "light") {
      root.classList.add("light");
    } else if (theme === "system") {
      root.classList.add("system");
    }
    // "dark" = no class needed (default)
  }, [theme]);
}
