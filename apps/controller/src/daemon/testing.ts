/**
 * Test helpers shared by the event pipeline's integration tests: a real
 * controller, a fake runner on the runner socket, and helpers to set up
 * subscriptions and events.
 *
 * Everything runs against the real controller, because a delivery only counts
 * when a frame crosses the socket. Tests never call the pipeline directly: its
 * tick runs with the interval shortened to a few milliseconds, in the same
 * loop `hercule serve` starts, and each test waits for the tick's result
 * rather than for a fixed time.
 *
 * Two things are read straight from the tables, because no operation returns
 * them: the router's cursor row, and the subscription and event an input row
 * was written for.
 *
 * The helpers for the run engine's tests are at the bottom: starting a run,
 * waiting for it to finish, the checks every finished run must pass, and
 * sample workflows.
 */
import { expect } from "vitest";
import { Duration, Effect, Layer, Schema } from "effect";
import type { ModelDescriptor, RunnerFacts, SessionInput } from "@hercule/protocol";
import type { ActionContext, Plugin } from "@hercule/plugin-host";
import { github } from "@hercule/plugin-github";
import type { Issue, Run, RunStatus, RunSummary, StepRecord, Task } from "@hercule/contract";
import { get, post, type ServerHarness } from "../http/testing";
import {
  buildActionPlugin,
  createPluginFixture,
  buildProviderDefinition,
} from "../plugins/testing";
import { EvaluationErrorNotifier } from "../subscriptions";
import {
  spawnAgentWithGrants,
  at,
  listFrames,
  createProfile,
  reportEvent,
  waitForSession,
  spawnSessionOrFail,
  waitForStartFrames,
  readSessionToken,
  waitUntil,
  withFleet as sharedWithFleet,
  type Agent,
  type Arranged,
} from "../sessions/testing";
import { readIssues } from "../workflows/testing";

/** The tick interval in tests: short enough to wait several ticks without a long sleep. */
const TICK = Duration.millis(10);

/**
 * Waits six pipeline ticks, for tests that check that nothing more was sent.
 * There is no result to wait for, so the test waits a fixed time, long enough
 * for any tick that would have sent something to have run.
 */
export const waitOutSeveralTicks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Duration.toMillis(TICK) * 6));

export const KIND = "github.pr.merged";
export const REF = "github:pr:o/r#87";
export const OTHER_REF = "github:pr:o/r#88";
export const PR_URL = "https://github.com/o/r/pull/87";

/** A condition that always fails to evaluate: the payload has no such path. */
export const UNRESOLVABLE = "event.payload.nothing.deeper == 1";

/**
 * The id of the input row a test inserts directly. It must be a UUID v7,
 * because the store reads back only v7 ids. A v4 id would fail on a delivery
 * fiber that no test is waiting on.
 */
export const STRANDED_INPUT_ID = "0199f0b7-0000-7000-8000-000000000000";

/** More events than one pass reads, so the router needs more than one pass. */
export const BURST = 250;

/** A condition that calls a function that does not exist. */
export const UNKNOWN_FUNCTION = 'shout(event.kind) == "X"';

/**
 * A condition that reads the raw payload from the source system. The router
 * leaves the raw payload out of the context, so this condition must fail to
 * evaluate, not evaluate as if the value were null.
 */
export const READS_RAW = "event.raw != null";

export const PROVIDER = buildProviderDefinition("full-provider", { token: "t" });

export const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider"],
  identityPort: 4939,
};

export const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "fast", name: "Fast", isDefault: true, options: [] },
];

export const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "providers", definitions: [PROVIDER] }).plugin,
  github,
];

/** The arguments of one call to the evaluation-error stub. */
export interface Notified {
  readonly subscriptionId: string;
  readonly message: string;
}

/**
 * Returns an evaluation-error notifier that records each call in `calls`.
 * Until notifications are built the real notifier does nothing, and this one
 * lets a test check that a notification happens once per error.
 */
export const buildRecordingNotifier = (
  calls: Array<Notified>,
): Layer.Layer<EvaluationErrorNotifier> =>
  Layer.succeed(EvaluationErrorNotifier, {
    notifyEvaluationError: (subscriptionId: string, message: string) =>
      Effect.sync(() => {
        calls.push({ subscriptionId, message });
      }),
  });

/**
 * Runs `body` against a controller whose pipeline ticks every few
 * milliseconds.
 *
 * A test about what one request does by itself passes an interval longer than
 * any test, so the tick never runs, and the test sees only the request's own
 * work.
 */
