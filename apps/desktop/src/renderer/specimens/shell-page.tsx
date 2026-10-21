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
 *   compares with the book's;
 * - settings-connections.tsx, which opens Settings > Connections, and whose
 *   main pane `pnpm compare:bureau` compares with the book's;
 * - intake.tsx, which opens Intake, with or without a signal's pane;
 * - workflows.tsx, which opens Workflows, and whose workflow list
 *   `pnpm compare:bureau` compares with the book's table;
 * - run.tsx, which opens a run's page, and whose main pane
 *   `pnpm compare:bureau` compares with the book's;
 * - discussions.tsx and wiki.tsx, which open Discussions and the Wiki, a
 *   list with an open Discussion or page, and whose main panes
 *   `pnpm compare:bureau` compares with the book's.
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
import { hashKey, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
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
  Event,
  EventCountsByConnection,
  EventHandling,
  EventWithFacts,
  IgnoreRuleWithCatches,
  Input,
  MemoryDocument,
  MemoryEntry,
  PluginDetail,
  Profile,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Signal,
  SignedInUser,
  SkillsPreviewFilter,
  Task,
  TrackingDetail,
  TrackingTask,
  TranscriptRow,
  Workspace,
  YourWorkTask,
} from "@hercule/contract";
import {
  createClient,
  type FetchLike,
  type HerculeClient,
  type Live,
  type ThreadPicks,
} from "@hercule/client-core";
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";
import type { Bridge } from "../../ipc/bridge";
import {
  agentsQuery,
  assistantsQuery,
  connectionsQuery,
  controllerQuery,
  conversationMessagesQuery,
  currentConversationSessionQuery,
  discussionQuery,
  discussionsQuery,
  eventQuery,
  eventsEverythingQuery,
  eventCountsQuery,
  ignoreRulesQuery,
  liveAgentSessionsQuery,
  liveRunsQuery,
  localRunnerQuery,
  memoryDocumentQuery,
  memoryIndexQuery,
  newestRunsQuery,
  pluginsQuery,
  previewSkillsQuery,
  profilesQuery,
  projectsQuery,
  providersQuery,
  queuedInputsQuery,
  rerunsQuery,
  resourcesQuery,
  runnersQuery,
  runningTurnQuery,
  runQuery,
  runSessionsQuery,
  senderSessionQuery,
  sessionQuery,
  sessionSkillsQuery,
  settingsQuery,
  signalQuery,
  signalsClearedTodayQuery,
  signalsDoneQuery,
  laterSignalsOfKindQuery,
  signalsLaterQuery,
  signalsToDoQuery,
  snoozeTimerQuery,
  startTasksQuery,
  subagentsQuery,
  threadsQuery,
  trackingDetailQuery,
  trackingQuery,
  yourWorkQuery,
  transcriptQuery,
  triggersQuery,
  userQuery,
  wikiPageQuery,
  wikiPagesQuery,
  workflowActionsQuery,
  workflowDayRunsQuery,
  workflowQuery,
  workflowRunsQuery,
  workflowsQuery,
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
import { Route as ConnectionsSettingsRoute } from "../routes/_connected/_shell/settings/connections";
import { Route as AssistantsSettingsRoute } from "../routes/_connected/_shell/settings/assistants/index";
import { Route as PermissionProfilesSettingsRoute } from "../routes/_connected/_shell/settings/permission-profiles/index";
import { Route as PermissionProfileSettingsRoute } from "../routes/_connected/_shell/settings/permission-profiles/$id";
import { Route as IntakeSettingsRoute } from "../routes/_connected/_shell/settings/intake";
import { Route as IntakeRoute } from "../routes/_connected/_shell/intake";
import { Route as WorkflowsRoute } from "../routes/_connected/_shell/workflows/route";
import { Route as OpenWorkflowRoute } from "../routes/_connected/_shell/workflows/$workflowId";
import { Route as RunRoute } from "../routes/_connected/_shell/runs/$runId";
import { Route as DiscussionsRoute } from "../routes/_connected/_shell/discussions/route";
import { Route as OpenDiscussionRoute } from "../routes/_connected/_shell/discussions/$discussionId";
import { Route as WikiRoute } from "../routes/_connected/_shell/wiki/route";
import { Route as OpenWikiPageRoute } from "../routes/_connected/_shell/wiki/$pageId";
import { Shell } from "../shell";
import { applySheetTheme } from "./sheet-page";
import type { DiscussionsRecords } from "./discussions-fixture";
import type { RunRecords } from "./run-fixture";
import type { WikiRecords } from "./wiki-fixture";
import type { WorkflowsRecords } from "./workflows-fixture";

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
  /** The signals on To do, which Intake's row and the Hercule segment count. None when left out. */
  readonly signals?: ReadonlyArray<Signal>;
  /** The signals on Later, soonest snooze first. None when left out. */
  readonly later?: ReadonlyArray<Signal>;
  /** The signals on Done, newest first, which Intake's foot counts. None when left out. */
  readonly done?: ReadonlyArray<Signal>;
  /** The installed plugins, which name each signal's source. None when left out. */
  readonly plugins?: ReadonlyArray<PluginDetail>;
  /**
   * The live sessions that are not threads. Those of a run with an open
   * Request show under "From runs" in Waiting on you, and put their
   * workflow in Needs you. None when left out.
   */
  readonly agentSessions?: ReadonlyArray<Session>;
  /**
   * What `task.queryTracking` returns: the Tasks Tracking follows, which the
   * Hercule segment's count and Intake's Tracking read. None when left out.
   */
  readonly tracking?: ReadonlyArray<TrackingTask>;
  /**
   * What `task.readTracking` returns for each Task whose pane a scene opens,
   * by the Task's id. None when left out.
   */
  readonly trackingDetails?: ReadonlyMap<string, TrackingDetail>;
  /**
   * The signals handed to the Tasks of `tracking`, as `signal.read` returns
   * them, which each Tracking pane reads under "You asked". None when left out.
   */
  readonly handedSignals?: ReadonlyArray<Signal>;
  /**
   * What `signal.queryYourWork` returns: the open Tasks that belong to a
   * signal on To do, which make a Tracking row Needs you (Your work). None
   * when left out.
   */
  readonly yourWorkTasks?: ReadonlyArray<YourWorkTask>;
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
  /**
   * The permission profiles, for the name a Permission Request's "Add to
   * profile" answer shows. None when left out. `null` stands for a read of
   * them that failed: the answer then names no profile, and the dock does not
   * read them again.
   */
  readonly profiles?: ReadonlyArray<Profile> | null;
  /**
   * Whether the thread was opened from its saved copy and the read that
   * brings its transcript up to date has not answered yet, so its header
   * says "Syncing…". False when left out.
   */
  readonly syncing?: boolean;
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
  /**
   * The filter the composer reads the draft's skills by: the runner and the
   * repos the picks open, or the empty filter when they open no repo. The
   * Bureau book draws no skill chip, so the list read by it is empty.
   */
  readonly skillsPreview: SkillsPreviewFilter;
}

