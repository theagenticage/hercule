import type { JSX } from "react";
import type {
  MachineActivityEntry,
  MachineActivityMember,
} from "@hercule/client-core/machine-activity";
import { SessionName } from "../actor/actor-mark";
import { MachineActivityBy, useRunWorkflowName } from "./machine-activity-names";
import "./machine-activity.css";

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
 * - An entry that folded several log entries has a "Show 12" button, "Hide"
 *   while it is unfolded. Pressing it calls `onToggle`. The caller draws the
 *   members under the line, as `MachineActivityMemberRow`s.
 * - An entry of one log entry about a session names that session after the
 *   sentence.
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
  const isFolded = entry.members.length > 1;
  const sessionId = isFolded ? undefined : entry.members[0]?.sessionId;
  return (
    <div className={buildRowClass(entry, joinsAbove, isOpen)}>
      <time className="machine-activity-time">
        {dayHeading === undefined ? "" : `${dayHeading}, `}
        {entry.time}
      </time>
      <i className="machine-activity-dot" aria-hidden="true" />
      <span className="machine-activity-text">
        <span className="machine-activity-sentence" title={sentence}>
          {sentence}
        </span>
        <MachineActivityBy actor={entry.actor} />
        {sessionId === undefined ? null : (
          <span className="machine-activity-about">
            {"· "}
            <SessionName sessionId={sessionId} />
          </span>
        )}
        {isFolded ? (
          <button
            type="button"
            className="machine-activity-more"
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            {isOpen ? "Hide" : `Show ${String(entry.members.length)}`}
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Renders one log entry inside an unfolded entry: its time, what it was, and
 * the session it is about, when there is one. Its text is cut with an
 * ellipsis, like the entry's.
 */
export function MachineActivityMemberRow({
  member,
}: {
  readonly member: MachineActivityMember;
}): JSX.Element {
  return (
    <div className="machine-activity-member">
      <time className="machine-activity-time">{member.time}</time>
      <span className="machine-activity-member-text">
        {member.line}
        {member.sessionId === undefined ? null : (
          <>
            {" · "}
            <SessionName sessionId={member.sessionId} />
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
