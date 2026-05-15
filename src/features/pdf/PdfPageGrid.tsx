import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import PdfPageCard, { type PageCardMode, type PageState } from "./PdfPageCard";

interface PdfPageGridProps {
  pages: PageState[];
  onChange: (next: PageState[]) => void;
  mode: PageCardMode;
}

/**
 * Grid of per-page cards with dnd-kit drag-reorder + keyboard reorder.
 * The `mode` prop picks which controls each card surfaces: reorder
 * exposes a drag handle, delete exposes an X, rotate exposes paired
 * rotate buttons. Reorder is the only mode that mutates page positions;
 * delete and rotate keep positions stable and mutate per-card state.
 *
 * CSS-only responsive layout — auto-fill grid sizes columns to the
 * viewport without a JS breakpoint.
 */
export default function PdfPageGrid({ pages, onChange, mode }: PdfPageGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = pages.map((p) => `page-${p.originalPage}`);
    const oldIndex = ids.indexOf(active.id.toString());
    const newIndex = ids.indexOf(over.id.toString());
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(pages, oldIndex, newIndex));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={pages.map((p) => `page-${p.originalPage}`)}
        strategy={rectSortingStrategy}
        disabled={mode !== "reorder"}
      >
        <div
          role="list"
          aria-label="PDF pages"
          aria-describedby="pdf-page-grid-help"
          className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))]"
        >
          {pages.map((page) => (
            <div role="listitem" key={`page-${page.originalPage}`}>
              <PdfPageCard
                state={page}
                mode={mode}
                onChange={(next) => {
                  const replaced = pages.map((p) =>
                    p.originalPage === page.originalPage ? next : p,
                  );
                  onChange(replaced);
                }}
              />
            </div>
          ))}
        </div>
        <p id="pdf-page-grid-help" className="sr-only">
          {mode === "reorder"
            ? "Drag cards to reorder. Tab to focus a page, then Space to pick it up, arrow keys to move, Space to drop, Escape to cancel."
            : mode === "delete"
              ? "Click the X on a page to mark it for deletion. Click again to restore."
              : "Click the rotate buttons on a page to apply a clockwise or counter-clockwise rotation."}
        </p>
      </SortableContext>
    </DndContext>
  );
}
