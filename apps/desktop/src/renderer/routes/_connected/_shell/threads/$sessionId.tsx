import type { JSX } from "react";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { isNotFound } from "@hercule/client-core";
import {
  clearLastThread,
  forgetLastThread,
  isReopenedAtLaunch,
  rememberLastThread,
} from "../../../../app/last-thread";
import { ensureThreadData } from "../../../../app/queries";
import { ThreadNotFound } from "../../../../screens/thread/not-found";
import { ThreadScreen } from "../../../../screens/thread/thread-screen";

/**
 * The screen of one thread.
 *
 * Its loader reads the session, its whole transcript and its queued inputs
 * before the screen renders, so the first frame shows the transcript at its
 * bottom and nothing on the screen waits. Each time the screen loads, the
 * thread is stored as the last open one, which the app opens again at launch.
 * Leaving the thread's screen for one that shows no thread forgets it, so the
 * app reopens only a thread that was open at quit.
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
  staticData: { title: "Thread" },
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
  onLeave: ({ context, params }) => {
    forgetLastThread(context.controller.url, params.sessionId);
  },
  component: ThreadRoute,
  notFoundComponent: ThreadNotFound,
});

function ThreadRoute(): JSX.Element {
  const { sessionId } = Route.useParams();
  // Keyed by the session id, so another thread starts with fresh state: its
  // own live tail, scroll position and expanded work stretches.
  return <ThreadScreen key={sessionId} sessionId={sessionId} />;
}
