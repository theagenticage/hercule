/**
 * Test helpers shared by the event pipeline's integration tests: a real
 * controller, a fake runner on the runner socket, and helpers to set up
 * subscriptions and events. The boot step's tests and the run engine's tests
 * use them too, which is why they sit at the top of the controller daemon
 * rather than in `events/`.
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
 */
import { expect } from "vitest";
import { Duration, Effect } from "effect";
import type { ModelDescriptor, RunnerFacts, SessionInput } from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { github } from "@hercule/plugin-github";
import { get, post, type ServerHarness } from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  spawnThreadWithGrants,
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
  type SpawnedThread,
  type Arranged,
} from "../sessions/testing";

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

/**
 * Runs `body` against a controller whose pipeline ticks every few
 * milliseconds.
 *
 * A test about what one request does by itself passes an interval longer than
 * any test, so the tick never runs, and the test sees only the request's own
 * work. A test that needs a workflow action of its own, such as one that holds
 * a run until the test releases it, passes that action's plugin in
 * `additionalPlugins`.
 */
export const withPipeline = (
  body: (arranged: Arranged) => Promise<void>,
  {
    additionalPlugins = [],
    ...options
  }: {
    readonly expressionBudget?: Duration.Duration;
    readonly eventRoutingInterval?: Duration.Duration;
    readonly additionalPlugins?: ReadonlyArray<Plugin>;
  } = {},
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [...buildPlugins(), ...additionalPlugins],
    facts: FACTS,
    models: MODELS,
    eventRoutingInterval: TICK,
    ...options,
  });

/** Runs one effect against the harness's database, failing the test if it fails. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

/** Spawns a Thread on a profile that may create and read subscriptions. */
export const spawnSubscriber = (arranged: Arranged, name: string): Promise<SpawnedThread> =>
  spawnThreadWithGrants(arranged, name, ["subscription.write", "subscription.read"]);

/**
 * Spawns a Thread that cannot be resumed once it exits: the fake runner never
 * reports a provider-native session for it, so it has no transcript.
 */
export const spawnStrandedThread = async (
  arranged: Arranged,
  name: string,
): Promise<SpawnedThread> => {
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
export const exitSession = async (
  arranged: Arranged,
  thread: SpawnedThread,
  seq: number,
): Promise<void> => {
  reportExit(arranged, thread.session.id, seq);
  await waitForSession(arranged, thread.session.id, (one) => one.status === "exited");
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

/**
 * Reports the end of the turn that the session's prompt opened, at sequence
 * number 2, and waits until the session is idle. A spawned Thread is `busy`
 * until then, so an input sent to it waits for that turn to end. The test's
 * next event is 3.
 */
export const endPromptTurn = async (arranged: Arranged, thread: SpawnedThread): Promise<void> => {
  reportTurnCompleted(arranged, thread.session.id, 2);
  await waitForSession(arranged, thread.session.id, (one) => one.status === "idle");
};

/** Starts a turn on the session, so a new input has to wait for the turn to end. */
export const makeBusy = async (
  arranged: Arranged,
  thread: SpawnedThread,
  seq: number,
): Promise<void> => {
  reportTurnStarted(arranged, thread.session.id, seq);
  await waitForSession(arranged, thread.session.id, (one) => one.status === "busy");
};

export const subscribeThread = async (
  arranged: Arranged,
  thread: SpawnedThread,
  ref: string,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/subscriptions",
    { target: { kind: "ref", ref } },
    thread.token,
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
  thread: SpawnedThread,
  id: string,
): Promise<ReadSubscription> => {
  const response = await get(arranged.harness.base, "/api/v1/subscriptions", thread.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = ((await response.json()) as { items: ReadonlyArray<ReadSubscription> }).items;
  const found = items.find((one) => one.id === id);
  expect(found, `no subscription ${id} in the page`).toBeDefined();
  return found!;
};

export const readHealth = async (
  arranged: Arranged,
  thread: SpawnedThread,
  id: string,
): Promise<Health> => (await readSubscription(arranged, thread, id)).health;

export const waitForSubscription = (
  arranged: Arranged,
  thread: SpawnedThread,
  id: string,
  ready: (subscription: ReadSubscription) => boolean,
): Promise<ReadSubscription> =>
  waitUntil("reached the subscription state the test waits for", async () => {
    const found = await readSubscription(arranged, thread, id);
    return ready(found) ? found : undefined;
  });

export const waitForHealth = async (
  arranged: Arranged,
  thread: SpawnedThread,
  id: string,
  ready: (health: Health) => boolean,
): Promise<Health> =>
  (await waitForSubscription(arranged, thread, id, (one) => ready(one.health))).health;

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
