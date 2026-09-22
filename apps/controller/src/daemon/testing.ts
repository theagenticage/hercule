/**
 * The harness the event pipeline's integration suites share: a real
 * controller, a real machine on the runner socket, and the arrangements a
 * subscription and an event need.
 *
 * Everything here runs against the real controller, because a delivery is only
 * a delivery when a frame crosses that socket. The pipeline is never called by
 * hand: its tick runs with the interval shrunk to a few milliseconds, which is
 * the same loop `hercule serve` forks, and each case waits for what the tick
 * did rather than for a clock.
 *
 * Two things are read from the tables rather than through an operation,
 * because no operation answers them: the router's own cursor row, and which
 * subscription and event an input row was written for.
 */
import { expect } from "vitest";
import { Duration, Effect, Layer } from "effect";
import type { ModelDescriptor, RunnerFacts, SessionInput } from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { github } from "@hercule/plugin-github";
import { get, post, type ServerHarness } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import { EvaluationErrorNotifier } from "../subscriptions";
import {
  agentHolding,
  at,
  framesOf,
  createProfile,
  report,
  sessionWhen,
  spawned,
  startFrames,
  readSessionToken,
  until,
  withFleet as sharedWithFleet,
  type Agent,
  type Arranged,
} from "../sessions/testing";

/** Short enough that a test waits out several ticks without a long sleep. */
const TICK = Duration.millis(10);

/**
 * Waits out several ticks of the pipeline, for a case whose criterion is that
 * nothing more went out. There is nothing to wait for, so the wait is a span
 * of time: six ticks, which is long enough that a tick that would have sent
 * something has run.
 */
export const waitOutSeveralTicks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Duration.toMillis(TICK) * 6));

export const KIND = "github.pr.merged";
export const REF = "github:pr:o/r#87";
export const OTHER_REF = "github:pr:o/r#88";
export const PR_URL = "https://github.com/o/r/pull/87";

/** A condition no evaluation can answer: the payload has no such path. */
export const UNRESOLVABLE = "event.payload.nothing.deeper == 1";

/**
 * The id of the row a test writes by hand. Canonical v7, because that is the
 * only shape the store reads back: a v4 is refused, and the refusal lands on
 * a delivery fiber nobody is waiting on.
 */
export const STRANDED_INPUT_ID = "0199f0b7-0000-7000-8000-000000000000";

/** More events than one pass reads, so the router has to pass again to finish. */
export const BURST = 250;

/** A condition that calls a function nobody registered. */
export const UNKNOWN_FUNCTION = 'shout(event.kind) == "X"';

/**
 * A condition reading the original payload the source system sent. The router
 * does not put it in the context at all, so this must fail rather than answer
 * that there is none.
 */
export const READS_RAW = "event.raw != null";

export const PROVIDER = providerDefinition("full-provider", { token: "t" });

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

export const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [PROVIDER] }).plugin,
  github,
];

/** What one call of the evaluation-error stub was told. */
export interface Notified {
  readonly subscriptionId: string;
  readonly message: string;
}

/**
 * The stub that the notification ticket will fill in. It records instead of
 * doing nothing, so "once per error" is something a test can read.
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
 * A controller whose pipeline ticks fast enough for a test to wait it out.
 *
 * A case about what one request does on its own hands over an interval no test
 * outlives, which stops the tick from running at all: what is then observed is
 * the request's own work and nothing else's.
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
    plugins: registry(),
    facts: FACTS,
    models: MODELS,
    eventRoutingInterval: TICK,
    ...options,
  });

/** Runs one effect against the harness's database, failing the test if it fails. */
export const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

/** A session on a profile that may subscribe and read back what it subscribed to. */
export const spawnSubscriber = (arranged: Arranged, name: string): Promise<Agent> =>
  agentHolding(arranged, name, ["subscription.write", "subscription.read"]);

/**
 * A session that exited leaving nothing to resume: its machine never reported
 * a provider-native session, so the transcript is gone.
 */
export const spawnStrandedAgent = async (arranged: Arranged, name: string): Promise<Agent> => {
  const profile = await createProfile(arranged, name, ["subscription.write", "subscription.read"]);
  const opened = await spawned(arranged, { prompt: "hello", permissionProfileId: profile.id });
  const token = readSessionToken((await startFrames(arranged, opened.id, 1))[0]!);
  return { session: opened, token };
};

