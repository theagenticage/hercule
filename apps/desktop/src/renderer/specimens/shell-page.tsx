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
 *   screen `pnpm compare:bureau` compares with the book's;
 * - assistant-states.tsx, which draws the Assistants section and opens an
 *   assistant's page;
 * - settings-assistants.tsx, which opens Settings > Assistants, and whose
 *   main pane `pnpm compare:bureau` compares with the book's;
 * - settings-profiles.tsx, which opens Settings > Permission profiles, the
 *   list or one profile's page, and whose main pane `pnpm compare:bureau`
 *   compares with the book's.
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
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type {
  Agent,
  Assistant,
  Connection,
  ConversationMessage,
  Input,
  Profile,
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
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";
import type { Bridge } from "../../ipc/bridge";
import {
  agentsQuery,
  assistantsQuery,
  connectionsQuery,
  conversationMessagesQuery,
  currentConversationSessionQuery,
  localRunnerQuery,
  profilesQuery,
  projectsQuery,
  providersQuery,
  queuedInputsQuery,
  resourcesQuery,
  runnersQuery,
  runningTurnQuery,
  senderSessionQuery,
  sessionQuery,
  settingsQuery,
  startTasksQuery,
  subagentsQuery,
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
import { createAppearanceStore } from "../app/appearance";
import { createQueryClient } from "../app/query-client";
import { AssistantScreen } from "../screens/assistant/assistant-screen";
import { DraftScreen } from "../screens/new-thread/draft-screen";
import { AgentPage } from "../screens/thread/agent-page";
import { Route as SettingsRoute } from "../routes/_connected/_shell/settings/route";
import { Route as AppearanceSettingsRoute } from "../routes/_connected/_shell/settings/appearance";
import { Route as AssistantsSettingsRoute } from "../routes/_connected/_shell/settings/assistants/route";
import { Route as PermissionProfilesSettingsRoute } from "../routes/_connected/_shell/settings/permission-profiles/index";
import { Route as PermissionProfileSettingsRoute } from "../routes/_connected/_shell/settings/permission-profiles/$id";
import { Shell } from "../shell";
import { applySheetTheme } from "./sheet-page";

/**
 * An assistant, the current session of its main conversation, or `null`
 * before its first, and what its Conversation shows.
 */
export interface SpecimenAssistant {
  readonly assistant: Assistant;
  readonly currentSession: Session | null;
  /** The messages of its main conversation, oldest first. None when left out. */
  readonly messages?: ReadonlyArray<ConversationMessage>;
  /** The rows of the current session's running turn, oldest first. None when left out. */
  readonly runningTurn?: ReadonlyArray<TranscriptRow>;
}

/** Every list the sidebar reads, as the controller would return it. */
export interface SidebarRecords {
  readonly threads: ReadonlyArray<Session>;
  /** The assistants, in the order the controller lists them. The sidebar sorts them by name. */
  readonly assistants: ReadonlyArray<SpecimenAssistant>;
  readonly projects: ReadonlyArray<Project>;
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly resources: ReadonlyArray<Resource>;
  readonly runners: ReadonlyArray<Runner>;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly user: SignedInUser;
  /**
   * The Connections, which decide the red dot on the Connections row of the
   * Hercule face. None when left out. A screen that reads them too sets its own.
   */
  readonly connections?: ReadonlyArray<Connection>;
}

/** What the thread screen reads of the one thread it shows, as the thread route's loader reads it. */
export interface ThreadScreenRecords {
  readonly session: Session;
  /** The transcript's rows, in position order. */
  readonly transcript: ReadonlyArray<TranscriptRow>;
  /** The inputs still queued for the thread, oldest first. */
  readonly queuedInputs: ReadonlyArray<Input>;
  /**
   * The sessions of the agents that sent the thread a message or queued one,
   * each by its id, and `null` for one the user cannot read. None when left out.
   */
  readonly senders?: ReadonlyArray<{ readonly id: string; readonly session: Session | null }>;
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

/** What Settings > Assistants reads besides the sidebar's lists. */
export interface AssistantsSettingsRecords {
  /** The permission profiles the Permission profile row offers. */
  readonly profiles: ReadonlyArray<Profile>;
  /** The Connections the Settings list reads for its Connections row's dot. */
  readonly connections: ReadonlyArray<Connection>;
}

/** What Settings > Permission profiles reads besides the sidebar's lists. */
export interface PermissionProfilesSettingsRecords {
  /** Every permission profile, in the order the controller lists them. */
  readonly profiles: ReadonlyArray<Profile>;
  /** The plain agents, whose permission profiles the section shows. */
  readonly agents: ReadonlyArray<Agent>;
  /** The Connections the Settings list reads for its Connections row's dot. */
  readonly connections: ReadonlyArray<Connection>;
}

/**
 * The records Settings > Appearance reads. The section itself reads none:
 * it reads the Appearance from the bridge.
 */
export interface AppearanceSettingsRecords {
  /** The Connections the Settings list reads for its Connections row's dot. */
  readonly connections: ReadonlyArray<Connection>;
}

/** The screens a shell specimen opens beside the sidebar. It opens at most one of them. */
interface OpenScreens {
  readonly thread?: ThreadScreenRecords;
  readonly draft?: DraftScreenRecords;
  readonly assistantsSettings?: AssistantsSettingsRecords;
  readonly permissionProfilesSettings?: PermissionProfilesSettingsRecords;
  readonly appearanceSettings?: AppearanceSettingsRecords;
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
 * and ignores it. It reads the Appearance as the defaults, so the page looks
 * as it does on a Mac where the user never changed them. It sends no menu command and opens no thread or
 * assistant.
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
  waiting: {
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
  appearance: {
    read: () => DEFAULT_APPEARANCE,
    save: () => Promise.reject(buildBridgeCallError("appearance.save")),
  },
  link: {
    open: () => Promise.reject(buildBridgeCallError("link.open")),
  },
  menu: {
    onCommand: () => () => undefined,
  },
  destination: {
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
  {
    thread,
    draft,
    assistantsSettings,
    permissionProfilesSettings,
    appearanceSettings,
  }: OpenScreens,
): void => {
  queryClient.setQueryData(threadsQuery(client).queryKey, records.threads);
  queryClient.setQueryData(projectsQuery(client).queryKey, records.projects);
  queryClient.setQueryData(workspacesQuery(client).queryKey, records.workspaces);
  queryClient.setQueryData(resourcesQuery(client).queryKey, records.resources);
  queryClient.setQueryData(runnersQuery(client).queryKey, records.runners);
  queryClient.setQueryData(providersQuery(client).queryKey, records.instances);
  queryClient.setQueryData(userQuery(client).queryKey, records.user);
  queryClient.setQueryData(connectionsQuery(client).queryKey, records.connections ?? []);
  queryClient.setQueryData(
    assistantsQuery(client).queryKey,
    records.assistants.map(({ assistant }) => assistant),
  );
  for (const { assistant, currentSession, messages = [], runningTurn = [] } of records.assistants) {
    queryClient.setQueryData(
      currentConversationSessionQuery(client, assistant.mainConversationId).queryKey,
      currentSession,
    );
    // One page holds every message, newest first, as the controller returns them.
    queryClient.setQueryData(
      conversationMessagesQuery(client, assistant.mainConversationId).queryKey,
      { pages: [{ items: messages.toReversed() }], pageParams: [undefined] },
    );
    if (currentSession !== null) {
      queryClient.setQueryData(runningTurnQuery(client, currentSession.id).queryKey, runningTurn);
    }
  }
  queryClient.setQueryData(settingsQuery(client).queryKey, { controller: {}, user: {} });
  queryClient.setQueryData(profilesQuery(client).queryKey, []);
  queryClient.setQueryData(localRunnerQuery(REFUSING_BRIDGE, records.runners).queryKey, null);
  if (draft !== undefined) {
    queryClient.setQueryData(startTasksQuery(client, draft.projectId).queryKey, draft.startTasks);
    queryClient.setQueryData(connectionsQuery(client).queryKey, draft.connections);
  }
  if (assistantsSettings !== undefined) {
    queryClient.setQueryData(profilesQuery(client).queryKey, assistantsSettings.profiles);
    queryClient.setQueryData(connectionsQuery(client).queryKey, assistantsSettings.connections);
  }
  if (permissionProfilesSettings !== undefined) {
    queryClient.setQueryData(profilesQuery(client).queryKey, permissionProfilesSettings.profiles);
    queryClient.setQueryData(agentsQuery(client).queryKey, permissionProfilesSettings.agents);
    queryClient.setQueryData(
      connectionsQuery(client).queryKey,
      permissionProfilesSettings.connections,
    );
  }
  if (appearanceSettings !== undefined) {
    queryClient.setQueryData(connectionsQuery(client).queryKey, appearanceSettings.connections);
  }
  if (thread !== undefined) {
    const sessionId = thread.session.id;
    queryClient.setQueryData(sessionQuery(client, sessionId).queryKey, thread.session);
    queryClient.setQueryData(transcriptQuery(client, sessionId).queryKey, thread.transcript);
    queryClient.setQueryData(queuedInputsQuery(client, sessionId).queryKey, thread.queuedInputs);
    // The Bureau book draws a thread with no subagents.
    queryClient.setQueryData(subagentsQuery(client, sessionId).queryKey, []);
    for (const sender of thread.senders ?? []) {
      queryClient.setQueryData(senderSessionQuery(client, sender.id).queryKey, sender.session);
    }
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

/** Renders the page of the assistant the address names, as the app's assistant route does. */
function AssistantRoute(): JSX.Element {
  const { assistantId } = useParams({ from: "/_connected/_shell/assistants/$assistantId" });
  return <AssistantScreen key={assistantId} assistantId={assistantId} />;
}

/**
 * Builds the router: the root, the `_connected` and `_shell` layout routes,
 * the three screens the sidebar links to, `/`, `/threads/$sessionId` and
 * `/assistants/$assistantId`, and Settings with its Appearance, Assistants
 * and Permission profiles sections, starting at `path`. The ids are the app's, because the sidebar and the
 * screens read their context, and the sidebar its selected thread or draft,
 * by route id.
 *
 * `/` draws the draft screen, as in the app. The thread's screen draws the
 * thread screen for `openThreadId`, when one is given, and nothing
 * otherwise. An assistant's address draws the assistant's page, which shows
 * that the assistant was not found when the fixture holds no assistant with
 * the address's id.
 *
 * Settings and its sections are the app's own routes, attached
 * under this router's `_shell`, because their components read their search
 * and their context through their own `Route`. The Assistants route is
 * attached without its loader: the loader reads the permission profiles and
 * the settings again each time the section opens, and the query cache
 * already holds both. The Permission profiles routes are attached the same way.
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
      appearance: createAppearanceStore(REFUSING_BRIDGE),
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
  // `update` is typed for the options a route may change once it is built,
  // which leave out its id, its path and its parent. The router reads those
  // from the same options, and the generated route tree attaches every file
  // route to its parent this way, so the options are cast as it casts them.
  const settingsRoute = SettingsRoute.update({
    id: "/settings",
    path: "/settings",
    getParentRoute: () => shellRoute,
  } as never);
  const assistantsSettingsRoute = AssistantsSettingsRoute.update({
    id: "/assistants",
    path: "/assistants",
    getParentRoute: () => settingsRoute,
    loader: undefined,
  } as never);
  const permissionProfilesSettingsRoute = PermissionProfilesSettingsRoute.update({
    id: "/permission-profiles/",
    path: "/permission-profiles/",
    getParentRoute: () => settingsRoute,
    loader: undefined,
  } as never);
  const permissionProfileSettingsRoute = PermissionProfileSettingsRoute.update({
    id: "/permission-profiles/$id",
    path: "/permission-profiles/$id",
    getParentRoute: () => settingsRoute,
    loader: undefined,
  } as never);
  const appearanceSettingsRoute = AppearanceSettingsRoute.update({
    id: "/appearance",
    path: "/appearance",
    getParentRoute: () => settingsRoute,
  } as never);
  const routeTree = rootRoute.addChildren([
    connectedRoute.addChildren([
      shellRoute.addChildren([
        createRoute({ getParentRoute: () => shellRoute, path: "/", component: NewThreadScreen }),
        createRoute({
          getParentRoute: () => shellRoute,
          path: "threads/$sessionId",
          component: () =>
            openThreadId === undefined ? null : (
              <AgentPage key={openThreadId} sessionId={openThreadId} subagentId={undefined} />
            ),
        }),
        createRoute({
          getParentRoute: () => shellRoute,
          path: "assistants/$assistantId",
          component: AssistantRoute,
        }),
        settingsRoute.addChildren([
          appearanceSettingsRoute,
          assistantsSettingsRoute,
          permissionProfilesSettingsRoute,
          permissionProfileSettingsRoute,
        ]),
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
 * `screens` opens a thread, an assistant's settings when it opens Settings >
 * Assistants, the theme cards when it opens Settings > Appearance, and the
 * start cards with the focus in the message field when
 * it opens a draft, and started no read. Fails with the keys of the
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
  if (
    screens.assistantsSettings !== undefined &&
    document.querySelector(".assistant-record") === null
  ) {
    throw new Error(
      "Settings > Assistants drew no assistant's settings. Check the page's console for the error.",
    );
  }
  if (
    screens.permissionProfilesSettings !== undefined &&
    document.querySelector(".profile-list, .profile-record") === null
  ) {
    throw new Error(
      "Settings > Permission profiles drew no list and no profile. Check the page's console for the error.",
    );
  }
  if (screens.appearanceSettings !== undefined && document.querySelector(".themes") === null) {
    throw new Error(
      "Settings > Appearance drew no theme cards. Check the page's console for the error.",
    );
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
 * `screens`. A draft's picks, and a message in the composer of each thread in
 * `unsentThreadIds`, are written to their pending submissions before the
 * first render, as if the user had made them. Returns once the page is in the
 * document. Fails when the page has no `#root`, draws nothing, or tries to
 * read a record the cache does not hold.
 */
async function mountShellSpecimen(
  records: SidebarRecords,
  path: string,
  screens: OpenScreens,
  unsentThreadIds: readonly string[] = [],
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
  for (const sessionId of unsentThreadIds) {
    pendingSubmissions.writeText(sessionId, "Also check the alt text on the gallery page");
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
 * The composer of each thread in `unsentThreadIds` holds an unsent message.
 * Returns once the sidebar is in the document. Fails when the page has no
 * `#root`, the sidebar draws no row, or it tries to read a record the cache
 * does not hold.
 */
export async function mountSidebarSpecimen(
  records: SidebarRecords,
  path: string,
  unsentThreadIds: readonly string[] = [],
): Promise<void> {
  await mountShellSpecimen(records, path, {}, unsentThreadIds);
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

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Settings > Assistants open at `path`, such as
 * `/settings/assistants?assistant=<id>`: the main pane shows the app's real
 * Settings frame and Assistants section, which read the permission profiles
 * from `settings`. Returns once the section is in the document. Fails when
 * the page has no `#root`, draws no sidebar row or no assistant's settings,
 * or tries to read a record the cache does not hold.
 */
export async function mountAssistantsSettingsSpecimen(
  records: SidebarRecords,
  path: string,
  settings: AssistantsSettingsRecords,
): Promise<void> {
  await mountShellSpecimen(records, path, { assistantsSettings: settings });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Settings > Permission profiles open at `path`:
 * `/settings/permission-profiles` for the list, or
 * `/settings/permission-profiles/<id>` for one profile's page. The main pane
 * shows the app's real Settings frame and section, which read the profiles
 * and the agents from `settings`. Returns once the list or the profile is in
 * the document. Fails when the page has no `#root`, draws no sidebar row, no
 * list and no profile, or tries to read a record the cache does not hold.
 */
export async function mountPermissionProfilesSettingsSpecimen(
  records: SidebarRecords,
  path: string,
  settings: PermissionProfilesSettingsRecords,
): Promise<void> {
  await mountShellSpecimen(records, path, { permissionProfilesSettings: settings });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Settings > Appearance open: the main pane shows the app's real
 * Settings frame and Appearance section, with the Appearance's defaults, and
 * the Settings list reads the Connections from `settings`.
 * Returns once the theme cards are in the document. Fails when the page has
 * no `#root`, draws no sidebar row or no theme card, or tries to read a
 * record the cache does not hold.
 */
export async function mountAppearanceSettingsSpecimen(
  records: SidebarRecords,
  settings: AppearanceSettingsRecords,
): Promise<void> {
  await mountShellSpecimen(records, "/settings/appearance", { appearanceSettings: settings });
}
