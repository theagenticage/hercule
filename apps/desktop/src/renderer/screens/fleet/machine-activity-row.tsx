import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type {
  MachineActivityDetail,
  MachineActivityActor,
  MachineActivityEntry,
} from "@hercule/client-core/machine-activity";
import { runQuery } from "../../app/queries";
import { SessionMark, SessionName } from "../actor/actor-mark";
import "./machine-activity.css";

/** The size of a session's face in an entry's "by", in CSS pixels. */
const ACTOR_FACE_SIZE = 14;

/**
 * Returns the name of the workflow that run `runId` followed, or `undefined`
 * while the run is read and when it cannot be read. It never suspends and
 * never fails: an entry reads well without the name, so a run that was
 * deleted or is slow to answer leaves the entry as it is.
 */
const useRunWorkflowName = (runId: string | undefined): string | undefined => {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  // The read is switched off for an entry that has no run. Its key is never used then.
  const run = useQuery({
    ...runQuery(client, runId ?? ""),
    enabled: runId !== undefined,
  });
  const name = run.data?.plan.name;
  return name === undefined || name === "" ? undefined : name;
};

/**
 * Renders who did an entry, such as "by you": the user, a session's face and
 * its name, "by Hercule" for the controller's own acts, or the label of
 * anything else (a run, a plugin).
 */
function MachineActivityActorName({
  actor,
}: {
  readonly actor: MachineActivityActor;
}): JSX.Element {
  switch (actor.kind) {
    case "user":
      return <span className="machine-activity-by">by you</span>;
    case "system":
      return <span className="machine-activity-by">by Hercule</span>;
    case "other":
      return <span className="machine-activity-by">by {actor.label}</span>;
    case "session":
      return (
        <span className="machine-activity-by">
          by <SessionMark sessionId={actor.sessionId} size={ACTOR_FACE_SIZE} />
          <SessionName sessionId={actor.sessionId} />
        </span>
      );
  }
}

/** Returns the class of an entry's line: its category, and whether it is a problem, whether the thread joins it to the line above, and whether it is unfolded. */
const buildRowClass = (entry: MachineActivityEntry, joinsAbove: boolean, isOpen: boolean): string =>
  [
    "machine-activity-row",
    `is-${entry.category}`,
    entry.problem ? "is-problem" : "",
    joinsAbove ? "joins-above" : "",
    isOpen ? "is-open" : "",
  ]
    .filter((each) => each !== "")
    .join(" ");

/**
 * Renders one entry of a machine's activity as a line of fixed height: its
 * time, a dot, the sentence, and who did it.
 *
 * - `dayHeading`, when given, goes before the time ("Yesterday, 09:12"). The
 *   Recent section passes it for an entry that is not from today, because it
 *   lists entries without their days. The Activity page puts its entries
 *   under day headings and passes none.
 * - When every log entry folded into this one was spawned for one workflow
 *   run, the sentence ends with " for <the workflow's name>", once it is read.
 * - An entry with details has a "Show 12" button, "Hide" while it is
 *   unfolded. Pressing it calls `onToggle`. The caller draws the details
 *   under the line, as `MachineActivityDetailRow`s.
 * - An entry about a session names that session after the sentence.
 * - `joinsAbove` draws the thread that joins this entry's dot to the line
 *   above it.
 *
 * The text is cut with an ellipsis rather than wrapped, so that the list that
 * holds the line can place it without measuring it. The sentence is in the
 * line's tooltip whole.
 */
export function MachineActivityRow({
  entry,
  dayHeading,
  joinsAbove,
  isOpen,
  onToggle,
}: {
  readonly entry: MachineActivityEntry;
  readonly dayHeading: string | undefined;
  readonly joinsAbove: boolean;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const workflowName = useRunWorkflowName(entry.runId);
  const sentence =
    workflowName === undefined ? entry.sentence : `${entry.sentence} for ${workflowName}`;
  return (
    <div className={buildRowClass(entry, joinsAbove, isOpen)} data-entry-key={entry.key}>
      <time className="machine-activity-time">
        {dayHeading === undefined ? "" : `${dayHeading}, `}
        {entry.time}
      </time>
      <i className="machine-activity-dot" aria-hidden="true" />
      <span className="machine-activity-text">
        <span className="machine-activity-sentence" title={sentence}>
          {sentence}
        </span>
        <MachineActivityActorName actor={entry.actor} />
        {entry.subjectSessionId === undefined ? null : (
          <span className="machine-activity-about">
            {"· "}
            <SessionName sessionId={entry.subjectSessionId} />
          </span>
        )}
        {entry.details.length > 0 ? (
          <button
            type="button"
            className="machine-activity-more"
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            {isOpen ? "Hide" : `Show ${String(entry.details.length)}`}
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Renders one detail of an unfolded entry: what the log entry was, when it
 * has a line of its own, and the session it is about, when there is one. The
 * line alone, the session's title alone, or "line · title". It has no time of
 * its own, because every log entry folded into an entry happened in the
 * entry's minute. Its text is cut with an ellipsis, like the entry's, and is
 * in the line's tooltip whole. `isLast` is true for the last detail of the
 * entry, which has room below it before the next entry.
 */
export function MachineActivityDetailRow({
  detail,
  isLast,
}: {
  readonly detail: MachineActivityDetail;
  readonly isLast: boolean;
}): JSX.Element {
  return (
    <div className={isLast ? "machine-activity-member is-last" : "machine-activity-member"}>
      <span className="machine-activity-member-text" title={detail.line}>
        {detail.line}
        {detail.sessionId === undefined ? null : (
          <>
            {detail.line === undefined ? null : " · "}
            <SessionName sessionId={detail.sessionId} />
          </>
        )}
      </span>
    </div>
  );
}

/** Renders the heading of a day of the Activity page: "Today", "Yesterday", "Sun 1 Nov". */
export function MachineActivityDayHeading({ heading }: { readonly heading: string }): JSX.Element {
  return <h3 className="machine-activity-day">{heading}</h3>;
}
