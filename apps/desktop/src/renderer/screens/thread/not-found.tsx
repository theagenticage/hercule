import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import "./not-found.css";

/**
 * Renders the screen a thread's route shows when its thread does not exist,
 * such as a thread deleted since the link to it was made. It fills the main
 * pane, beside the sidebar, and offers a link to the new-thread screen.
 *
 * The thread the app reopens at launch never shows this screen: when that
 * thread is gone, the app opens the new-thread screen instead (see
 * `app/last-thread.ts`).
 */
export function ThreadNotFound(): JSX.Element {
  return (
    <div className="thread-not-found">
      <h1 className="thread-not-found-headline">This thread was not found.</h1>
      <Link to="/" className="btn btn--accent thread-not-found-link">
        Start a new thread
      </Link>
    </div>
  );
}
