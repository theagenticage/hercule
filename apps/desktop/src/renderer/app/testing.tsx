/**
 * Test helpers that run the real renderer against a fake bridge and a stubbed
 * controller.
 *
 * Only the edges are replaced: `window.bridge`, which main provides, and the
 * global `fetch` and `WebSocket`, which reach the controller. Boot's context,
 * the client, the live connection, the router, the entry guard and the
 * screens are the ones that ship, so a change to any of them shows up in the
 * tests.
 */
import { afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import type { Live } from "@hercule/client-core";
import {
  buildErrorBody,
  createApiStub,
  stubWebSocketInto,
  type Answer,
  type Call,
  type Handler,
  type StubSocket,
} from "@hercule/client-core/testing";
import { buildSession, buildThreadsWorld } from "@hercule/client-core/threads/testing";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  buildSubagentStreamTopic,
  buildSubagentTapTopic,
  GITHUB_CONNECTION_TYPE,
  type Connection,
  type Input,
  type ModelOption,
  type MutableLiveTopic,
  type OpenRequest,
  type Project,
  type ProviderInstance,
  type Resource,
  type Runner,
  type Session,
  type Subagent,
  type TapItem,
  type TranscriptRow,
  type Workspace,
} from "@hercule/contract";
import type { Bridge } from "../../ipc/bridge";
import type {
  ControllerUrlSaveOutcome,
  EncodedIpcPayload,
  EncodedIpcRequest,
  FirstRunProgress,
  FolderPickOutcome,
  LocalControllerFindOutcome,
  LocalControllerStartOutcome,
  MenuCommand,
  SetupTokenReadOutcome,
} from "../../ipc/contract";
import { buildRouterContext, type RouterContext } from "./context";
import { createAppRouter } from "./router";

/** The address of the stubbed controller. */
export const CONTROLLER_URL = "http://controller.test";

/** The bridge a test passes to the app, and what the app did with it. */
export interface FakeBridge {
  readonly bridge: Bridge;
  /** The tokens the app sent main to store, oldest first. `null` is a removal. */
  readonly tokenWrites: readonly (string | null)[];
  /** The addresses the app asked main to check and save, oldest first. */
  readonly savedUrls: readonly string[];
  /** Sends a menu command, as main does when the user picks the menu item. */
  readonly sendMenuCommand: (command: MenuCommand) => void;
  /** Each list of threads the app sent main for the Go menu, oldest first. */
  readonly goMenus: readonly EncodedIpcRequest<"goMenu.set">[];
  /** Each list of threads waiting on the user the app sent main, oldest first. */
  readonly waitingThreadLists: readonly EncodedIpcRequest<"waitingThreads.set">[];
  /** Asks the app to open a thread, as main does for Go and a notification's click. */
  readonly openThread: (sessionId: string) => void;
  /** What the app asked main to keep of the first run, oldest first. `null` forgets it. */
  readonly firstRunWrites: readonly (FirstRunProgress | null)[];
  /** The URLs the app asked main to open in the browser, oldest first. */
  readonly openedLinks: readonly string[];
  /** How many times the app asked main to start Hercule on this Mac. */
  readonly startCount: () => number;
  /** How many times the app asked main to show the logs folder. */
  readonly logsFolderShowCount: () => number;
}

/**
 * Creates a bridge that answers as main would for a user whose settings hold
 * `controllerUrl` and whose Keychain holds `token`. `save` answers each
 * Connect; by default the controller checks out and the URL is saved.
 * `runnerIdentities` maps a loopback port to the runner id that answers
 * there; any other port answers nothing, as a Mac with no runner does.
 *
 * The first run's channels answer as on a Mac with no Hercule on it, no
 * setup token and no first run kept, unless a test passes its own: `find`
 * and `start` answer the look for and the start of Hercule on this Mac,
 * `setupToken` the setup token read, `pickFolder` the folder dialog, and
 * `firstRun` is what main keeps of the first run at launch. A write of the
 * first run replaces what a later read returns.
 */
