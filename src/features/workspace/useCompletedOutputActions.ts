import type { Job } from "@/types";
import { api } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { HandoffDestination } from "./handoff";
import {
  completedOutput,
  outputActionIds,
  OUTPUT_ACTION_LABELS,
  type CompletedOutputActionId,
} from "./outputActions";

export interface CompletedOutputAction {
  readonly id: CompletedOutputActionId;
  readonly label: string;
  readonly run: () => Promise<void>;
}

export function useCompletedOutputActions(
  job: Job,
  onHandoff?: (job: Job, destination: HandoffDestination) => void,
): readonly CompletedOutputAction[] {
  const enqueueToast = useAppStore((state) => state.enqueueToast);
  const output = completedOutput(job);

  async function run(action: CompletedOutputActionId): Promise<void> {
    if (!output) return;
    try {
      switch (action) {
        case "open":
          await api.output.open(output.path, output.kind);
          return;
        case "reveal":
          await api.queue.reveal(output.path);
          return;
        case "copy_path":
          await navigator.clipboard.writeText(output.path);
          enqueueToast({ variant: "info", title: "Path copied" });
          return;
        case "convert":
        case "compress":
          onHandoff?.(job, action);
          return;
      }
    } catch (error) {
      const title =
        action === "open"
          ? "Couldn't open output"
          : action === "reveal"
            ? "Couldn't show in Finder"
            : "Couldn't copy path";
      enqueueToast({ variant: "error", title, detail: formatError(error) });
    }
  }

  return outputActionIds(output)
    .filter((id) => onHandoff || (id !== "convert" && id !== "compress"))
    .map((id) => ({
      id,
      label: OUTPUT_ACTION_LABELS[id],
      run: () => run(id),
    }));
}
