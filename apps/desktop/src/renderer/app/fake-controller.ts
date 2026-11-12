/**
 * The records and the handlers of the stubbed controller that the renderer's
 * tests and the counts check's page share: what the sidebar and the shell
 * read, answered from a `SidebarRecords`, and the fixture world most tests
 * draw. Nothing here imports a test runner, so a page in a real browser can
 * import it (`specimens/perf-counts.tsx`). `testing.tsx` re-exports all of it
 * for the tests.
 */
import {
  buildErrorBody,
  HARNESSES,
  PROVIDERS,
  type Answer,
  type Call,
  type Handler,
} from "@hercule/client-core/testing";
import { buildInboxCounts, buildInboxOutline } from "@hercule/client-core/inbox/testing";
import { buildSession, buildThreadsWorld } from "@hercule/client-core/threads/testing";
import {
  MEMORY_CORE,
  type Assistant,
  type MemoryDocument,
  type MemoryWriteInput,
  type ModelProfile,
  type OpenRequest,
  type PluginDetail,
  type Project,
  type ProviderAccount,
  type Resource,
  type Runner,
  type RunSummary,
  type Session,
  type Signal,
  type Workspace,
} from "@hercule/contract";

/**
 * The handlers of the reads every app makes as it boots, whatever the
 * controller holds: the setup check, the live connection's ticket, the
 * machines' metrics and the Initiatives.
 */
export const BOOT_HANDLERS: Readonly<Record<string, Handler>> = {
  "GET /api/v1/setup": { body: { complete: true } },
  "POST /api/v1/auth/ws-ticket": { body: { ticket: "ws-ticket" } },
  "GET /api/v1/runner-metrics": { body: { items: [] } },
  "GET /api/v1/initiatives": { body: { items: [] } },
};

/** The records the sidebar reads, as the stubbed controller holds them. */
export interface SidebarRecords {
  readonly threads: readonly Session[];
  readonly projects: readonly Project[];
  readonly workspaces: readonly Workspace[];
  readonly resources: readonly Resource[];
  readonly runners: readonly Runner[];
  readonly accounts: readonly ProviderAccount[];
  /**
   * The Model Profiles, whose entries the composer's model menu lists and
   * names its models from. None when absent.
   */
  readonly modelProfiles?: readonly ModelProfile[];
  /** The signed-in user's name. */
  readonly username: string;
  /** The assistants, each with the current session of its main conversation. None when absent. */
  readonly assistants?: readonly AssistantRecords[];
  /**
   * The signals the controller holds, open and resolved. Each view of
   * Intake reads its own of them (see `answerSignalQuery`). None when absent.
   */
  readonly signals?: readonly Signal[];
  /** The installed plugins. None when absent. */
  readonly plugins?: readonly PluginDetail[];
  /** The live sessions that are not threads, such as a run's agent steps'. None when absent. */
  readonly agentSessions?: readonly Session[];
  /**
   * The runs, which the Office reads by status, and as it opens, by
   * `activeSince`. None when absent.
   */
  readonly runs?: readonly RunSummary[];
  /**
   * The sessions of the runs' agent steps, exited ones included, which the
   * Office reads by run. None when absent.
   */
  readonly runSessions?: readonly Session[];
}

/** An assistant as the stubbed controller holds it. */
export interface AssistantRecords {
  readonly assistant: Assistant;
  /** The current session of the assistant's main conversation, or `null` when none has started. */
  readonly session: Session | null;
}

/** A controller that holds no threads, projects, workspaces, resources, runners or accounts. */
export const NO_SIDEBAR_RECORDS: SidebarRecords = {
  threads: [],
  projects: [],
  workspaces: [],
  resources: [],
  runners: [],
  accounts: [],
  username: "rogier",
};

/**
 * Answers a session listing from `records`:
 *
 * - a listing filtered to one conversation, which is how the app reads an
 *   assistant's current session, gets that assistant's session, or none;
 * - a listing filtered to runs gets the sessions of those runs in
 *   `runSessions`;
 * - a listing that holds the threads gets the threads and the sessions of
 *   `agentSessions` of kind `agent`, as the sidebar reads them;
 * - a listing of the sessions that are not threads gets `agentSessions`;
 * - any other listing gets the threads.
 */
