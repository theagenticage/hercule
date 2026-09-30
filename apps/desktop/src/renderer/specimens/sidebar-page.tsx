/**
 * Draws the app's real shell and sidebar from a fixture's records, for the
 * specimens that show the shell:
 *
 * - sidebar.tsx, whose sidebar `pnpm compare:bureau` compares with the
 *   Bureau book's;
 * - sidebar-states.tsx, which draws the sidebar states the book never draws;
 * - thread.tsx, which also opens a thread, and whose thread screen
 *   `pnpm compare:bureau` compares with the book's.
 *
 * The page builds a router whose routes have the app's route ids, so the
 * sidebar and the thread screen find the controller in their route context,
 * and the sidebar marks the open thread as it does in the app. The query
 * cache holds every record the page reads before the first render. The
 * client refuses every request, and no live connection runs, so the page
 * never talks to a controller.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * A page that shows ages must import ./fixed-clock before this module,
 * because the app's age clock reads the time as soon as its module loads.
 */
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/controls.css";
import type { JSX } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  Input,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  SignedInUser,
  TranscriptRow,
  Workspace,
} from "@hercule/contract";
import { createClient, type FetchLike, type HerculeClient } from "@hercule/client-core";
import {
  projectsQuery,
  providersQuery,
  queuedInputsQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  transcriptQuery,
  userQuery,
  workspacesQuery,
} from "../app/queries";
import { createPendingSubmissions } from "../app/pending-submissions";
import { createQueryClient } from "../app/query-client";
import { ThreadScreen } from "../screens/thread/thread-screen";
import { Shell } from "../shell";
import { applySheetTheme } from "./sheet-page";

/** Every list the sidebar reads, as the controller would return it. */
export interface SidebarRecords {
  readonly threads: ReadonlyArray<Session>;
  readonly projects: ReadonlyArray<Project>;
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly resources: ReadonlyArray<Resource>;
  readonly runners: ReadonlyArray<Runner>;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly user: SignedInUser;
}

/** What the thread screen reads of the one thread it shows, as the thread route's loader reads it. */
export interface ThreadScreenRecords {
  readonly session: Session;
  /** The transcript's rows, in position order. */
  readonly transcript: ReadonlyArray<TranscriptRow>;
  /** The inputs still queued for the thread, oldest first. */
  readonly queuedInputs: ReadonlyArray<Input>;
}

/** An address that never answers. The client sends nothing to it. */
const CONTROLLER_URL = "http://controller.invalid";

/**
 * Fails every request. The query cache already holds every record the page
 * reads, so a request means the page read something the fixture does not
 * hold.
 */
const refuseRequest: FetchLike = (url) =>
  Promise.reject(
    new Error(
      `The shell specimen sends no request, but the page asked for ${url}. ` +
        "Add the record it reads to the specimen's fixture.",
    ),
  );

/**
 * Stores every list of `records` in the query cache, and the records of
 * `thread` when one is given, each under the key the page reads it by.
 */
const seedQueryCache = (
  queryClient: QueryClient,
  client: HerculeClient,
  records: SidebarRecords,
  thread: ThreadScreenRecords | undefined,
): void => {
  queryClient.setQueryData(threadsQuery(client).queryKey, records.threads);
  queryClient.setQueryData(projectsQuery(client).queryKey, records.projects);
  queryClient.setQueryData(workspacesQuery(client).queryKey, records.workspaces);
  queryClient.setQueryData(resourcesQuery(client).queryKey, records.resources);
  queryClient.setQueryData(runnersQuery(client).queryKey, records.runners);
  queryClient.setQueryData(providersQuery(client).queryKey, records.instances);
  queryClient.setQueryData(userQuery(client).queryKey, records.user);
  if (thread === undefined) return;
  const sessionId = thread.session.id;
  queryClient.setQueryData(sessionQuery(client, sessionId).queryKey, thread.session);
  queryClient.setQueryData(transcriptQuery(client, sessionId).queryKey, thread.transcript);
  queryClient.setQueryData(queuedInputsQuery(client, sessionId).queryKey, thread.queuedInputs);
};

