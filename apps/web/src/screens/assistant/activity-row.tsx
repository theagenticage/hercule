import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { ConversationActivity } from "@hercule/client-core";
import { DecisionMark, WorkingMark, buildButtonClassName } from "@hercule/ui";

/**
 * The row under the conversation's last message, while the assistant is
 * busy:
 *
 * - "<name> is working…" beside the working mark, in the live hue, while a
 *   turn runs;
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
        <div className="flex items-center gap-2 text-meta text-live">
          <WorkingMark />
          {name} is working…
        </div>
      );
    case "awaiting-approval":
      return (
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: activity.sessionId }}
          className={buildButtonClassName("primary", "-ml-2 self-start text-meta")}
        >
          <DecisionMark />
          {name} needs your approval
        </Link>
      );
    case "quiet":
      return null;
  }
}
