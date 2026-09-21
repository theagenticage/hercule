/**
 * The matcher, running: a live subscription, an event carrying the ref it
 * waits for, and the row that wakes the session holding it.
 *
 * Everything here runs against the real controller with a real machine on the
 * runner socket, because a delivery is only a delivery when a frame crosses
 * that socket. The matcher is never called by hand: the polling loop runs with
 * the interval shrunk to a few milliseconds, which is the same loop `hercule
 * serve` forks, and each case waits for what the loop did rather than for a
 * clock.
 *
 * Two things are read from the tables rather than through an operation,
 * because no operation answers them: the matcher's own cursor row, and which
 * subscription and event an input row was written for.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect, Layer } from "effect";
import type { ModelDescriptor, RunnerFacts, SessionInput } from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { github } from "@hercule/plugin-github";
import { get, post, type ServerHarness } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import { EvaluationErrorNotifier } from "../subscriptions";
import {
  agentOn,
  at,
  framesOf,
  profileOf,
  readSession,
  report,
  sessionWhen,
  spawned,
  startFrames,
  tokenOf,
  until,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Agent,
  type Arranged,
} from "../sessions/testing";

/** A fleet, three sessions and several ticks fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

/** Short enough that a test waits out several ticks without a sleep of its own. */
const TICK = Duration.millis(10);

const KIND = "github.pr.merged";
const REF = "github:pr:o/r#87";
const OTHER_REF = "github:pr:o/r#88";
const PR_URL = "https://github.com/o/r/pull/87";

/** A condition no evaluation can answer: the payload has no such path. */
const UNRESOLVABLE = "event.payload.nothing.deeper == 1";

/** A condition that calls a function nobody registered. */
const UNKNOWN_FUNCTION = 'shout(event.kind) == "X"';

const PROVIDER = providerDefinition("full-provider", { token: "t" });

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "fast", name: "Fast", isDefault: true, options: [] },
];

const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [PROVIDER] }).plugin,
  github,
];

/** What one call of the evaluation-error stub was told. */
interface Notified {
  readonly subscriptionId: string;
  readonly message: string;
}

/**
 * The stub that the notification ticket will fill in, recording instead of
 * doing nothing, so "once per streak" is something a test can read.
 */
const recording = (calls: Array<Notified>): Layer.Layer<EvaluationErrorNotifier> =>
  Layer.succeed(EvaluationErrorNotifier, {
    notifyEvaluationError: (subscriptionId: string, message: string) =>
      Effect.sync(() => {
        calls.push({ subscriptionId, message });
      }),
  });

/** A controller whose matcher ticks fast enough for a test to wait it out. */
const withMatcher = (
  body: (arranged: Arranged) => Promise<void>,
  options: {
    readonly expressionBudget?: Duration.Duration;
    readonly evaluationErrorNotifier?: Layer.Layer<EvaluationErrorNotifier>;
  } = {},
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: registry(),
    facts: FACTS,
    models: MODELS,
    eventMatchInterval: TICK,
    ...options,
  });

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.orDie(effect));

/** A session on a profile that may subscribe and read back what it subscribed to. */
const subscriber = async (arranged: Arranged, name: string): Promise<Agent> =>
  agentOn(arranged, await profileOf(arranged, name, ["subscription.write", "subscription.read"]));

/**
 * A session that exited leaving nothing to resume: its machine never reported
 * a provider-native session, so the transcript is gone.
 */
const stranded = async (arranged: Arranged, name: string): Promise<Agent> => {
  const profile = await profileOf(arranged, name, ["subscription.write", "subscription.read"]);
  const opened = await spawned(arranged, { prompt: "hello", permissionProfileId: profile.id });
  const token = tokenOf((await startFrames(arranged, opened.id, 1))[0]!);
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
const exit = async (arranged: Arranged, agent: Agent, seq: number): Promise<void> => {
  reportExit(arranged, agent.session.id, seq);
  await sessionWhen(arranged, agent.session.id, (one) => one.status === "exited");
};

const turnStarted = (arranged: Arranged, sessionId: string, seq: number): void =>
  report(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId: `t${String(seq)}`,
  });

