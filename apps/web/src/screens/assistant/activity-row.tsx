import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ConversationActivity } from "@hercule/client-core";
import { DecisionMark, WorkingMark } from "@hercule/ui";
import { ShowWork } from "./conversation-message-view";

/**
 * The row under the conversation's last message, while the assistant is
 * busy:
 *
 * - "<name> is working…" beside the working mark, in the live hue, while a
 *   turn runs, with a "Show work" link to the session doing the work;
 * - "<name> needs your approval" while the session waits on a permission
 *   request. The request is answered on the session, so the row links there
 *   instead of repeating the permission card here.
 *
 * Nothing renders when the assistant is quiet.
 */
export function ActivityRow({
  activity,
  name,
}: {
  readonly activity: ConversationActivity;
  readonly name: string;
}): JSX.Element | null {
  switch (activity.kind) {
    case "working":
      return (
        <div className="flex items-baseline gap-x-2 text-meta">
          <span className="flex items-center gap-2 self-center text-live">
            <WorkingMark />
            {name} is working…
          </span>
          <ShowWork sessionId={activity.sessionId} />
        </div>
      );
    case "awaiting-approval":
      return (
        // Underlined like the other links inside text (the actor links), so
        // it reads as a way to the permission request, not as a status.
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: activity.sessionId }}
          className="flex items-center gap-2 self-start rounded-control text-meta text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
        >
          <DecisionMark />
          <span className="underline decoration-line underline-offset-[3px]">
            {name} needs your approval
          </span>
        </Link>
      );
    case "quiet":
      return null;
  }
}
