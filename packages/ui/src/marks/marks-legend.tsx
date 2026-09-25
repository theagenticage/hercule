import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover";
import { LaneLabel } from "../patterns/patterns";
import {
  CancelledMark,
  DecisionMark,
  DoneMark,
  FailedMark,
  PausedMark,
  QueuedMark,
  RunGlyph,
  SessionGlyph,
  SkippedMark,
  TaskGlyph,
  WorkflowGlyph,
  WorkingMark,
} from "./marks";

const states: [ReactNode, string][] = [
  [<WorkingMark key="working" />, "agent working"],
  [<DecisionMark key="decision" />, "decision wanted"],
  [<QueuedMark key="queued" />, "queued"],
  [<PausedMark key="paused" />, "paused"],
  [<DoneMark key="done" />, "done"],
  [<FailedMark key="failed" />, "failed"],
  [<CancelledMark key="cancelled" />, "cancelled"],
  [<SkippedMark key="skipped" />, "skipped"],
];

const things: [ReactNode, string][] = [
  [<TaskGlyph key="task" />, "task"],
  [<RunGlyph key="run" />, "run"],
  [<SessionGlyph key="session" />, "session"],
  [<WorkflowGlyph key="workflow" />, "workflow"],
];

function renderLegendRow([mark, meaning]: [ReactNode, string]): JSX.Element {
  return (
    <div key={meaning} className="flex items-center gap-2.5 py-[2.5px] text-fine text-muted">
      <span className="flex w-4 justify-start">{mark}</span>
      <span>{meaning}</span>
    </div>
  );
}

/** Checks whether a key event's target is a field the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * The marks legend: a toggle at the foot of the sidebar that opens a popover
 * explaining the marks. `?` opens it from anywhere on the page, and Esc closes
 * it. The legend is never permanently on a page.
 */
export function MarksLegend(): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "?" || event.defaultPrevented || isTyping(event.target)) return;
      event.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-[5px] text-row text-muted hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live">
        <QueuedMark />
        Marks
        <kbd className="ml-auto rounded-[4px] border border-line px-1 font-mono text-label leading-[1.5] text-faint">
          ?
        </kbd>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-[236px]" aria-label="Marks legend">
        <LaneLabel className="mb-1">Marks</LaneLabel>
        {states.map(renderLegendRow)}
        <div className="mt-2">
          <LaneLabel className="mb-1">Things</LaneLabel>
        </div>
        {things.map(renderLegendRow)}
        <p className="mt-2 border-t border-line-soft pt-2 text-fine text-faint">
          Open with <kbd className="font-mono">?</kbd> · Esc closes
        </p>
      </PopoverContent>
    </Popover>
  );
}