const turnCompleted = (arranged: Arranged, sessionId: string, seq: number): void =>
  report(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.completed",
    turnId: `t${String(seq - 1)}`,
    state: "completed",
  });

/** Puts a session on a running turn, so an input has to wait for a boundary. */
const madeBusy = async (arranged: Arranged, agent: Agent, seq: number): Promise<void> => {
  turnStarted(arranged, agent.session.id, seq);
  await sessionWhen(arranged, agent.session.id, (one) => one.status === "busy");
};

const subscribed = async (arranged: Arranged, agent: Agent, ref: string): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/subscriptions",
    { target: { kind: "ref", ref } },
    agent.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { subscriptionId: string }).subscriptionId;
};

interface Health {
  readonly state: string;
  readonly message?: string;
  readonly at?: string;
}

const healthOf = async (arranged: Arranged, agent: Agent, id: string): Promise<Health> => {
  const response = await get(arranged.harness.base, "/api/v1/subscriptions", agent.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = (
    (await response.json()) as {
      items: ReadonlyArray<{ readonly id: string; readonly health: Health }>;
    }
  ).items;
  const found = items.find((one) => one.id === id);
  expect(found, `no subscription ${id} in the page`).toBeDefined();
  return found!.health;
};

const healthWhen = (
  arranged: Arranged,
  agent: Agent,
  id: string,
  ready: (health: Health) => boolean,
): Promise<Health> =>
  until("reported the subscription's health", async () => {
    const health = await healthOf(arranged, agent, id);
    return ready(health) ? health : undefined;
  });

const payloadOf = (title: string): unknown => ({
  subject: { repo: "o/r", number: 87, title, url: PR_URL },
});

/** One manual event, through the operation a person calls. */
const emitted = async (
  arranged: Arranged,
  refs: ReadonlyArray<string>,
  title: string,
): Promise<number> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/events/emit",
    { kind: KIND, payload: payloadOf(title), refs },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { eventId: number }).eventId;
};

/** One effect row: which event it came from, and what the session will read. */
interface EffectRow {
  readonly event_id: number;
  readonly source: string;
  readonly status: string;
  readonly text: string;
  readonly reason: string | null;
  readonly session: string;
}

const effectRows = (
  harness: ServerHarness,
  subscriptionId: string,
): Promise<ReadonlyArray<EffectRow>> =>
  run(
    harness.sql<EffectRow>`
      SELECT event_id, source, status, text, reason, lower(hex(session_id)) AS session
      FROM session_inputs
      WHERE subscription_id = unhex(replace(${subscriptionId}, '-', ''))
      ORDER BY created_at, id`,
  );

const rowsWhen = (
  harness: ServerHarness,
  subscriptionId: string,
  ready: (rows: ReadonlyArray<EffectRow>) => boolean,
): Promise<ReadonlyArray<EffectRow>> =>
  until("wrote the effect rows", async () => {
    const rows = await effectRows(harness, subscriptionId);
    return ready(rows) ? rows : undefined;
  });

/** The matcher's cursor, beside the position of the newest entry in the log. */
const walk = async (
  harness: ServerHarness,
): Promise<{ readonly position: number | null; readonly head: number }> => {
  const rows = await run(
    harness.sql<{ readonly position: number | null; readonly head: number | null }>`
      SELECT (SELECT position FROM event_cursors WHERE consumer = 'matcher') AS position,
             (SELECT MAX(id) FROM events) AS head`,
  );
  return { position: rows[0]?.position ?? null, head: rows[0]?.head ?? 0 };
};

/**
 * The cursor once it has reached the end of the log. Read together with the
 * head in one statement, so the pair can never be half a tick apart.
 */
