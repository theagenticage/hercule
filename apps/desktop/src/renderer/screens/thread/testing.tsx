/**
 * Test helpers for the parts of the thread screen: the header, the composer,
 * the dock and the queued inputs.
 *
 * A part is rendered alone, so its test does not depend on the rest of the
 * screen. It still runs against the real client and the stubbed controller of
 * `app/testing`, whose cleanup runs after each test.
 */
import type { JSX } from "react";
import { render } from "@testing-library/react";
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
import {
  projectsQuery,
  providersQuery,
  queuedInputsQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import {
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
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
}

/**
 * Renders `Part` for the thread in `thread`, as the thread screen will, and
 * returns the requests the app sends the stubbed controller, with the app's
 * query cache and pending submissions.
 *
 * The controller holds the sidebar fixture's records, with `thread.session`
 * in place of the fixture's thread of the same id, and answers the thread's
 * own reads from `thread`. `handlers` add or replace answers, such as the
 * answer to `session.respond`.
 *
 * The router has the app's `_connected` route id, so the part finds the
 * controller in its route context, and the app's paths `/` and
 * `/threads/$sessionId`, so the part's links resolve. It starts at the
 * thread, whose loader reads everything the thread screen's loaders read.
 * So, as in the app, nothing waits once this returns.
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
  const { bridge } = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const { controller, queryClient } = await buildRouterContext(bridge);
  if (controller === null) throw new Error("The fake bridge must hold a controller URL.");
  const { client } = controller;

  const rootRoute = createRootRoute({ component: Outlet });
  const connectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_connected",
    beforeLoad: () => ({ controller }),
  });
  const threadRoute = createRoute({
    getParentRoute: () => connectedRoute,
    path: "threads/$sessionId",
    loader: () =>
      Promise.all([
        queryClient.ensureQueryData(threadsQuery(client)),
        queryClient.ensureQueryData(projectsQuery(client)),
        queryClient.ensureQueryData(workspacesQuery(client)),
        queryClient.ensureQueryData(resourcesQuery(client)),
        queryClient.ensureQueryData(runnersQuery(client)),
        queryClient.ensureQueryData(providersQuery(client)),
        queryClient.ensureQueryData(sessionQuery(client, sessionId)),
        queryClient.ensureQueryData(queuedInputsQuery(client, sessionId)),
      ]),
    component: () => <Part sessionId={sessionId} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      connectedRoute.addChildren([
        createRoute({ getParentRoute: () => connectedRoute, path: "/" }),
        threadRoute,
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/threads/${sessionId}`] }),
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return { calls, queryClient, pendingSubmissions: controller.pendingSubmissions };
};