export const createFakeBridge = ({
  controllerUrl = null,
  token = null,
  save = (url) => Promise.resolve({ _tag: "Saved", origin: url }),
  runnerIdentities = {},
  find = () => Promise.resolve({ _tag: "NotFound", line: null }),
  start = () => Promise.resolve({ _tag: "NotInstalled" }),
  setupToken = { _tag: "PasteNeeded" },
  pickFolder = () => Promise.resolve({ _tag: "Cancelled" }),
  firstRun = null,
}: {
  readonly controllerUrl?: string | null;
  readonly token?: string | null;
  readonly save?: (url: string) => Promise<ControllerUrlSaveOutcome>;
  readonly runnerIdentities?: Readonly<Record<number, string>>;
  readonly find?: () => Promise<LocalControllerFindOutcome>;
  readonly start?: () => Promise<LocalControllerStartOutcome>;
  readonly setupToken?: SetupTokenReadOutcome;
  readonly pickFolder?: () => Promise<FolderPickOutcome>;
  readonly firstRun?: FirstRunProgress | null;
} = {}): FakeBridge => {
  const tokenWrites: (string | null)[] = [];
  const savedUrls: string[] = [];
  const firstRunWrites: (FirstRunProgress | null)[] = [];
  const openedLinks: string[] = [];
  let keptFirstRun = firstRun;
  let starts = 0;
  let logsFolderShows = 0;
  const menuListeners = new Set<(command: MenuCommand) => void>();
  const threadListeners = new Set<(payload: EncodedIpcPayload<"thread.open">) => void>();
  const goMenus: EncodedIpcRequest<"goMenu.set">[] = [];
  const waitingThreadLists: EncodedIpcRequest<"waitingThreads.set">[] = [];
  return {
    bridge: {
      controllerUrl: {
        read: () => Promise.resolve(controllerUrl),
        save: (url) => {
          savedUrls.push(url);
          return save(url);
        },
      },
      token: {
        read: () => Promise.resolve(token),
        write: (next) => {
          tokenWrites.push(next);
          return Promise.resolve(undefined);
        },
      },
      runnerIdentity: {
        read: ({ port }) => Promise.resolve(runnerIdentities[port] ?? null),
      },
      firstScreen: {
        report: () => Promise.resolve(undefined),
      },
      goMenu: {
        set: (threads) => {
          goMenus.push(threads);
          return Promise.resolve(undefined);
        },
      },
      waitingThreads: {
        set: (threads) => {
          waitingThreadLists.push(threads);
          return Promise.resolve(undefined);
        },
      },
      localController: {
        find,
        start: () => {
          starts += 1;
          return start();
        },
      },
      logsFolder: {
        show: () => {
          logsFolderShows += 1;
          return Promise.resolve(undefined);
        },
      },
      setupToken: {
        read: () => Promise.resolve(setupToken),
      },
      macUser: {
        read: () => Promise.resolve({ username: "ada" }),
      },
      folder: {
        pick: pickFolder,
      },
      firstRunProgress: {
        read: () => Promise.resolve(keptFirstRun),
        save: (next) => {
          firstRunWrites.push(next);
          keptFirstRun = next;
          return Promise.resolve(undefined);
        },
      },
      link: {
        open: ({ url }) => {
          openedLinks.push(url);
          return Promise.resolve(undefined);
        },
      },
      menu: {
        onCommand: (listener) => {
          menuListeners.add(listener);
          return () => menuListeners.delete(listener);
        },
      },
      thread: {
        onOpen: (listener) => {
          threadListeners.add(listener);
          return () => threadListeners.delete(listener);
        },
      },
    },
    tokenWrites,
    savedUrls,
    goMenus,
    waitingThreadLists,
    firstRunWrites,
    openedLinks,
    startCount: () => starts,
    logsFolderShowCount: () => logsFolderShows,
    // Main sends these from outside React, so the updates they cause are
    // wrapped in `act`, which applies them before the test goes on.
    sendMenuCommand: (command) => {
      act(() => {
        for (const listener of menuListeners) listener(command);
      });
    },
    openThread: (sessionId) => {
      act(() => {
        for (const listener of threadListeners) listener({ sessionId });
      });
    },
  };
};

// The fake API is shared with the web app's tests. A test imports it from
// here with the rest of the harness.
export { buildErrorBody, type Answer, type Call, type Handler } from "@hercule/client-core/testing";

/** The error `fetch` rejects with when nothing answers at the address. */
export const refuseConnection = (): never => {
  throw new TypeError("Failed to fetch");
};

/**
 * Answers never, like a controller that accepts the connection and then
 * hangs. The request still ends when its signal aborts, as a real one does.
 */
export const neverAnswer = (): Promise<Answer> => new Promise(() => {});

/**
 * Returns a handler that holds its request until the test calls `answer`,
 * and `answer`, which answers the latest held request with `reply` inside
 * `act`. A test uses it to look at the screen while a request is on its way.
 */
export const holdAnswer = (): {
  readonly handler: () => Promise<Answer>;
  readonly answer: (reply: Answer) => void;
} => {
  let answer: (reply: Answer) => void = () => {};
  return {
    handler: () =>
      new Promise<Answer>((resolve) => {
        answer = resolve;
      }),
    answer: (reply) => {
      act(() => {
        answer(reply);
      });
    },
  };
};

/**
 * Sets what `document.visibilityState` reads and fires `visibilitychange`,
 * as hiding or showing the window does. It runs inside `act`, so the renders
 * the change causes are done when it returns.
 */
export const setVisibility = (state: DocumentVisibilityState): void => {
  act(() => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

/**
 * Makes every element measure `width` by `height` CSS pixels, until
 * `vi.restoreAllMocks` runs. jsdom lays nothing out, so every element would
 * measure 0, and a virtualized list, which reads its own size to know how
 * many rows fit, would draw none.
 */
export const stubElementSize = (width: number, height: number): void => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
};

/** The records the sidebar reads, as the stubbed controller holds them. */
export interface SidebarRecords {
  readonly threads: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly providers: readonly ProviderInstance[];
  /** The signed-in user's name. */
  readonly username: string;
}

/** A controller that holds no threads, projects, workspaces, resources, runners or providers. */
export const NO_SIDEBAR_RECORDS: SidebarRecords = {
  threads: [],
  projects: [],
  workspaces: [],
  resources: [],
  runners: [],
  providers: [],
  username: "rogier",
};

/**
 * Returns the handlers that answer the sidebar's seven reads from `records`.
 * Each list comes back as one page, with no cursor to a next one.
 *
 * They also answer the three reads a Draft Thread adds, which the app makes
 * whenever it opens at `/`: the settings, with none set, the profiles, and
 * the project's open tasks, of which there are none.
 */
export const buildSidebarHandlers = (
  records: SidebarRecords,
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/sessions": { body: { items: records.threads } },
  "GET /api/v1/projects": { body: { items: records.projects } },
  "GET /api/v1/workspaces": { body: { items: records.workspaces } },
  "GET /api/v1/resources": { body: { items: records.resources } },
  "GET /api/v1/runners": { body: { items: records.runners } },
  "GET /api/v1/providers": { body: records.providers },
  "GET /api/v1/user": { body: { username: records.username } },
  "GET /api/v1/settings": { body: { controller: {}, user: {} } },
  "GET /api/v1/profiles": { body: { items: [] } },
  "GET /api/v1/tasks": { body: { items: [] } },
  // The shell reads the Connections, for New project and the starter threads.
  "GET /api/v1/connections": { body: { items: [] } },
});

