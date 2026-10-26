/** Which batch apply last set a row's settings. Draft-only: never part of a request. */
export type BatchStamp = { id: string; label: string; revision: number };
export type BatchState = "batch" | "edited" | null;
export type StampableEntry = { id?: string; revision?: number; batch?: BatchStamp | null };

export const MAX_BATCH_ID = 128;
export const MAX_BATCH_LABEL = 256;

export function newBatchStampId(): string {
  return crypto.randomUUID();
}

export function validBatchStamp(value: unknown): value is BatchStamp {
  if (typeof value !== "object" || value === null) return false;
  const { id, label, revision } = value as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_BATCH_ID
    && typeof label === "string" && label.length > 0 && label.length <= MAX_BATCH_LABEL
    && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
}

/** Derived, never stored: any edit bumps the row's revision past its stamp. */
export function batchState(entry: StampableEntry): BatchState {
  if (!entry.batch) return null;
  return entry.batch.revision === (entry.revision ?? 0) ? "batch" : "edited";
}

function boundedLabel(label: string): string {
  const cut = label.slice(0, MAX_BATCH_LABEL);
  const last = cut.charCodeAt(cut.length - 1);
  // Never leave half of a surrogate pair at the cut.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function stampEntries<T extends StampableEntry>(
  entries: readonly T[],
  ids: ReadonlySet<string>,
  stamp: { id: string; label: string },
): T[] {
  const label = boundedLabel(stamp.label);
  return entries.map(entry => entry.id !== undefined && ids.has(entry.id)
    ? { ...entry, batch: { id: stamp.id, label, revision: entry.revision ?? 0 } }
    : entry);
}

/** The batch baseline is whichever other member still has its batch settings. */
/**
 * Changes exactly when Apply or Use batch settings writes the entry: edits bump
 * the entry's revision but not its stamp. Editors holding local text key on it.
 */
export function batchEpoch(entry: StampableEntry): string | undefined {
  return entry.batch ? `${entry.batch.id}:${entry.batch.revision}` : undefined;
}

export function batchResetSource<T extends StampableEntry>(entry: T, entries: readonly T[]): T | null {
  const id = entry.batch?.id;
  if (!id) return null;
  return entries.find(candidate => candidate !== entry
    && candidate.id !== entry.id
    && candidate.batch?.id === id
    && batchState(candidate) === "batch") ?? null;
}