const caughtUp = (harness: ServerHarness): Promise<number> =>
  until("walked the log to its end", async () => {
    const seen = await walk(harness);
    return seen.position !== null && seen.position === seen.head ? seen.position : undefined;
  });

/** One subscription's stored row, which is where an ended one is read. */
interface SubscriptionRow {
  readonly ended_at: string | null;
  readonly ended_reason: string | null;
  readonly condition: string;
}

const subscriptionRow = async (
  harness: ServerHarness,
  id: string,
): Promise<SubscriptionRow | undefined> => {
  const rows = await run(
    harness.sql<SubscriptionRow>`
      SELECT ended_at, ended_reason, condition FROM subscriptions
      WHERE id = unhex(replace(${id}, '-', ''))`,
  );
  return rows[0];
};

/**
 * Rewrites a stored condition. `subscription.create` stores only what it
 * expanded from a target, so a condition that fails is arranged on the row the
 * matcher reads rather than asked for through an operation that would refuse
 * it.
 */
const storeCondition = (harness: ServerHarness, id: string, condition: string): Promise<unknown> =>
  run(
    harness.sql`UPDATE subscriptions SET condition = ${condition}
                WHERE id = unhex(replace(${id}, '-', ''))`,
  );

const inputFrames = (arranged: Arranged): ReadonlyArray<SessionInput> =>
  framesOf<SessionInput>(arranged.wire, "sessionInput");

/** Whether a frame carrying this text has crossed the socket. */
const sentFrames = (arranged: Arranged, text: string): ReadonlyArray<SessionInput> =>
  inputFrames(arranged).filter((frame) => frame.input.text.includes(text));

const frameWhen = (arranged: Arranged, text: string): Promise<SessionInput> =>
  until(`sent a frame carrying ${text}`, () => sentFrames(arranged, text)[0]);

describe("the matcher's tick", () => {
  it("writes one effect row for a matched subscription, and walks its cursor past the event", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);

      const eventId = await emitted(arranged, [REF], "The lid does not close");

      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("subscription");
      expect(rows[0]!.event_id).toBe(eventId);
      expect(rows[0]!.session).toBe(agent.session.id.replaceAll("-", ""));
      // The text is pinned in `matching.test.ts`; what matters here is that
      // the row carries the rendering and not the raw envelope.
      expect(rows[0]!.text).toContain(KIND);
      expect(rows[0]!.text).toContain("The lid does not close");
      expect(rows[0]!.text).toContain("```json");

      // The cursor ends at the event, which is the end of the log: it is read
      // against the head rather than against the id alone, so an entry
      // appended by anything else in the meantime is not read as a defect.
      const position = await caughtUp(arranged.harness);
      expect(position).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("writes nothing a second time, however often the cursor is rewound over the same events", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      const eventId = await emitted(arranged, [REF], "The lid does not close");
      await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);
      const settled = await caughtUp(arranged.harness);

      // The crash between the commit of the effect rows and the advance of
      // the cursor, three times over.
      for (let pass = 0; pass < 3; pass++) {
        await run(
          arranged.harness.sql`UPDATE event_cursors SET position = ${eventId - 1}
                               WHERE consumer = 'matcher'`,
        );
        await until("walked the log again", async () => {
          const seen = await walk(arranged.harness);
          return seen.position !== null && seen.position >= settled ? seen.position : undefined;
        });
        const rows = await effectRows(arranged.harness, subscriptionId);
        expect(rows, `pass ${String(pass)}`).toHaveLength(1);
        expect(rows[0]!.event_id).toBe(eventId);
      }

      expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(settled);
    });
  });

  it("writes no row for an audit entry, whatever a subscription's condition says, and passes it", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      // A condition that admits everything, so a row that is not written is
      // the population's doing and not the condition's.
      await storeCondition(arranged.harness, subscriptionId, "true");

      // Creating a profile appends `profile.created`, which is an audit entry.
      await profileOf(arranged, "leaves-an-entry", ["event.read"]);
      const entries = await run(
        arranged.harness.sql<{
          readonly id: number;
        }>`SELECT id FROM events WHERE kind = 'profile.created' ORDER BY id DESC LIMIT 1`,
      );
      const entryId = entries[0]!.id;

      await until("walked past the audit entry", async () => {
        const seen = await walk(arranged.harness);
        return seen.position !== null && seen.position >= entryId ? seen.position : undefined;
      });
      expect(await effectRows(arranged.harness, subscriptionId)).toEqual([]);

      // The same subscription does get a row for a pipeline event, so the
      // silence above is about the population and not about a dead matcher.
      const eventId = await emitted(arranged, [REF], "The lid does not close");
      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);
      expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    });
  });
});

