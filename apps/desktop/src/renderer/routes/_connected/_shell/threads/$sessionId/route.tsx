import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { isNotFound } from "@hercule/client-core";
import {
  clearLastThread,
  forgetLastThread,
  isReopenedAtLaunch,
  rememberLastThread,
} from "../../../../../app/last-thread";
import { useLiveInvalidation } from "../../../../../app/live";
import { ensureThreadData, sessionQuery } from "../../../../../app/queries";
import { ThreadDraftsProvider } from "../../../../../app/thread-drafts";
import { ThreadNotFound } from "../../../../../screens/thread/not-found";

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
 * - shows `ThreadNotFound` when the user opened the thread;
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
 * renders the open agent's page with the thread's Request drafts, so what
 * the user typed on a Request and has not sent survives a move between the
 * thread's pages.
 *
 * The `subagent` topic is subscribed only here, while a thread is open,
 * because only a thread's pages show subagents (spec 17 §What subagents
 * cost). The shell already holds the `session` topic.
 */
function ThreadLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  const { sessionId } = Route.useParams();
  const { openRequests } = useSuspenseQuery(sessionQuery(controller.client, sessionId)).data;
  useLiveInvalidation(controller.live, queryClient, "subagent");

  // The side pane's mount point: the Subagents surface is drawn beside the
  // open page from here, loaded lazily, so its code stays out of the first
  // screen's chunk. Nothing is drawn here yet.
  return (
    // Keyed by the session, so one thread's drafts never show on another:
    // the router keeps this layout when only the session id changes.
    <ThreadDraftsProvider key={sessionId} openRequests={openRequests}>
      <Outlet />
    </ThreadDraftsProvider>
  );
}