/**
 * The ids of client-core's shared fixture world, in the UUIDv7 format the
 * contract accepts, so the records decode when the stubbed controller sends
 * them.
 */
const WORLD_IDS = {
  moss: "01a06d02-beff-7037-9f5b-042822015952",
  cove: "01a06d02-beff-7037-9f5b-042822015953",
  webshopProject: "01a06d02-7000-7000-8000-000000000001",
  opsProject: "01a06d02-7000-7000-8000-000000000002",
  webshop: "01a06d02-7100-7000-8000-000000000001",
  infra: "01a06d02-7100-7000-8000-000000000002",
  runbooks: "01a06d02-7100-7000-8000-000000000003",
  primary: "01a06d02-7200-7000-8000-000000000001",
  primaryCheckout: "01a06d02-7300-7000-8000-000000000001",
  thread3f1: "01a06d02-7200-7000-8000-000000000002",
  thread3f1Checkout: "01a06d02-7300-7000-8000-000000000002",
  flakyThread: "01a06d02-7400-7000-8000-000000000001",
  runbookThread: "01a06d02-7400-7000-8000-000000000002",
};

/** The ids of the threads in `SIDEBAR_FIXTURE`, for a test that opens one. */
export const FIXTURE_THREAD_IDS = {
  /** "Write the retry runbook": waiting on a command approval, in the `hercule/thread-3f1` worktree. */
  runbook: WORLD_IDS.runbookThread,
  /** "Fix flaky webhook tests": working, in the same worktree. */
  flaky: WORLD_IDS.flakyThread,
  /** "Bump the Bun pin": idle, in webshop's main workspace. */
  bunPin: "01a06d02-7400-7000-8000-000000000003",
  /** "Rotate the backups key": exited, in the ops project, with no workspace. */
  backupsKey: "01a06d02-7400-7000-8000-000000000004",
  /** "Sketch the pricing page": idle, in no project. */
  pricingPage: "01a06d02-7400-7000-8000-000000000005",
} as const;

const WORLD = buildThreadsWorld(WORLD_IDS);

/** The permission profile and provider instance every fixture thread names. */
const PROFILE_ID = "01a06d02-7500-7000-8000-000000000001";
const INSTANCE_ID = "01a06d02-7600-7000-8000-000000000001";

/** Returns a fixture thread on moss, with ids the contract accepts. */
const buildFixtureThread = (
  over: Partial<Session> & { readonly id: string; readonly title: string },
): Session =>
  buildSession({
    runnerId: WORLD.MOSS.id,
    permissionProfileId: PROFILE_ID,
    instanceId: INSTANCE_ID,
    ...over,
  });

const APPROVAL_REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** The fixture threads, one per `FIXTURE_THREAD_IDS` entry. */
const FIXTURE_THREADS = {
  runbook: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.runbook,
    title: "Write the retry runbook",
    status: "busy",
    openRequests: [APPROVAL_REQUEST],
    projectId: WORLD.WEBSHOP_PROJECT.id,
    workspaceId: WORLD.THREAD_3F1.id,
    lastActivityAt: "2026-09-10T09:05:00.000Z",
  }),
  flaky: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.flaky,
    title: "Fix flaky webhook tests",
    status: "busy",
    projectId: WORLD.WEBSHOP_PROJECT.id,
    workspaceId: WORLD.THREAD_3F1.id,
    lastActivityAt: "2026-09-10T09:04:00.000Z",
  }),
  bunPin: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.bunPin,
    title: "Bump the Bun pin",
    projectId: WORLD.WEBSHOP_PROJECT.id,
    workspaceId: WORLD.PRIMARY.id,
    lastActivityAt: "2026-09-10T09:03:00.000Z",
  }),
  backupsKey: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.backupsKey,
    title: "Rotate the backups key",
    status: "exited",
    projectId: WORLD.OPS_PROJECT.id,
    exitedAt: "2026-09-10T09:02:00.000Z",
    lastActivityAt: "2026-09-10T09:02:00.000Z",
  }),
  pricingPage: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.pricingPage,
    title: "Sketch the pricing page",
    lastActivityAt: "2026-09-10T09:01:00.000Z",
  }),
};

