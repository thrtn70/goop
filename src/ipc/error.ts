/**
 * Format errors surfaced from Tauri `invoke` calls. Tauri serializes Rust's
 * `IpcError` enum as `{ code: string; message?: string }` (serde's internally
 * tagged form), which gets stringified to `"[object Object]"` by default.
 *
 * This helper unwraps the structured form into a readable, user-friendly
 * message while falling back gracefully for anything else.
 */

/** Map known error codes to friendly explanations. */
const FRIENDLY: Record<string, string> = {
  sidecar_missing: "A required helper tool is missing. Try reinstalling Goop.",
  sidecar_failed: "A helper tool crashed. Try again, or restart the app.",
  probe_failed: "Couldn't read file details. The file may be corrupted or unsupported.",
  download_failed: "Download didn't complete. Check your connection and try again.",
  conversion_failed: "Conversion didn't finish. The file format may not be supported.",
  io_error: "Couldn't read or write a file. Check that the folder exists and you have permission.",
  network_error: "Network issue. Check your connection and try again.",
};

export function formatError(err: unknown): string {
  const raw = extractRaw(err);
  // Check if the raw message starts with a known code
  for (const [code, friendly] of Object.entries(FRIENDLY)) {
    if (raw.startsWith(code)) return friendly;
  }
  return raw;
}

function extractRaw(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const o = err as { code?: string; message?: string };
    if (o.code && FRIENDLY[o.code]) return FRIENDLY[o.code];
    if (o.code && o.message) return o.message;
    if (o.message) return o.message;
    if (o.code) return o.code;
    try {
      return JSON.stringify(err);
    } catch {
      return "Something unexpected happened. Try again.";
    }
  }
  return String(err);
}
