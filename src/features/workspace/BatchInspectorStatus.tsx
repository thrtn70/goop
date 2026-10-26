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
  // status line once it has re-rendered with the restored state. A row that is
  // still offering a restore was not restored, so it never takes focus.
  useLayoutEffect(() => {
    if (!focusAfterCommit.current) return;
    focusAfterCommit.current = false;
    if (!onRestore) statusRef.current?.focus();
  });
  const restore = () => {
    if (onRestore?.()) focusAfterCommit.current = true;
  };
  const editing = "Editing " + name;
  const status = state && inspectorBatchStatus(state, label);
  // Long file and batch names stay on one line, with the full text on hover,
  // so they never push the settings and the footer out of a small window.
  // The Edited line keeps wrapping: its words are short and it holds a button.
  return (
    <>
      <span className="block truncate" title={editing}>{editing}</span>
      {state && (
        <span
          ref={statusRef}
          tabIndex={-1}
          title={state === "batch" ? status ?? undefined : undefined}
          className={`mt-1 block text-fg-secondary focus-visible:outline-accent ${state === "batch" ? "truncate" : ""}`}
        >
          {status}
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