/**
 * A sidebar with something in every place: two projects, a worktree two
 * threads share, a main workspace, a thread with no workspace, and a thread
 * in no project. One thread waits on an approval, one works, two are idle and
 * one has exited. The threads are listed most recent first, as the controller
 * lists them.
 */
export const SIDEBAR_FIXTURE: SidebarRecords = {
  threads: [
    FIXTURE_THREADS.runbook,
    FIXTURE_THREADS.flaky,
    FIXTURE_THREADS.bunPin,
    FIXTURE_THREADS.backupsKey,
    FIXTURE_THREADS.pricingPage,
  ],
  projects: [WORLD.WEBSHOP_PROJECT, WORLD.OPS_PROJECT],
  workspaces: [{ ...WORLD.PRIMARY, sessionIds: [FIXTURE_THREAD_IDS.bunPin] }, WORLD.THREAD_3F1],
  resources: [WORLD.WEBSHOP, WORLD.INFRA, WORLD.RUNBOOKS],
  runners: [WORLD.MOSS],
  providers: [],
  username: "rogier",
};

/** The reasoning effort the fixture models offer, as their one model option. */
export const EFFORT_OPTION: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  default: "medium",
};

/**
 * The provider instance every fixture thread names, as moss probed it: Claude
 * Code, signed in, with the fixture turns' model as its default, a second
 * model, and an older one. Both current models offer `EFFORT_OPTION`.
 *
 * `SIDEBAR_FIXTURE` leaves it out, so its threads show their model's slug. A
 * test that needs model names adds it to the providers.
 */
export const FIXTURE_INSTANCE: ProviderInstance = {
  id: INSTANCE_ID,
  providerId: "claude-code",
  name: "personal",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
  secretFields: [],
  snapshots: [
    {
      runnerId: WORLD.MOSS.id,
      probedAt: "2026-09-10T08:00:00.000Z",
      harnessVersion: "2.1.263",
      versionVerdict: "ok",
      auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          isDefault: true,
          options: [EFFORT_OPTION],
        },
        { slug: "claude-opus-5", name: "Claude Opus 5", options: [EFFORT_OPTION] },
        { slug: "claude-sonnet-4", name: "Claude Sonnet 4", isLegacy: true, options: [] },
      ],
    },
  ],
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

/** A connected GitHub Connection, for the user "rogier". */
export const FIXTURE_GITHUB_CONNECTION: Connection = {
  id: "01a06d02-7700-7000-8000-000000000001",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
};

/**
 * A thread as the stubbed controller holds it: its session, its transcript,
 * its inputs, and its subagents with their transcripts.
 */
export interface ThreadRecords {
  readonly session: Session;
  /** The session's own agent's transcript rows, in position order. */
  readonly transcript: readonly TranscriptRow[];
  /** Every input the session was given, oldest first, whatever its status. */
  readonly inputs: readonly Input[];
  /** The session's subagents, oldest first; none when absent. */
  readonly subagents?: readonly Subagent[];
  /** Each subagent's transcript rows, in position order, by subagent id. */
  readonly subagentTranscripts?: Readonly<Record<string, readonly TranscriptRow[]>>;
}

/** A provider event, as a transcript row holds it. */
type ProviderEvent = TranscriptRow["event"];

/** Removes the fields every event has from each event type of `Event`. */
type OmitEventBase<Event> = Event extends unknown
  ? Omit<Event, "eventId" | "sessionId" | "at">
  : never;

/**
 * A provider event without the fields every event has, which `buildTranscript`
 * and `buildNextRows` fill in.
 */
export type EventBody = OmitEventBase<ProviderEvent>;

/** One event of a fixture transcript, and how many seconds after the transcript's start it happened. */
type TranscriptStep = readonly [seconds: number, event: EventBody];

/**
 * Returns the transcript rows of `steps` for the session `sessionId`, with
 * positions from 1 and times counted from `startAt`.
 */
const buildTranscript = (
  sessionId: string,
  startAt: string,
  steps: readonly TranscriptStep[],
): TranscriptRow[] =>
  steps.map(([seconds, body], index) => {
    const at = new Date(Date.parse(startAt) + seconds * 1000).toISOString();
    return {
      position: index + 1,
      at,
      event: { ...body, eventId: `event-${index + 1}`, sessionId, at },
    };
  });

/**
 * Returns the rows that follow `thread`'s transcript, one per body, as the
 * thread's stream delivers them. Positions continue from the last row, and
 * every row has the last row's time. Throws when the thread has no rows.
 */
export const buildNextRows = (thread: ThreadRecords, ...bodies: EventBody[]): TranscriptRow[] => {
  const last = thread.transcript.at(-1);
  if (last === undefined) throw new Error("buildNextRows needs a thread with at least one row.");
  const sessionId = thread.session.id;
  return bodies.map((body, index) => {
    const position = last.position + index + 1;
    return {
      position,
      at: last.at,
      event: { ...body, eventId: `event-${position}`, sessionId, at: last.at },
    };
  });
};

/** Returns the steps of a user message: its item starts and completes at once, holding the text. */
const writeUserMessage = (seconds: number, turnId: string, text: string): TranscriptStep[] => {
  const item = {
    turnId,
    itemId: `${turnId}-user`,
    kind: "user_message",
    detail: { text },
  } as const;
  return [
    [seconds, { _tag: "item.started", ...item }],
    [seconds, { _tag: "item.completed", ...item, status: "completed" }],
  ];
};