/** What Settings > Assistants reads besides the sidebar's lists. */
export interface AssistantsSettingsRecords {
  /** The permission profiles the Permission profile row offers. */
  readonly profiles: ReadonlyArray<Profile>;
  /** The Connections the Settings list reads for its Connections row's dot. */
  readonly connections: ReadonlyArray<Connection>;
  /** The picked assistant's memory, which the Memory column shows: its index and its core note. */
  readonly memory: {
    readonly assistantId: string;
    readonly entries: ReadonlyArray<MemoryEntry>;
    readonly core: MemoryDocument;
  };
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

/**
 * What Intake reads besides the shell's lists, which hold To do, Later, Done
 * and the plugins: the selected signal and the event it was raised from. It
 * also says which view Intake opens on, and how the page answers a move.
 */
export interface IntakeRecords {
  /** The selected signal, as the controller reads it, or `null` when none is selected. */
  readonly signal: Signal | null;
  /** The event the selected signal was raised from, or `null` for none. */
  readonly event: Event | null;
  /** The view Intake opens on. To do when left out. */
  readonly view?: "later" | "done" | "everything";
  /** Whether Tracking is opened over the To do list. Folded when left out. */
  readonly trackingOpen?: boolean;
  /** The Task whose pane is open in opened Tracking. None when left out. */
  readonly trackingTaskId?: string;
  /**
   * What the Everything view reads: the events its one page holds, newest
   * first, under the search text, the handling filter and the source tab it
   * opens with, and the event whose pane is open. Used only when `view` is "everything".
   */
  readonly everything?: {
    readonly events: ReadonlyArray<EventWithFacts>;
    readonly text?: string;
    readonly handling?: EventHandling;
    readonly source?: string;
    readonly selectedEventId?: number;
  };
  /**
   * Answers the requests that move signals, such as `signal.markDone`, for a
   * scene that makes a move. Every other request is refused, as on every
   * page. When left out, moves are refused too.
   */
  readonly answerMove?: FetchLike;
}

/**
 * What Settings > Connections reads: the Connections, the plugins that
 * declare their types and marks, and the events each Connection received.
 */
export interface ConnectionsSettingsRecords {
  readonly connections: ReadonlyArray<Connection>;
  readonly plugins: ReadonlyArray<PluginDetail>;
  readonly counts: EventCountsByConnection;
}

/**
 * What Settings > Intake reads besides the shell's lists, which hold the
 * plugins and the Connections: the Ignore Rules, with what each caught.
 */
export interface IntakeSettingsRecords {
  readonly ignoreRules: ReadonlyArray<IgnoreRuleWithCatches>;
}

/** The screens a shell specimen opens beside the sidebar. It opens at most one of them. */
interface OpenScreens {
  readonly thread?: ThreadScreenRecords;
  readonly draft?: DraftScreenRecords;
  readonly assistantsSettings?: AssistantsSettingsRecords;
  readonly permissionProfilesSettings?: PermissionProfilesSettingsRecords;
  readonly appearanceSettings?: AppearanceSettingsRecords;
  readonly connectionsSettings?: ConnectionsSettingsRecords;
  readonly intake?: IntakeRecords;
  readonly intakeSettings?: IntakeSettingsRecords;
  readonly workflows?: WorkflowsRecords;
  readonly run?: RunScreenRecords;
  readonly discussions?: DiscussionsRecords;
  readonly wiki?: WikiRecords;
}

/**
 * The run a run's page opens, with its sessions, and the Workflows records
 * that hold its workflow, the triggers, the Agents and the workflow actions
 * the page reads besides.
 */
export interface RunScreenRecords {
  readonly records: RunRecords;
  readonly workflows: WorkflowsRecords;
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

/** Matches the address of a request that moves signals: Done, Snooze, Unsnooze or Not urgent. */
const MOVE_PATH = /\/api\/v1\/signals\/(mark-done|snooze|unsnooze|lower-priority)$/;

/** Returns an error for a bridge call the page made, naming `call`. */
const buildBridgeCallError = (call: string): Error =>
  new Error(
    `The shell specimen refuses ${call}, because the page reads everything from the ` +
      "specimen's query cache. Add the record the page needs there.",
  );

/**
 * The live connection the page passes to the app. It never connects: it
 * accepts every subscription and never pushes, so the reads stay as the
 * fixture seeded them. The Workflows page subscribes to its topics as it
 * opens, which is why the page needs one at all.
 */
const SILENT_LIVE: Live = {
  start: () => undefined,
  stop: () => Promise.resolve(),
  subscribe: () => () => undefined,
  onStatus: () => () => undefined,
  serverVersion: null,
};

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
  urgentSignals: {
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
  skillFolders: {
    pick: () => Promise.reject(buildBridgeCallError("skillFolders.pick")),
  },
  skillArchive: {
    build: () => Promise.reject(buildBridgeCallError("skillArchive.build")),
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
 * The hashes of the reads a specimen keeps running on purpose, to draw what
 * the page shows while they wait. `assertShellDrawn` does not count them as
 * reads the cache should have answered.
 */
const keptReadingHashes = new Set<string>();

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
    connectionsSettings,
    intake,
    intakeSettings,
    workflows,
    run,
    discussions,
    wiki,
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
  queryClient.setQueryData(signalsToDoQuery(client).queryKey, records.signals ?? []);
  // Each paged list fits on its one page.
  queryClient.setQueryData(signalsLaterQuery(client).queryKey, {
    pages: [{ items: records.later ?? [] }],
    pageParams: [undefined],
  });
  // The Ignore dialog, and an open offer of an Ignore Rule, look for the
  // signals a rule matches in Later of the rule's kind, read whole.
  for (const kind of new Set(
    [...(records.signals ?? []), ...(records.later ?? [])].map((signal) => signal.kind),
  )) {
    queryClient.setQueryData(
      laterSignalsOfKindQuery(client, kind).queryKey,
      (records.later ?? []).filter((signal) => signal.kind === kind),
    );
  }
  queryClient.setQueryData(signalsDoneQuery(client).queryKey, {
    pages: [{ items: records.done ?? [] }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(signalsClearedTodayQuery(client).queryKey, {
    pages: [{ items: records.done ?? [] }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(
    snoozeTimerQuery(client).queryKey,
    records.later?.[0]?.snooze?.until ?? null,
  );
  queryClient.setQueryData(pluginsQuery(client).queryKey, records.plugins ?? []);
  queryClient.setQueryData(trackingQuery(client).queryKey, {
    tasks: records.tracking ?? [],
    readStartedAt: 0,
  });
  for (const [taskId, detail] of records.trackingDetails ?? []) {
    queryClient.setQueryData(trackingDetailQuery(client, taskId).queryKey, detail);
  }
  for (const signal of records.handedSignals ?? []) {
    queryClient.setQueryData(signalQuery(client, signal.id).queryKey, signal);
  }
  queryClient.setQueryData(yourWorkQuery(client).queryKey, { tasks: records.yourWorkTasks ?? [] });
  queryClient.setQueryData(liveAgentSessionsQuery(client).queryKey, records.agentSessions ?? []);
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
    queryClient.setQueryData(previewSkillsQuery(client, draft.skillsPreview).queryKey, {
      items: [],
      skipped: [],
    });
  }
  if (assistantsSettings !== undefined) {
    queryClient.setQueryData(profilesQuery(client).queryKey, assistantsSettings.profiles);
    queryClient.setQueryData(connectionsQuery(client).queryKey, assistantsSettings.connections);
    const { assistantId, entries, core } = assistantsSettings.memory;
    queryClient.setQueryData(memoryIndexQuery(client, assistantId).queryKey, entries);
    queryClient.setQueryData(memoryDocumentQuery(client, assistantId, core.name).queryKey, core);
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
  if (connectionsSettings !== undefined) {
    queryClient.setQueryData(connectionsQuery(client).queryKey, connectionsSettings.connections);
    queryClient.setQueryData(pluginsQuery(client).queryKey, connectionsSettings.plugins);
    queryClient.setQueryData(eventCountsQuery(client).queryKey, connectionsSettings.counts);
  }
  if (intakeSettings !== undefined) {
    queryClient.setQueryData(ignoreRulesQuery(client).queryKey, intakeSettings.ignoreRules);
  }
  if (intake !== undefined) {
    // The drawings' signals come from plugins, so no workflow names any of them.
    queryClient.setQueryData(workflowsQuery(client).queryKey, []);
  }
  if (intake?.everything !== undefined) {
    const { events, text, handling, source } = intake.everything;
    queryClient.setQueryData(
      // `since` is not part of the listing's key, so any value finds it.
      eventsEverythingQuery(client, { text, handling, source }, "").queryKey,
      { pages: [{ items: events }], pageParams: [undefined] },
    );
  }
  if (intake?.signal != null) {
    queryClient.setQueryData(signalQuery(client, intake.signal.id).queryKey, intake.signal);
  }
  if (intake?.event != null) {
    queryClient.setQueryData(eventQuery(client, intake.event.id).queryKey, intake.event);
  }
  if (run !== undefined) {
    const { workflow, agents, workflowActions } = run.workflows.openWorkflow;
    const runId = run.records.run.id;
    queryClient.setQueryData(runQuery(client, runId).queryKey, run.records.run);
    queryClient.setQueryData(runSessionsQuery(client, runId).queryKey, run.records.sessions);
    queryClient.setQueryData(rerunsQuery(client, runId).queryKey, []);
    queryClient.setQueryData(workflowsQuery(client).queryKey, run.workflows.workflows);
    queryClient.setQueryData(workflowQuery(client, workflow.id).queryKey, workflow);
    const ownWorkflow = run.records.workflow;
    if (ownWorkflow !== undefined) {
      queryClient.setQueryData(workflowQuery(client, ownWorkflow.id).queryKey, ownWorkflow);
    }
    const { textGeneration } = run.records;
    if (textGeneration !== undefined) {
      queryClient.setQueryData(controllerQuery(client).queryKey, {
        id: "01a06d02-7800-7000-8000-000000000001",
        publicKey: "controller-key",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration,
      });
    }
    queryClient.setQueryData(triggersQuery(client).queryKey, run.workflows.triggers);
    queryClient.setQueryData(agentsQuery(client).queryKey, agents);
    queryClient.setQueryData(workflowActionsQuery(client).queryKey, workflowActions);
    // The book's times are UTC, and so is the specimen's clock.
    queryClient.setQueryData(settingsQuery(client).queryKey, {
      controller: {},
      user: { timezone: "UTC" },
    });
  }
  if (workflows !== undefined) {
    queryClient.setQueryData(workflowsQuery(client).queryKey, workflows.workflows);
    queryClient.setQueryData(triggersQuery(client).queryKey, workflows.triggers);
    queryClient.setQueryData(newestRunsQuery(client).queryKey, workflows.newestRuns);
    queryClient.setQueryData(liveRunsQuery(client, "running").queryKey, workflows.runningRuns);
    queryClient.setQueryData(liveRunsQuery(client, "pending").queryKey, []);
    const { workflow, runs, todayRuns, agents, workflowActions } = workflows.openWorkflow;
    queryClient.setQueryData(workflowQuery(client, workflow.id).queryKey, workflow);
    queryClient.setQueryData(workflowRunsQuery(client, workflow.id).queryKey, {
      pages: [{ items: runs }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(
      workflowDayRunsQuery(client, workflow.id, {
        start: new Date(todayRuns.activeSince),
        end: new Date(todayRuns.until),
        isToday: true,
      }).queryKey,
      todayRuns.runs,
    );
    queryClient.setQueryData(agentsQuery(client).queryKey, agents);
    queryClient.setQueryData(workflowActionsQuery(client).queryKey, workflowActions);
    // The book's times are UTC, and so is the specimen's clock.
    queryClient.setQueryData(settingsQuery(client).queryKey, {
      controller: {},
      user: { timezone: "UTC" },
    });
  }
  if (discussions !== undefined) {
    // Each paged list fits on its one page.
    queryClient.setQueryData(discussionsQuery(client).queryKey, {
      pages: [{ items: discussions.discussions }],
      pageParams: [undefined],
    });
    const { discussion } = discussions.openDiscussion;
    queryClient.setQueryData(
      discussionQuery(client, discussion.id).queryKey,
      discussions.openDiscussion,
    );
    for (const sender of discussions.senders) {
      queryClient.setQueryData(senderSessionQuery(client, sender.id).queryKey, sender);
    }
    // The book's times are UTC, and so is the specimen's clock.
    queryClient.setQueryData(settingsQuery(client).queryKey, {
      controller: {},
      user: { timezone: "UTC" },
    });
  }
  if (wiki !== undefined) {
    queryClient.setQueryData(wikiPagesQuery(client).queryKey, {
      pages: [{ items: wiki.pages }],
      pageParams: [undefined],
    });
    const { id } = wiki.openPage.page;
    queryClient.setQueryData(wikiPageQuery(client, id).queryKey, wiki.openPage);
    queryClient.setQueryData(
      wikiPageQuery(client, id, wiki.olderRevisionNumber).queryKey,
      wiki.olderRevision,
    );
    for (const sender of wiki.senders) {
      queryClient.setQueryData(senderSessionQuery(client, sender.id).queryKey, sender);
    }
    // The book's times are UTC, and so is the specimen's clock.
    queryClient.setQueryData(settingsQuery(client).queryKey, {
      controller: {},
      user: { timezone: "UTC" },
    });
  }
  if (thread !== undefined) {
    const sessionId = thread.session.id;
    queryClient.setQueryData(sessionQuery(client, sessionId).queryKey, thread.session);
    queryClient.setQueryData(transcriptQuery(client, sessionId).queryKey, thread.transcript);
    queryClient.setQueryData(queuedInputsQuery(client, sessionId).queryKey, thread.queuedInputs);
    // The Bureau book draws a thread with no subagents.
    queryClient.setQueryData(subagentsQuery(client, sessionId).queryKey, []);
    // The Bureau book draws no skill chip, so the thread has no skills.
    queryClient.setQueryData(sessionSkillsQuery(client, sessionId).queryKey, {
      items: [],
      skipped: [],
    });
    if (thread.profiles === null) {
      // A failed read keeps the list read before it, here an empty one, and
      // the dock reads the profiles again only after a read that succeeded.
      queryClient
        .getQueryCache()
        .find({ queryKey: profilesQuery(client).queryKey })
        ?.setState({
          status: "error",
          error: new Error("The permission profiles could not be read."),
        });
    } else if (thread.profiles !== undefined) {
      queryClient.setQueryData(profilesQuery(client).queryKey, thread.profiles);
    }
    if (thread.syncing === true) {
      // A read that never answers, on top of the rows just stored: the
      // marker watches the transcript's query while it reads.
      const { queryKey } = transcriptQuery(client, sessionId);
      keptReadingHashes.add(hashKey(queryKey));
      void queryClient.prefetchQuery({
        queryKey,
        queryFn: () => new Promise<never>(() => undefined),
        staleTime: 0,
      });
    }
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
 * `/assistants/$assistantId`, Intake, Workflows, and Settings with its Appearance,
 * Connections, Intake, Assistants and Permission profiles sections, starting at `path`. The ids are the app's, because the sidebar and the
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
 * already holds both. The Permission profiles routes are attached the same
 * way, and so are Settings > Intake, whose loader reads the Ignore Rules
 * again each time the section opens, and Workflows, whose loader reads the lists the cache already
 * holds, and so is Settings > Connections, whose loader reads the
 * Connections and the plugins through a query client this router's context
 * does not have, and the cache already holds both. Intake keeps a loader of
 * its own that returns the moment it opened, because the screen reads that
 * moment, and the cache already holds the records its real loader would read.
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
    // The live connection never connects, so nothing invalidates a seeded read.
    beforeLoad: () => ({
      bridge: REFUSING_BRIDGE,
      appearance: createAppearanceStore(REFUSING_BRIDGE),
      controller: {
        url: CONTROLLER_URL,
        client,
        live: SILENT_LIVE,
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
    id: "/assistants/",
    path: "/assistants/",
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
  const connectionsSettingsRoute = ConnectionsSettingsRoute.update({
    id: "/connections",
    path: "/connections",
    getParentRoute: () => settingsRoute,
    loader: undefined,
  } as never);
  const intakeSettingsRoute = IntakeSettingsRoute.update({
    id: "/intake",
    path: "/intake",
    getParentRoute: () => settingsRoute,
    loader: undefined,
  } as never);
  const intakeRoute = IntakeRoute.update({
    id: "/intake",
    path: "/intake",
    getParentRoute: () => shellRoute,
    // The real loader reads the cache again; the screen needs only the moment
    // it opened, which is the specimen's stopped clock.
    loader: () => ({ openedAt: Date.now() }),
  } as never);
  const workflowsRoute = WorkflowsRoute.update({
    id: "/workflows",
    path: "/workflows",
    getParentRoute: () => shellRoute,
    loader: undefined,
  } as never);
  const openWorkflowRoute = OpenWorkflowRoute.update({
    id: "/$workflowId",
    path: "/$workflowId",
    getParentRoute: () => workflowsRoute,
    loader: undefined,
  } as never);
  const runRoute = RunRoute.update({
    id: "/runs/$runId",
    path: "/runs/$runId",
    getParentRoute: () => shellRoute,
    loader: undefined,
  } as never);
  const discussionsRoute = DiscussionsRoute.update({
    id: "/discussions",
    path: "/discussions",
    getParentRoute: () => shellRoute,
    loader: undefined,
  } as never);
  const openDiscussionRoute = OpenDiscussionRoute.update({
    id: "/$discussionId",
    path: "/$discussionId",
    getParentRoute: () => discussionsRoute,
    loader: undefined,
  } as never);
  const wikiRoute = WikiRoute.update({
    id: "/wiki",
    path: "/wiki",
    getParentRoute: () => shellRoute,
    loader: undefined,
  } as never);
  const openWikiPageRoute = OpenWikiPageRoute.update({
    id: "/$pageId",
    path: "/$pageId",
    getParentRoute: () => wikiRoute,
    loader: undefined,
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
              <AgentPage
                key={openThreadId}
                sessionId={openThreadId}
                subagentId={undefined}
                inThreadRoute
              />
            ),
        }),
        createRoute({
          getParentRoute: () => shellRoute,
          path: "assistants/$assistantId",
          component: AssistantRoute,
        }),
        intakeRoute,
        workflowsRoute.addChildren([openWorkflowRoute]),
        discussionsRoute.addChildren([openDiscussionRoute]),
        wikiRoute.addChildren([openWikiPageRoute]),
        runRoute,
        settingsRoute.addChildren([
          appearanceSettingsRoute,
          connectionsSettingsRoute,
          intakeSettingsRoute,
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
 * Returns the selector of what Workflows draws last at `path`, the app's
 * address: the list's rows, or its empty line, at `/workflows`; and with a
 * workflow open, the Runs tab's rows or the timeline's bars, or their empty
 * line. The list and the Runs tab each draw their rows once they have
 * measured their height, after the first render, and the open workflow's
 * runs are measured after the list.
 */
const findWorkflowsDrawnSelector = (path: string): string => {
  if (!path.startsWith("/workflows/")) return ".table-row, .workflow-list-empty";
  return path.includes("runsView=timeline")
    ? ".open-pane .run-bar, .open-pane .lanes-empty"
    : ".open-pane .table-row, .open-pane .table-empty";
};

/**
 * Returns the selector of what Discussions or the Wiki draws last at `path`,
 * the app's address: the list's rows, or its empty line, unless the list is
 * hidden (`full=true`), and then the open Discussion's Posts or the open
 * page's body. The list draws its rows once it has measured its height,
 * after the first render, where the open Discussion or page draws at once.
 * `openPart` is the selector of the open one's last part.
 */
const findListDrawnSelector = (path: string, openPart: string): string =>
  path.includes("full=true") ? openPart : ".table-row, .column-row, .list-empty";

/** The part the open Discussion draws last: its Posts. */
const OPEN_DISCUSSION_PART = ".open-pane .posts";

/** The part the open wiki page draws last: its body. */
const OPEN_WIKI_PAGE_PART = ".open-pane .page-body";

/**
 * Returns the selector of what a run's page at `path` draws last: the
 * graph's nodes, or the timeline's axis ticks, which the timeline draws
 * once it has measured its axis, after the first render.
 */
const findRunDrawnSelector = (path: string): string =>
  path.includes("view=timeline") ? ".run-page .axis-tick" : ".run-page .node";

/**
 * Checks that the page drew the sidebar's thread rows, the transcript when
 * `screens` opens a thread, an assistant's settings when it opens Settings >
 * Assistants, the theme cards when it opens Settings > Appearance, a
 * Connection's row when it opens Settings > Connections, a
 * plugin's section when it opens Settings > Intake, the
 * list's rows or its empty line when it opens Intake or Workflows, a step
 * when it opens a run's page, and the start cards with the focus in the
 * message field when it opens a draft, and started no read. Fails with the keys of the
 * reads it started, or with what it did not draw, otherwise.
 */
const assertShellDrawn = (queryClient: QueryClient, screens: OpenScreens, path: string): void => {
  // A specimen may mark a read it keeps running on purpose, to draw what
  // the page shows while that read waits.
  const reads = queryClient
    .getQueryCache()
    .findAll({ fetchStatus: "fetching" })
    .filter((query) => !keptReadingHashes.has(query.queryHash));
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
  if (screens.connectionsSettings !== undefined && document.querySelector(".conn") === null) {
    throw new Error(
      "Settings > Connections drew no Connection's row. Check the page's console for the error.",
    );
  }
  if (screens.intakeSettings !== undefined && document.querySelector(".set-sec") === null) {
    throw new Error(
      "Settings > Intake drew no plugin's section. Check the page's console for the error.",
    );
  }
  if (
    screens.intake !== undefined &&
    document.querySelector(".ask-row, .asks-empty, .asks-zero, .asks-note") === null
  ) {
    throw new Error(
      "Intake drew no row and no empty line. Check the page's console for the error.",
    );
  }
  if (
    screens.workflows !== undefined &&
    document.querySelector(findWorkflowsDrawnSelector(path)) === null
  ) {
    throw new Error(
      "Workflows drew no row and no empty line. Check the page's console for the error.",
    );
  }
  if (
    screens.discussions !== undefined &&
    document.querySelector(findListDrawnSelector(path, OPEN_DISCUSSION_PART)) === null
  ) {
    throw new Error(
      "Discussions drew no row and no empty line. Check the page's console for the error.",
    );
  }
  if (
    screens.wiki !== undefined &&
    document.querySelector(findListDrawnSelector(path, OPEN_WIKI_PAGE_PART)) === null
  ) {
    throw new Error(
      "The Wiki drew no row and no empty line. Check the page's console for the error.",
    );
  }
  if (screens.run !== undefined && document.querySelector(findRunDrawnSelector(path)) === null) {
    throw new Error("The run's page drew no step. Check the page's console for the error.");
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
  const answerMove = screens.intake?.answerMove;
  const client = createClient({
    baseUrl: CONTROLLER_URL,
    fetch:
      answerMove === undefined
        ? refuseRequest
        : (url, init) => (MOVE_PATH.test(url) ? answerMove(url, init) : refuseRequest(url, init)),
  });
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
  // The list draws its rows once it has measured its height, after the first render.
  if (screens.intake !== undefined) await waitForElement(".ask-row, .asks-empty, .asks-zero");
  if (screens.workflows !== undefined) {
    await waitForElement(findWorkflowsDrawnSelector(path));
  }
  if (screens.discussions !== undefined) {
    await waitForElement(findListDrawnSelector(path, OPEN_DISCUSSION_PART));
  }
  if (screens.wiki !== undefined) {
    await waitForElement(findListDrawnSelector(path, OPEN_WIKI_PAGE_PART));
  }
  if (screens.run !== undefined) await waitForElement(findRunDrawnSelector(path));
  assertShellDrawn(queryClient, screens, path);
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

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Settings > Connections open: the main pane shows the app's real
 * Settings frame and Connections section, with the Connections and the
 * plugins of `settings`. Returns once the Connections' rows are in the
 * document. Fails when the page has no `#root`, draws no sidebar row or no
 * Connection's row, or tries to read a record the cache does not hold.
 */
export async function mountConnectionsSettingsSpecimen(
  records: SidebarRecords,
  settings: ConnectionsSettingsRecords,
): Promise<void> {
  await mountShellSpecimen(records, "/settings/connections", { connectionsSettings: settings });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Intake open: the main pane shows the app's real Intake screen, on
 * `intake.view` or To do, with the signals from `records`, and the pane of
 * `intake.signal` when it is not `null`. On Everything, it shows the events
 * of `intake.everything`. Returns once the list's rows, or its empty line, are in
 * the document. Fails when the page has no `#root`, draws no sidebar row, no
 * list row and no empty line, or tries to read a record the cache does not
 * hold.
 */
export async function mountIntakeSpecimen(
  records: SidebarRecords,
  intake: IntakeRecords,
): Promise<void> {
  const search = new URLSearchParams();
  if (intake.view !== undefined) search.set("view", intake.view);
  if (intake.signal !== null) search.set("signal", intake.signal.id);
  if (intake.trackingOpen === true) search.set("tracking", "true");
  if (intake.trackingTaskId !== undefined) search.set("task", intake.trackingTaskId);
  const everything = intake.everything;
  if (everything?.selectedEventId !== undefined) {
    search.set("event", String(everything.selectedEventId));
  }
  if (everything?.text !== undefined) search.set("text", everything.text);
  if (everything?.handling !== undefined) search.set("handling", everything.handling);
  if (everything?.source !== undefined) search.set("source", everything.source);
  const path = search.size === 0 ? "/intake" : `/intake?${search.toString()}`;
  await mountShellSpecimen(records, path, { intake });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Settings > Intake open: the main pane shows the app's real Settings
 * frame and Intake section, with a section for each plugin in `records`
 * that raises signals or reads events, and the Ignore Rules of `settings`.
 * Returns once the sections are in the document. Fails when the page has no
 * `#root`, draws no sidebar row or no plugin's section, or tries to read a
 * record the cache does not hold.
 */
export async function mountIntakeSettingsSpecimen(
  records: SidebarRecords,
  settings: IntakeSettingsRecords,
): Promise<void> {
  await mountShellSpecimen(records, "/settings/intake", { intakeSettings: settings });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Workflows open: the main pane shows the app's real workflow list,
 * built from `workflows`, at the width `view` names, as the book's `?view=`
 * names it:
 *
 * - `table`: no workflow is open, and the list fills the pane;
 * - `split`: Ship release is open beside the list, drawn as a column;
 * - `full`: Ship release fills the pane, and the list is hidden.
 *
 * An open workflow shows its Runs tab as a list, or as a timeline of today
 * when `runsView` is `timeline`. Returns once the list's rows, or the Runs
 * tab's, are in the document. Fails when the page has no `#root`, draws no
 * sidebar row and none of those rows, or tries to read a record the cache
 * does not hold.
 */
export async function mountWorkflowsSpecimen(
  records: SidebarRecords,
  workflows: WorkflowsRecords,
  view: "table" | "split" | "full",
  runsView: "list" | "timeline",
): Promise<void> {
  const search = new URLSearchParams();
  if (view === "full") search.set("full", "true");
  if (runsView === "timeline") search.set("runsView", "timeline");
  const path =
    view === "table"
      ? "/workflows"
      : `/workflows/${workflows.openWorkflow.workflow.id}` +
        (search.size === 0 ? "" : `?${search.toString()}`);
  await mountShellSpecimen(records, path, { workflows });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with the page of `run` open: the main pane shows the app's real run page,
 * with its steps as a graph, or on a timeline when `stepsView` is
 * `timeline`. Returns once the graph's nodes, or the timeline's ticks, are
 * in the document. Fails when the page has no `#root`, draws no sidebar row
 * and no step, or tries to read a record the cache does not hold.
 */
export async function mountRunSpecimen(
  records: SidebarRecords,
  run: RunScreenRecords,
  stepsView: "graph" | "timeline",
): Promise<void> {
  const path = `/runs/${run.records.run.id}` + (stepsView === "timeline" ? "?view=timeline" : "");
  await mountShellSpecimen(records, path, { run });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with Discussions open: the main pane shows the app's real Discussion list,
 * built from `discussions`, at the width `view` names, as the book's `?view=`
 * names it:
 *
 * - `table`: no Discussion is open, and the list fills the pane;
 * - `split`: the open Discussion is beside the list, drawn as a column;
 * - `full`: the open Discussion fills the pane, and the list is hidden.
 *
 * Returns once the list's rows, or the open Discussion's Posts, are in the
 * document. Fails when the page has no `#root`, draws no sidebar row and none
 * of those, or tries to read a record the cache does not hold.
 */
export async function mountDiscussionsSpecimen(
  records: SidebarRecords,
  discussions: DiscussionsRecords,
  view: "table" | "split" | "full",
): Promise<void> {
  const path =
    view === "table"
      ? "/discussions"
      : `/discussions/${discussions.openDiscussion.discussion.id}` +
        (view === "full" ? "?full=true" : "");
  await mountShellSpecimen(records, path, { discussions });
}

/**
 * Applies the URL's theme and draws the shell into `#root` from `records`,
 * with the Wiki open: the main pane shows the app's real page list, built
 * from `wiki`, at the width `view` names, as `mountDiscussionsSpecimen`'s
 * views are. The open page is "Checkout architecture", as of its older
 * revision when `olderRevision` is true. Returns once the list's rows, or the
 * open page's body, are in the document. Fails when the page has no `#root`,
 * draws no sidebar row and none of those, or tries to read a record the cache
 * does not hold.
 */
export async function mountWikiSpecimen(
  records: SidebarRecords,
  wiki: WikiRecords,
  view: "table" | "split" | "full",
  olderRevision: boolean,
): Promise<void> {
  const search = new URLSearchParams();
  if (view === "full") search.set("full", "true");
  if (olderRevision) search.set("revision", String(wiki.olderRevisionNumber));
  const path =
    view === "table"
      ? "/wiki"
      : `/wiki/${wiki.openPage.page.id}` + (search.size === 0 ? "" : `?${search.toString()}`);
  await mountShellSpecimen(records, path, { wiki });
}
