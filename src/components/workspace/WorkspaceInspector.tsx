import { useId, type ReactNode } from "react";

export type WorkspaceInspectorProps = { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode; media?: ReactNode };

export default function WorkspaceInspector({title, description, children, actions, media}: WorkspaceInspectorProps) {
  const titleId = useId();
  return <aside aria-labelledby={titleId} className="workspace-inspector">
    <header><h3 id={titleId}>{title}</h3>{description && <div className="workspace-description">{description}</div>}</header>
    {media && <div className="workspace-inspector-media">{media}</div>}
    <div className="workspace-inspector-scroll">{children}</div>
    {actions && <footer className="workspace-inspector-actions">{actions}</footer>}
  </aside>;
}
