import type { ReactNode } from "react";

export type WorkspaceListProps = { label: string; header?: ReactNode; children: ReactNode };

/** Labelled source region; callers supply their own list and selection semantics. */
export default function WorkspaceList({label, header, children}: WorkspaceListProps) {
  return <section aria-label={label} className="workspace-list">{header}{children}</section>;
}
