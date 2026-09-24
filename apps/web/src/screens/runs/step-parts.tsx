import type { JSX } from "react";
import { describeFailureReason, type StepRow } from "@hercule/client-core";
import type { FailureReason, StepError } from "@hercule/contract";
import { WorkStateMark, cn } from "@hercule/ui";

/**
 * The first two cells of a step's row, in the step list and on the timeline:
 * the state mark, then the step id and the action it calls. A step the run
 * has not reached has no mark, and its id recedes.
 *
 * The space between the cells keeps their words apart when the row is read
 * as text, as a screen reader reads it; between grid cells it takes no room.
 */
export function StepCells({ row }: { readonly row: StepRow }): JSX.Element {
  return (
    <>
      <span className="flex items-center" aria-hidden="true">
        <WorkStateMark state={row.state} />
      </span>{" "}
      <span className="flex min-w-0 items-baseline gap-2.5">
        <span
          className={cn(
            "truncate font-mono text-row font-emph",
            row.state === "unreached" ? "text-muted" : "text-ink",
          )}
        >
          {row.stepId}
        </span>{" "}
        <span className="truncate font-mono text-fine text-faint">{row.action}</span>
      </span>
    </>
  );
}

/** A failed step's error, under its row: the code a program acts on, then the sentence. */
export function StepErrorLine({ error }: { readonly error: StepError }): JSX.Element {
  return (
    <p className="pr-2.5 pb-2.5 pl-[42px] text-fine text-fail">
      <span className="font-mono">{error.code}</span>
      {` · ${error.message}`}
    </p>
  );
}

/** Why a run failed, in the fail hue: "step failed at create_task". */
export function FailureText({
  reason,
  stepId,
}: {
  readonly reason: FailureReason;
  readonly stepId: string | undefined;
}): JSX.Element {
  return (
    <span className="text-fail">
      {describeFailureReason(reason)}
      {stepId === undefined ? null : (
        <>
          {" at "}
          <span className="font-mono text-fine">{stepId}</span>
        </>
      )}
    </span>
  );
}