export const withPipeline = (
  body: (arranged: Arranged) => Promise<void>,
  options: {
    readonly expressionBudget?: Duration.Duration;
    readonly evaluationErrorNotifier?: Layer.Layer<EvaluationErrorNotifier>;
    readonly eventRoutingInterval?: Duration.Duration;
  } = {},
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: buildPlugins(),
    facts: FACTS,
    models: MODELS,
    eventRoutingInterval: TICK,
    ...options,
  });

/** Runs one effect against the harness's database, failing the test if it fails. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

/** Spawns a session on a profile that may create and read subscriptions. */
export const spawnSubscriber = (arranged: Arranged, name: string): Promise<Agent> =>
  spawnAgentWithGrants(arranged, name, ["subscription.write", "subscription.read"]);

/**
 * Spawns a session that cannot be resumed once it exits: the fake runner never
 * reports a provider-native session for it, so it has no transcript.
 */
export const spawnStrandedAgent = async (arranged: Arranged, name: string): Promise<Agent> => {
  const profile = await createProfile(arranged, name, ["subscription.write", "subscription.read"]);
  const opened = await spawnSessionOrFail(arranged, {
    prompt: "hello",
    permissionProfileId: profile.id,
  });
  const token = readSessionToken((await waitForStartFrames(arranged, opened.id, 1))[0]!);
  return { session: opened, token };
};

const reportExit = (arranged: Arranged, sessionId: string, seq: number): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });

/** Reports the session's exit from the fake runner, and waits until the session is exited. */
export const exitSession = async (arranged: Arranged, agent: Agent, seq: number): Promise<void> => {
  reportExit(arranged, agent.session.id, seq);
  await waitForSession(arranged, agent.session.id, (one) => one.status === "exited");
};

export const reportTurnStarted = (arranged: Arranged, sessionId: string, seq: number): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId: `t${String(seq)}`,
  });

export const reportTurnCompleted = (arranged: Arranged, sessionId: string, seq: number): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.completed",
    turnId: `t${String(seq - 1)}`,
    state: "completed",
  });

/** Starts a turn on the session, so a new input has to wait for the turn to end. */
export const makeBusy = async (arranged: Arranged, agent: Agent, seq: number): Promise<void> => {
  reportTurnStarted(arranged, agent.session.id, seq);
  await waitForSession(arranged, agent.session.id, (one) => one.status === "busy");
};

export const subscribeAgent = async (
  arranged: Arranged,
  agent: Agent,
  ref: string,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/subscriptions",
    { target: { kind: "ref", ref } },
    agent.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { subscriptionId: string }).subscriptionId;
};

export interface Health {
  readonly state: string;
  readonly message?: string;
  readonly at?: string;
}

/** A wake-up that a restart cancelled, as the subscription list returns it. */
export interface LostWakeUp {
  readonly eventId: number;
  readonly at: string;
}

/** One subscription, as its holder reads it through the API. */
export interface ReadSubscription {
  readonly id: string;
  readonly health: Health;
  readonly lostWakeUp: LostWakeUp | null;
}

export const readSubscription = async (
  arranged: Arranged,
  agent: Agent,
  id: string,
): Promise<ReadSubscription> => {
  const response = await get(arranged.harness.base, "/api/v1/subscriptions", agent.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = ((await response.json()) as { items: ReadonlyArray<ReadSubscription> }).items;
  const found = items.find((one) => one.id === id);
  expect(found, `no subscription ${id} in the page`).toBeDefined();
  return found!;
};

export const readHealth = async (arranged: Arranged, agent: Agent, id: string): Promise<Health> =>
  (await readSubscription(arranged, agent, id)).health;

export const waitForSubscription = (
  arranged: Arranged,
  agent: Agent,
  id: string,
  ready: (subscription: ReadSubscription) => boolean,
): Promise<ReadSubscription> =>
  waitUntil("reached the subscription state the test waits for", async () => {
    const found = await readSubscription(arranged, agent, id);
    return ready(found) ? found : undefined;
  });

export const waitForHealth = async (
  arranged: Arranged,
  agent: Agent,
  id: string,
  ready: (health: Health) => boolean,
): Promise<Health> =>
  (await waitForSubscription(arranged, agent, id, (one) => ready(one.health))).health;

export const buildPayload = (title: string): unknown => ({
  subject: { repo: "o/r", number: 87, title, url: PR_URL },
});

/** Emits one manual event through the API. Returns its event id. */
export const emitManualEvent = async (
  arranged: Arranged,
  refs: ReadonlyArray<string>,
  title: string,
): Promise<number> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/events/emit",
    { kind: KIND, payload: buildPayload(title), refs },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { eventId: number }).eventId;
};

