import { useState, type JSX, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Link } from "@tanstack/react-router";
import { Button, SegmentedControl, SegmentedControlItem } from "@hercule/ui";
import { readWorkflowView, WORKFLOW_VIEWS, type WorkflowView } from "./-view";

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

/**
 * A question asked in place of the header's buttons, rather than behind a
 * browser dialog, like every other question this app puts to the reader.
 *
 * The answer that declines comes first and the answer that accepts comes
 * last, as everywhere in the app. The focus moves to the answer that
 * declines, so a key press that follows the question cannot accept it. After
 * that answer, the focus goes back to the element that asked. The page keeps
 * its own buttons mounted, and hidden, while a question shows, so that
 * element is still there when the question goes. Each question has a key of
 * its own, so a question that takes the place of another starts again: it
 * takes the focus, and it keeps the element that asked it.
 */
export function HeaderQuestion({
  question,
  declineLabel,
  acceptLabel,
  onDecline,
  onAccept,
}: {
  readonly question: string;
  readonly declineLabel: string;
  readonly acceptLabel: string;
  readonly onDecline: () => void;
  readonly onAccept: () => void;
}): JSX.Element {
  // The first render comes before the answer that declines takes the focus,
  // so the element with the focus is the element that asked.
  const [asker] = useState(() => document.activeElement);
  return (
    <>
      <span className="min-w-0 truncate text-row text-muted">{question}</span>
      <Button
        autoFocus
        onClick={() => {
          // The element that asked can take the focus only after the page
          // has rendered without the question.
          flushSync(onDecline);
          if (asker instanceof HTMLElement) asker.focus();
        }}
      >
        {declineLabel}
      </Button>
      <Button variant="primary" onClick={onAccept}>
        {acceptLabel}
      </Button>
    </>
  );
}
