import { useState, type JSX } from "react";
import {
  describeStepState,
  formatElapsed,
  measureElapsed,
  type StepRow,
} from "@hercule/client-core";
import type { RunStatus } from "@hercule/contract";
import { WORK_STATE_HUES, cn } from "@hercule/ui";
import { StepCells, StepErrorLine } from "./step-parts";

/**
 * The steps of a run as a list: one row per step record, then the steps the
 * run has not reached. A row shows the step's mark, id, action, state and
 * duration, and its error under it. A row with an output opens to show it.
 */
export function StepList({
  rows,
  runStatus,
  now,
}: {
  readonly rows: ReadonlyArray<StepRow>;
  readonly runStatus: RunStatus;
  /** The time a running step's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
}): JSX.Element {
  const [openKey, setOpenKey] = useState<string>();
  return (
    <ul className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
      {rows.map((row) => {
        const output = row.record?.output;
        const isOpen = openKey === row.key && output !== undefined;
        const elapsed = measureElapsed(row.record?.startedAt, row.record?.finishedAt, now);
        const cells = (
          <>
            <StepCells row={row} />{" "}
            <span className={cn("text-meta", WORK_STATE_HUES[row.state] ?? "text-muted")}>
              {describeStepState(row.state, runStatus)}
            </span>{" "}
            <span
              className={cn(
                "text-right font-mono text-fine tabular-nums",
                WORK_STATE_HUES[row.state] ?? "text-muted",
              )}
            >
              {elapsed === undefined ? "" : formatElapsed(elapsed)}
            </span>{" "}
            <span className="flex justify-end text-faint" aria-hidden="true">
              {output === undefined ? null : <Chevron isOpen={isOpen} />}
            </span>
          </>
        );
        const grid =
          "grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_96px_72px_16px] items-center gap-3 rounded-control px-2.5 text-left";
        return (
          <li key={row.key} className="border-b border-line-soft last:border-b-0">
            {output === undefined ? (
              <div className={grid}>{cells}</div>
            ) : (
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpenKey(isOpen ? undefined : row.key);
                }}
                className={cn(
                  grid,
                  "cursor-pointer hover:bg-line-soft",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
                )}
              >
                {cells}
              </button>
            )}
            {row.record?.error === undefined ? null : <StepErrorLine error={row.record.error} />}
            {isOpen ? (
              <pre className="mr-2.5 mb-2.5 ml-[42px] overflow-x-auto rounded-control border border-line-soft bg-raised px-3 py-2 font-mono text-fine leading-5 text-ink">
                {JSON.stringify(output, null, 2)}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The chevron at the end of a row that opens: pointing right when shut, down when open. */
function Chevron({ isOpen }: { readonly isOpen: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("transition-transform", isOpen && "rotate-90")}
    >
      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}