/**
 * Returns the steps of one item that runs from `from` to `to` seconds: its
 * start, the text it streams (as one row, as the controller stores a short
 * item's text) and its completion. `text` is left out for an item that
 * streams none.
 */
const runItem = (
  [from, to]: readonly [number, number],
  item: {
    readonly turnId: string;
    readonly itemId: string;
    readonly kind: Extract<ProviderEvent, { _tag: "item.started" }>["kind"];
    readonly detail?: Record<string, string>;
    readonly text?: { readonly streamKind: TapItem["streamKind"]; readonly delta: string };
  },
): TranscriptStep[] => {
  const { text, ...fields } = item;
  return [
    [from, { _tag: "item.started", ...fields }],
    ...(text === undefined
      ? []
      : [
          [
            to,
            { _tag: "content.delta", turnId: item.turnId, itemId: item.itemId, ...text },
          ] as const,
        ]),
    [to, { _tag: "item.completed", ...fields, status: "completed" }],
  ];
};

/** Returns an input the user sent to `sessionId` at `createdAt`, still queued. */
const buildQueuedInput = (
  id: string,
  sessionId: string,
  text: string,
  createdAt: string,
): Input => ({
  id,
  sessionId,
  source: "user",
  actor: "user",
  text,
  status: "queued",
  delivery: null,
  createdAt,
  deliveredAt: null,
  sentAt: null,
  reason: null,
});

/** The item the running fixture thread's agent is writing, for a test that taps text into it. */
export const RUNNING_ITEM_ID = "turn-1-answer";

/** The rows of the running fixture thread, whose agent is writing its answer. */
const RUNNING_TRANSCRIPT = buildTranscript(FIXTURE_THREAD_IDS.flaky, "2026-09-10T09:03:30.000Z", [
  [0, { _tag: "turn.started", turnId: "turn-1", model: "claude-sonnet-5" }],
  ...writeUserMessage(
    0,
    "turn-1",
    "The webhook tests fail about one run in five. Find out why and fix it.",
  ),
  ...runItem([2, 21], {
    turnId: "turn-1",
    itemId: "turn-1-rerun",
    kind: "command_execution",
    detail: { command: "bun test test/webhooks --rerun-each 20" },
    text: { streamKind: "command_output", delta: "57 pass\n3 fail\n" },
  }),
  [
    22,
    { _tag: "item.started", turnId: "turn-1", itemId: RUNNING_ITEM_ID, kind: "assistant_message" },
  ],
  [
    24,
    {
      _tag: "content.delta",
      turnId: "turn-1",
      itemId: RUNNING_ITEM_ID,
      streamKind: "assistant_text",
      delta: "The three failures share one cause: ",
    },
  ],
]);

/** The subagent the `delegating` fixture thread's agent started, still running. */
export const FIXTURE_SUBAGENT: Subagent = {
  id: "agent-1",
  sessionId: FIXTURE_THREAD_IDS.flaky,
  itemId: "turn-1-delegate",
  description: "Find the flaky webhook test",
  agentType: "Explore",
  status: "running",
  toolCalls: 1,
  startedAt: "2026-09-10T09:03:40.000Z",
};

/** The item `FIXTURE_SUBAGENT` is writing, for a test that taps text into it. */
export const SUBAGENT_RUNNING_ITEM_ID = "agent-1-turn-1-answer";

/** The rows of `FIXTURE_SUBAGENT`'s transcript: its brief, one command, and the answer it is writing. */
const SUBAGENT_TRANSCRIPT = buildTranscript(FIXTURE_THREAD_IDS.flaky, "2026-09-10T09:03:40.000Z", [
  [0, { _tag: "turn.started", turnId: "agent-1-turn-1", model: "claude-haiku-5" }],
  ...writeUserMessage(0, "agent-1-turn-1", "Find which webhook test fails, and why."),
  ...runItem([1, 4], {
    turnId: "agent-1-turn-1",
    itemId: "agent-1-turn-1-grep",
    kind: "command_execution",
    detail: { command: "rg -l setTimeout test/webhooks" },
    text: { streamKind: "command_output", delta: "test/webhooks/retry.test.ts\n" },
  }),
  [
    5,
    {
      _tag: "item.started",
      turnId: "agent-1-turn-1",
      itemId: SUBAGENT_RUNNING_ITEM_ID,
      kind: "assistant_message",
    },
  ],
]);

/**
 * The fixture threads' records, for a test that opens a thread. Each thread
 * is the sidebar fixture's thread of the same name, so the sidebar and the
 * thread agree. Stub them with `buildThreadHandlers`.
 */
