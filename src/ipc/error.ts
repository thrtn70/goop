/**
 * Format errors surfaced from Tauri `invoke` calls. Tauri serializes Rust's
 * `IpcError` enum as `{ code: string; message?: string }` (serde's internally
 * tagged form), which gets stringified to `"[object Object]"` by default.
 *
 * This helper unwraps the structured form into a readable message while falling
 * back gracefully for anything else that lands in a catch block.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const o = err as { code?: string; message?: string };
    if (o.code && o.message) return `${o.code}: ${o.message}`;
    if (o.message) return o.message;
    if (o.code) return o.code;
    try {
      return JSON.stringify(err);
    } catch {
      return "unknown error";
    }
  }
  return String(err);
}
