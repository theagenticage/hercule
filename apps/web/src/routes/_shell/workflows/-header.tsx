import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkflowHeaderStatus } from "@hercule/client-core";
import { Button, SegmentedControl, SegmentedControlItem, cn } from "@hercule/ui";
import type { WorkflowView } from "../../../screens/workflow-editor";
import { parseWorkflowView, WORKFLOW_VIEWS } from "./-view";

/** The label of each view in the view control. */
const VIEW_LABELS: Readonly<Record<WorkflowView, string>> = {
  yaml: "YAML",
  graph: "Graph",
  split: "Split",
};

/**
 * Renders the header of a workflow's page: a link back to the list, the
 * workflow's name, the view control, and on the right whatever the page
 * passes as children.
 *
 * Layout:
 * - The title sits where the shell's top bar puts every other screen's
 *   title, and the content below starts at the same height as on other
 *   screens. The row is one title line high, and the taller controls are
 *   centred on that line.
 * - Every control has the height of the view control, so Save lines up with
 *   it and does not move when Delete appears or disappears.
 * - The row is a three-column grid with the view control in the middle
 *   column. The outer columns share the remaining width equally, so the view
 *   control never moves when the title, the status or a question changes.
 *   The pointer never ends up over a different view than the one it was on.
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
  /** The status text and the action buttons, or a question that replaces them. */
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] grid-rows-[1lh] items-center gap-4 px-8 pt-[22px] text-title">
      <div className="flex min-w-0 items-baseline gap-2 tracking-[-0.015em]">
        <Link
          to="/workflows"
          // Marked as current only on the list itself. A workflow's page is
          // under /workflows, but from there this link leads away.
          activeOptions={{ exact: true }}
          // The padding gives the focus ring room around the word, and the
          // negative margin cancels the padding so the word does not move.
          className="-mx-1 shrink-0 rounded-control px-1 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
        >
          Workflows
        </Link>
        <span aria-hidden="true" className="text-faint">
          /
        </span>
        {/* A long name is truncated, so the tooltip shows the full name. */}
        <h1 title={name} className="min-w-0 truncate font-emph text-ink">
          {name}
        </h1>
      </div>
      <SegmentedControl
        aria-label="View"
        className="h-8 w-auto"
        value={view}
        onValueChange={(next) => {
          onViewChange(parseWorkflowView(next));
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
 * Renders the right side of a workflow's header: the result of the last save
 * or delete, then Run, Delete and Save. Run and Delete are there for a stored
 * workflow only, because a new one has nothing to run or delete yet. While a
 * question shows, these are hidden instead of unmounted, so the focus can
 * return to the button that opened the question.
 *
 * A run uses the saved workflow, so Run cannot be pressed while the text has
 * unsaved changes, and its tooltip says why.
 */
export function WorkflowHeaderActions({
  isHidden,
  status,
  isStored,
  isRunDisabled,
  isDeleteDisabled,
  isSaveDisabled,
  onRun,
  onDelete,
  onSave,
}: {
  readonly isHidden: boolean;
  readonly status: WorkflowHeaderStatus | undefined;
  /** Whether the workflow is stored, so that it can be run and deleted. */
  readonly isStored: boolean;
  readonly isRunDisabled: boolean;
  readonly isDeleteDisabled: boolean;
  readonly isSaveDisabled: boolean;
  readonly onRun: () => void;
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
      {isStored ? (
        <>
          <Button
            aria-disabled={isRunDisabled}
            title={isRunDisabled ? "Save first: a run uses the saved workflow." : undefined}
            onClick={onRun}
          >
            Run
          </Button>
          <Button disabled={isDeleteDisabled} onClick={onDelete}>
            Delete
          </Button>
        </>
      ) : null}
      {/* `aria-disabled` instead of `disabled`, so Save keeps the focus while
          the save is in flight and after it finishes. A `disabled` button
          loses the focus. */}
      <Button variant="form" aria-disabled={isSaveDisabled} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}
