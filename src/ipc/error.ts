import type { IpcError } from "@/types";

const FRIENDLY: Partial<Record<IpcError["code"], string>> = {
  sidecar_missing: "A required helper tool is missing. Try reinstalling Goop.",
  config: "Check that the selected folder exists and you have permission to use it.",
};

export function formatError(err: unknown): string {
  const ipc = parseIpcError(err);
  if (ipc) return formatIpcError(ipc);

  const raw = extractRaw(err);
  for (const [code, friendly] of Object.entries(FRIENDLY)) {
    if (raw.startsWith(code)) return friendly;
  }
  return raw;
}

export function parseIpcError(err: unknown): IpcError | null {
  if (!isRecord(err)) return null;
  const code = stringField(err, "code");
  if (!code) return null;
  const message = stringField(err, "message");

  switch (code) {
    case "sidecar_missing":
    case "subprocess_failed":
    case "queue":
    case "config":
      return { code, message: message ?? code };
    case "cancelled":
      return { code };
    case "unknown":
      return { code, message: message ?? code };
    default:
      return { code: "unknown", message: message ?? code };
  }
}

function formatIpcError(err: IpcError): string {
  const friendly = FRIENDLY[err.code];
  if (friendly) return friendly;
  if (err.code === "cancelled") return "cancelled";
  return err.message;
}

function extractRaw(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (isRecord(err)) {
    const message = stringField(err, "message");
    const code = stringField(err, "code");
    if (message) return message;
    if (code) return code;
    try {
      return JSON.stringify(err);
    } catch {
      return "Something unexpected happened. Try again.";
    }
  }
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}
