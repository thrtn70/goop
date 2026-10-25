import { useLayoutEffect, useRef } from "react";
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
  const focusAfterCommit = useRef(false);
  // A successful restore unmounts the focused button, so focus moves to the
  // status line once it has re-rendered with the restored state.
  useLayoutEffect(() => {
    if (!focusAfterCommit.current) return;
    focusAfterCommit.current = false;
    statusRef.current?.focus();
  });
  const restore = () => {
    if (onRestore?.()) focusAfterCommit.current = true;
  };
  return (
    <>
      <span className="block wrap-anywhere">{"Editing " + name}</span>
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
