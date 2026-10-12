import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { readErrorMessage, type HerculeClient, type SpawnBoundRow } from "@hercule/client-core";
import { Button, LaneLabel, PausedMark, cn } from "@hercule/ui";
import { DiscardHeldEvents } from "../../../screens/discard-held-events";
import { SaveStatus } from "../../../screens/save-status";
import { useResumeTrigger } from "../../../screens/use-resume-trigger";

/** The number of columns, which a row under a trigger's row spans. */
const COLUMN_COUNT = 6;

/** The style of a column heading: the lane label's, in a table header. */
const HEADING = "px-2 pb-1.5 text-label font-emph tracking-[0.1em] text-faint uppercase";

/** The text color of each status tone. */
const TONE_CLASS = { muted: "text-muted", attn: "text-attn", fail: "text-fail" } as const;

/**
 * Renders the start triggers as a table, one row each, under the default
 * bound's card.
 *
 * The table is wider than the settings cards, as wide as the Workflows list:
 * six columns and a button do not fit in a card's width. The workflow's name
 * takes the width the other columns leave, so a long name is cut short last.
 * On a narrow window the table scrolls sideways rather than cutting the
 * columns short.
 */
export function BoundTable({
  client,
  rows,
}: {
  readonly client: HerculeClient;
  readonly rows: ReadonlyArray<SpawnBoundRow>;
}): JSX.Element {
  return (
    <section aria-labelledby="bound-triggers">
      <LaneLabel id="bound-triggers">Triggers</LaneLabel>
      <div className="max-w-[1040px] overflow-x-auto rounded-card border border-line-soft bg-surface px-1.5 pt-2.5 pb-1">
        <table className="w-full min-w-[880px] table-fixed border-collapse text-meta">
          <colgroup>
            <col />
            <col className="w-[136px]" />
            <col className="w-[232px]" />
            <col className="w-[160px]" />
            <col className="w-[56px]" />
            <col className="w-[88px]" />
          </colgroup>
          <thead>
            <tr>
              {/* The first heading starts where the workflow's name does,
                  after the mark's space. */}
              <th scope="col" className={cn(HEADING, "pl-7 text-left")}>
                Workflow
              </th>
              <th scope="col" className={cn(HEADING, "text-left")}>
                Trigger
              </th>
              <th scope="col" className={cn(HEADING, "text-left")}>
                Bound
              </th>
              <th scope="col" className={cn(HEADING, "text-left")}>
                Status
              </th>
              <th scope="col" className={cn(HEADING, "text-right")}>
                Held
              </th>
              <th scope="col" className={HEADING}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <BoundRow key={row.key} client={client} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Renders one start trigger's row, and under it, when they apply, the offer
 * to resume it with its held events discarded and the error of its last
 * resume.
 *
 * A paused trigger offers Resume, which keeps its held events: they start
 * runs as its window frees up. The row owns the resume mutation, because
 * nothing above it needs it. A resume changes the row itself, so the row's
 * new status is the feedback, and only a failure is shown.
 */
function BoundRow({
  client,
  row,
}: {
  readonly client: HerculeClient;
  readonly row: SpawnBoundRow;
}): JSX.Element {
  const { workflowId, triggerId } = row;
  const resume = useResumeTrigger(client, { workflowId, triggerId });

  // The `{" "}` spaces are for screen readers. Flex layout adds no space
  // between items, so without them the texts run together.
  return (
    <>
      <tr className="h-9 align-middle">
        <td className="px-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex w-3 shrink-0 justify-center">
              {row.isPaused ? <PausedMark /> : null}
            </span>
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId }}
              title={row.workflowName}
              className="min-w-0 truncate rounded-control font-emph text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
            >
              {row.workflowName}
            </Link>
          </div>
        </td>
        <td className="truncate px-2 font-mono text-fine text-ink">{triggerId}</td>
        <td className="truncate px-2" title={row.boundUse.title}>
          <span
            className={cn(
              "font-mono text-fine tabular-nums",
              row.isNearLimit ? "text-attn" : "text-muted",
            )}
          >
            {row.boundUse.text}
          </span>{" "}
          <span className="text-fine text-faint">{row.isDefault ? "default" : "override"}</span>
        </td>
        <td className={cn("truncate px-2", TONE_CLASS[row.status.tone])}>{row.status.text}</td>
        <td
          className={cn(
            "px-2 text-right font-mono text-fine tabular-nums",
            row.heldCount > 0 ? "text-ink" : "text-faint",
          )}
        >
          {row.heldCount}
        </td>
        <td className="px-2">
          {row.isPaused ? (
            <div className="-mr-1 flex justify-end">
              <Button
                className="text-meta"
                // An `aria-disabled` button ignores clicks, so a double
                // click cannot send the request twice.
                aria-disabled={resume.isPending}
                onClick={() => {
                  resume.mutate(false);
                }}
              >
                Resume
              </Button>
            </div>
          ) : null}
        </td>
      </tr>
      {row.canDiscardHeldEvents ? (
        <DetailRow>
          <DiscardHeldEvents
            heldCount={row.heldCount}
            isPending={resume.isPending}
            onConfirm={() => {
              resume.mutate(true);
            }}
          />
        </DetailRow>
      ) : null}
      {resume.error === null ? null : (
        <DetailRow>
          <SaveStatus saved={false} failure={readErrorMessage(resume.error)} />
        </DetailRow>
      )}
    </>
  );
}

/**
 * Renders a row under a trigger's row that spans the whole table, with its
 * content lined up under the workflow's name.
 */
function DetailRow({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <tr>
      <td colSpan={COLUMN_COUNT} className="pr-2 pb-2 pl-7">
        {children}
      </td>
    </tr>
  );
}
