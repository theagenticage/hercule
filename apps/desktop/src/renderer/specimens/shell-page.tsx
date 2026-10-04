/**
 * Draws the app's real shell and sidebar from a fixture's records, for the
 * specimens that show the shell:
 *
 * - sidebar.tsx, whose sidebar `pnpm compare:bureau` compares with the
 *   Bureau book's;
 * - sidebar-states.tsx, which draws the sidebar states the book never draws;
 * - thread.tsx, which also opens a thread, and whose thread screen
 *   `pnpm compare:bureau` compares with the book's;
 * - draft.tsx, which opens a Draft Thread in a project, and whose draft
 *   screen `pnpm compare:bureau` compares with the book's.
 *
 * The page builds a router whose routes have the app's route ids, so the
 * sidebar and the screens find the controller in their route context, and
 * the sidebar marks the open thread or draft as it does in the app. It does
 * not mount the app's own route tree, because the app's routes talk to the
 * controller even when the cache holds everything they read: the new-thread
 * route reads the settings and the profiles again each time it opens, and
 * the shell's route starts the live connection. The
 * query cache holds every record the page reads before the first render. The
 * client refuses every request, the bridge refuses every call, and no live
 * connection runs, so the page never talks to a controller or to main.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * A page that shows ages must import ./fixed-clock before this module,
 * because the app's age clock reads the time as soon as its module loads.
 */
import "../styles/base-layer.css";
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
  useSearch,
} from "@tanstack/react-router";
import type {
  Connection,
  Input,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  SignedInUser,
  Task,
  TranscriptRow,
  Workspace,
} from "@hercule/contract";
import {
  createClient,
  type FetchLike,
  type HerculeClient,
  type ThreadPicks,
} from "@hercule/client-core";
import type { Bridge } from "../../ipc/bridge";
import {
  connectionsQuery,
  localRunnerQuery,
  profilesQuery,
  projectsQuery,
  providersQuery,
  queuedInputsQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  settingsQuery,
  startTasksQuery,
  threadsQuery,
  transcriptQuery,
  userQuery,
  workspacesQuery,
} from "../app/queries";
import {
  buildDraftKey,
  createPendingSubmissions,
  type PendingSubmissions,
} from "../app/pending-submissions";
import { createQueryClient } from "../app/query-client";
import { DraftScreen } from "../screens/new-thread/draft-screen";
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

/** What the draft screen reads of a Draft Thread in a project that joins no workspace. */
export interface DraftScreenRecords {
  readonly projectId: string;
  /** The project's open tasks the start cards offer, most urgent first, as the start cards' query returns them. */
  readonly startTasks: ReadonlyArray<Task>;
  /** The Connections, which decide the line under the starters that show when there is no open task. */
  readonly connections: ReadonlyArray<Connection>;
  /** What the user picked in the draft's composer, which the draft's pending submission holds. */
  readonly picks: ThreadPicks;
}

