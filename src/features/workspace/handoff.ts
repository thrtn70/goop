import type { HandoffResolved, HandoffSource, Job } from "@/types";

export type HandoffDestination = "convert" | "compress";

export const HANDOFF_MAX_FILES = 200;

export interface HandoffItem {
  readonly sourceJobId: string;
  readonly path: string;
}

export interface HandoffSkips {
  readonly failed: number;
  readonly cancelled: number;
  readonly unfinished: number;
  readonly noFileList: number;
  readonly folder: number;
  readonly missing: number;
}

export interface Handoff {
  readonly id: string;
  readonly destination: HandoffDestination;
  readonly items: readonly HandoffItem[];
  readonly skipped: HandoffSkips;
}

export interface HandoffCandidate {
  readonly sourceJobId: string;
  readonly source: HandoffSource;
}

export type HandoffPlan =
  | { readonly kind: "ready"; readonly count: number; readonly candidates: readonly HandoffCandidate[]; readonly skipped: HandoffSkips }
  | { readonly kind: "too_many"; readonly count: number; readonly singleAlbum: boolean; readonly skipped: HandoffSkips }
  | { readonly kind: "none"; readonly skipped: HandoffSkips };

type SkipReason = keyof HandoffSkips;

const NO_SKIPS: HandoffSkips = { failed: 0, cancelled: 0, unfinished: 0, noFileList: 0, folder: 0, missing: 0 };

const DESTINATION_LABELS: Readonly<Record<HandoffDestination, string>> = { convert: "Convert", compress: "Compress" };

const SKIP_LABELS: Readonly<Record<SkipReason, readonly [string, string]>> = {
  failed: ["failed", "failed"],
  cancelled: ["cancelled", "cancelled"],
  unfinished: ["not finished", "not finished"],
  noFileList: ["album without a file list", "albums without a file list"],
  folder: ["folder", "folders"],
  missing: ["missing file", "missing files"],
};

const SKIP_ORDER: readonly SkipReason[] = ["failed", "cancelled", "unfinished", "noFileList", "folder", "missing"];

/** What a job hands off, or why it can't be handed off. */
export function handoffEligibility(job: Job): HandoffSource | SkipReason {
  if (typeof job.state === "object") return "failed";
  if (job.state === "cancelled") return "cancelled";
  if (job.state !== "done") return "unfinished";
  const result = job.result;
  if (!result?.output_path) return "missing";
  if (result.result_kind !== "folder") return { output_path: result.output_path };
  if (job.kind !== "extract") return "folder";
  return result.files && result.files.length > 0 ? { output_path: result.output_path, files: result.files } : "noFileList";
}

function addSkip(skips: HandoffSkips, reason: SkipReason, by = 1): HandoffSkips {
  return { ...skips, [reason]: skips[reason] + by };
}

function fileCount(source: HandoffSource): number {
  return source.files?.length ?? 1;
}

/** Which jobs qualify, how many files they bring, and the 200-file limit (all or nothing). */
export function planHandoff(jobs: readonly Job[]): HandoffPlan {
  let skipped = NO_SKIPS;
  const candidates: HandoffCandidate[] = [];
  for (const job of jobs) {
    const eligibility = handoffEligibility(job);
    if (typeof eligibility === "string") skipped = addSkip(skipped, eligibility);
    else candidates.push({ sourceJobId: String(job.id), source: eligibility });
  }
  if (candidates.length === 0) return { kind: "none", skipped };
  const count = candidates.reduce((sum, candidate) => sum + fileCount(candidate.source), 0);
  if (count > HANDOFF_MAX_FILES) {
    const singleAlbum = candidates.length === 1 && candidates[0].source.files !== undefined;
    return { kind: "too_many", count, singleAlbum, skipped };
  }
  return { kind: "ready", count, candidates, skipped };
}

