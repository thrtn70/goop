/**
 * Platform detection for keyboard shortcut display. Goop ships on macOS and
 * Windows only; we treat anything non-Mac as Windows-style for label
 * purposes. Detection runs once per module load (the platform doesn't
 * change at runtime).
 */

const cachedIsMac =
  typeof navigator !== "undefined" &&
  /Mac|iPad|iPhone|iPod/.test(navigator.userAgent);

export function isMacPlatform(): boolean {
  return cachedIsMac;
}

/** Symbol shown in shortcut hints. `⌘` on Mac, `Ctrl+` on Windows. */
export function modKeyLabel(): string {
  return cachedIsMac ? "⌘" : "Ctrl+";
}

/**
 * Routes whose page mounts a file picker and consumes the
 * `pendingFilePicker` token. Cmd+O stays on these routes; otherwise we
 * route to `/convert` first. Exported as a constant so the guard
 * isn't duplicated in `useHotkeys.ts` and the page effects.
 */
export const FILE_PICKER_ROUTES: readonly string[] = ["/convert", "/compress"];

export function isFilePickerRoute(pathname: string): boolean {
  return FILE_PICKER_ROUTES.some((r) => pathname.startsWith(r));
}
