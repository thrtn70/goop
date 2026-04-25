import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Job } from "@/types";
import { jobIdKey } from "@/store/appStore";
import QueueRow from "./QueueRow";

interface SortableQueueRowProps {
  job: Job;
  index: number;
}

/**
 * Wraps a single queued QueueRow with `useSortable` so it can be
 * drag-reordered inside a SortableContext. Running and terminal rows are
 * deliberately not sortable; the parent only renders this wrapper for jobs
 * with `state === "queued"`.
 */
export default function SortableQueueRow({ job, index }: SortableQueueRowProps) {
  const id = jobIdKey(job.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <QueueRow job={job} index={index} />
    </div>
  );
}