/** The router state for a ready plan, from the paths the app found still in place. */
export function buildHandoff(
  destination: HandoffDestination,
  plan: Extract<HandoffPlan, { kind: "ready" }>,
  resolved: readonly HandoffResolved[],
): Handoff {
  const items: HandoffItem[] = [];
  let skipped = plan.skipped;
  plan.candidates.forEach((candidate, index) => {
    const found = resolved[index];
    if (!found) {
      skipped = addSkip(skipped, "missing", fileCount(candidate.source));
      return;
    }
    found.paths.forEach(path => items.push({ sourceJobId: candidate.sourceJobId, path }));
    skipped = addSkip(skipped, "missing", found.missing);
  });
  return { id: crypto.randomUUID(), destination, items, skipped };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readSkips(value: unknown): HandoffSkips {
  if (!value || typeof value !== "object") return NO_SKIPS;
  const record = value as Record<string, unknown>;
  return SKIP_ORDER.reduce<HandoffSkips>((skips, reason) => {
    const count = record[reason];
    return isCount(count) ? { ...skips, [reason]: count } : skips;
  }, NO_SKIPS);
}

function readItem(value: unknown): HandoffItem | null {
  if (!value || typeof value !== "object") return null;
  const { sourceJobId, path } = value as Record<string, unknown>;
  return typeof sourceJobId === "string" && typeof path === "string" && path.length > 0 ? { sourceJobId, path } : null;
}

/**
 * The handoff in navigation state for `destination`. A single-path handoff
 * from before the update is read as a one-item list.
 */
export function readHandoff(state: unknown, destination: HandoffDestination): Handoff | null {
  if (!state || typeof state !== "object" || !("handoff" in state)) return null;
  const value = state.handoff;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.destination !== destination) return null;
  if (!("items" in record)) {
    const item = readItem(record);
    return item ? { id: record.id, destination, items: [item], skipped: NO_SKIPS } : null;
  }
  if (!Array.isArray(record.items) || record.items.length === 0) return null;
  const items = record.items.map(readItem);
  if (items.some(item => item === null)) return null;
  return { id: record.id, destination, items: items as HandoffItem[], skipped: readSkips(record.skipped) };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function skipSummary(skips: HandoffSkips): string {
  const parts = SKIP_ORDER.filter(reason => skips[reason] > 0).map(reason =>
    plural(skips[reason], SKIP_LABELS[reason][0], SKIP_LABELS[reason][1]),
  );
  const total = SKIP_ORDER.reduce((sum, reason) => sum + skips[reason], 0);
  return total === 0 ? "" : `Skipped ${total}: ${parts.join(", ")}.`;
}

/** The one status line after a handoff lands in Convert or Compress. */
export function handoffOutcome(destination: HandoffDestination, added: number, existing: number, skips: HandoffSkips): string {
  const tool = DESTINATION_LABELS[destination];
  const lead =
    added > 0
      ? [`Added ${plural(added, "file", "files")} to ${tool}.`, existing > 0 ? `${existing} ${existing === 1 ? "was" : "were"} already there.` : ""]
      : [`${plural(existing, "file was", "files were")} already in ${tool}.`];
  return [...lead, skipSummary(skips)].filter(Boolean).join(" ");
}

export function tooManyMessage(destination: HandoffDestination, plan: Extract<HandoffPlan, { kind: "too_many" }>): string {
  const tool = DESTINATION_LABELS[destination];
  return plan.singleAlbum
    ? `This album has ${plan.count} files; ${tool} takes up to ${HANDOFF_MAX_FILES} at a time. Use Show in Finder to pick some.`
    : `The selection has ${plan.count} files; ${tool} takes up to ${HANDOFF_MAX_FILES} at a time. Select fewer items.`;
}

export function noHandoffMessage(destination: HandoffDestination, skips: HandoffSkips): { title: string; detail: string } {
  return { title: `Nothing to add to ${DESTINATION_LABELS[destination]}`, detail: skipSummary(skips) };
}

export interface HandoffIntake<Row> {
  readonly rows: Row[];
  readonly pdfs: string[];
  readonly selectId: string | null;
  readonly added: number;
  readonly existing: number;
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/**
 * The destination's lists after a handoff: new paths are appended after the
 * drafts, a path already there is kept as it is, PDFs go to the PDF list.
 * The first added row is selected, or else the first existing one.
 */
export function intakeHandoff<Row extends { readonly id?: string; readonly path: string }>(
  rows: readonly Row[],
  pdfs: readonly string[],
  items: readonly HandoffItem[],
  makeRow: (path: string) => Row,
): HandoffIntake<Row> {
  const nextRows = [...rows];
  const nextPdfs = [...pdfs];
  let added = 0;
  let existing = 0;
  let firstAdded: string | null = null;
  let firstExisting: string | null = null;
  for (const { path } of items) {
    if (isPdfPath(path)) {
      if (nextPdfs.includes(path)) existing++;
      else { nextPdfs.push(path); added++; }
      continue;
    }
    const found = nextRows.find(row => row.path === path);
    if (found) {
      if (rows.includes(found)) { existing++; firstExisting ??= found.id ?? null; }
      continue;
    }
    const row = makeRow(path);
    nextRows.push(row);
    added++;
    firstAdded ??= row.id ?? null;
  }
  return { rows: nextRows, pdfs: nextPdfs, selectId: firstAdded ?? firstExisting, added, existing };
}
