/**
 * Test helpers for the parts of the thread screen: the header, the composer,
 * the dock, the queued inputs, the menus and the paragraph being written.
 *
 * A part is rendered alone, so its test does not depend on the rest of the
 * screen. It still runs against the real client and the stubbed controller of
 * `app/testing`, whose cleanup runs after each test.
 */
import type { JSX } from "react";
import { vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { buildRouterContext } from "../../app/context";
import type { PendingSubmissions } from "../../app/pending-submissions";
import { ensureShellData, ensureThreadData } from "../../app/queries";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type FakeBridge,
  type Handler,
  type ThreadRecords,
} from "../../app/testing";

/** A part of the thread screen, drawn for the thread `sessionId`. */
export type ThreadPart = (props: { readonly sessionId: string }) => JSX.Element;

/** What `renderThreadPart` returns. */
export interface RenderedThreadPart {
  /** The requests the app sent the stubbed controller, oldest first. */
  readonly calls: readonly Call[];
  /** The app's query cache, for a test that waits until no write is running. */
  readonly queryClient: QueryClient;
  /** What each thread's composer holds and has not sent. */
  readonly pendingSubmissions: PendingSubmissions;
  /** Sends a menu command, as main does when the user picks the menu item. */
  readonly sendMenuCommand: FakeBridge["sendMenuCommand"];
}

/**
 * Renders `Part` for the thread in `thread`, as the thread screen will, and
 * returns the requests the app sends the stubbed controller, with the app's
 * query cache and pending submissions.
 *
 * The controller holds the sidebar fixture's records, with `thread.session`
 * in place of the fixture's thread of the same id, and answers the thread's
 * own reads from `thread`. `handlers` add or replace answers, such as the
 * answer to `session.respondToApprovalRequest`.
 *
 * The router has the app's `_connected` route id, so the part finds the
 * bridge and the controller in its route context, the app's paths `/` and
 * `/threads/$sessionId`, so the part's links resolve, and the app's id for
 * the thread's route under `_shell`, so a part that matches that route finds
 * it. It starts at the
 * thread, whose loader makes the reads the shell's and the thread's loaders
 * make. So, as in the app, nothing waits once this returns.
 */
export const renderThreadPart = async (
  Part: ThreadPart,
  {
    thread,
    handlers = {},
  }: { readonly thread: ThreadRecords; readonly handlers?: Readonly<Record<string, Handler>> },
): Promise<RenderedThreadPart> => {
  const sessionId = thread.session.id;
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      threads: SIDEBAR_FIXTURE.threads.map((each) =>
        each.id === sessionId ? thread.session : each,
      ),
    }),
    ...buildThreadHandlers(thread),
    ...handlers,
  });
  const { bridge, sendMenuCommand } = createFakeBridge({
    controllerUrl: CONTROLLER_URL,
    token: "bearer",
  });
  const { controller, queryClient } = await buildRouterContext(bridge);
  if (controller === null) throw new Error("The fake bridge must hold a controller URL.");
  const { client } = controller;

  const rootRoute = createRootRoute({ component: Outlet });
  const connectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_connected",
    beforeLoad: () => ({ bridge, controller }),
  });
  const shellRoute = createRoute({
    getParentRoute: () => connectedRoute,
    id: "_shell",
    component: Outlet,
  });
  const threadRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "threads/$sessionId",
    loader: () =>
      Promise.all([
        ensureShellData(queryClient, client),
        ensureThreadData(queryClient, client, sessionId),
      ]),
    component: () => <Part sessionId={sessionId} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      connectedRoute.addChildren([
        createRoute({ getParentRoute: () => connectedRoute, path: "/" }),
        shellRoute.addChildren([threadRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/threads/${sessionId}`] }),
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return {
    calls,
    queryClient,
    pendingSubmissions: controller.pendingSubmissions,
    sendMenuCommand,
  };
};

/** Returns each menu line's text and whether it is marked current, in order. */
export const readMenuLines = (): readonly (readonly [string, boolean])[] =>
  [...document.querySelectorAll(".line")].map((line) => [
    line.textContent,
    line.getAttribute("aria-current") === "true",
  ]);

/** The animation frames `holdAnimationFrames` holds. */
export interface HeldFrames {
  /** Runs every frame requested and not run yet, inside `act`, so the renders they cause are done. */
  readonly run: () => void;
  /** Returns how many frames are requested and not run yet. */
  readonly countWaiting: () => number;
  /** Returns how many frames were requested in all. */
  readonly countRequested: () => number;
}

/**
 * Replaces `requestAnimationFrame` with a stub that holds every frame until
 * the test runs it, and returns the held frames. The paragraph being written
 * is painted in a frame, so a test that holds them decides when it is
 * painted.
 */
export const holdAnimationFrames = (): HeldFrames => {
  let waiting: Array<() => void> = [];
  let requested = 0;
  vi.stubGlobal("requestAnimationFrame", (frame: () => void) => {
    waiting.push(frame);
    requested += 1;
    return requested;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    run: () => {
      act(() => {
        const due = waiting;
        waiting = [];
        for (const frame of due) frame();
      });
    },
    countWaiting: () => waiting.length,
    countRequested: () => requested,
  };
};
