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

export function outputActionIds(
  output: CompletedOutput | null,
): readonly CompletedOutputActionId[] {
  if (!output) return [];
  return output.kind === "folder" ? FOLDER_ACTIONS : FILE_ACTIONS;
}
