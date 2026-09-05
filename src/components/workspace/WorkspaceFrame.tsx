import { useId, type ReactNode } from "react";
import clsx from "clsx";

export type WorkspaceFrameProps = {
  title: string;
  description?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  outputSummary?: ReactNode;
};

/** Layout slots only: source selection and processing state belong to the page. */
export default function WorkspaceFrame({title, description, toolbar, children, inspector, outputSummary}: WorkspaceFrameProps) {
  const titleId = useId();
  return <section aria-labelledby={titleId} className={clsx("workspace-frame", inspector && "has-inspector")}>
    <div className="workspace-source-column">
      <header className="workspace-heading">
        <div><h2 id={titleId}>{title}</h2>{description && <div className="workspace-description">{description}</div>}</div>
        {toolbar && <div className="workspace-toolbar">{toolbar}</div>}
      </header>
      <div className="workspace-source-scroll">{children}</div>
      {outputSummary && <footer className="workspace-output">{outputSummary}</footer>}
    </div>
    {inspector}
  </section>;
}