/** The screens a shell specimen opens beside the sidebar. It opens at most one of them. */
interface OpenScreens {
  readonly thread?: ThreadScreenRecords;
  readonly draft?: DraftScreenRecords;
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

/** Returns an error for a bridge call the page made, naming `call`. */
const buildBridgeCallError = (call: string): Error =>
  new Error(
    `The shell specimen refuses ${call}, because the page reads everything from the ` +
      "specimen's query cache. Add the record the page needs there.",
  );

/**
 * The bridge the page passes to the app. It refuses every call, for the same
 * reason the client refuses every request, except what the shell sends main
 * for the Go menu, the dock badge and the notifications: it accepts that,
 * and ignores it. It sends no menu command and opens no thread.
 */
const REFUSING_BRIDGE: Bridge = {
  controllerUrl: {
    read: () => Promise.reject(buildBridgeCallError("controllerUrl.read")),
    save: () => Promise.reject(buildBridgeCallError("controllerUrl.save")),
  },
  token: {
    read: () => Promise.reject(buildBridgeCallError("token.read")),
    write: () => Promise.reject(buildBridgeCallError("token.write")),
  },
  runnerIdentity: {
    read: () => Promise.reject(buildBridgeCallError("runnerIdentity.read")),
  },
  firstScreen: {
    report: () => Promise.reject(buildBridgeCallError("firstScreen.report")),
  },
  goMenu: {
    set: () => Promise.resolve(undefined),
  },
  waitingThreads: {
    set: () => Promise.resolve(undefined),
  },
  localController: {
    find: () => Promise.reject(buildBridgeCallError("localController.find")),
    start: () => Promise.reject(buildBridgeCallError("localController.start")),
  },
  logsFolder: {
    show: () => Promise.reject(buildBridgeCallError("logsFolder.show")),
  },
  setupToken: {
    read: () => Promise.reject(buildBridgeCallError("setupToken.read")),
  },
  macUser: {
    read: () => Promise.reject(buildBridgeCallError("macUser.read")),
  },
  folder: {
    pick: () => Promise.reject(buildBridgeCallError("folder.pick")),
  },
  firstRunProgress: {
    read: () => Promise.reject(buildBridgeCallError("firstRunProgress.read")),
    save: () => Promise.reject(buildBridgeCallError("firstRunProgress.save")),
  },
  link: {
    open: () => Promise.reject(buildBridgeCallError("link.open")),
  },
  menu: {
    onCommand: () => () => undefined,
  },
  thread: {
    onOpen: () => () => undefined,
  },
};

/**
 * Stores every list of `records` in the query cache, and the records of each
 * screen in `screens`, each under the key the page reads it by.
 *
 * At `/` the app shows a Draft Thread, which the sidebar draws as a row, so
 * the cache also holds what the draft is built from: no setting set, no
 * profile, and no runner on this Mac.
 */
const seedQueryCache = (
  queryClient: QueryClient,
  client: HerculeClient,
  records: SidebarRecords,
  { thread, draft }: OpenScreens,
): void => {
  queryClient.setQueryData(threadsQuery(client).queryKey, records.threads);
  queryClient.setQueryData(projectsQuery(client).queryKey, records.projects);
  queryClient.setQueryData(workspacesQuery(client).queryKey, records.workspaces);
  queryClient.setQueryData(resourcesQuery(client).queryKey, records.resources);
  queryClient.setQueryData(runnersQuery(client).queryKey, records.runners);
  queryClient.setQueryData(providersQuery(client).queryKey, records.instances);
  queryClient.setQueryData(userQuery(client).queryKey, records.user);
  queryClient.setQueryData(settingsQuery(client).queryKey, { controller: {}, user: {} });
  queryClient.setQueryData(profilesQuery(client).queryKey, []);
  queryClient.setQueryData(localRunnerQuery(REFUSING_BRIDGE, records.runners).queryKey, null);
  if (draft !== undefined) {
    queryClient.setQueryData(startTasksQuery(client, draft.projectId).queryKey, draft.startTasks);
    queryClient.setQueryData(connectionsQuery(client).queryKey, draft.connections);
  }
  if (thread !== undefined) {
    const sessionId = thread.session.id;
    queryClient.setQueryData(sessionQuery(client, sessionId).queryKey, thread.session);
    queryClient.setQueryData(transcriptQuery(client, sessionId).queryKey, thread.transcript);
    queryClient.setQueryData(queuedInputsQuery(client, sessionId).queryKey, thread.queuedInputs);
  }
};

/**
 * Renders the shell around the matched screen, as the app's `_shell` layout
 * route does. New thread does nothing: the page has no project picker.
 */
function ShellLayout(): JSX.Element {
  return (
    <Shell onNewThread={() => undefined}>
      <Outlet />
    </Shell>
  );
}

/**
 * Renders the Draft Thread in the project and the workspace that the address
 * names, as the app's new-thread route does.
 */
function NewThreadScreen(): JSX.Element {
  const search = useSearch({ from: "/_connected/_shell/" });
  return <DraftScreen projectId={search.project ?? null} workspaceId={search.workspace ?? null} />;
}

/**
 * Builds the router: the root, the `_connected` and `_shell` layout routes,
 * and the two screens the sidebar links to, `/` and `/threads/$sessionId`,
 * starting at `path`. The ids are the app's, because the sidebar and the
 * screens read their context, and the sidebar its selected thread or draft,
 * by route id.
 *
 * `/` draws the draft screen, as in the app. The thread's screen draws the
 * thread screen for `openThreadId`, when one is given, and nothing
 * otherwise.
 */
const buildRouter = (
  client: HerculeClient,
  pendingSubmissions: PendingSubmissions,
  path: string,
  openThreadId: string | undefined,
) => {
  const rootRoute = createRootRoute();
  const connectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_connected",
    // `live` is null: the sidebar never touches the live connection.
    beforeLoad: () => ({
      bridge: REFUSING_BRIDGE,
      controller: {
        url: CONTROLLER_URL,
        client,
        live: null,
        pendingSubmissions,
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
        createRoute({ getParentRoute: () => shellRoute, path: "/", component: NewThreadScreen }),
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
 * Waits until the page holds an element that matches `selector`, checking
 * once a frame. Returns when it does, or after five seconds when it never
 * does, and leaves the failure to the check that follows.
 */
const waitForElement = async (selector: string): Promise<void> => {
  const deadline = performance.now() + 5000;
  while (document.querySelector(selector) === null && performance.now() < deadline) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

/**
 * Checks that the page drew the sidebar's thread rows, the transcript when
 * `screens` opens a thread, and the start cards with the focus in the message
 * field when it opens a draft, and started no read. Fails with the keys of the
 * reads it started, or with what it did not draw, otherwise.
 */
const assertShellDrawn = (queryClient: QueryClient, screens: OpenScreens): void => {
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
  if (screens.thread !== undefined && document.querySelector(".tx-item") === null) {
    throw new Error("The thread screen drew no block. Check the page's console for the error.");
  }
  if (screens.draft !== undefined) {
    if (document.querySelector(".start") === null) {
      throw new Error(
        "The draft screen drew no start card and no starter. Check the page's console for the error.",
      );
    }
    // The app's draft screen puts the focus in its message field as it opens,
    // and the book's draft does the same. The capture window is hidden and
    // never has the system's focus, so neither page draws the caret, and the
    // pixels cannot show whether the field has the focus. This check does.
    if (!(document.activeElement?.matches(".composer-input") ?? false)) {
      throw new Error(
        "The draft screen's message field does not have the focus, as it has in the app.",
      );
    }
  }
};

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with the app's address at `path`, and the records of each screen in
 * `screens`. A draft's picks are written to its pending submission before
 * the first render, as if the user had made them. Returns once the page is
 * in the document. Fails when the page has no `#root`, draws nothing, or
 * tries to read a record the cache does not hold.
 */
async function mountShellSpecimen(
  records: SidebarRecords,
  path: string,
  screens: OpenScreens,
): Promise<void> {
  applySheetTheme();
  const client = createClient({ baseUrl: CONTROLLER_URL, fetch: refuseRequest });
  const queryClient = createQueryClient();
  seedQueryCache(queryClient, client, records, screens);
  const pendingSubmissions = createPendingSubmissions();
  if (screens.draft !== undefined) {
    pendingSubmissions.writePicks(
      buildDraftKey(screens.draft.projectId, null),
      screens.draft.picks,
    );
  }
  const router = buildRouter(client, pendingSubmissions, path, screens.thread?.session.id);
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
  // The starters, which a draft shows in a project with no open task, load
  // the first time they show, so they arrive after the first render.
  if (screens.draft !== undefined) await waitForElement(".start");
  assertShellDrawn(queryClient, screens);
}

/**
 * Applies the URL's theme and draws the shell into `#root`, from `records`,
 * with the app's address at `path`: `/threads/<id>` to select a thread in the
 * sidebar, where the screen stays empty, or `/` for a Draft Thread in no
 * project, which the sidebar draws as a row and the screen as the app does.
 * Returns once the sidebar is in the document. Fails when the page has no
 * `#root`, the sidebar draws no row, or it tries to read a record the cache
 * does not hold.
 */
export async function mountSidebarSpecimen(records: SidebarRecords, path: string): Promise<void> {
  await mountShellSpecimen(records, path, {});
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
  await mountShellSpecimen(records, `/threads/${thread.session.id}`, { thread });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with the Draft Thread of `draft` open: the sidebar draws it as a row, and
 * the main pane shows the app's real draft screen, with `draft`'s picks made
 * and its project's start cards, or the starters when `draft` has no open
 * task, and the focus in the message field, as the app puts it there.
 * Returns once the cards are in the document. Fails when the page has no
 * `#root`, draws no sidebar row or no card, leaves
 * the message field without the focus, or tries to read a record the cache
 * does not hold.
 */
export async function mountDraftSpecimen(
  records: SidebarRecords,
  draft: DraftScreenRecords,
): Promise<void> {
  await mountShellSpecimen(records, `/?project=${draft.projectId}`, { draft });
}