const answerSessionQuery = (records: SidebarRecords, call: Call): Answer => {
  const params = new URLSearchParams(call.search);
  const conversationId = params.get("conversationId");
  const runIds = params.getAll("runId");
  if (runIds.length > 0) {
    const items = (records.runSessions ?? []).filter(
      (session) => session.runId !== null && runIds.includes(session.runId),
    );
    return { body: { items } };
  }
  if (conversationId === null) {
    const kinds = params.getAll("kind");
    if (kinds.includes("thread")) {
      const partners = (records.agentSessions ?? []).filter((session) => session.kind === "agent");
      return {
        body: {
          items: kinds.includes("agent") ? [...records.threads, ...partners] : records.threads,
        },
      };
    }
    if (!kinds.includes("agent")) return { body: { items: records.threads } };
    const activeSince = params.get("activeSince");
    if (activeSince === null) return { body: { items: records.agentSessions ?? [] } };
    // The Office reads every session an Agent spawned that had not exited
    // before `activeSince`: the live ones, and the ones that exited since.
    const sessions = new Map(
      [...(records.agentSessions ?? []), ...(records.runSessions ?? [])].map((session) => [
        session.id,
        session,
      ]),
    );
    const status = params.get("status");
    const items = [...sessions.values()].filter(
      (session) =>
        (status === null || session.status === status) &&
        (session.status !== "exited" ||
          (session.exitedAt !== null && session.exitedAt >= activeSince)),
    );
    return { body: { items } };
  }
  const session = records.assistants?.find(
    ({ assistant }) => assistant.mainConversationId === conversationId,
  )?.session;
  return { body: { items: session ? [session] : [] } };
};

/**
 * Answers a signal listing from `signals` as the controller does, in one page
 * with no cursor to a next one:
 *
 * - `to-do`, the default: the open signals not snoozed, or whose snooze has
 *   run out by now;
 * - `later`: the open signals snoozed until after now, soonest first;
 * - `done`: the resolved signals, newest first.
 *
 * A `source` keeps the signals of that plugin's kinds, and a `kind` keeps the
 * signals of that one kind.
 */
export const answerSignalQuery = (signals: readonly Signal[], call: Call): Answer => {
  const query = new URLSearchParams(call.search);
  const view = query.get("view") ?? "to-do";
  const source = query.get("source");
  const kind = query.get("kind");
  const now = Date.now();
  const snoozed = (signal: Signal): boolean =>
    signal.snooze !== undefined && Date.parse(signal.snooze.until) > now;
  const fromSource = signals.filter(
    (signal) =>
      (source === null || signal.kind.startsWith(`${source}/`)) &&
      (kind === null || signal.kind === kind),
  );
  const items =
    view === "done"
      ? fromSource
          .filter((signal) => signal.status === "resolved")
          .toSorted((a, b) => (b.resolution?.at ?? "").localeCompare(a.resolution?.at ?? ""))
      : view === "later"
        ? fromSource
            .filter((signal) => signal.status === "open" && snoozed(signal))
            .toSorted((a, b) => a.snooze!.until.localeCompare(b.snooze!.until))
        : fromSource.filter((signal) => signal.status === "open" && !snoozed(signal));
  return { body: { items } };
};

/**
 * Returns the handlers that answer the sidebar's reads from `records`: the
 * threads, projects, workspaces, resources, runners (and each runner on its
 * own), accounts, the user, the assistants and each assistant's current session. Each list comes back as
 * one page, with no cursor to a next one.
 *
 * They also answer the three reads a Draft Thread adds, which the app makes
 * whenever it opens at `/`: the settings, with none set, the profiles, and
 * the project's planned tasks, of which there are none. And each assistant has
 * an empty core note and no topic, which Settings > Assistants reads.
 */
