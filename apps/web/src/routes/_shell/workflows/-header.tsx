import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkflowHeaderStatus } from "@hercule/client-core";
import { Button, SegmentedControl, SegmentedControlItem, cn } from "@hercule/ui";
import type { WorkflowView } from "../../../screens/workflow-editor";
import { readWorkflowView, WORKFLOW_VIEWS } from "./-view";

/** What the view control calls each view. */
const VIEW_LABELS: Readonly<Record<WorkflowView, string>> = {
  yaml: "YAML",
  graph: "Graph",
  split: "Split",
};

/**
 * The header of a workflow's page: the way back to the list, the workflow's
 * name, the view control, and at the right whatever the page puts there.
 *
 * The title stands where the shell's bar puts every other screen's title,
 * and the page under the header starts where every other screen starts: the
 * row is one line of the title high, and the controls, which are higher, are
 * centred on that line. Every control is as high as the view control, and
 * each is centred in the row, so Save lines up with the view control and
 * does not move when Delete comes or goes.
 *
 * The row has three columns, and the middle one holds the view control. The
 * two outer columns share the rest of the width equally, so the view control
 * stays in one place whatever the title, the status or a question holds, and
 * a pointer that rests on it never finds another view under it.
 */
export function WorkflowHeader({
  name,
  view,
  onViewChange,
  children,
}: {
  readonly name: string;
  readonly view: WorkflowView;
  readonly onViewChange: (view: WorkflowView) => void;
  /** The status and the actions of the page, or the question that stands in their place. */
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-[1lh] items-center gap-4 px-8 pt-[22px] text-title">
      <div className="flex min-w-0 items-baseline gap-2 tracking-[-0.015em]">
        <Link
          to="/workflows"
          // The link is the current page only on the list itself. A
          // workflow's page is under the list's address, and the link leads
          // out of it.
          activeOptions={{ exact: true }}
          // The padding gives the focus ring room around the word, and the
          // margin keeps the word where it stands.
          className="-mx-1 shrink-0 rounded-control px-1 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
        >
          Workflows
        </Link>
        <span aria-hidden="true" className="text-faint">
          /
        </span>
        {/* A long name is cut off, so the whole name is in its tooltip. */}
        <h1 title={name} className="min-w-0 truncate font-emph text-ink">
          {name}
        </h1>
      </div>
      <SegmentedControl
        aria-label="View"
        className="h-8 w-auto"
        value={view}
        onValueChange={(next) => {
          onViewChange(readWorkflowView(next));
        }}
      >
        {WORKFLOW_VIEWS.map((option) => (
          <SegmentedControlItem key={option} value={option} className="px-3">
            {VIEW_LABELS[option]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <div className="flex min-w-0 items-center justify-end gap-1.5 [&_button]:h-8">{children}</div>
    </header>
  );
}

const STATUS_TONE: Readonly<Record<WorkflowHeaderStatus["tone"], string>> = {
  muted: "text-muted",
  attn: "text-attn",
  fail: "text-fail",
};

/**
 * What the header of a workflow's page holds at its right: what the page's
 * last write said, Delete for a stored workflow, and Save. A question takes
 * their place while it shows. They are hidden then, and not removed, so the
 * focus can go back to the button that asked.
 */
export function WorkflowHeaderActions({
  isHidden,
  status,
  canDelete,
  isDeleteDisabled,
  isSaveDisabled,
  onDelete,
  onSave,
}: {
  readonly isHidden: boolean;
  readonly status: WorkflowHeaderStatus | undefined;
  readonly canDelete: boolean;
  readonly isDeleteDisabled: boolean;
  readonly isSaveDisabled: boolean;
  readonly onDelete: () => void;
  readonly onSave: () => void;
}): JSX.Element {
  return (
    <div hidden={isHidden} className="flex min-w-0 items-center gap-1.5">
      {status === undefined ? null : (
        <span
          role={status.tone === "fail" ? "alert" : "status"}
          title={status.text}
          className={cn("min-w-0 truncate text-fine", STATUS_TONE[status.tone])}
        >
          {status.text}
        </span>
      )}
      {canDelete ? (
        <Button disabled={isDeleteDisabled} onClick={onDelete}>
          Delete
        </Button>
      ) : null}
      {/* `aria-disabled`, and not `disabled`, so that Save keeps the focus
          while its write is in flight and after it lands. */}
      <Button variant="form" aria-disabled={isSaveDisabled} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}
