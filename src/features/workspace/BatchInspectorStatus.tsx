import { useRef } from "react";
import type { BatchState } from "./batchStamp";
import { inspectorBatchStatus, USE_BATCH_SETTINGS } from "./batchCopy";

/** The inspector description on both pages: the file being edited, then its batch status. */
export default function BatchInspectorStatus({
  name,
  state,
  label,
  onRestore,
}: {
  name: string;
  state: BatchState | null;
  label: string;
  /** Offered only while another row still has the batch settings; returns whether it applied. */
  onRestore: (() => boolean) | null;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  // A successful restore unmounts the focused button, so focus moves to the
  // status line, which now reads the restored state.
  const restore = () => {
    if (onRestore?.()) statusRef.current?.focus();
  };
  return (
    <>
      <span className="block">{"Editing " + name}</span>
      {state && (
        <span ref={statusRef} tabIndex={-1} className="mt-1 block text-fg-secondary wrap-anywhere focus-visible:outline-accent">
          {inspectorBatchStatus(state, label)}
          {onRestore && (
            <>
              {" "}
              <button type="button" onClick={restore} className="text-accent underline">
                {USE_BATCH_SETTINGS}
              </button>
            </>
          )}
        </span>
      )}
    </>
  );
}