/** One matched input row: the event it came from, and the text the session receives. */
export interface MatchedInputRow {
  readonly event_id: number;
  readonly source: string;
  readonly status: string;
  readonly text: string;
  readonly reason: string | null;
  readonly session: string;
}

export const readMatchedInputRows = (
  harness: ServerHarness,
  subscriptionId: string,
): Promise<ReadonlyArray<MatchedInputRow>> =>
  runEffect(
    harness.sql<MatchedInputRow>`
      SELECT event_id, source, status, text, reason, lower(hex(session_id)) AS session
      FROM session_inputs
      WHERE subscription_id = unhex(replace(${subscriptionId}, '-', ''))
      ORDER BY created_at, id`,
  );

export const waitForMatchedInputRows = (
  harness: ServerHarness,
  subscriptionId: string,
  ready: (rows: ReadonlyArray<MatchedInputRow>) => boolean,
): Promise<ReadonlyArray<MatchedInputRow>> =>
  waitUntil("wrote the matched inputs", async () => {
    const rows = await readMatchedInputRows(harness, subscriptionId);
    return ready(rows) ? rows : undefined;
  });

/** Reads the router's cursor and the id of the newest event in the log. */
export const readCursorAndHead = async (
  harness: ServerHarness,
): Promise<{ readonly position: number | null; readonly head: number }> => {
  const rows = await runEffect(
    harness.sql<{ readonly position: number | null; readonly head: number | null }>`
      SELECT (SELECT position FROM event_cursors WHERE consumer = 'router') AS position,
             (SELECT MAX(id) FROM events) AS head`,
  );
  return { position: rows[0]?.position ?? null, head: rows[0]?.head ?? 0 };
};

/**
 * Waits until the router's cursor reaches the end of the log, and returns it.
 * The cursor and the newest event id are read in one statement, so they
 * always come from the same moment.
 */
export const waitUntilCaughtUp = (harness: ServerHarness): Promise<number> =>
  waitUntil("walked the log to its end", async () => {
    const seen = await readCursorAndHead(harness);
    return seen.position !== null && seen.position === seen.head ? seen.position : undefined;
  });

/** One subscription's stored row, read straight from the table. */
export interface SubscriptionRow {
  readonly ended_at: string | null;
  readonly ended_reason: string | null;
  readonly ended_actor: string | null;
  readonly condition: string;
  readonly health_error_message: string | null;
  readonly lost_wake_up_event_id: number | null;
}

export const readSubscriptionRow = async (
  harness: ServerHarness,
  id: string,
): Promise<SubscriptionRow | undefined> => {
  const rows = await runEffect(
    harness.sql<SubscriptionRow>`
      SELECT ended_at, ended_reason, ended_actor, condition,
             health_error_message, lost_wake_up_event_id FROM subscriptions
      WHERE id = unhex(replace(${id}, '-', ''))`,
  );
  return rows[0];
};

/**
 * Overwrites a subscription's stored condition. `subscription.create` stores
 * only conditions it builds from a target, so a test that needs a failing
 * condition writes it straight into the row the router reads.
 */
export const storeCondition = (
  harness: ServerHarness,
  id: string,
  condition: string,
): Promise<unknown> =>
  runEffect(
    harness.sql`UPDATE subscriptions SET condition = ${condition}
                WHERE id = unhex(replace(${id}, '-', ''))`,
  );

export const listInputFrames = (arranged: Arranged): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(arranged.wire, "sessionInput");

/** Lists the input frames sent so far whose text contains `text`. */
export const listFramesCarrying = (arranged: Arranged, text: string): ReadonlyArray<SessionInput> =>
  listInputFrames(arranged).filter((frame) => frame.input.text.includes(text));

export const waitForFrameCarrying = (arranged: Arranged, text: string): Promise<SessionInput> =>
  waitUntil(`sent a frame carrying ${text}`, () => listFramesCarrying(arranged, text)[0]);

/* ------------------------------------------------------------------------ */
/* Runs: helpers to start runs, wait for them to finish, and check what a   */
/* finished run keeps.                                                       */
/* ------------------------------------------------------------------------ */

