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
import type { Signal, TrackingDetail } from "@hercule/contract";
import {
  decideTrackingRowPose,
  describeSignalKindAndPlace,
  describeTrackingLine,
  describeTrackingTrip,
  formatBlocksAsText,
  formatMessageTime,
  isKnownBlock,
  lowerFirst,
  nameSignalSource,
  readErrorMessage,
  readTrackingFaceSeed,
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
  QuestionCard,
  RunList,
  SignalMessage,
  StepOutput,
  type AskedQuote,
} from "./tracking-messages";
import "./tracking.css";

/**
 * Renders the trip of `row`: what the user asked, what the agent did, and
 * when the work waits on a signal, that signal. Nothing is drawn until the
 * Task's read answers, so the pane's head and answers show at once. A read
 * that fails shows its error where the trip would be, also when an earlier
 * read of the trip succeeded: the trip it drew may no longer be true.
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
  if (read.isError) {
    return (
      <p className="ad-flag" role="alert">
        {readErrorMessage(read.error)}
      </p>
    );
  }
  return read.data === undefined ? null : (
    <Trip row={row} detail={read.data} timezone={timezone} onOpenDestination={onOpenDestination} />
  );
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

  const trip = describeTrackingTrip(row, detail, timezone, now);
  // A failed read shows its error even when an earlier read left data behind.
  const quote: AskedQuote = asked.isError
    ? { kind: "failed", message: readErrorMessage(asked.error) }
    : asked.data !== undefined
      ? {
          kind: "ready",
          mark: <SignalMark signal={asked.data} plugins={plugins} size={13} />,
          who: asked.data.asker ?? nameSignalSource(asked.data, plugins, raisers),
          kindAndPlace: describeSignalKindAndPlace(asked.data),
          text: buildQuoteText(asked.data),
        }
      : { kind: "loading" };

  const waitsOn = row.state === "needs-you" ? row.waitsOn : undefined;
  return (
    <div className="tr-trip">
      <AskedMessage
        avatar={<UserAvatar name={username} size={28} />}
        small={trip.askedSmall}
        quote={quote}
      />
      <AgentMessage
        face={<Face look={look} pose={decideTrackingRowPose(row)} size={28} />}
        name={row.run.workflowName}
        hue={buildHueStyle(look.hue)}
        stamp={trip.stamp}
      >
        {trip.failureCause !== undefined && <FailureReason cause={trip.failureCause} />}
        {trip.output !== undefined && (
          <StepOutput
            output={trip.output}
            onOpenRun={() => {
              openRun(trip.outputRunId);
            }}
            onOpenThread={openThread}
          />
        )}
        {trip.runs.length > 0 && (
          <RunList lines={trip.runs} onOpenRun={openRun} onOpenThread={openThread} />
        )}
        {trip.endingActionStepName !== undefined && (
          <EndedOnAction stepName={trip.endingActionStepName} />
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
