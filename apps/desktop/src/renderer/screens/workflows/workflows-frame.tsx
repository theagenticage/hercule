/**
 * PROTOTYPE. The frame of the Workflows page: the floating header, then the
 * workflow list and the open workflow, side by side or one alone, at the
 * width `view` names.
 */
import type { JSX, ReactNode } from "react";
import "./workflows-frame.css";

/**
 * The list's three widths:
 *
 * - `table`: no workflow is open, and the list fills the main pane;
 * - `column`: the list is a column beside the open workflow;
 * - `full`: the open workflow fills the main pane, and the list is hidden.
 */
export type WorkflowsView = "table" | "column" | "full";

/**
 * Renders `header` over the page, and `list`, unless the view hides it,
 * beside `children`, the open workflow.
 */
export function WorkflowsFrame({
  view,
  header,
  list,
  children,
}: {
  readonly view: WorkflowsView;
  readonly header: ReactNode;
  readonly list: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`wf wf--${view}`}>
      {header}
      {view === "full" ? null : <section className="wf-list">{list}</section>}
      {children}
    </div>
  );
}