const FINAL_STATUSES: ReadonlyArray<RunStatus> = ["completed", "failed", "cancelled"];

/**
 * How far along a status is. A run or a step record may only move to a status
 * with a higher rank, and once final it never changes again.
 */
const STATUS_RANK: Record<RunStatus, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

export const requestRun = (base: string, token: string, workflowId: string, body: unknown = {}) =>
  post(base, `/api/v1/workflows/${workflowId}/run`, body, token);

/**
 * Starts a run of a stored workflow and returns its id. Fails the test if the
 * request is refused, or if the response holds anything but the run id.
 */
export const startRun = async (
  base: string,
  token: string,
  workflowId: string,
  body: unknown = {},
): Promise<string> => {
  const response = await requestRun(base, token, workflowId, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const started = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(started)).toEqual(["runId"]);
  expect(started["runId"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return started["runId"] as string;
};

export const readRun = async (base: string, token: string, id: string): Promise<Run> => {
  const response = await get(base, `/api/v1/runs/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Run;
};

/** Fails the test if any status moved backwards between two reads of the same run. */
const expectMovedForward = (earlier: Run, later: Run): void => {
  const describeMove = (what: string, from: RunStatus, to: RunStatus) =>
    `${what} went from ${from} to ${to}`;
  expect(
    STATUS_RANK[later.status],
    describeMove("the run", earlier.status, later.status),
  ).toBeGreaterThanOrEqual(STATUS_RANK[earlier.status]);
  if (FINAL_STATUSES.includes(earlier.status)) {
    expect(later.status, describeMove("the finished run", earlier.status, later.status)).toBe(
      earlier.status,
    );
  }
  for (const before of earlier.steps) {
    const what = `step record ${before.stepId}#${String(before.iteration)}`;
    const after = later.steps.find(
      (record) => record.stepId === before.stepId && record.iteration === before.iteration,
    );
    expect(after, `${what} disappeared`).toBeDefined();
    expect(
      STATUS_RANK[after!.status],
      describeMove(what, before.status, after!.status),
    ).toBeGreaterThanOrEqual(STATUS_RANK[before.status]);
    if (FINAL_STATUSES.includes(before.status)) {
      expect(after!.status, describeMove(what, before.status, after!.status)).toBe(before.status);
    }
  }
};

/**
 * Checks what every finished run keeps true:
 * - its status is final, it has `finishedAt`, and it has a failure reason
 *   exactly when it failed;
 * - none of its step records is still `pending` or `running`;
 * - the first record of every step has iteration 1;
 * - every timestamp is at or after the one before it.
 */
const expectFinishedRun = (run: Run): void => {
  const where = `run ${run.id}: ${JSON.stringify(run)}`;
  expect(FINAL_STATUSES, where).toContain(run.status);
  expect(run.finishedAt, where).toBeDefined();
  expect(run.failureReason !== undefined, where).toBe(run.status === "failed");
  if (run.startedAt !== undefined) {
    expect(run.startedAt >= run.createdAt, where).toBe(true);
    expect(run.finishedAt! >= run.startedAt, where).toBe(true);
  }
  for (const record of run.steps) {
    expect(["pending", "running"], where).not.toContain(record.status);
    if (record.startedAt !== undefined && record.finishedAt !== undefined) {
      expect(record.finishedAt >= record.startedAt, where).toBe(true);
    }
  }
  const stepIds = new Set(run.steps.map((record) => record.stepId));
  for (const stepId of stepIds) {
    const iterations = run.steps
      .filter((record) => record.stepId === stepId)
      .map((record) => record.iteration);
    expect(Math.min(...iterations), `${stepId} in ${where}`).toBe(1);
  }
};

/**
 * Reads the run over and over until its status is final, and returns the
 * final read. Every read is compared with the read before it, and the final
 * read is checked with `expectFinishedRun`.
 */
export const waitForRunToFinish = async (base: string, token: string, id: string): Promise<Run> => {
  let previous: Run | undefined;
  const finished = await waitUntil(`finished run ${id}`, async () => {
    const run = await readRun(base, token, id);
    if (previous !== undefined) expectMovedForward(previous, run);
    previous = run;
    return FINAL_STATUSES.includes(run.status) ? run : undefined;
  });
  expectFinishedRun(finished);
  return finished;
};

/** Returns how many runs the database holds. No operation lists runs yet, so the table is read directly. */
export const countRuns = async (harness: ServerHarness): Promise<number> => {
  const rows = await runEffect(
    harness.sql<{ readonly count: number }>`SELECT count(*) AS count FROM runs`,
  );
  return rows[0]!.count;
};

/**
 * Checks that the run request was refused with `validation`, with one issue
 * whose path starts with each of `prefixes` and no other issue, and that no
 * run was created. Returns the issues.
 */
export const expectRefusedAt = async (
  harness: ServerHarness,
  response: Response,
  prefixes: ReadonlyArray<ReadonlyArray<string>>,
  description = "the run request",
): Promise<ReadonlyArray<Issue>> => {
  const issues = await readIssues(response);
  const shown = `${description}: ${JSON.stringify(issues)}`;
  expect(issues, shown).toHaveLength(prefixes.length);
  for (const prefix of prefixes) {
    const matching = issues.filter((issue) =>
      prefix.every((segment, index) => issue.path[index] === segment),
    );
    expect(matching, `one issue under ${JSON.stringify(prefix)} in ${shown}`).toHaveLength(1);
  }
  expect(await countRuns(harness), description).toBe(0);
  return issues;
};

export const readTask = async (base: string, token: string, id: string): Promise<Task> => {
  const response = await get(base, `/api/v1/tasks/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

export const listTasks = async (base: string, token: string): Promise<ReadonlyArray<Task>> => {
  const response = await get(base, "/api/v1/tasks", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Task> }).items;
};

/** Returns the step records of one step, in the order the run created them. */
export const findRecords = (run: Run, stepId: string): ReadonlyArray<StepRecord> =>
  run.steps.filter((record) => record.stepId === stepId);

/* ------------------------------------------------------------------------ */
/* Workflow definitions for the run tests.                                   */
/* ------------------------------------------------------------------------ */

/**
 * Two steps: the first creates a task titled from the `title` input, the
 * second moves that task to in-progress. The second step reads the task id
 * from the first step's output.
 */
export const FILE_AND_START_DEFINITION = {
  name: "File and start a task",
  inputs: [{ name: "title", schema: { type: "string", minLength: 1 }, required: true }],
  steps: [
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: {
        title: "{{ inputs.title }}",
        description: "Filed by a run.",
        provenance: [{ ref: "test:ticket:79" }],
      },
    },
    {
      id: "update",
      kind: "action",
      action: "task.update",
      params: { taskId: "{{ steps.create.output.id }}", status: "in-progress" },
    },
  ],
  edges: [{ from: "create", to: "update" }],
};

/**
 * One step that creates a task, with an input of every kind a run resolves:
 * - `title`: required, with a JSON Schema;
 * - `priority`: optional, with a default;
 * - `note`: optional, with no default, so it is absent when not given;
 * - `repo`: optional, a GitHub Connection.
 */
export const INPUTS_DEFINITION = {
  name: "File a task from inputs",
  inputs: [
    { name: "title", schema: { type: "string", minLength: 1 }, required: true },
    {
      name: "priority",
      schema: { type: "string", enum: ["urgent", "high", "normal", "low"] },
      required: false,
      default: "high",
    },
    { name: "note", schema: { type: "string" }, required: false },
    { name: "repo", connection: { type: "github/github" }, required: false },
  ],
  steps: [
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: { title: "{{ inputs.title }}", description: "", priority: "{{ inputs.priority }}" },
    },
  ],
};

/** Builds an action step that creates a task, for definitions that only need some step to exist. */
export const buildCreateStep = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "action",
  action: "task.create",
  params: { title: `File the ${id} task`, description: "" },
  ...extra,
});

/* ------------------------------------------------------------------------ */
/* Submitting, listing and cancelling runs.                                  */
/* ------------------------------------------------------------------------ */

export const requestSubmit = (base: string, token: string, body: unknown) =>
  post(base, "/api/v1/workflows/submit", body, token);

/**
 * Submits a workflow and returns the new run's id. Fails the test if the
 * request is refused, or if the response holds anything but the run id.
 */
export const submitRun = async (base: string, token: string, body: unknown): Promise<string> => {
  const response = await requestSubmit(base, token, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const started = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(started)).toEqual(["runId"]);
  return started["runId"] as string;
};

/** One page of the run list. */
export interface RunPage {
  readonly items: ReadonlyArray<RunSummary>;
  readonly nextCursor?: string;
}

/**
 * Reads one page of the run list. `query` is the query string without the
 * `?`, such as `status=failed&limit=2`. Fails the test if the request is
 * refused.
 */
export const queryRuns = async (base: string, token: string, query = ""): Promise<RunPage> => {
  const response = await get(base, `/api/v1/runs${query === "" ? "" : `?${query}`}`, token);
  expect(response.status, `${query}: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as RunPage;
};

export const requestCancel = (base: string, token: string, id: string) =>
  post(base, `/api/v1/runs/${id}/cancel`, {}, token);

/**
 * A plugin action that does not return until the test releases it or its run
 * is cancelled. A run with a step of this action stays `running` for as long
 * as the test needs, so the test can act on a run it knows is unfinished.
 */
export interface HeldAction {
  readonly plugin: Plugin;
  /** The qualified id a step uses to call the action. */
  readonly actionId: string;
  /** The context of every execution so far, in the order they started. */
  readonly contexts: ReadonlyArray<ActionContext>;
  /** Ends every execution that is waiting, and makes every later one return at once. */
  readonly release: () => void;
}

/**
 * Builds a plugin `hold` with one action `hold/wait`. The action takes a
 * `label` and returns `{ released: true }` once the test calls `release`, or
 * once its cancel signal aborts.
 *
 * It returns normally on abort, rather than failing, so a test can check that
 * a cancelled run ignores what an action returns after the cancel.
 */
export const buildHeldAction = (): HeldAction => {
  const contexts: Array<ActionContext> = [];
  const waiting: Array<() => void> = [];
  let released = false;
  const release = (): void => {
    released = true;
    for (const finish of waiting.splice(0)) finish();
  };
  const plugin = buildActionPlugin("hold", {
    id: "wait",
    displayName: "Wait",
    description: "Waits until the test releases it, or until its run is cancelled.",
    input: Schema.Struct({ label: Schema.String }),
    output: Schema.Struct({ released: Schema.Boolean }),
    execute: (_input, context) =>
      Effect.callback<{ released: boolean }>((resume) => {
        contexts.push(context);
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resume(Effect.succeed({ released: true }));
        };
        if (released) return finish();
        waiting.push(finish);
        context.signal.addEventListener("abort", finish);
      }),
  });
  return { plugin, actionId: "hold/wait", contexts, release };
};

/** Builds a step that calls the held action. */
export const buildHeldStep = (held: HeldAction, id: string) => ({
  id,
  kind: "action",
  action: held.actionId,
  params: { label: id },
});

/** Waits until the held action has started `count` executions, and returns their contexts. */
export const waitForHeldExecutions = (
  held: HeldAction,
  count: number,
): Promise<ReadonlyArray<ActionContext>> =>
  waitUntil(`started ${String(count)} held action(s)`, () =>
    held.contexts.length >= count ? held.contexts : undefined,
  );

/**
 * Runs `body` against a controller with one connected runner, so sessions can
 * be spawned with the grants a test needs, and with `plugins` installed next
 * to the agent provider.
 */
export const withRunFleet = (
  body: (arranged: Arranged) => Promise<void>,
  plugins: ReadonlyArray<Plugin> = [],
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [createPluginFixture({ id: "providers", definitions: [PROVIDER] }).plugin, ...plugins],
    facts: FACTS,
    models: MODELS,
  });

/**
 * Inserts a run of `workflowId` with the status `pending` and one pending
 * step record for `stepId`, the rows a run has between its start request and
 * the moment the engine picks it up. No request can hold a run at `pending`,
 * so the rows are written directly.
 */
export const insertPendingRun = (
  harness: ServerHarness,
  fields: {
    readonly id: string;
    readonly workflowId: string;
    readonly plan: unknown;
    readonly stepId: string;
  },
): Promise<void> => {
  const createdAt = new Date().toISOString();
  return runEffect(
    Effect.andThen(
      harness.sql`
        INSERT INTO runs (id, workflow_id, plan, inputs, origin, status, created_at)
        VALUES
          (unhex(replace(${fields.id}, '-', '')),
           unhex(replace(${fields.workflowId}, '-', '')),
           ${JSON.stringify(fields.plan)}, ${JSON.stringify({})},
           ${JSON.stringify({ kind: "manual", actor: "user" })}, 'pending', ${createdAt})`,
      harness.sql`
        INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
        VALUES (unhex(replace(${fields.id}, '-', '')), ${fields.stepId}, 1, 'pending', ${createdAt})`,
    ),
  ).then(() => undefined);
};
