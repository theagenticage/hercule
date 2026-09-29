/**
 * Draws the app's real shell and sidebar from a fixture's records, for the
 * sidebar specimens: sidebar.tsx, which `pnpm compare:bureau` compares with
 * the Bureau book, and sidebar-states.tsx, which draws the states the book
 * never draws.
 *
 * The page builds a router whose routes have the app's route ids, so the
 * sidebar finds the controller in its route context and marks the selected
 * thread as it does in the app. The query cache holds every record the
 * sidebar reads before the first render. The client refuses every request,
 * and no live connection runs, so the page never talks to a controller.
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
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  SignedInUser,
  Workspace,
} from "@hercule/contract";
import { createClient, type FetchLike, type HerculeClient } from "@hercule/client-core";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  threadsQuery,
  userQuery,
  workspacesQuery,
} from "../app/queries";
import { createQueryClient } from "../app/query-client";
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

/** An address that never answers. The client sends nothing to it. */
const CONTROLLER_URL = "http://controller.invalid";

/**
 * Fails every request. The query cache already holds every record the
 * sidebar reads, so a request means the sidebar read something the fixture
 * does not hold.
 */
const refuseRequest: FetchLike = (url) =>
  Promise.reject(
    new Error(
      `The sidebar specimen sends no request, but the sidebar asked for ${url}. ` +
        "Add the record it reads to the specimen's fixture.",
    ),
  );

/** Stores every list of `records` in the query cache, under the key the sidebar reads it by. */
const seedQueryCache = (
  queryClient: QueryClient,
  client: HerculeClient,
  records: SidebarRecords,
): void => {
  queryClient.setQueryData(threadsQuery(client).queryKey, records.threads);
  queryClient.setQueryData(projectsQuery(client).queryKey, records.projects);
  queryClient.setQueryData(workspacesQuery(client).queryKey, records.workspaces);
  queryClient.setQueryData(resourcesQuery(client).queryKey, records.resources);
  queryClient.setQueryData(runnersQuery(client).queryKey, records.runners);
  queryClient.setQueryData(providersQuery(client).queryKey, records.instances);
  queryClient.setQueryData(userQuery(client).queryKey, records.user);
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
 * starting at `path`. The ids are the app's, because the sidebar reads its
 * context and its selected thread by route id. The screens draw nothing.
 */
const buildRouter = (client: HerculeClient, path: string) => {
  const rootRoute = createRootRoute();
  const connectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_connected",
    // `live` is null: the sidebar never touches the live connection.
    beforeLoad: () => ({ controller: { url: CONTROLLER_URL, client, live: null } }),
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
        createRoute({ getParentRoute: () => shellRoute, path: "threads/$sessionId" }),
      ]),
    ]),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
};

/**
 * Checks that the sidebar drew its thread rows and started no read. Fails
 * with the keys of the reads it started otherwise.
 */
const assertSidebarDrawn = (queryClient: QueryClient): void => {
  const reads = queryClient.getQueryCache().findAll({ fetchStatus: "fetching" });
  if (reads.length > 0) {
    throw new Error(
      `The sidebar read ${reads.map((query) => JSON.stringify(query.queryKey)).join(", ")} ` +
        "again. The specimen's query cache must hold every record it reads.",
    );
  }
  if (document.querySelector(".side-row") === null) {
    throw new Error("The sidebar drew no thread row. Check the page's console for the error.");
  }
};

/**
 * Applies the URL's theme and draws the shell into `#root`, from `records`,
 * with the app's address at `path`: `/threads/<id>` to open a thread, which
 * the sidebar then shows selected, or `/` for none. Returns once the sidebar
 * is in the document. Fails when the page has no `#root`, the sidebar draws
 * no row, or it tries to read a record the cache does not hold.
 */
export async function mountSidebarSpecimen(records: SidebarRecords, path: string): Promise<void> {
  applySheetTheme();
  const client = createClient({ baseUrl: CONTROLLER_URL, fetch: refuseRequest });
  const queryClient = createQueryClient();
  seedQueryCache(queryClient, client, records);
  const router = buildRouter(client, path);
  await router.load();

  const root = document.getElementById("root");
  if (root === null) throw new Error("The sidebar specimen's page is missing #root.");
  flushSync(() => {
    createRoot(root).render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  assertSidebarDrawn(queryClient);
}
