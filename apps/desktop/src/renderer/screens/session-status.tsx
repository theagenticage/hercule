/**
 * The parts of a session's line that show what it runs on and how it is
 * doing, drawn the same in the sidebar's unfolded groups, the thread hover
 * card, and the thread header's overflow menu.
 */
import type { JSX } from "react";
import type { ThreadRowStatus } from "@hercule/client-core";
import { AgeLabel } from "./age-label";
import { HarnessLogo } from "./thread/harness-logo";
import "./session-status.css";

/** The words a session's status slot shows for each status but `age`. */
const STATUS_WORDS: Readonly<Record<Exclude<ThreadRowStatus, "age">, string>> = {
  working: "Working",
  approval: "Approval",
  question: "Question",
  queued: "Queued",
  offline: "Offline",
};

/**
 * Renders the status slot at the end of a line that shows a session or a
 * thread, in the sidebar's rows, the hover card and the thread header's
 * menu: the status in words, such as "Working" or "Approval", or, for `age`,
 * how long ago `activityAt` was. The age's words, such as "20 minutes ago",
 * and every other status carry the id `id`, which the line's description
 * points at.
 */
export function StatusSlot({
  id,
  status,
  activityAt,
  onScreen,
}: {
  readonly id: string;
  readonly status: ThreadRowStatus;
  readonly activityAt: string;
  readonly onScreen: boolean;
}): JSX.Element {
  return status === "age" ? (
    <span className="side-end">
      <AgeLabel
        at={activityAt}
        onScreen={onScreen}
        descriptionId={id}
        as="span"
        className="side-age"
      />
    </span>
  ) : (
    <span className={`side-end side-end--${status}`} id={id}>
      {STATUS_WORDS[status]}
    </span>
  );
}

/**
 * Renders the agent of a session: its harness's mark, then the name of its
 * model, which is left out whole, never cut short, when it has no room,
 * before the session's own name is. Both sit in the faint ink of a line's
 * second part. Used in the sidebar's rows, the hover card and the thread
 * header's menu.
 */
export function AgentLabel({
  harnessId,
  model,
}: {
  readonly harnessId: string | null;
  readonly model: string;
}): JSX.Element {
  return (
    <span className="side-agent">
      {harnessId === null ? null : <HarnessLogo harnessId={harnessId} size={11} />}
      <span>{model}</span>
    </span>
  );
}
