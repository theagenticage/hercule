import { Suspense, lazy, type JSX } from "react";
import { Outlet, createFileRoute, notFound, redirect, useMatch } from "@tanstack/react-router";
import { isNotFound } from "@hercule/client-core";
import {
  clearLastThread,
  forgetLastThread,
  isReopenedAtLaunch,
  rememberLastThread,
} from "../../../../../app/last-thread";
import { useSubagentsLive } from "../../../../../app/live";
import { ensureThreadData } from "../../../../../app/queries";
import { useKeepRequestDrafts } from "../../../../../app/thread-drafts";
import { useSidePaneLayout } from "../../../../../screens/subagents/use-side-pane";
import { ThreadNotFound } from "../../../../../screens/thread/not-found";
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
 * page reads its own transcript on top. Each time the thread loads, it is
 * stored as the last open one, which the app opens again at launch. Leaving
 * the thread for a screen that shows no thread forgets it, so the app
 * reopens only a thread that was open at quit.
 *
 * When the thread does not exist, the loader clears the last open thread,
 * whichever it is, because the screen now shows no thread, and:
 *
 * - shows `ThreadNotFound` when the user opened the thread, with a link to
 *   the new-thread screen;
 * - goes to the new-thread screen when the app opened it at launch, because
 *   the user did not ask for it this time.
 *
 * Any other failure shows `RenderFailure`, the router's default.
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId")({
  loader: async ({ context: { controller, queryClient }, params: { sessionId }, location }) => {
    const { client, url } = controller;
    try {
      await ensureThreadData(queryClient, client, sessionId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      clearLastThread(url);
      // The router acts on a thrown `redirect` or `notFound`, which are plain
      // descriptors rather than Errors.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (isReopenedAtLaunch(location.state)) throw redirect({ to: "/", replace: true });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw notFound();
    }
    rememberLastThread(url, sessionId);
  },
  // The router calls this only when the next screen shows no thread. Going
  // to another thread keeps this route, and that thread's loader stores it.
  // Going to one of this thread's subagents keeps it too.
  onLeave: ({ context, params }) => {
    forgetLastThread(context.controller.url, params.sessionId);
  },
  component: ThreadLayout,
  notFoundComponent: ThreadNotFound,
});

/**
 * Keeps the thread's subagents current while any of its pages is open, and
 * renders the open agent's page in the main pane, with the thread's side
 * pane beside it while that is open. The page has the thread's Request
 * drafts, so what the user typed on a Request and has not sent survives a
 * move between the thread's pages.
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