const reportExit = (arranged: Arranged, sessionId: string, seq: number): void =>
  report(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });

/** Ends a session the way its machine ends one, and answers the ended row. */
export const exit = async (arranged: Arranged, agent: Agent, seq: number): Promise<void> => {
  reportExit(arranged, agent.session.id, seq);
  await sessionWhen(arranged, agent.session.id, (one) => one.status === "exited");
};

export const turnStarted = (arranged: Arranged, sessionId: string, seq: number): void =>
  report(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId: `t${String(seq)}`,
  });

export const turnCompleted = (arranged: Arranged, sessionId: string, seq: number): void =>
  report(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.completed",
    turnId: `t${String(seq - 1)}`,
    state: "completed",
  });

/** Puts a session on a running turn, so an input has to wait for a boundary. */
export const madeBusy = async (arranged: Arranged, agent: Agent, seq: number): Promise<void> => {
  turnStarted(arranged, agent.session.id, seq);
  await sessionWhen(arranged, agent.session.id, (one) => one.status === "busy");
};

export const subscribed = async (
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

/** The wake-up a restart cancelled, as a subscription answers it. */
export interface LostWakeUp {
  readonly eventId: number;
  readonly at: string;
}

/** One subscription, as its holder reads it back. */
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

export const subscriptionWhen = (
  arranged: Arranged,
  agent: Agent,
  id: string,
  ready: (subscription: ReadSubscription) => boolean,
): Promise<ReadSubscription> =>
  until("answered the subscription the holder was waiting on", async () => {
    const found = await readSubscription(arranged, agent, id);
    return ready(found) ? found : undefined;
  });

export const healthWhen = async (
  arranged: Arranged,
  agent: Agent,
  id: string,
  ready: (health: Health) => boolean,
): Promise<Health> =>
  (await subscriptionWhen(arranged, agent, id, (one) => ready(one.health))).health;

export const buildPayload = (title: string): unknown => ({
  subject: { repo: "o/r", number: 87, title, url: PR_URL },
});

/** One manual event, through the operation a person calls. */
export const emitted = async (
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

/** One matched input: which event it came from, and what the session will read. */
export interface MatchedInputRow {
  readonly event_id: number;
  readonly source: string;
  readonly status: string;
  readonly text: string;
  readonly reason: string | null;
  readonly session: string;
}

export const matchedInputRows = (
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

export const rowsWhen = (
  harness: ServerHarness,
  subscriptionId: string,
  ready: (rows: ReadonlyArray<MatchedInputRow>) => boolean,
): Promise<ReadonlyArray<MatchedInputRow>> =>
  until("wrote the matched inputs", async () => {
    const rows = await matchedInputRows(harness, subscriptionId);
    return ready(rows) ? rows : undefined;
  });

/** The router's cursor, beside the position of the newest entry in the log. */
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
 * The cursor once it has reached the end of the log. Read together with the
 * head in one statement, so the pair can never be half a tick apart.
 */
export const caughtUp = (harness: ServerHarness): Promise<number> =>
  until("walked the log to its end", async () => {
    const seen = await readCursorAndHead(harness);
    return seen.position !== null && seen.position === seen.head ? seen.position : undefined;
  });

/** One subscription's stored row, which is where an ended one is read. */
export interface SubscriptionRow {
  readonly ended_at: string | null;
  readonly ended_reason: string | null;
  readonly ended_actor: string | null;
  readonly condition: string;
  readonly health_error_message: string | null;
  readonly lost_wake_up_event_id: number | null;
}

export const subscriptionRow = async (
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
 * Rewrites a stored condition. `subscription.create` stores only what it
 * expanded from a target, so a condition that fails is arranged on the row the
 * router reads rather than asked for through an operation that would refuse
 * it.
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

export const inputFrames = (arranged: Arranged): ReadonlyArray<SessionInput> =>
  framesOf<SessionInput>(arranged.wire, "sessionInput");

/** Whether a frame carrying this text has crossed the socket. */
export const sentFrames = (arranged: Arranged, text: string): ReadonlyArray<SessionInput> =>
  inputFrames(arranged).filter((frame) => frame.input.text.includes(text));

export const frameWhen = (arranged: Arranged, text: string): Promise<SessionInput> =>
  until(`sent a frame carrying ${text}`, () => sentFrames(arranged, text)[0]);