export const buildSidebarHandlers = (
  records: SidebarRecords,
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/sessions": (call) => answerSessionQuery(records, call),
  "GET /api/v1/assistants": {
    body: { items: (records.assistants ?? []).map(({ assistant }) => assistant) },
  },
  "GET /api/v1/projects": { body: { items: records.projects } },
  "GET /api/v1/workspaces": { body: { items: records.workspaces } },
  "GET /api/v1/resources": { body: { items: records.resources } },
  "GET /api/v1/runners": { body: { items: records.runners } },
  // A machine's page reads each runner on its own too, for what it negotiated.
  // A test of a runner that negotiated something sets its own answer.
  ...Object.fromEntries(
    records.runners.map((runner) => [
      `GET /api/v1/runners/${runner.id}`,
      { body: { ...runner, negotiatedCapabilities: null, protocolVersion: null } },
    ]),
  ),
  "GET /api/v1/provider-accounts": { body: records.accounts },
  "GET /api/v1/model-profiles": { body: records.modelProfiles ?? [] },
  // The providers and harnesses are what the plugins register, so they do not
  // vary with the accounts a test sets up.
  "GET /api/v1/providers": { body: PROVIDERS },
  "GET /api/v1/harnesses": { body: HARNESSES },
  "GET /api/v1/user": { body: { username: records.username } },
  "GET /api/v1/settings": { body: { controller: {}, user: {} } },
  "GET /api/v1/profiles": { body: { items: [] } },
  "GET /api/v1/tasks": { body: { items: [] } },
  // The shell reads what Tracking follows, for the To do count.
  "GET /api/v1/tasks/tracking": { body: { rows: [] } },
  // A draft's composer reads the skills a start would have, for its `$` list.
  "GET /api/v1/sessions/preview-skills": { body: { items: [], skipped: [] } },
  // The shell reads the Connections, for New project and the starter threads.
  "GET /api/v1/connections": { body: { items: [] } },
  // The shell reads To do for Intake's count, and the plugins for its sources.
  "GET /api/v1/signals": (call) => answerSignalQuery(records.signals ?? [], call),
  // The shell reads the Tasks the signals on To do are about (Your work).
  "GET /api/v1/signals/your-work": { body: { tasks: [] } },
  // The shell reads whether a run failed on a Task, for the sidebar's dot.
  "GET /api/v1/tasks/attention": { body: { anyFailure: false } },
  // The shell reads the Inbox's counts, for the Inbox row.
  "GET /api/v1/external-entities/inbox/count": {
    body: buildInboxCounts(),
  },
  // The Inbox screen reads its outline once, for the rail.
  "GET /api/v1/external-entities/inbox/outline": {
    body: buildInboxOutline(),
  },
  "GET /api/v1/plugins": { body: records.plugins ?? [] },
  // Settings > Intake reads the Ignore Rules each time it opens.
  "GET /api/v1/ignore-rules": { body: [] },
  // Settings > Connections reads the event counts each time it opens.
  "GET /api/v1/events/counts": { body: { connections: [] } },
  // Intake reads the workflows, whose names label the signals their runs raised.
  "GET /api/v1/workflows": { body: { items: [] } },
  // The Office reads the runs that are running and those that are pending,
  // and as it opens, the runs that had not ended a minute before.
  "GET /api/v1/runs": (call) => {
    const params = new URLSearchParams(call.search);
    const activeSince = params.get("activeSince");
    const runs = records.runs ?? [];
    if (activeSince !== null) {
      const items = runs.filter((run) => !("finishedAt" in run) || run.finishedAt >= activeSince);
      return { body: { items } };
    }
    return { body: { items: runs.filter((run) => run.status === params.get("status")) } };
  },
  // Settings > Assistants reads the picked assistant's memory.
  ...Object.fromEntries(
    (records.assistants ?? []).flatMap(({ assistant }) =>
      Object.entries(storeMemory(assistant.id, [buildMemoryDocument(MEMORY_CORE, "")])),
    ),
  ),
});

/** The moment every fixture memory document was last written. */
const MEMORY_UPDATED_AT = "2026-10-01T09:00:00.000Z";

/**
 * Returns the memory document `name` holding `body`, with its size counted
 * in characters as the controller counts them, `gist`, and `version`.
 */