export const THREAD_FIXTURES = {
  /**
   * "Bump the Bun pin", idle: one finished turn with a user message, two
   * commands, an agent message, three edits, two more commands and a final
   * agent message in markdown.
   */
  finished: {
    session: FIXTURE_THREADS.bunPin,
    transcript: buildTranscript(FIXTURE_THREAD_IDS.bunPin, "2026-09-10T09:00:00.000Z", [
      [0, { _tag: "turn.started", turnId: "turn-1", model: "claude-sonnet-5" }],
      ...writeUserMessage(0, "turn-1", "Bump the Bun pin to 1.3.2 and make sure CI still passes."),
      ...runItem([2, 5], {
        turnId: "turn-1",
        itemId: "turn-1-reasoning",
        kind: "reasoning",
        text: { streamKind: "reasoning_text", delta: "Find every place the version is pinned." },
      }),
      ...runItem([5, 6], {
        turnId: "turn-1",
        itemId: "turn-1-cat",
        kind: "command_execution",
        detail: { command: "cat .bun-version" },
        text: { streamKind: "command_output", delta: "1.3.1\n" },
      }),
      ...runItem([6, 8], {
        turnId: "turn-1",
        itemId: "turn-1-search",
        kind: "command_execution",
        detail: { command: "rg -l 1.3.1 --glob '!node_modules'" },
        text: {
          streamKind: "command_output",
          delta: ".bun-version\n.github/workflows/ci.yml\n.github/workflows/release.yml\n",
        },
      }),
      ...runItem([9, 12], {
        turnId: "turn-1",
        itemId: "turn-1-plan",
        kind: "assistant_message",
        text: {
          streamKind: "assistant_text",
          delta: "The pin lives in `.bun-version` and in two workflows. I'll update all three.",
        },
      }),
      ...runItem([13, 14], {
        turnId: "turn-1",
        itemId: "turn-1-edit-version",
        kind: "file_change",
        detail: { path: ".bun-version" },
      }),
      ...runItem([14, 16], {
        turnId: "turn-1",
        itemId: "turn-1-edit-ci",
        kind: "file_change",
        detail: { path: ".github/workflows/ci.yml" },
      }),
      ...runItem([16, 18], {
        turnId: "turn-1",
        itemId: "turn-1-edit-release",
        kind: "file_change",
        detail: { path: ".github/workflows/release.yml" },
      }),
      ...runItem([19, 41], {
        turnId: "turn-1",
        itemId: "turn-1-install",
        kind: "command_execution",
        detail: { command: "bun install" },
        text: { streamKind: "command_output", delta: "412 packages installed [21.40s]\n" },
      }),
      ...runItem([41, 128], {
        turnId: "turn-1",
        itemId: "turn-1-test",
        kind: "command_execution",
        detail: { command: "bun test" },
        text: { streamKind: "command_output", delta: "1204 pass\n0 fail\n" },
      }),
      ...runItem([129, 134], {
        turnId: "turn-1",
        itemId: "turn-1-answer",
        kind: "assistant_message",
        text: {
          streamKind: "assistant_text",
          delta:
            "Done. The pin is now **1.3.2** in:\n\n- `.bun-version`\n- `.github/workflows/ci.yml`\n- `.github/workflows/release.yml`\n\n`bun install` and `bun test` pass.",
        },
      }),
      [134, { _tag: "turn.completed", turnId: "turn-1", state: "completed" }],
    ]),
    inputs: [],
  },
  /**
   * "Fix flaky webhook tests", busy: a turn that ran one command and whose
   * agent is writing its answer, `RUNNING_ITEM_ID`, with the first words
   * stored.
   */
  running: { session: FIXTURE_THREADS.flaky, transcript: RUNNING_TRANSCRIPT, inputs: [] },
  /**
   * "Write the retry runbook", busy and waiting on the user: the agent wrote
   * a file, said so, and asks to run `git push` (the session's open Request).
   */
  waiting: {
    session: FIXTURE_THREADS.runbook,
    transcript: buildTranscript(FIXTURE_THREAD_IDS.runbook, "2026-09-10T08:55:00.000Z", [
      [0, { _tag: "turn.started", turnId: "turn-1", model: "claude-sonnet-5" }],
      ...writeUserMessage(
        0,
        "turn-1",
        "Write a runbook for retrying failed webhook deliveries, then push it.",
      ),
      ...runItem([3, 40], {
        turnId: "turn-1",
        itemId: "turn-1-edit",
        kind: "file_change",
        detail: { path: "docs/runbooks/retry.md" },
      }),
      ...runItem([41, 43], {
        turnId: "turn-1",
        itemId: "turn-1-note",
        kind: "assistant_message",
        text: { streamKind: "assistant_text", delta: "The runbook is written. Pushing it now." },
      }),
      [
        44,
        {
          _tag: "item.started",
          turnId: "turn-1",
          itemId: APPROVAL_REQUEST.itemId,
          kind: "command_execution",
          detail: { command: "git push" },
        },
      ],
      [44, { _tag: "request.opened", request: APPROVAL_REQUEST }],
    ]),
    inputs: [],
  },
  /** The running thread with two messages queued behind its turn, oldest first. */
  queued: {
    session: FIXTURE_THREADS.flaky,
    transcript: RUNNING_TRANSCRIPT,
    inputs: [
      buildQueuedInput(
        "01a06d02-7700-7000-8000-000000000001",
        FIXTURE_THREAD_IDS.flaky,
        "Also check the retry test while you are there.",
        "2026-09-10T09:03:50.000Z",
      ),
      buildQueuedInput(
        "01a06d02-7700-7000-8000-000000000002",
        FIXTURE_THREAD_IDS.flaky,
        "And keep the fix to the webhooks package.",
        "2026-09-10T09:03:58.000Z",
      ),
    ],
  },
  /**
   * The running thread with one subagent, `FIXTURE_SUBAGENT`, which is
   * writing its answer.
   */
  delegating: {
    session: FIXTURE_THREADS.flaky,
    transcript: RUNNING_TRANSCRIPT,
    inputs: [],
    subagents: [FIXTURE_SUBAGENT],
    subagentTranscripts: { [FIXTURE_SUBAGENT.id]: SUBAGENT_TRANSCRIPT },
  },
  /** "Sketch the pricing page", idle: a turn that failed after its first command. */
  failed: {
    session: FIXTURE_THREADS.pricingPage,
    transcript: buildTranscript(FIXTURE_THREAD_IDS.pricingPage, "2026-09-10T09:00:30.000Z", [
      [0, { _tag: "turn.started", turnId: "turn-1", model: "claude-sonnet-5" }],
      ...writeUserMessage(0, "turn-1", "Sketch the pricing page: three tiers, monthly and yearly."),
      ...runItem([2, 3], {
        turnId: "turn-1",
        itemId: "turn-1-list",
        kind: "command_execution",
        detail: { command: "ls src/pages" },
        text: { streamKind: "command_output", delta: "index.tsx\nabout.tsx\n" },
      }),
      [
        4,
        {
          _tag: "turn.completed",
          turnId: "turn-1",
          state: "failed",
          error: "The provider stopped answering: rate limit reached.",
        },
      ],
    ]),
    inputs: [],
  },
} satisfies Readonly<Record<string, ThreadRecords>>;

