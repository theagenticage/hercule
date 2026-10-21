/**
 * The body of the Tracking pane: the trip of the work from the user's
 * handoff to where it stands now, as the Tracking drawing draws it (spec 17
 * §Tracking). It reads what the pane's row does not hold: the Task's runs and
 * the output of its last agent step (`task.readTracking`), and the signal the
 * user first handed off (`signal.read`).
 */
import type { JSX, ReactNode } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Signal, TrackingDetail, TrackingDetailRun } from "@hercule/contract";
import {
  decideTrackingRowPose,
  decideTrackingRunPose,
  describeSignalKindAndPlace,
  describeTrackingLine,
  describeTrackingRunLine,
  describeTrackingStamp,
  formatBlocksAsText,
  formatMessageTime,
  isKnownBlock,
  isRunLive,
  lowerFirst,
  nameSignalSource,
  readErrorMessage,
  readTrackingFaceSeed,
  shouldListTrackingRuns,
  type TrackingDestination,
  type TrackingRow,
} from "@hercule/client-core";
import {
  assistantsQuery,
  pluginsQuery,
  signalQuery,
  trackingDetailQuery,
  userQuery,
  workflowsQuery,
} from "../../app/queries";
import { buildHueStyle, buildLook, Face, UserAvatar } from "../../faces";
import { Markdown } from "../session/markdown";
import { SignalMark } from "./source-mark";
import {
  AgentMessage,
  AskedMessage,
  EndedOnAction,
  FailureReason,
  StepOutput,
  QuestionCard,
  RunList,
  SignalMessage,
  type AskedQuote,
  type RunLine,
} from "./tracking-messages";
import "./tracking.css";

/**
 * Renders the trip of `row`: what the user asked, what the agent did, and
 * when the work waits on a signal, that signal. Nothing is drawn until the
 * Task's read answers, so the pane's head and answers show at once. A read
 * that fails shows its error where the trip would be.
 *
 * `onOpenDestination` is called with the run, thread or signal a link opens.
 */