export const buildMemoryDocument = (
  name: string,
  body: string,
  gist = "",
  version = 1,
): MemoryDocument => ({
  name,
  gist,
  size: [...body].length,
  body,
  version,
  updatedAt: MEMORY_UPDATED_AT,
});

/**
 * Returns handlers that play the controller's memory of the assistant
 * `assistantId`, on one stored set of documents that starts as `documents`:
 *
 * - the index lists the core note first, then the topics by name;
 * - a document named in `documents` or `newNames` can be read, written and
 *   deleted. A read of one that is not stored answers 404;
 * - a write creates the document when it is not stored, with an empty gist
 *   unless the write sets one, and otherwise replaces its text, and its gist
 *   when the write sets one. The core note keeps an empty gist. Each write
 *   adds one to the version, and a write whose `expectedVersion` is not the
 *   stored version, 0 for a document not stored, answers 409 `conflict`.
 *
 * A handler for the same path, spread after these, answers in its place.
 */
export const storeMemory = (
  assistantId: string,
  documents: readonly MemoryDocument[],
  newNames: readonly string[] = [],
): Readonly<Record<string, Handler>> => {
  let stored = [...documents];
  const base = `/api/v1/assistants/${assistantId}/memory`;
  const listEntries = () =>
    stored
      .map(({ name, gist, size }) => ({ name, gist, size }))
      .toSorted((a, b) =>
        a.name === MEMORY_CORE ? -1 : b.name === MEMORY_CORE ? 1 : a.name < b.name ? -1 : 1,
      );
  const handlers: Record<string, Handler> = { [`GET ${base}`]: () => ({ body: listEntries() }) };
  for (const name of [...documents.map((each) => each.name), ...newNames]) {
    const path = `${base}/${encodeURIComponent(name)}`;
    const notFound = { status: 404, body: buildErrorBody("not_found", `no document ${name}`) };
    handlers[`GET ${path}`] = () => {
      const document = stored.find((each) => each.name === name);
      return document === undefined ? notFound : { body: document };
    };
    handlers[`PUT ${path}`] = (call) => {
      const { body, gist, expectedVersion } = call.body as MemoryWriteInput;
      const previous = stored.find((each) => each.name === name);
      const version = previous?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== version) {
        return {
          status: 409,
          body: buildErrorBody(
            "conflict",
            `${name} is at version ${String(version)}, not ${String(expectedVersion)}`,
          ),
        };
      }
      const written = buildMemoryDocument(
        name,
        body,
        name === MEMORY_CORE ? "" : (gist ?? previous?.gist ?? ""),
        version + 1,
      );
      stored = [...stored.filter((each) => each.name !== name), written];
      return { body: written };
    };
    handlers[`DELETE ${path}`] = () => {
      stored = stored.filter((each) => each.name !== name);
      return { body: {} };
    };
  }
  return handlers;
};

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

/** The projects, resources, workspaces and runner the fixture threads live in. */
export const FIXTURE_WORLD = buildThreadsWorld(WORLD_IDS);

/** The permission profile and Provider Account every fixture thread names. */
const FIXTURE_PROFILE_ID = "01a06d02-7500-7000-8000-000000000001";
export const FIXTURE_ACCOUNT_ID = "01a06d02-7600-7000-8000-000000000001";

/** Returns a fixture thread on moss, with ids the contract accepts. */
const buildFixtureThread = (
  over: Partial<Session> & { readonly id: string; readonly title: string },
): Session =>
  buildSession({
    runnerId: FIXTURE_WORLD.MOSS.id,
    permissionProfileId: FIXTURE_PROFILE_ID,
    providerAccountId: FIXTURE_ACCOUNT_ID,
    harnessId: "claude-code/claude-code",
    ...over,
  });

/**
 * Returns a fixture assistant with every field the contract requires. The
 * caller picks its id, name and main conversation, in the UUIDv7 format the
 * contract accepts.
 */
