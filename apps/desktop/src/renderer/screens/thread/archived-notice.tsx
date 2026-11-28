import type { JSX, Ref } from "react";
import { Link } from "@tanstack/react-router";
import type { Session } from "@hercule/contract";
import "../subagents/status-card.css";

/**
 * Renders the line that takes the composer's place on the page of an archived
 * Thread, which takes no input and can never be resumed: it says so, and its
 * New thread button opens a Draft Thread in the same project. It does not
 * join the Thread's workspace: archiving was final, and the workspace is on
 * its way to removal, so a new Thread must not keep it alive.
 *
 * It is drawn as the subagent's status card is, a card in the composer's
 * frame, so it sits exactly where the composer sits and the transcript clears
 * it the same way. `ref` receives the frame's element, which the transcript
 * measures to size its bottom padding.
 */
export function ArchivedNotice({
  session,
  ref,
}: {
  readonly session: Session;
  readonly ref: Ref<HTMLDivElement>;
}): JSX.Element {
  return (
    <div className="composer-wrap">
      <div className="composer" ref={ref}>
        <div className="composer-card status-card">
          <span className="status-card-text">
            <span>This thread is archived. Start a new thread to carry on.</span>
          </span>
          <Link to="/" search={{ project: session.projectId ?? undefined }} className="btn btn--sm">
            New thread
          </Link>
        </div>
      </div>
    </div>
  );
}
