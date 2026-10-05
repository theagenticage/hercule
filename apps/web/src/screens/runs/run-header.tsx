import { Fragment, type JSX, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  describeRunOrigin,
  describeRunStatus,
  findFailedEdge,
  formatPreciseStamp,
  listAwaitedSignals,
  readTimestamps,
  toIdTail,
  type RerunsReading,
} from "@hercule/client-core";
import type { Run, Runner } from "@hercule/contract";
import { WORK_STATE_HUES, WorkStateMark, cn } from "@hercule/ui";
import { ActorLink, INLINE_LINK } from "../actor-link";
import { Connectivity } from "../connectivity";
import { FailureText } from "./step-parts";

/** The quiet link style of the breadcrumb back to the run list. */
const QUIET_LINK =
  "-mx-1 rounded-control px-1 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/**
 * Renders the header of a run's page. The first line is a breadcrumb back to
 * the run list and the workflow's name, with the page's actions on the right.
 * The second line shows where the run is: its status mark and status with its
 * duration, why it failed or which signals a running run with nothing left
 * to run waits on, their ids in the live hue, who or which trigger started it and how,
 * when it started and ended, and its id's tail, which the CLI takes. For a run that is
 * a re-run, or that was re-run, the next line links the runs on either side,
 * such as "re-run of run 1f3a9c2e" or "re-run as run 4e5f6a7b, run 8c9d0e1f,
 * run 2b7c4d9a and 2 more". Once the run is pinned to a runner, the next line
 * shows where it works: the runner, linked to its page, with whether the
 * controller can reach it, the run's workspace, and the note on what happens
 * to the workspace, such as "Workspace deleted 3 Oct". A run that failed at an
 * edge has a last line: what went wrong there. So does a run whose trigger's
 * event did not make valid inputs: the line shows why, and the run has no
 * start time, so the time shown is when it was created.
 *
 * Below the header's lines, each on a row of its own, come why the controller
 * refused one of the page's actions, and the question shown before an action
 * is done.
 *
 * The title sits where the shell's top bar puts every other screen's title,
 * so the page does not jump when it opens.
 */
