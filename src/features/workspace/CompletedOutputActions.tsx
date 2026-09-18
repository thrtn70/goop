import type { Job } from "@/types";
import type { HandoffDestination } from "./handoff";
import type { CompletedOutputActionId } from "./outputActions";
import { useCompletedOutputActions } from "./useCompletedOutputActions";

interface CompletedOutputActionsProps {
  readonly job: Job;
  readonly variant: "panel" | "modal";
  readonly onHandoff: (job: Job, destination: HandoffDestination) => void;
}

const WORKFLOW_ACTIONS = new Set<CompletedOutputActionId>(["convert", "compress"]);

export default function CompletedOutputActions({
  job,
  variant,
  onHandoff,
}: CompletedOutputActionsProps) {
  const actions = useCompletedOutputActions(job, onHandoff);
  if (actions.length === 0) return null;
  const utilityActions = actions.filter((action) => !WORKFLOW_ACTIONS.has(action.id));
  const workflowActions = actions.filter((action) => WORKFLOW_ACTIONS.has(action.id));
  const groupClass = variant === "panel" ? "flex flex-col gap-2" : "flex flex-wrap gap-2";
  const buttonClass = `btn-press rounded-md bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-secondary transition duration-fast ease-out hover:text-fg ${variant === "panel" ? "w-full" : ""}`;

  const renderAction = (action: (typeof actions)[number]) => (
    <button
      key={action.id}
      type="button"
      onClick={() => void action.run()}
      className={buttonClass}
    >
      {action.label}
    </button>
  );

  return (
    <div className={variant === "panel" ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}>
      <div className={groupClass}>{utilityActions.map(renderAction)}</div>
      {workflowActions.length > 0 && (
        <div className={groupClass}>{workflowActions.map(renderAction)}</div>
      )}
    </div>
  );
}