/**
 * Returns the handlers that answer a thread's reads from `thread`: its
 * session, its subagents, each agent's transcript as one page, and its
 * inputs, newest first, as the app asks for them. A transcript read for a
 * subagent the thread has no transcript for answers `not_found`.
 */
export const buildThreadHandlers = (thread: ThreadRecords): Readonly<Record<string, Handler>> => {
  const path = `/api/v1/sessions/${thread.session.id}`;
  return {
    [`GET ${path}`]: { body: thread.session },
    [`GET ${path}/subagents`]: { body: { items: thread.subagents ?? [] } },
    [`GET ${path}/transcript`]: (call) => {
      const subagentId = new URLSearchParams(call.search).get("subagentId");
      if (subagentId === null) return { body: { items: thread.transcript } };
      const rows = thread.subagentTranscripts?.[subagentId];
      return rows === undefined
        ? { status: 404, body: buildErrorBody("not_found", `no subagent ${subagentId}`) }
        : { body: { items: rows } };
    },
    [`GET ${path}/inputs`]: { body: { items: [...thread.inputs].reverse() } },
  };
};

/**
 * Stubs the global `fetch` for this test with one that responds from
 * `handlers`, keyed `METHOD /path`, and returns the calls it receives.
 *
 * Some reads answer by default, unless a handler says otherwise, because
 * every signed-in start makes them:
 *
 * - `GET /api/v1/setup` answers that setup is complete; the entry guard reads
 *   it on every start.
 * - `POST /api/v1/auth/ws-ticket` answers with a ticket, so the live
 *   connection opens.
 * - The sidebar's reads answer from `NO_SIDEBAR_RECORDS`.
 *
 * Any other unstubbed path returns 404, so a test that forgot a route notices.
 */