/** Renders the shell around the matched screen, as the app's `_shell` layout route does. */
function ShellLayout(): JSX.Element {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

/**
 * Builds the router: the root, the `_connected` and `_shell` layout routes,
 * and the two screens the sidebar links to, `/` and `/threads/$sessionId`,
 * starting at `path`. The ids are the app's, because the sidebar and the
 * thread screen read their context, and the sidebar its selected thread, by
 * route id.
 *
 * The thread's screen draws the thread screen for `openThreadId`, when one
 * is given; every other screen draws nothing.
 */
const buildRouter = (client: HerculeClient, path: string, openThreadId: string | undefined) => {
  const rootRoute = createRootRoute();
  const connectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_connected",
    // `live` is null: the sidebar never touches the live connection.
    beforeLoad: () => ({
      controller: {
        url: CONTROLLER_URL,
        client,
        live: null,
        pendingSubmissions: createPendingSubmissions(),
      },
    }),
  });
  const shellRoute = createRoute({
    getParentRoute: () => connectedRoute,
    id: "_shell",
    component: ShellLayout,
  });
  const routeTree = rootRoute.addChildren([
    connectedRoute.addChildren([
      shellRoute.addChildren([
        createRoute({ getParentRoute: () => shellRoute, path: "/" }),
        createRoute({
          getParentRoute: () => shellRoute,
          path: "threads/$sessionId",
          component: () =>
            openThreadId === undefined ? null : (
              <ThreadScreen key={openThreadId} sessionId={openThreadId} />
            ),
        }),
      ]),
    ]),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
};

/**
 * Checks that the page drew the sidebar's thread rows, and the transcript
 * when `drawsThread` is true, and started no read. Fails with the keys of
 * the reads it started, or with what it did not draw, otherwise.
 */
const assertShellDrawn = (queryClient: QueryClient, drawsThread: boolean): void => {
  const reads = queryClient.getQueryCache().findAll({ fetchStatus: "fetching" });
  if (reads.length > 0) {
    throw new Error(
      `The page read ${reads.map((query) => JSON.stringify(query.queryKey)).join(", ")} ` +
        "again. The specimen's query cache must hold every record it reads.",
    );
  }
  if (document.querySelector(".side-row") === null) {
    throw new Error("The sidebar drew no thread row. Check the page's console for the error.");
  }
  if (drawsThread && document.querySelector(".tx-item") === null) {
    throw new Error("The thread screen drew no block. Check the page's console for the error.");
  }
};

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with the app's address at `path`, and the thread screen of `thread` when
 * one is given. Returns once the page is in the document. Fails when the
 * page has no `#root`, draws nothing, or tries to read a record the cache
 * does not hold.
 */
async function mountShellSpecimen(
  records: SidebarRecords,
  path: string,
  thread: ThreadScreenRecords | undefined,
): Promise<void> {
  applySheetTheme();
  const client = createClient({ baseUrl: CONTROLLER_URL, fetch: refuseRequest });
  const queryClient = createQueryClient();
  seedQueryCache(queryClient, client, records, thread);
  const router = buildRouter(client, path, thread?.session.id);
  await router.load();

  const root = document.getElementById("root");
  if (root === null) throw new Error("The shell specimen's page is missing #root.");
  flushSync(() => {
    createRoot(root).render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  assertShellDrawn(queryClient, thread !== undefined);
}

/**
 * Applies the URL's theme and draws the shell into `#root`, from `records`,
 * with the app's address at `path`: `/threads/<id>` to select a thread in the
 * sidebar, or `/` for none. The thread's screen stays empty. Returns once the
 * sidebar is in the document. Fails when the page has no `#root`, the sidebar
 * draws no row, or it tries to read a record the cache does not hold.
 */
export async function mountSidebarSpecimen(records: SidebarRecords, path: string): Promise<void> {
  await mountShellSpecimen(records, path, undefined);
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with `thread` open: the sidebar shows it selected, and the main pane shows
 * the app's real thread screen. Returns once the transcript is in the
 * document. Fails when the page has no `#root`, draws no sidebar row or no
 * block, or tries to read a record the cache does not hold.
 */
export async function mountThreadSpecimen(
  records: SidebarRecords,
  thread: ThreadScreenRecords,
): Promise<void> {
  await mountShellSpecimen(records, `/threads/${thread.session.id}`, thread);
}