export function TrackingTrip({
  row,
  timezone,
  onOpenDestination,
}: {
  readonly row: TrackingRow;
  readonly timezone: string;
  readonly onOpenDestination: (destination: TrackingDestination) => void;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const read = useQuery(trackingDetailQuery(client, row.task.taskId));
  if (read.data !== undefined) {
    return (
      <Trip
        row={row}
        detail={read.data}
        timezone={timezone}
        onOpenDestination={onOpenDestination}
      />
    );
  }
  return read.isError ? (
    <p className="ad-flag" role="alert">
      {readErrorMessage(read.error)}
    </p>
  ) : null;
}

/**
 * Returns the first block of `signal` as the quote of a handoff draws it: its
 * markdown for a text block, the block as plain text for any other, and the
 * signal's title when it has no block.
 */
const buildQuoteText = (signal: Signal): ReactNode => {
  const [first] = signal.blocks;
  if (first === undefined) return signal.title;
  if (isKnownBlock(first) && first.type === "text") return <Markdown text={first.markdown} />;
  return formatBlocksAsText([first]);
};

/** Builds the line of `run` in the list of runs, with times in `timezone` as seen from `now`. */
const buildRunLine = (run: TrackingDetailRun, timezone: string, now: Date): RunLine => {
  // A run that has not ended is led by when it started.
  const timeAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
  return {
    runId: run.id,
    time: formatMessageTime(new Date(timeAt), timezone, now) ?? "",
    timeAt,
    mark: decideTrackingRunPose(run),
    live: isRunLive(run.status),
    workflowName: run.workflowName,
    hue: buildHueStyle(buildLook(run.workflowId ?? run.workflowName).hue),
    outcome: describeTrackingRunLine(run),
    sessionId: run.sessionId,
  };
};

/** Renders the trip once the Task's read has answered. */
function Trip({
  row,
  detail,
  timezone,
  onOpenDestination,
}: {
  readonly row: TrackingRow;
  readonly detail: TrackingDetail;
  readonly timezone: string;
  readonly onOpenDestination: (destination: TrackingDestination) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: workflows } = useSuspenseQuery(workflowsQuery(client));
  const { data: assistants } = useSuspenseQuery(assistantsQuery(client));
  const raisers = { workflows, assistants };
  const asked = useQuery(signalQuery(client, detail.firstHandoff.signalId));
  const now = new Date();
  const look = buildLook(readTrackingFaceSeed(row));
  const openRun = (runId: string): void => {
    onOpenDestination({ kind: "run", runId });
  };
  const openThread = (sessionId: string): void => {
    onOpenDestination({ kind: "thread", sessionId });
  };

  const handedAt = formatMessageTime(new Date(detail.firstHandoff.at), timezone, now);
  const handedTo =
    detail.runs.find((run) => run.id === detail.firstHandoff.runId)?.workflowName ??
    row.run.workflowName;
  const handed = `handed to ${handedTo}`;
  const quote: AskedQuote =
    asked.data !== undefined
      ? {
          kind: "ready",
          mark: <SignalMark signal={asked.data} plugins={plugins} size={13} />,
          who: asked.data.asker ?? nameSignalSource(asked.data, plugins, raisers),
          kindAndPlace: describeSignalKindAndPlace(asked.data),
          text: buildQuoteText(asked.data),
        }
      : asked.isError
        ? { kind: "failed", message: readErrorMessage(asked.error) }
        : { kind: "loading" };

  const { output } = detail;
  // The output is the newest run's, so its page is the newest run's.
  const outputRunId = detail.runs.at(-1)?.id ?? row.run.id;
  const waitsOn = row.state === "needs-you" ? row.waitsOn : undefined;
  return (
    <div className="tr-trip">
      <AskedMessage
        avatar={<UserAvatar name={username} size={28} />}
        small={handedAt === undefined ? handed : `${handedAt} · ${handed}`}
        quote={quote}
      />
      <AgentMessage
        face={<Face look={look} pose={decideTrackingRowPose(row)} size={28} />}
        name={row.run.workflowName}
        hue={buildHueStyle(look.hue)}
        stamp={describeTrackingStamp(row, timezone, now)}
      >
        {row.state === "failed" && row.run.failureCause !== undefined && (
          <FailureReason cause={row.run.failureCause} />
        )}
        {row.state !== "working" && output !== undefined && (
          <StepOutput
            output={output}
            onOpenRun={() => {
              openRun(outputRunId);
            }}
            onOpenThread={openThread}
          />
        )}
        {shouldListTrackingRuns(detail.runs) && (
          <RunList
            lines={detail.runs.map((run) => buildRunLine(run, timezone, now))}
            onOpenRun={openRun}
            onOpenThread={openThread}
          />
        )}
        {detail.endingActionStepName !== undefined && (
          <EndedOnAction stepName={detail.endingActionStepName} />
        )}
        {waitsOn?.kind === "request" && (
          <QuestionCard
            question={waitsOn.session.question}
            onOpenThread={() => {
              openThread(waitsOn.session.sessionId);
            }}
          />
        )}
      </AgentMessage>
      {waitsOn?.kind === "signal" && (
        <SignalMessage
          mark={<SignalMark signal={waitsOn.signal} plugins={plugins} size={14} />}
          name={waitsOn.signal.asker ?? nameSignalSource(waitsOn.signal, plugins, raisers)}
          small={[
            lowerFirst(describeTrackingLine(row).text),
            formatMessageTime(new Date(row.since), timezone, now),
          ]
            .filter((part) => part !== undefined)
            .join(" · ")}
          title={waitsOn.signal.title}
          onOpenSignal={() => {
            onOpenDestination({ kind: "signal", signalId: waitsOn.signal.id });
          }}
        />
      )}
    </div>
  );
}