describe("the matcher's delivery", () => {
  it("delivers to an idle session at once", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      expect((await readSession(arranged, agent.session.id)).status).toBe("idle");

      await emitted(arranged, [REF], "delivered at once");

      const frame = await frameWhen(arranged, "delivered at once");
      expect(frame.sessionId).toBe(agent.session.id);
      const rows = await rowsWhen(
        arranged.harness,
        subscriptionId,
        (found) => found[0]?.status === "delivered",
      );
      expect(rows[0]!.status).toBe("delivered");
    });
  });

  it("keeps a busy session's row waiting, and sends one row per boundary, oldest first", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await madeBusy(arranged, agent, 2);

      await emitted(arranged, [REF], "the older one");
      await emitted(arranged, [REF], "the newer one");
      const waiting = await rowsWhen(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 2,
      );
      expect(waiting.map((row) => row.status)).toEqual(["queued", "queued"]);
      // Nothing crossed the socket while the turn was running.
      expect(sentFrames(arranged, "the older one")).toEqual([]);
      expect(sentFrames(arranged, "the newer one")).toEqual([]);

      // The first boundary takes the oldest row, and only that one.
      turnCompleted(arranged, agent.session.id, 3);
      await frameWhen(arranged, "the older one");
      expect(sentFrames(arranged, "the newer one")).toEqual([]);

      // The next boundary takes the next one.
      await madeBusy(arranged, agent, 4);
      turnCompleted(arranged, agent.session.id, 5);
      await frameWhen(arranged, "the newer one");
      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) =>
        found.every((row) => row.status === "delivered"),
      );
      expect(rows.map((row) => row.text.includes("the older one"))).toEqual([true, false]);
    });
  });

  it("resumes a session whose harness is gone but whose transcript is not, and opens its turn with the row", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await exit(arranged, agent, 2);
      const ended = await readSession(arranged, agent.session.id);
      expect(ended.status).toBe("exited");
      expect(ended.resumable).toBe(true);

      await emitted(arranged, [REF], "wake up");

      // The session is told to start again, on its own native session.
      const starts = await startFrames(arranged, agent.session.id, 2);
      expect(starts[1]!.spec.continue).toMatchObject({ mode: "resume" });
      await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);

      // The resumed harness reports it is up, and the turn opens with the row.
      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: agent.session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-1" },
      });
      const frame = await frameWhen(arranged, "wake up");
      expect(frame.sessionId).toBe(agent.session.id);
    });
  });
});