export function RunHeader({
  run,
  runner,
  workspaceLabel,
  workspaceNote,
  reruns,
  now,
  timezone,
  children,
  refusals,
  question,
}: {
  readonly run: Run;
  /** The runner the run is pinned to, once it is pinned and the runner has been read. */
  readonly runner: Runner | undefined;
  /** The name of the run's workspace, once it has one and it has been read. */
  readonly workspaceLabel: string | undefined;
  /** What happens to the run's workspace, such as "Workspace kept until 9 Oct". */
  readonly workspaceNote: string | undefined;
  /** The runs that re-ran this one. */
  readonly reruns: RerunsReading;
  /** The time a live run's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
  readonly timezone: string;
  /**
   * The actions on the right: Cancel, Delete workspace or Re-run, and the
   * question shown before Cancel or Delete workspace is done.
   */
  readonly children: ReactNode;
  /**
   * Why the controller refused the page's actions, one text per action, such
   * as "Not re-run: This run's workflow has been deleted...". Each is shown
   * in full, wrapped over as many lines as it needs, because its end often
   * says what to do instead.
   */
  readonly refusals: ReadonlyArray<string>;
  /**
   * The question shown before an action is done, when it is not shown beside
   * the title: the re-run question, and the others on a page too narrow for
   * them there. It takes a row of its own below the header's lines.
   */
  readonly question?: ReactNode;
}): JSX.Element {
  const origin = describeRunOrigin(run);
  const awaitedSignals = listAwaitedSignals(run);
  const { startedAt, finishedAt } = readTimestamps(run);
  const started = startedAt ?? run.createdAt;
  return (
    <header className="shrink-0 px-8 pt-[22px]">
      {/*
        The actions take the room they need, and the title the rest. The
        breadcrumb back to the run list always keeps its room, so a long
        question beside it cannot run over it. The workflow's name adds
        nothing to the smallest width the title needs, so it is the part that
        gives way.
      */}
      <div className="grid grid-cols-[minmax(min-content,1fr)_auto] grid-rows-[1lh] items-center gap-4 text-title">
        <div className="flex min-w-0 items-baseline gap-2 tracking-[-0.015em]">
          <Link
            to="/runs"
            activeOptions={{ exact: true }}
            className={cn("shrink-0 text-muted", QUIET_LINK)}
          >
            Runs
          </Link>
          <span aria-hidden="true" className="text-faint">
            /
          </span>
          <h1
            title={run.plan.name}
            className="min-w-0 grow truncate font-emph text-ink contain-inline-size"
          >
            {run.plan.name}
          </h1>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5 [&_button]:h-8">
          {children}
        </div>
      </div>
      <p className="mt-1.5 flex h-5 min-w-0 items-center gap-2 text-meta whitespace-nowrap text-muted">
        <WorkStateMark state={run.status} />
        <span className={cn("shrink-0 font-emph", WORK_STATE_HUES[run.status] ?? "text-ink")}>
          {describeRunStatus(run, now)}
        </span>
        <Dot />
        {/*
          The rest of the line is one run of text, so a narrow page cuts it
          off at its end with a single ellipsis. The facts are in the order
          they matter, so the ones cut off are the ones that matter least.
          The smaller monospaced parts have no line height of their own, so
          they do not make the line taller and push its text off centre.
        */}
        <span className="min-w-0 truncate">
          {run.status !== "failed" ? null : (
            <>
              <FailureText
                reason={run.failureReason}
                stepId={run.failureReason === "validation-error" ? undefined : run.failedStepId}
                edge={findFailedEdge(run)}
              />
              <Dot inline />
            </>
          )}
          {awaitedSignals.length === 0 ? null : (
            <>
              {/* Colour stays at the scale of a word: only the signal ids
                  take the live hue, and the words around them stay muted. */}
              {"waiting on "}
              {awaitedSignals.map((signalId, index) => (
                <Fragment key={signalId}>
                  {index === 0 ? null : " or "}
                  <span className="font-mono text-fine leading-none text-live">{signalId}</span>
                </Fragment>
              ))}
              <Dot inline />
            </>
          )}
          {"started by "}
          {origin.kind === "actor" ? (
            <ActorLink actor={origin} plainClassName="text-ink" />
          ) : (
            <>
              {"trigger "}
              <span className="font-mono text-fine leading-none text-ink">{origin.triggerId}</span>
            </>
          )}
          {origin.howStarted === undefined ? null : ` ${origin.howStarted}`}
          <Dot inline />
          <span className="font-mono text-fine leading-none tabular-nums">
            <time dateTime={started}>
              {formatPreciseStamp(new Date(started), timezone) ?? started}
            </time>
            {finishedAt === undefined ? null : (
              <>
                <span className="text-faint">{" → "}</span>
                <time dateTime={finishedAt}>
                  {formatPreciseStamp(new Date(finishedAt), timezone, new Date(started)) ??
                    finishedAt}
                </time>
              </>
            )}
          </span>
          <Dot inline />
          <span className="font-mono text-fine leading-none text-faint" title={run.id}>
            {`run ${toIdTail(run.id)}`}
          </span>
        </span>
      </p>
      {run.originalRunId === undefined && reruns.runIds.length === 0 ? null : (
        <p className="mt-1 flex h-5 min-w-0 items-center text-meta whitespace-nowrap text-muted">
          {/* One run of text, cut off at its end on a narrow page, like the line above. */}
          <span className="min-w-0 truncate">
            {run.originalRunId === undefined ? null : (
              <>
                {"re-run of "}
                <RunLink runId={run.originalRunId} />
              </>
            )}
            {run.originalRunId === undefined || reruns.runIds.length === 0 ? null : <Dot inline />}
            {reruns.runIds.length === 0 ? null : (
              <>
                {"re-run as "}
                {reruns.runIds.map((runId, index) => (
                  <Fragment key={runId}>
                    {index === 0 ? null : ", "}
                    <RunLink runId={runId} />
                  </Fragment>
                ))}
                {reruns.unlinkedCountText === undefined ? null : ` and ${reruns.unlinkedCountText}`}
              </>
            )}
          </span>
        </p>
      )}
      {runner === undefined && workspaceLabel === undefined ? null : (
        <p className="mt-1 flex h-5 min-w-0 items-center gap-2 text-meta whitespace-nowrap text-muted">
          {runner === undefined ? null : (
            <>
              <span className="shrink-0">
                {"on runner "}
                <Link
                  to="/fleet/$runnerId"
                  params={{ runnerId: runner.id }}
                  className={cn("text-ink", QUIET_LINK)}
                >
                  {runner.name}
                </Link>
              </span>
              <Connectivity runner={runner} timezone={timezone} />
            </>
          )}
          {runner === undefined || workspaceLabel === undefined ? null : <Dot />}
          {workspaceLabel === undefined ? null : (
            // When the line is too narrow for both, the workspace's name gives
            // way before the note: hovering shows the whole name, and the note
            // is what the user may act on. The name starts from no width and
            // grows up to its full width into the space the rest of the line
            // leaves. A shrinking name would take the note down with it by a
            // fraction of a pixel, which is enough to cut the note's last
            // letters off. The name has no line height of its own for the
            // same reason as the times on the line above.
            <span className="max-w-max min-w-0 flex-[1_1_0%] truncate" title={workspaceLabel}>
              {"in "}
              <span className="font-mono text-fine leading-none text-ink">{workspaceLabel}</span>
            </span>
          )}
          {workspaceLabel === undefined || workspaceNote === undefined ? null : (
            <>
              <Dot />
              <span className="min-w-0 truncate" title={workspaceNote}>
                {workspaceNote}
              </span>
            </>
          )}
        </p>
      )}
      {"failedEdge" in run && run.failedEdge !== undefined ? (
        <p className="mt-1 text-fine text-fail">{run.failedEdge.message}</p>
      ) : null}
      {run.status === "failed" && run.failureReason === "validation-error" ? (
        <p className="mt-1 text-fine text-pretty text-fail">{run.failureMessage}</p>
      ) : null}
      {refusals.map((refusal) => (
        <p key={refusal} role="alert" className="mt-3 text-fine text-pretty text-fail">
          {refusal}
        </p>
      ))}
      {question === undefined ? null : <div className="mt-3">{question}</div>}
    </header>
  );
}

/**
 * Renders another run as "run 1f3a9c2e", linked to its page, in the style of
 * the link to a run that started this one.
 */
function RunLink({ runId }: { readonly runId: string }): JSX.Element {
  return (
    <Link to="/runs/$runId" params={{ runId }} className={INLINE_LINK}>
      {`run ${toIdTail(runId)}`}
    </Link>
  );
}

/**
 * Renders the separator between two facts of a header line. Inside a run of
 * text, where no flex gap spaces the facts, the separator takes the gap's
 * width as its margins, so both kinds look the same.
 */
function Dot({ inline = false }: { readonly inline?: boolean }): JSX.Element {
  return (
    <span aria-hidden="true" className={cn("text-faint", inline && "mx-2")}>
      ·
    </span>
  );
}