export const stubApi = (handlers: Readonly<Record<string, Handler>> = {}): readonly Call[] => {
  const { fetch, calls } = createApiStub({
    "GET /api/v1/setup": { body: { complete: true } },
    "POST /api/v1/auth/ws-ticket": { body: { ticket: "ws-ticket" } },
    ...buildSidebarHandlers(NO_SIDEBAR_RECORDS),
    ...handlers,
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
};

/** The live connection of a rendered app, with the controller's end played by the test. */
export interface LiveStub {
  /** Returns the topics the app is subscribed to on its current socket, oldest first. */
  readonly readTopics: () => readonly string[];
  /** Checks whether the app's current socket is open. `false` before the app opens one. */
  readonly isConnected: () => boolean;
  /**
   * Sends the app an invalidation on its subscription to `topic`, naming `ids`
   * as updated. Throws when the app has no socket or no subscription to
   * `topic`.
   */
  readonly pushInvalidation: (topic: MutableLiveTopic, ids?: readonly string[]) => void;
  /**
   * Sends the app stored rows on its subscription to `session:<sessionId>:stream`,
   * or to the subagent `subagentId`'s stream when it is given, with the last
   * row's position as the cursor, as the controller does. Throws when the app
   * has no socket or no such subscription.
   */
  readonly pushStreamRows: (
    sessionId: string,
    rows: readonly TranscriptRow[],
    subagentId?: string,
  ) => void;
  /**
   * Sends the app an empty replay on its subscription to
   * `session:<sessionId>:stream`, with the subscription's cursor. The
   * controller answers every stream subscription with the rows written after
   * its cursor first, even when there are none, so the rows pushed after the
   * replay are live rows. `subagentId` sends it on that subagent's stream.
   * Throws when the app has no socket or no such subscription.
   */
  readonly pushEmptyReplay: (sessionId: string, subagentId?: string) => void;
  /**
   * Sends the app token deltas on its subscription to `session:<sessionId>:tap`,
   * or to the subagent `subagentId`'s tap when it is given. Throws when the
   * app has no socket or no such subscription.
   */
  readonly pushTaps: (sessionId: string, taps: readonly TapItem[], subagentId?: string) => void;
  /**
   * Rejects the cursor of the app's subscription to `session:<sessionId>:stream`,
   * as the controller does when the transcript's log was replaced. The live
   * connection then tells the app to read the transcript again, and
   * subscribes again from the head.
   */
  readonly resetStream: (sessionId: string) => void;
  /** Closes the app's current socket from the controller's end, as a restart or a sleep does. */
  readonly drop: () => void;
}

/** Returns the stream topic of the session's own agent, or of its subagent `subagentId`. */
const buildStreamTopic = (sessionId: string, subagentId: string | undefined): string =>
  subagentId === undefined
    ? buildSessionStreamTopic(sessionId)
    : buildSubagentStreamTopic(sessionId, subagentId);

/**
 * The live connections the current test's app built. A connection keeps its
 * keepalive and its reconnects running even after the app that started it
 * unmounts, so one left behind would still act during the next test.
 */
const started: Live[] = [];

afterEach(async () => {
  // Unmount the app first. Otherwise a navigation still in flight could mount
  // the shell after the stop and start a connection that nothing stops.
  cleanup();
  await Promise.all(started.splice(0).map((live) => live.stop()));
  vi.unstubAllGlobals();
});

/**
 * Stubs the global `WebSocket` for this test, builds the router context the
 * way `main.tsx` does with `fake` as the bridge, and returns the context with
 * a `LiveStub` for its live connection. The app builds its live connection
 * with no socket factory of its own, so the stub has to replace the global.
 */
const buildTestContext = async (
  fake: FakeBridge,
): Promise<{ readonly context: RouterContext; readonly live: LiveStub }> => {
  const sockets: StubSocket[] = [];
  const dial = stubWebSocketInto(sockets);
  // A function called with `new` that returns an object gives that object,
  // so `new WebSocket(url)` returns the stub.
  vi.stubGlobal("WebSocket", function (url: string) {
    return dial(url);
  });
  const context = await buildRouterContext(fake.bridge);
  if (context.controller !== null) started.push(context.controller.live);

  const readSocket = (): StubSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("the app has not opened a socket");
    return socket;
  };
  const live: LiveStub = {
    readTopics: () =>
      sockets
        .at(-1)
        ?.subscriptions()
        .map((each) => each.topic) ?? [],
    isConnected: () => sockets.at(-1)?.readyState === 1,
    pushInvalidation: (topic, ids = []) => {
      readSocket().push(topic, { _tag: "invalidate", ids, kind: "updated" });
    },
    pushStreamRows: (sessionId, rows, subagentId) => {
      const last = rows.at(-1);
      readSocket().push(buildStreamTopic(sessionId, subagentId), {
        _tag: "delta",
        ...(last === undefined ? {} : { cursor: String(last.position) }),
        items: rows,
      });
    },
    pushEmptyReplay: (sessionId, subagentId) => {
      const socket = readSocket();
      const topic = buildStreamTopic(sessionId, subagentId);
      const { cursor } = socket.findSubscription(topic);
      socket.push(topic, { _tag: "delta", cursor, items: [] });
    },
    pushTaps: (sessionId, taps, subagentId) => {
      const topic =
        subagentId === undefined
          ? buildSessionTapTopic(sessionId)
          : buildSubagentTapTopic(sessionId, subagentId);
      readSocket().push(topic, { _tag: "delta", items: taps });
    },
    resetStream: (sessionId) => {
      const socket = readSocket();
      socket.fail(socket.findSubscription(buildSessionStreamTopic(sessionId)).requestId, {
        error: {
          code: "validation",
          message: "cursor is past the end of the log",
          details: { issues: [] },
        },
      });
    },
    drop: () => {
      readSocket().drop();
    },
  };
  return { context, live };
};

/** What `startApp` and `renderApp` return. */
export interface RenderedApp {
  readonly router: ReturnType<typeof createAppRouter>;
  readonly context: RouterContext;
  readonly live: LiveStub;
}

/**
 * Boots the app the way `main.tsx` does, with `fake` as the bridge, and
 * renders it at once, while the first navigation is still running. For a test
 * of what the window shows while the entry guard waits. Stub the API with
 * `stubApi` first.
 */
export const startApp = async (fake: FakeBridge): Promise<RenderedApp> => {
  const { context, live } = await buildTestContext(fake);
  const router = createAppRouter(context);
  render(<RouterProvider router={router} />);
  return { router, context, live };
};

/**
 * Boots the app the way `main.tsx` does, with `fake` as the bridge, and
 * renders it once the first navigation, entry guard included, has settled.
 * Stub the API with `stubApi` first.
 *
 * The app starts where it would at launch, unless `path` is given: at `/`,
 * or at the last open thread when one is stored for the controller (see
 * `last-thread.ts`). A path lets a test open a screen, such as a thread at
 * `/threads/<id>`, without clicking its way there.
 */
export const renderApp = async (
  fake: FakeBridge,
  { path }: { readonly path?: string } = {},
): Promise<RenderedApp> => {
  const { context, live } = await buildTestContext(fake);
  const router = createAppRouter(context);
  if (path !== undefined) router.history.replace(path);
  await router.load();
  render(<RouterProvider router={router} />);
  return { router, context, live };
};
