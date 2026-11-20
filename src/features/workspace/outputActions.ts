import type { Job, ResultKind } from "@/types";

export type CompletedOutputActionId =
  | "open"
  | "reveal"
  | "copy_path"
  | "convert"
  | "compress";

export interface CompletedOutput {
  readonly job: Job;
  readonly path: string;
  readonly kind: ResultKind;
}

const FILE_ACTIONS: readonly CompletedOutputActionId[] = [
  "open",
  "reveal",
  "copy_path",
  "convert",
  "compress",
];

const FOLDER_ACTIONS: readonly CompletedOutputActionId[] = [
  "open",
  "reveal",
  "copy_path",
];

export const OUTPUT_ACTION_LABELS: Readonly<Record<CompletedOutputActionId, string>> = {
  open: "Open",
  reveal: "Show in Finder",
  copy_path: "Copy path",
  convert: "Convert…",
  compress: "Compress…",
};

export function completedOutput(job: Job): CompletedOutput | null {
  const path = job.result?.output_path;
  if (job.state !== "done" || !path) return null;
  return { job, path, kind: job.result?.result_kind ?? "file" };
}

// Older albums, albums over 2,000 files and albums with no safely listable
// file all lack a list; the job does not record which, so one reason fits all.
export const NO_FILE_LIST_REASON = "No file list was saved for this album: use Show in Finder";

function isAlbum(job: Job): boolean {
  return job.kind === "extract" && job.result?.result_kind === "folder";
}

/** A downloaded album is handed off file by file; other folders are not. */
export function outputActionIds(
  output: CompletedOutput | null,
): readonly CompletedOutputActionId[] {
  if (!output) return [];
  return output.kind === "folder" && !isAlbum(output.job) ? FOLDER_ACTIONS : FILE_ACTIONS;
}

/** Why Convert… and Compress… are offered disabled: an album with no saved file list. */
export function handoffUnavailable(job: Job): string | null {
  return isAlbum(job) && !(job.result?.files?.length) ? NO_FILE_LIST_REASON : null;
}