export const buildFixtureAssistant = (
  over: Partial<Assistant> & Pick<Assistant, "id" | "name" | "mainConversationId">,
): Assistant => ({
  systemPrompt: `You are ${over.name}.`,
  providerAccountId: FIXTURE_ACCOUNT_ID,
  harnessId: null,
  permissionProfileId: FIXTURE_PROFILE_ID,
  accessMode: "auto-accept-edits",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
  ...over,
});

/**
 * Returns a session of `assistant`'s main conversation on moss, idle unless
 * `over` says otherwise.
 */
export const buildFixtureAssistantSession = (
  assistant: Assistant,
  over: Partial<Session> & { readonly id: string },
): Session =>
  buildFixtureThread({
    title: assistant.name,
    agentId: assistant.id,
    conversationId: assistant.mainConversationId,
    ...over,
  });

/** The command approval the fixture's waiting thread asks for. */
export const FIXTURE_APPROVAL_REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/** The fixture threads, one per `FIXTURE_THREAD_IDS` entry. */
export const FIXTURE_THREADS = {
  runbook: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.runbook,
    title: "Write the retry runbook",
    status: "busy",
    openRequests: [FIXTURE_APPROVAL_REQUEST],
    projectId: FIXTURE_WORLD.WEBSHOP_PROJECT.id,
    workspaceId: FIXTURE_WORLD.THREAD_3F1.id,
    createdAt: "2026-09-10T09:05:00.000Z",
    lastActivityAt: "2026-09-10T09:05:00.000Z",
  }),
  flaky: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.flaky,
    title: "Fix flaky webhook tests",
    status: "busy",
    projectId: FIXTURE_WORLD.WEBSHOP_PROJECT.id,
    workspaceId: FIXTURE_WORLD.THREAD_3F1.id,
    createdAt: "2026-09-10T09:04:00.000Z",
    lastActivityAt: "2026-09-10T09:04:00.000Z",
  }),
  bunPin: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.bunPin,
    title: "Bump the Bun pin",
    projectId: FIXTURE_WORLD.WEBSHOP_PROJECT.id,
    workspaceId: FIXTURE_WORLD.PRIMARY.id,
    createdAt: "2026-09-10T09:03:00.000Z",
    lastActivityAt: "2026-09-10T09:03:00.000Z",
  }),
  backupsKey: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.backupsKey,
    title: "Rotate the backups key",
    status: "exited",
    projectId: FIXTURE_WORLD.OPS_PROJECT.id,
    exitedAt: "2026-09-10T09:02:00.000Z",
    createdAt: "2026-09-10T09:02:00.000Z",
    lastActivityAt: "2026-09-10T09:02:00.000Z",
  }),
  pricingPage: buildFixtureThread({
    id: FIXTURE_THREAD_IDS.pricingPage,
    title: "Sketch the pricing page",
    createdAt: "2026-09-10T09:01:00.000Z",
    lastActivityAt: "2026-09-10T09:01:00.000Z",
  }),
};

/**
 * A sidebar with something in every place: two projects, a worktree two
 * threads share, a main workspace, a thread with no workspace, and a thread
 * in no project. One thread waits on an approval, one works, two are idle and
 * one has exited. Each was created when it was last active, so they are
 * listed most recent first by either time, as the controller lists them.
 */
export const SIDEBAR_FIXTURE: SidebarRecords = {
  threads: [
    FIXTURE_THREADS.runbook,
    FIXTURE_THREADS.flaky,
    FIXTURE_THREADS.bunPin,
    FIXTURE_THREADS.backupsKey,
    FIXTURE_THREADS.pricingPage,
  ],
  projects: [FIXTURE_WORLD.WEBSHOP_PROJECT, FIXTURE_WORLD.OPS_PROJECT],
  workspaces: [
    { ...FIXTURE_WORLD.PRIMARY, sessionIds: [FIXTURE_THREAD_IDS.bunPin] },
    FIXTURE_WORLD.THREAD_3F1,
  ],
  resources: [FIXTURE_WORLD.WEBSHOP, FIXTURE_WORLD.INFRA, FIXTURE_WORLD.RUNBOOKS],
  runners: [FIXTURE_WORLD.MOSS],
  accounts: [],
  username: "rogier",
};