describe("the matcher's sweep", () => {
  it("ends only the subscription whose holder is past resuming, and matches for the other two", async () => {
    await withMatcher(async (arranged) => {
      const idle = await subscriber(arranged, "idle-holder");
      const resumable = await subscriber(arranged, "resumable-holder");
      const gone = await stranded(arranged, "gone-holder");

      const live = await subscribed(arranged, idle, REF);
      const sleeping = await subscribed(arranged, resumable, REF);
      const doomed = await subscribed(arranged, gone, REF);

      await exit(arranged, resumable, 2);
      expect((await readSession(arranged, resumable.session.id)).resumable).toBe(true);
      await exit(arranged, gone, 1);
      expect((await readSession(arranged, gone.session.id)).resumable).toBe(false);

      const ended = await until("ended the subscription whose holder is gone", async () => {
        const row = await subscriptionRow(arranged.harness, doomed);
        return row?.ended_at === null ? undefined : row;
      });
      expect(ended.ended_reason, "the reason names the holder that ended").toMatch(/session/i);

      // A restart changes nothing: a subscription does not end because a
      // process exited.
      await arranged.harness.reboot();

      await emitted(arranged, [REF], "after the sweep");

      expect((await subscriptionRow(arranged.harness, live))!.ended_at).toBeNull();
      expect((await subscriptionRow(arranged.harness, sleeping))!.ended_at).toBeNull();
      // The idle holder is woken, and the resumable one is told to start again.
      await frameWhen(arranged, "after the sweep");
      await rowsWhen(arranged.harness, live, (rows) => rows.length >= 1);
      await rowsWhen(arranged.harness, sleeping, (rows) => rows.length >= 1);
      await startFrames(arranged, resumable.session.id, 2);
      expect(await effectRows(arranged.harness, doomed)).toEqual([]);
    });
  });

  it("calls off an input still waiting for the holder it can no longer reach, with the same reason", async () => {
    await withMatcher(async (arranged) => {
      const agent = await subscriber(arranged, "resumable-holder");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await exit(arranged, agent, 2);
      expect((await readSession(arranged, agent.session.id)).resumable).toBe(true);

      // A row the matcher wrote and nothing has delivered yet: what a crash
      // between the effect row's commit and its delivery leaves behind.
      const eventId = await emitted(arranged, [REF], "never delivered");
      await run(
        arranged.harness.sql`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, subscription_id, event_id)
          VALUES
            (unhex(replace(${crypto.randomUUID()}, '-', '')),
             unhex(replace(${agent.session.id}, '-', '')),
             'subscription', 'system', 'never delivered', 'queued', ${at},
             unhex(replace(${subscriptionId}, '-', '')), ${eventId + 1000})`,
      );

      // The machine is retired, so the transcript can no longer be picked up
      // and the holder has ended for good.
      await run(
        arranged.harness.sql`UPDATE runners SET lifecycle = 'retired'
                             WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
      );

      const ended = await until("ended the subscription", async () => {
        const row = await subscriptionRow(arranged.harness, subscriptionId);
        return row?.ended_at === null ? undefined : row;
      });
      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) =>
        found.every((row) => row.status !== "queued"),
      );
      const waiting = rows.find((row) => row.text === "never delivered");
      expect(waiting, "the row that was still waiting").toBeDefined();
      expect(waiting!.status).toBe("cancelled");
      expect(waiting!.reason).toBe(ended.ended_reason);
    });
  });
});

describe("enrichment's second look", () => {
  it("writes a row for the subscription the added ref now matches, and for nothing else", async () => {
    await withMatcher(async (arranged) => {
      const first = await subscriber(arranged, "first-holder");
      const second = await subscriber(arranged, "second-holder");
      const early = await subscribed(arranged, first, REF);
      const eventId = await emitted(arranged, [REF], "the first match");
      await rowsWhen(arranged.harness, early, (rows) => rows.length >= 1);
      const before = await caughtUp(arranged.harness);

      // The second subscription is created after the event was matched, so
      // nothing it could match on has happened yet.
      const late = await subscribed(arranged, second, OTHER_REF);
      expect(await effectRows(arranged.harness, late)).toEqual([]);

      const response = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { url: "https://github.com/o/r/pull/88", refs: [OTHER_REF] },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      const rows = await rowsWhen(arranged.harness, late, (found) => found.length >= 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_id).toBe(eventId);
      // The row reads the amended envelope, not the one that was stored when
      // the event first arrived.
      expect(rows[0]!.text).toContain("https://github.com/o/r/pull/88");
      // The subscription that already matched gets nothing a second time.
      expect(await effectRows(arranged.harness, early)).toHaveLength(1);
      expect((await walk(arranged.harness)).position).toBe(before);

      // An enrichment that adds nothing writes nothing.
      const again = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: [OTHER_REF] },
        arranged.token,
      );
      expect(again.status, await again.clone().text()).toBe(200);
      expect(await effectRows(arranged.harness, late)).toHaveLength(1);
      expect(await effectRows(arranged.harness, early)).toHaveLength(1);
      expect((await walk(arranged.harness)).position).toBe(before);
    });
  });
});

describe("a condition the matcher cannot evaluate", () => {
  it("reports it once per streak, keeps the subscription live, and goes quiet again when it is clean", async () => {
    const calls: Array<Notified> = [];
    await withMatcher(
      async (arranged) => {
        const agent = await subscriber(arranged, "subscribers");
        const subscriptionId = await subscribed(arranged, agent, REF);
        await storeCondition(arranged.harness, subscriptionId, UNRESOLVABLE);

        await emitted(arranged, [REF], "the first failure");
        const failed = await healthWhen(
          arranged,
          agent,
          subscriptionId,
          (health) => health.state === "error",
        );
        expect(failed.message ?? "").not.toBe("");
        expect(failed.at ?? "").not.toBe("");

        // A second failing evaluation refreshes the message and says nothing.
        const second = await emitted(arranged, [REF], "the second failure");
        await until("walked past the second event", async () => {
          const seen = await walk(arranged.harness);
          return seen.position !== null && seen.position >= second ? seen.position : undefined;
        });
        expect(await effectRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);
        expect(calls[0]!.message).toBe(failed.message);

        // A clean evaluation returns the health to ok, and says nothing.
        await storeCondition(arranged.harness, subscriptionId, "true");
        await emitted(arranged, [REF], "the clean one");
        await healthWhen(arranged, agent, subscriptionId, (health) => health.state === "ok");
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);

        // The next failure is a new streak, and is reported again.
        await storeCondition(arranged.harness, subscriptionId, UNRESOLVABLE);
        await emitted(arranged, [REF], "the new streak");
        await healthWhen(arranged, agent, subscriptionId, (health) => health.state === "error");
        await until("reported the new streak", () =>
          calls.filter((call) => call.subscriptionId === subscriptionId).length === 2
            ? calls
            : undefined,
        );
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(2);
      },
      { evaluationErrorNotifier: recording(calls) },
    );
  });

  it("is a no-match for that subscription alone: every other one is still evaluated and delivered", async () => {
    await withMatcher(async (arranged) => {
      const broken = await subscriber(arranged, "broken-holder");
      const sound = await subscriber(arranged, "sound-holder");
      const failing = await subscribed(arranged, broken, REF);
      const working = await subscribed(arranged, sound, REF);
      await storeCondition(arranged.harness, failing, UNKNOWN_FUNCTION);

      const eventId = await emitted(arranged, [REF], "still delivered");

      const rows = await rowsWhen(arranged.harness, working, (found) => found.length >= 1);
      expect(rows[0]!.event_id).toBe(eventId);
      await frameWhen(arranged, "still delivered");
      expect(await effectRows(arranged.harness, failing)).toEqual([]);
      const health = await healthWhen(arranged, broken, failing, (one) => one.state === "error");
      expect(health.message ?? "").toContain("shout");
      expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("treats an evaluation over the wall-clock budget as a no-match, and says so on the subscription", async () => {
    await withMatcher(
      async (arranged) => {
        const agent = await subscriber(arranged, "subscribers");
        const subscriptionId = await subscribed(arranged, agent, REF);

        const eventId = await emitted(arranged, [REF], "over budget");

        const health = await healthWhen(
          arranged,
          agent,
          subscriptionId,
          (one) => one.state === "error",
        );
        expect(health.message ?? "").toContain("budget");
        expect(await effectRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
      },
      // Every evaluation on this controller is over budget, which is the only
      // lever there is: the evaluator offers no timeout and no fuel.
      { expressionBudget: Duration.millis(1) },
    );
  });
});
