import { Suspense, lazy, type JSX } from "react";
import { Outlet, createFileRoute, useMatch } from "@tanstack/react-router";
import { isNotFound } from "@hercule/client-core";
import { throwScreenNotFound } from "../../../../../app/last-screen";
import { useSubagentsLive } from "../../../../../app/live";
import { ensureThreadData, showThreadCopy, transcriptQuery } from "../../../../../app/queries";
import { useKeepRequestDrafts } from "../../../../../app/request-drafts";
import { useThreadCopySaving } from "../../../../../app/thread-copy-saving";
import { useSidePaneLayout } from "../../../../../screens/subagents/use-side-pane";
import { ThreadNotFound } from "../../../../../screens/thread/not-found";
import { ThreadOpening } from "../../../../../screens/thread/opening";
import "../../../../../screens/subagents/side-pane-split.css";

/**
 * The side pane, loaded the first time a thread's pane opens, so its code
 * and its surfaces' code stay out of the first screen's chunk (spec 17
 * §What subagents cost).
 */
const SidePane = lazy(() =>
  import("../../../../../screens/subagents/side-pane").then((module) => ({
    default: module.SidePane,
  })),
);

/**
 * The thread: the layout around the page of each of its agents, the
 * session's own agent's page (`index.tsx`) and each subagent's page
 * (`subagents/$subagentId.tsx`). Moving between those pages keeps this
 * layout, its live subscription and the thread's Request drafts.
 *
 * Its loader reads the session, its subagents, the session's own transcript
 * and its queued inputs before any page renders, so the first frame shows
 * the transcript at its bottom and nothing on the screen waits. A subagent's
 * page reads its own transcript on top.
 *
 * When the session's own transcript is not in the query cache and the thread
 * has a saved copy on disk (`ThreadCopies`), the loader shows the copy
 * instead and waits for no read from the controller (`showThreadCopy`). The
 * reads that bring it up to date run in the background while the page
 * shows "Syncing…". A thread with no copy, or one whose transcript is
 * cached, loads as described above.
 *
 * While the loader runs, the sidebar already marks the thread. Past 150 ms,
 * the route shows `ThreadOpening` in place of the previous screen, so the
 * main pane names the same thread as the sidebar. A cached thread opens well
 * within that time and never shows it. Once shown, it goes as soon as the
 * loader ends, because holding it longer would only delay the transcript.
 *
 * When the thread does not exist, the route shows `ThreadNotFound`, with a
 * link to the new-thread screen, or goes to the new-thread screen when the
 * app opened the thread at launch (see `throwScreenNotFound`).
 *
 * Any other failure shows `RenderFailure`, the router's default.
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId")({
  loader: async ({ context: { controller, queryClient }, params: { sessionId }, location }) => {
    const { client, threadCopies } = controller;
    try {
      const isCached =
        queryClient.getQueryData(transcriptQuery(client, sessionId).queryKey) !== undefined;
      const copy = isCached ? undefined : await threadCopies.read(sessionId);
      if (copy !== undefined) {
        showThreadCopy(queryClient, client, threadCopies, copy);
        return;
      }
      await ensureThreadData(queryClient, client, sessionId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throwScreenNotFound(location);
    }
  },
  component: ThreadLayout,
  pendingComponent: ThreadPending,
  pendingMs: 150,
  pendingMinMs: 0,
  notFoundComponent: ThreadNotFound,
});

/** Renders the screen shown while the thread opens, for the thread in the route's params. */
function ThreadPending(): JSX.Element {
  const { sessionId } = Route.useParams();
  return <ThreadOpening sessionId={sessionId} />;
}

/**
 * Keeps the thread's subagents current while any of its pages is open, and
 * renders the open agent's page in the main pane, with the thread's side
 * pane beside it while that is open. The page has the thread's Request
 * drafts, so what the user typed on a Request and has not sent survives a
 * move between the thread's pages.
 *
 * It also keeps the thread's saved copy: it saves the copy when the page
 * closes and when a turn ends (see `useThreadCopySaving`).
 *
 * The `subagent` topic is subscribed here, while a thread is open, because
 * only a thread's pages show subagents (spec 17 §What subagents cost); the
 * Office's drawer subscribes it the same way while it shows a thread. The
 * shell already holds the `session` topic.
 *
 * The side pane stays as it was while the main pane moves between the
 * thread's pages, because it is drawn here and not by a page.
 */
function ThreadLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  useSubagentsLive(controller.live, queryClient, sessionId);
  useKeepRequestDrafts(sessionId);
  useThreadCopySaving(controller, queryClient, sessionId);
  const { layout } = useSidePaneLayout(sessionId);
  // The subagent whose page is open, so the side pane can mark its row.
  const subagentId = useMatch({
    from: "/_connected/_shell/threads/$sessionId/subagents/$subagentId",
    shouldThrow: false,
  })?.params.subagentId;

  return (
    // Keyed by the session, so nothing one thread's pages hold shows on
    // another: the router keeps this layout when only the session id changes.
    <div key={sessionId} className="thread-split">
      <div className="thread-split-main">
        <Outlet />
      </div>
      {layout.open ? (
        // Nothing is drawn while the pane's code loads, which happens once.
        <Suspense fallback={null}>
          <SidePane sessionId={sessionId} openSubagentId={subagentId} />
        </Suspense>
      ) : null}
    </div>
  );
}
