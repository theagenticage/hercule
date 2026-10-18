/**
 * Tests `event.query` on a migrated test database: its filters, the set
 * of events Intake shows, the facts each event carries, the security entries
 * it hides, and the query plans of the filters that read other tables.
 *
 * Every row is written with plain SQL, because the events domain cannot
 * import the domains that own these tables. The plugins' settings come from a
 * stub of the `PluginIntake` port, as the plugins domain does not run here.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import type { EventHandling, IntakeOverrides, IntakeSettings } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction, TestDatabase } from "../db/testing";
import { uuidFromString, withTransaction } from "../db";
import { PluginIntake } from "../intake-settings";
import { SECURITY_KINDS } from "./audit-log";
import { EventKindCatalog } from "./catalog";
import { EventService, EventServiceLayer, type QueryInput } from "./service";

const AT = "2026-10-11T10:00:00.000Z";
const LATER = "2026-10-12T10:00:00.000Z";

/** What the stubbed plugins give at their own level: each plugin's event kinds and whether each is on. */
const PLUGIN_LEVELS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  acme: { "acme.thing.opened": true, "acme.thing.noisy": false },
  other: { "other.thing.opened": true },
};

const buildPluginLevel = (pluginId: string): IntakeSettings => ({
  eventKinds: Object.entries(PLUGIN_LEVELS[pluginId] ?? {}).map(([kind, on]) => ({
    kind,
    description: kind,
    on,
    level: "default",
  })),
  signalKinds: [],
});

const PluginIntakeStub = Layer.mock(PluginIntake)({
  read: (pluginId) => Effect.succeed(buildPluginLevel(pluginId)),
});

const layer = EventServiceLayer.pipe(
  Layer.provide(PluginIntakeStub),
  Layer.provide(Layer.mock(EventKindCatalog)({})),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const buildSessionActor = (
  grants: ReadonlyArray<"event.read" | "event.audit" | "session.read" | "run.read">,
): Actor => ({
  _tag: "session",
  sessionId: "0199e0e7-0000-7000-8000-00000000b501",
  profileId: "0199e0e7-0000-7000-8000-00000000d001",
  grants: [...grants],
  profileGrants: [...grants],
  assistantId: null,
  agentId: null,
});

type Deps = EventService | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Deps>, actor: Actor = USER): Promise<A> =>
  Effect.runPromise(Effect.provide(Effect.provideService(effect, CurrentActor, actor), layer));

/** Returns the id written as a UUID: `n` in the last digits. */
const idOf = (n: number): string => `0199e0e7-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const bytesOf = (n: number): Uint8Array => uuidFromString(idOf(n));

let counter = 0;

interface NewEvent {
  readonly source?: string;
  readonly connection?: number;
  readonly kind?: string;
  readonly title?: string;
  readonly author?: string;
}

/** Writes one event and returns its position in the log. */
const insertEvent = (event: NewEvent = {}) =>
  inTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      counter += 1;
      const rows = yield* sql<{ readonly id: number }>`
      INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at,
                          dedup_key, payload, title, author)
      VALUES (${event.source ?? "acme"},
              ${event.connection === undefined ? null : bytesOf(event.connection)},
              'acme', ${event.kind ?? "acme.thing.opened"}, ${AT}, ${AT},
              ${`key-${String(counter)}`}, '{}', ${event.title ?? null}, ${event.author ?? null})
      RETURNING id`;
      return rows[0]!.id;
    }),
  );

const insertPlugin = (pluginId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES (${pluginId}, 1, '{}', ${AT}, ${AT})`,
    ),
  );

const insertConnection = (n: number, pluginId: string, intake: IntakeOverrides) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status,
                                 labels, config, intake, created_at, updated_at)
        VALUES (${bytesOf(n)}, ${pluginId}, ${`${pluginId}/${pluginId}`}, 'L', 'D', ${`a-${String(n)}`},
                'connected', '[]', '{}', ${JSON.stringify(intake)}, ${AT}, ${AT})`,
    ),
  );

const deleteConnection = (n: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(sql, sql`DELETE FROM connections WHERE id = ${bytesOf(n)}`),
  );

interface NewSignal {
  readonly kind: string;
  readonly title?: string;
  readonly eventIds?: ReadonlyArray<number>;
  readonly resolution?: { readonly eventId?: number; readonly outcome: string };
  readonly snoozedUntil?: string;
  readonly createdAt?: string;
}

/** Writes one signal with its `signal_events` rows, and its snooze if it has one. */
const insertSignal = (n: number, signal: NewSignal) =>
  inTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const resolution =
        signal.resolution === undefined
          ? null
          : JSON.stringify({
              kind: "decided",
              actor: "user",
              origin: "user",
              at: AT,
              ...signal.resolution,
            });
      yield* sql`
      INSERT INTO signals (id, kind, origin, title, priority, blocks, actions, match, status,
                           resolution, created_at)
      VALUES (${bytesOf(n)}, ${signal.kind}, '{}', ${signal.title ?? `Signal ${String(n)}`},
              'normal', '[]', '[]', '{}', ${resolution === null ? "open" : "resolved"},
              ${resolution}, ${signal.createdAt ?? AT})`;
      for (const eventId of signal.eventIds ?? []) {
        yield* sql`INSERT INTO signal_events (signal_id, event_id) VALUES (${bytesOf(n)}, ${eventId})`;
      }
      if (signal.snoozedUntil !== undefined) {
        yield* sql`
        INSERT INTO signal_snoozes (signal_id, until, snoozed_at, actor)
        VALUES (${bytesOf(n)}, ${signal.snoozedUntil}, ${AT}, 'user')`;
      }
    }),
  );

const insertTask = (n: number, title: string, eventId: number, deleted = false) =>
  inTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
      INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at,
                         status_changed_at, deleted_at)
      VALUES (${bytesOf(n)}, ${title}, '', 'open', 'normal', ${AT}, ${AT}, ${AT},
              ${deleted ? AT : null})`;
      yield* sql`
      INSERT INTO task_provenance (id, task_id, event_id, at, actor)
      VALUES (${bytesOf(n + 1000)}, ${bytesOf(n)}, ${eventId}, ${AT}, 'user')`;
    }),
  );

const insertSubscription = (
  n: number,
  holderKind: "session" | "run",
  holderId: number,
  options: { readonly triggerId?: string; readonly ended?: boolean } = {},
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO subscriptions (id, holder_kind, holder_id, target, condition, created_at,
                                 ended_at, actor)
      VALUES (${bytesOf(n)}, ${holderKind}, ${bytesOf(holderId)},
              ${JSON.stringify({ kind: "signal", triggerId: options.triggerId ?? "t" })}, 'true',
              ${AT}, ${options.ended === true ? LATER : null}, 'user')`,
    ),
  );

const insertSession = (n: number, title: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                            requested_access_mode, access_mode, spec, title, status, created_at,
                            last_activity_at)
      VALUES (${bytesOf(n)}, x'01', x'01', x'01', 'write', 'write', '{}', ${title}, 'idle', ${AT},
              ${AT})`,
    ),
  );

const insertRun = (n: number, workflowName: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO runs (id, plan, inputs, origin, status, created_at)
      VALUES (${bytesOf(n)}, ${JSON.stringify({ name: workflowName })}, '{}', '{}', 'running', ${AT})`,
    ),
  );

/** Records that a session queued the event as an input from the subscription. */
const insertSessionInput = (
  n: number,
  sessionId: number,
  subscriptionId: number,
  eventId: number,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO session_inputs (id, session_id, source, actor, text, status, created_at,
                                  subscription_id, event_id)
      VALUES (${bytesOf(n)}, ${bytesOf(sessionId)}, 'subscription', 'user', 'x', 'queued', ${AT},
              ${bytesOf(subscriptionId)}, ${eventId})`,
    ),
  );

/** Records that a run's trigger started a step for the event. */
const insertRunStep = (runId: number, stepId: string, eventId: number) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO run_steps (run_id, step_id, iteration, status, created_at, event_id)
      VALUES (${bytesOf(runId)}, ${stepId}, 1, 'completed', ${AT}, ${eventId})`,
    ),
  );

/** Writes an Ignore Rule of `acme/asked` with the text given. */
const insertIgnoreRule = (n: number, text: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO ignore_rules (id, kind, match, text, actor, created_at)
      VALUES (${bytesOf(n)}, 'acme/asked', '{"author":"bot"}', ${text}, 'user', ${AT})`,
    ),
  );

/** Records that the Ignore Rule `ruleId` caught the event, with a copy of `ruleText`. */
const insertIgnoreRuleCatch = (
  eventId: number,
  ruleId: number,
  ruleText: string,
  kind = "acme/asked",
  at = AT,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    withTransaction(
      sql,
      sql`
      INSERT INTO ignore_rule_catches (event_id, rule_id, kind, rule_text, at)
      VALUES (${eventId}, ${bytesOf(ruleId)}, ${kind}, ${ruleText}, ${at})`,
    ),
  );

/** Returns the ids of the events a query returns, in the order returned. */
const queryIds = (input: QueryInput = {}) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const page = yield* events.query(input);
    return page.items.map((item) => item.id);
  });

const handling = (...handlings: ReadonlyArray<EventHandling>): QueryInput => ({
  handling: handlings,
});

/**
 * Writes one event of each way the handlings tell apart, and returns their
 * ids by name:
 *
 * - `raised`: raised an Acme signal;
 * - `evidence`: listed by a core `unsure` signal;
 * - `ended`: ended an Acme signal;
 * - `ignored`: caught by an Ignore Rule;
 * - `onTask`: on a Task, and on a deleted Task;
 * - `known`: received by a live session Subscription;
 * - `knownEnded`: received only by an ended Subscription;
 * - `deletedTask`: on a deleted Task only;
 * - `none`: nothing came of it.
 */
const arrangeHandlings = Effect.gen(function* () {
  const raised = yield* insertEvent({ title: "raised" });
  const evidence = yield* insertEvent({ title: "evidence" });
  const ended = yield* insertEvent({ title: "ended" });
  const ignored = yield* insertEvent({ title: "ignored" });
  const onTask = yield* insertEvent({ title: "on task" });
  const known = yield* insertEvent({ title: "known" });
  const knownEnded = yield* insertEvent({ title: "known ended" });
  const deletedTask = yield* insertEvent({ title: "deleted task" });
  const none = yield* insertEvent({ title: "none" });

  yield* insertSignal(1, { kind: "acme/asked", eventIds: [raised] });
  yield* insertSignal(2, { kind: "unsure", eventIds: [evidence] });
  yield* insertSignal(3, {
    kind: "acme/asked",
    eventIds: [],
    resolution: { eventId: ended, outcome: "Merged" },
  });
  yield* insertIgnoreRule(5, "Asked · Author bot");
  yield* insertIgnoreRuleCatch(ignored, 5, "Asked · Author bot");
  yield* insertTask(10, "Fix it", onTask);
  yield* insertTask(11, "Gone", deletedTask, true);
  yield* insertSession(20, "Triage session");
  yield* insertSubscription(30, "session", 20);
  yield* insertSessionInput(40, 20, 30, known);
  yield* insertSubscription(31, "session", 20, { ended: true });
  yield* insertSessionInput(41, 20, 31, knownEnded);
  return { raised, evidence, ended, ignored, onTask, known, knownEnded, deletedTask, none };
});

describe("event.query handling filters", () => {
  it("finds the event that raised a plugin signal with raised-signal", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("raised-signal")), arranged.raised] as const;
      }),
    );
    expect(ids[0]).toEqual([ids[1]]);
  });

  it("finds the event a core signal lists with evidence, and not the one a plugin signal raised", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("evidence")), arranged.evidence] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("finds the event that ended a signal with ended-signal", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("ended-signal")), arranged.ended] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("finds the event an Ignore Rule caught with ignored", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("ignored")), arranged.ignored] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("finds an event on a live Task with on-task, and not one on a deleted Task", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("on-task")), arranged.onTask] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("finds an event a live Subscription received with known-work, and not one only an ended Subscription received", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("known-work")), arranged.known] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("finds a run's Subscription's event only through the trigger that received it", async () => {
    const found = await run(
      Effect.gen(function* () {
        const received = yield* insertEvent();
        const other = yield* insertEvent();
        yield* insertRun(50, "Nightly");
        yield* insertSubscription(60, "run", 50, { triggerId: "wanted" });
        yield* insertSubscription(61, "run", 50, { triggerId: "unrelated" });
        yield* insertRunStep(50, "wanted", received);
        return [yield* queryIds(handling("known-work")), received, other] as const;
      }),
    );
    expect(found[0]).toEqual([found[1]]);
  });

  it("finds the events nothing came of with no-action, including the ones with only an ended Subscription or a deleted Task, and not the one an Ignore Rule caught", async () => {
    const [found, arranged] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        return [yield* queryIds(handling("no-action")), arranged] as const;
      }),
    );
    expect(found).toEqual(
      [arranged.none, arranged.deletedTask, arranged.knownEnded].sort((a, b) => b - a),
    );
  });

  it("returns the events with any of several handlings, newest first, with no event twice", async () => {
    const [found, arranged] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeHandlings;
        // The event on a Task also raised a signal, so it matches both handlings.
        yield* insertSignal(4, { kind: "acme/asked", eventIds: [arranged.onTask] });
        return [yield* queryIds(handling("raised-signal", "on-task")), arranged] as const;
      }),
    );
    expect(found).toEqual([arranged.onTask, arranged.raised]);
  });

  it("returns every event for an empty handling list", async () => {
    const found = await run(
      Effect.gen(function* () {
        yield* arrangeHandlings;
        return yield* queryIds({ handling: [] });
      }),
    );
    expect(found).toHaveLength(9);
  });
});

describe("event.query facts", () => {
  it("lists the signals an event raised or is evidence for, with the snooze and the outcome", async () => {
    const [event, signals] = await run(
      Effect.gen(function* () {
        const eventId = yield* insertEvent();
        yield* insertSignal(1, {
          kind: "acme/asked",
          title: "Review it",
          eventIds: [eventId],
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          createdAt: "2026-10-11T10:00:00.000Z",
        });
        yield* insertSignal(2, {
          kind: "unsure",
          title: "Done already",
          eventIds: [eventId],
          resolution: { outcome: "Replied" },
          createdAt: "2026-10-11T11:00:00.000Z",
        });
        // A snooze that has run out no longer shows.
        yield* insertSignal(3, {
          kind: "fyi",
          title: "Woke up",
          eventIds: [eventId],
          snoozedUntil: "2000-01-01T00:00:00.000Z",
          createdAt: "2026-10-11T12:00:00.000Z",
        });
        const events = yield* EventService;
        const page = yield* events.query({});
        return [eventId, page.items[0]!.signals] as const;
      }),
    );
    expect(event).toBeGreaterThan(0);
    expect(signals).toEqual([
      {
        signalId: idOf(1),
        kind: "acme/asked",
        status: "open",
        title: "Review it",
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      },
      {
        signalId: idOf(2),
        kind: "unsure",
        status: "resolved",
        title: "Done already",
        outcome: "Replied",
      },
      { signalId: idOf(3), kind: "fyi", status: "open", title: "Woke up" },
    ]);
  });

  it("lists the signals an event ended", async () => {
    const resolved = await run(
      Effect.gen(function* () {
        const eventId = yield* insertEvent();
        yield* insertSignal(1, {
          kind: "acme/asked",
          title: "Asked",
          resolution: { eventId, outcome: "Merged" },
        });
        // A signal ended by hand names no event.
        yield* insertSignal(2, { kind: "acme/asked", resolution: { outcome: "Dismissed" } });
        const events = yield* EventService;
        return (yield* events.query({})).items[0]!.resolvedSignals;
      }),
    );
    expect(resolved).toEqual([{ signalId: idOf(1), title: "Asked", outcome: "Merged" }]);
  });

  it("lists the Tasks of an event and leaves out a deleted Task", async () => {
    const tasks = await run(
      Effect.gen(function* () {
        const eventId = yield* insertEvent();
        yield* insertTask(1, "Keep", eventId);
        yield* insertTask(2, "Gone", eventId, true);
        const events = yield* EventService;
        return (yield* events.query({})).items[0]!.tasks;
      }),
    );
    expect(tasks).toEqual([{ taskId: idOf(1), title: "Keep" }]);
  });

  it("lists the live Subscriptions that received the event, with the session's title or the run's workflow name", async () => {
    const knownBy = await run(
      Effect.gen(function* () {
        const eventId = yield* insertEvent();
        yield* insertSession(20, "Triage session");
        yield* insertSubscription(30, "session", 20);
        yield* insertSessionInput(40, 20, 30, eventId);
        yield* insertRun(50, "Nightly");
        yield* insertSubscription(60, "run", 50, { triggerId: "wanted" });
        yield* insertRunStep(50, "wanted", eventId);
        // An ended Subscription is not listed, and neither is a holder with no record.
        yield* insertSubscription(31, "session", 20, { ended: true });
        yield* insertSessionInput(41, 20, 31, eventId);
        yield* insertSubscription(32, "session", 99);
        yield* insertSessionInput(42, 99, 32, eventId);
        const events = yield* EventService;
        return (yield* events.query({})).items[0]!.knownBy;
      }),
    );
    expect(knownBy).toEqual([
      {
        subscriptionId: idOf(30),
        holder: { kind: "session", id: idOf(20) },
        title: "Triage session",
      },
      { subscriptionId: idOf(32), holder: { kind: "session", id: idOf(99) }, title: null },
      { subscriptionId: idOf(60), holder: { kind: "run", id: idOf(50) }, title: "Nightly" },
    ]);
  });

  it.each([
    [["event.read"], null, null],
    [["event.read", "session.read"], "Triage session", null],
    [["event.read", "run.read"], null, "Nightly"],
    [["event.read", "session.read", "run.read"], "Triage session", "Nightly"],
  ] as const)(
    "shows a holder's title only to a caller that holds the grant to read it (%j)",
    async (grants, sessionTitle, runTitle) => {
      const knownBy = await run(
        Effect.gen(function* () {
          const eventId = yield* insertEvent();
          yield* insertSession(20, "Triage session");
          yield* insertSubscription(30, "session", 20);
          yield* insertSessionInput(40, 20, 30, eventId);
          yield* insertRun(50, "Nightly");
          yield* insertSubscription(60, "run", 50, { triggerId: "wanted" });
          yield* insertRunStep(50, "wanted", eventId);
          const events = yield* EventService;
          return (yield* events.query({})).items[0]!.knownBy;
        }),
        buildSessionActor(grants),
      );
      expect(knownBy.map((fact) => [fact.holder.kind, fact.title])).toEqual([
        ["session", sessionTitle],
        ["run", runTitle],
      ]);
    },
  );

  it("names the Ignore Rule that caught an event, by the text the catch keeps, and says when the rule was deleted", async () => {
    const [live, deleted] = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const liveEvent = yield* insertEvent();
        const deletedEvent = yield* insertEvent();
        yield* insertIgnoreRule(1, "Asked · Author bot");
        yield* insertIgnoreRuleCatch(liveEvent, 1, "Asked · Author bot");
        yield* insertIgnoreRuleCatch(deletedEvent, 2, "Asked · Author gone");
        const events = yield* EventService;
        const byId = new Map((yield* events.query({})).items.map((item) => [item.id, item]));
        yield* withTransaction(sql, sql`DELETE FROM ignore_rules WHERE id = ${bytesOf(1)}`);
        const afterDelete = (yield* events.query({})).items.find((item) => item.id === liveEvent);
        return [
          [byId.get(liveEvent)!.ignoredBy, afterDelete!.ignoredBy],
          byId.get(deletedEvent)!.ignoredBy,
        ] as const;
      }),
    );
    expect(live).toEqual([
      { ruleId: idOf(1), kind: "acme/asked", text: "Asked · Author bot", ruleDeleted: false },
      { ruleId: idOf(1), kind: "acme/asked", text: "Asked · Author bot", ruleDeleted: true },
    ]);
    expect(deleted).toEqual({
      ruleId: idOf(2),
      kind: "acme/asked",
      text: "Asked · Author gone",
      ruleDeleted: true,
    });
  });

  it("names the first catch of an event that rules of two kinds caught", async () => {
    const ignoredBy = await run(
      Effect.gen(function* () {
        const eventId = yield* insertEvent();
        yield* insertIgnoreRuleCatch(eventId, 2, "Pinged · Author bot", "acme/pinged", LATER);
        yield* insertIgnoreRuleCatch(eventId, 1, "Asked · Author bot", "acme/asked", AT);
        const events = yield* EventService;
        return (yield* events.query({})).items[0]!.ignoredBy;
      }),
    );
    expect(ignoredBy).toEqual({
      ruleId: idOf(1),
      kind: "acme/asked",
      text: "Asked · Author bot",
      ruleDeleted: true,
    });
  });

  it("returns empty fact lists for an event nothing came of", async () => {
    const [item] = await run(
      Effect.gen(function* () {
        yield* insertEvent();
        const events = yield* EventService;
        return (yield* events.query({})).items;
      }),
    );
    expect(item).toMatchObject({
      signals: [],
      resolvedSignals: [],
      ignoredBy: null,
      tasks: [],
      knownBy: [],
    });
  });

  it("reads each list of facts with one query, whatever the size of the page", async () => {
    const statements = await run(
      Effect.gen(function* () {
        const first = yield* insertEvent();
        for (let index = 0; index < 5; index += 1) {
          const eventId = yield* insertEvent();
          yield* insertSignal(index + 1, { kind: "acme/asked", eventIds: [eventId] });
        }
        yield* insertTask(20, "A task", first);
        const compiled: Array<string> = [];
        const events = yield* EventService;
        yield* events.query({}).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              compiled.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
        return compiled;
      }),
    );
    // One page query, then one query each for the signals, the signals ended,
    // the Ignore Rule catches, the Tasks and the Subscriptions.
    expect(statements.filter((text) => text.includes("FROM events"))).toHaveLength(1);
    expect(statements.filter((text) => text.includes("task_provenance"))).toHaveLength(1);
    expect(statements).toHaveLength(6);
  });
});

describe("event.query filters", () => {
  it("searches the title and author of events, newest first, and pages through the matches", async () => {
    const [firstPage, secondPage, matching] = await run(
      Effect.gen(function* () {
        const events = yield* EventService;
        const a = yield* insertEvent({ title: "Login page crashes" });
        yield* insertEvent({ title: "Unrelated" });
        const b = yield* insertEvent({ title: "Fix the login form" });
        const c = yield* insertEvent({ author: "Logina" });
        const d = yield* insertEvent({ title: "LOGIN broken" });
        const first = yield* events.query({ text: "login", limit: 2 });
        const second = yield* events.query({ text: "login", limit: 2, cursor: first.nextCursor! });
        return [
          first.items.map((item) => item.id),
          second.items.map((item) => item.id),
          [d, b, a, c],
        ] as const;
      }),
    );
    expect(firstPage).toEqual([matching[0], matching[1]]);
    expect(secondPage).toEqual([matching[2]]);
  });

  it("returns an empty page for text with no word to search for", async () => {
    const found = await run(
      Effect.gen(function* () {
        yield* insertEvent({ title: "Anything" });
        return yield* queryIds({ text: "!!!" });
      }),
    );
    expect(found).toEqual([]);
  });

  it("finds a title however its accents are spelled", async () => {
    const decomposed = "re\u0301sume\u0301";
    const composed = "r\u00e9sum\u00e9";
    const [byDecomposed, byComposed, byPlain, expected] = await run(
      Effect.gen(function* () {
        const a = yield* insertEvent({ title: `My ${decomposed} draft` });
        const b = yield* insertEvent({ title: `Your ${composed} draft` });
        yield* insertEvent({ title: "Unrelated" });
        return [
          yield* queryIds({ text: decomposed }),
          yield* queryIds({ text: composed }),
          yield* queryIds({ text: "resume" }),
          [b, a],
        ] as const;
      }),
    );
    expect(byDecomposed).toEqual(expected);
    expect(byComposed).toEqual(expected);
    expect(byPlain).toEqual(expected);
  });

  it("filters by source", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        yield* insertEvent({ source: "acme" });
        const manual = yield* insertEvent({ source: "manual" });
        return [yield* queryIds({ source: "manual" }), manual] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("combines the filters with and, not or", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        const wanted = yield* insertEvent({ source: "acme", title: "pager alert" });
        yield* insertEvent({ source: "manual", title: "pager alert" });
        yield* insertEvent({ source: "acme", title: "calm" });
        yield* insertSignal(1, { kind: "acme/asked", eventIds: [wanted] });
        return [
          yield* queryIds({ source: "acme", text: "pager", ...handling("raised-signal") }),
          wanted,
        ] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });
});

describe("event.query intake", () => {
  const NONE: IntakeOverrides = { eventKinds: {}, signalKinds: {} };

  it("includes an event whose kind is on at its plugin's level and leaves out one whose kind is off", async () => {
    const [found, on] = await run(
      Effect.gen(function* () {
        yield* insertPlugin("acme");
        yield* insertConnection(1, "acme", NONE);
        const on = yield* insertEvent({ connection: 1, kind: "acme.thing.opened" });
        yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        return [yield* queryIds({ intake: true }), on] as const;
      }),
    );
    expect(found).toEqual([on]);
  });

  it("follows a Connection's own switch over its plugin's", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        yield* insertPlugin("acme");
        yield* insertConnection(1, "acme", {
          eventKinds: { "acme.thing.noisy": true, "acme.thing.opened": false },
          signalKinds: {},
        });
        yield* insertConnection(2, "acme", NONE);
        yield* insertEvent({ connection: 1, kind: "acme.thing.opened" });
        const noisyOn = yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        const otherConnection = yield* insertEvent({ connection: 2, kind: "acme.thing.opened" });
        return [yield* queryIds({ intake: true }), [otherConnection, noisyOn]] as const;
      }),
    );
    expect(found).toEqual(expected);
  });

  it("falls back to the plugin's level for an event whose Connection was deleted", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        yield* insertPlugin("acme");
        yield* insertConnection(1, "acme", {
          eventKinds: { "acme.thing.opened": false },
          signalKinds: {},
        });
        const orphan = yield* insertEvent({ connection: 1, kind: "acme.thing.opened" });
        const before = yield* queryIds({ intake: true });
        yield* deleteConnection(1);
        return [[before, yield* queryIds({ intake: true })], orphan] as const;
      }),
    );
    expect(found).toEqual([[], [expected]]);
  });

  it("leaves out an event with no Connection, a manual event and an event of an unknown plugin", async () => {
    const found = await run(
      Effect.gen(function* () {
        yield* insertPlugin("acme");
        yield* insertConnection(1, "acme", NONE);
        yield* insertEvent({ kind: "acme.thing.opened" });
        yield* insertEvent({ source: "manual", connection: 1, kind: "acme.thing.opened" });
        yield* insertEvent({ source: "ghost", connection: 2, kind: "ghost.thing.opened" });
        return yield* queryIds({ intake: true });
      }),
    );
    expect(found).toEqual([]);
  });

  it("includes an event an Ignore Rule caught even when its kind is off", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        yield* insertPlugin("acme");
        yield* insertConnection(1, "acme", NONE);
        const caught = yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        yield* insertIgnoreRuleCatch(caught, 5, "Asked · Author bot");
        return [yield* queryIds({ intake: true }), caught] as const;
      }),
    );
    expect(found).toEqual([expected]);
  });

  it("includes an event with a signal behind it even when its kind is off", async () => {
    const [found, expected] = await run(
      Effect.gen(function* () {
        yield* insertPlugin("acme");
        yield* insertConnection(1, "acme", NONE);
        const raised = yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        const evidence = yield* insertEvent({ kind: "acme.thing.noisy" });
        const ended = yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        yield* insertEvent({ connection: 1, kind: "acme.thing.noisy" });
        yield* insertSignal(1, { kind: "acme/asked", eventIds: [raised] });
        yield* insertSignal(2, { kind: "unsure", eventIds: [evidence] });
        yield* insertSignal(3, {
          kind: "acme/asked",
          resolution: { eventId: ended, outcome: "Merged" },
        });
        return [yield* queryIds({ intake: true }), [ended, evidence, raised]] as const;
      }),
    );
    expect(found).toEqual(expected);
  });

  it("returns every event when intake is false or not sent", async () => {
    const [none, off] = await run(
      Effect.gen(function* () {
        yield* insertEvent();
        yield* insertEvent();
        return [yield* queryIds({}), yield* queryIds({ intake: false })] as const;
      }),
    );
    expect(none).toHaveLength(2);
    expect(off).toHaveLength(2);
  });
});

describe("event.query security entries", () => {
  const SECURITY_KIND = SECURITY_KINDS[0]!;

  /** Writes a security entry that every filter below finds, and an ordinary event beside it. */
  const arrangeSecurityEntry = Effect.gen(function* () {
    yield* insertPlugin("acme");
    yield* insertConnection(1, "acme", { eventKinds: { [SECURITY_KIND]: true }, signalKinds: {} });
    const entry = yield* insertEvent({
      source: "acme",
      connection: 1,
      kind: SECURITY_KIND,
      title: "findme",
    });
    const ordinary = yield* insertEvent({ connection: 1, title: "findme" });
    yield* insertSignal(1, { kind: "acme/asked", eventIds: [entry, ordinary] });
    return { entry, ordinary };
  });

  const FILTERS: ReadonlyArray<readonly [string, QueryInput]> = [
    ["intake", { intake: true }],
    ["text", { text: "findme" }],
    ["source", { source: "acme" }],
    ["handling", handling("raised-signal")],
    ["all of them", { intake: true, text: "findme", source: "acme", ...handling("raised-signal") }],
  ];

  it.each(FILTERS)(
    "hides them from a session without event.audit, with the %s filter",
    async (_name, filter) => {
      const [found, arranged] = await run(
        Effect.gen(function* () {
          const arranged = yield* arrangeSecurityEntry;
          return [yield* queryIds(filter), arranged] as const;
        }),
        buildSessionActor(["event.read"]),
      );
      expect(found).toEqual([arranged.ordinary]);
    },
  );

  it.each(FILTERS)("shows them to the user, with the %s filter", async (_name, filter) => {
    const [found, arranged] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeSecurityEntry;
        return [yield* queryIds(filter), arranged] as const;
      }),
    );
    expect(found).toEqual([arranged.ordinary, arranged.entry].sort((a, b) => b - a));
  });

  it("shows them to a session with event.audit", async () => {
    const [found, arranged] = await run(
      Effect.gen(function* () {
        const arranged = yield* arrangeSecurityEntry;
        return [yield* queryIds({ intake: true }), arranged] as const;
      }),
      buildSessionActor(["event.read", "event.audit"]),
    );
    expect(found).toContain(arranged.entry);
  });
});

/**
 * Returns SQLite's plan for every statement `event.query` sends for `input`,
 * in the order sent, each as its steps joined with " / ". The statements are
 * captured as the service builds them, so the plans are the plans of the real
 * queries. `arrange` writes rows first. An empty database is enough otherwise:
 * with no statistics gathered by `ANALYZE`, SQLite chooses a plan without
 * regard to table sizes.
 */
const explainQuery = (
  input: QueryInput,
  arrange: Effect.Effect<unknown, unknown, SqlClient.SqlClient> = Effect.void,
) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventService;
      yield* arrange;
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      yield* events.query(input).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile());
            return statement;
          }),
        ),
      );
      const plans: Array<string> = [];
      for (const [text, params] of statements) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        plans.push(plan.map((row) => row.detail).join(" / "));
      }
      return plans;
    }).pipe(Effect.orDie),
  );

/** Returns the plan of the statement that reads the page of events. */
const explainPageQuery = async (input: QueryInput): Promise<string> =>
  (await explainQuery(input))[0]!;

/**
 * Returns the tables a plan reads in full, by the name or alias the plan
 * gives them. `SCAN events` is the page read in id order, and the events
 * index is `SCAN events_fts VIRTUAL TABLE`, which only walks the matches.
 */
const listScans = (plan: string): ReadonlyArray<string> =>
  (plan.match(/SCAN \w+/g) ?? []).filter(
    (scan) => scan !== "SCAN events" && scan !== "SCAN events_fts",
  );

describe("event.query plans", () => {
  it("reads a text search through the full-text index, with a keyset cursor", async () => {
    const first = await run(
      Effect.gen(function* () {
        for (let index = 0; index < 3; index += 1) yield* insertEvent({ title: "login" });
        const events = yield* EventService;
        return (yield* events.query({ text: "login", limit: 1 })).nextCursor!;
      }),
    );
    const plan = await explainPageQuery({ text: "login", limit: 1, cursor: first });
    expect(plan).toContain("SCAN events_fts VIRTUAL TABLE");
    expect(plan).toContain("SEARCH events USING INTEGER PRIMARY KEY");
    expect(listScans(plan)).toEqual([]);
  });

  it.each([
    ["ended-signal", "signals_resolution_event"],
    ["on-task", "task_provenance_event"],
    ["raised-signal", "signal_events_event"],
    ["evidence", "signal_events_event"],
  ] as const)("reads the %s filter by listing the event ids in %s", async (name, index) => {
    const plan = await explainPageQuery(handling(name));
    // The events with this handling are few, so the filter reads the index
    // of the fact table and looks those events up by id. It never reads the
    // whole log.
    expect(plan).toMatch(new RegExp(`(SCAN|SEARCH) \\w+ USING (COVERING )?INDEX ${index}\\b`));
    expect(plan).toContain("SEARCH events USING INTEGER PRIMARY KEY");
    expect(plan).not.toContain("SCAN events");
  });

  it("reads the ignored filter by listing the caught event ids, then looking those events up", async () => {
    // A catch's key is its event's id, so the catches table is its own index.
    const plan = await explainPageQuery(handling("ignored"));
    expect(plan).toContain("ignore_rule_catches");
    expect(plan).toContain("SEARCH events USING INTEGER PRIMARY KEY");
    expect(plan).not.toContain("SCAN events");
  });

  it.each([["session_inputs_event"], ["run_steps_event"]] as const)(
    "reads the known-work filter by searching %s",
    async (index) => {
      const plan = await explainPageQuery(handling("known-work"));
      expect(plan).toMatch(new RegExp(`SEARCH \\w+ USING (COVERING )?INDEX ${index} \\(`));
      expect(listScans(plan)).toEqual([]);
    },
  );

  it("reads the source filter through the events_source index", async () => {
    const plan = await explainPageQuery({ source: "acme" });
    expect(plan).toMatch(/SEARCH events USING (COVERING )?INDEX events_source \(/);
  });

  it("reads the no-action filter by walking the log newest first", async () => {
    // No-action asks for the events that have nothing, which SQLite can find
    // only by checking each event. The walk stops once the page is full, and
    // the facts it checks are looked up through indexes.
    const plan = await explainPageQuery(handling("no-action"));
    expect(plan).toContain("SCAN events");
    expect(plan).toContain("signal_events_event");
    expect(plan).toContain("signals_resolution_event");
  });

  it("reads the facts of a page through indexes", async () => {
    const plans = await explainQuery({}, insertEvent());
    // The page, then the signals, the signals ended, the Ignore Rule catches,
    // the Tasks and the Subscriptions.
    expect(plans).toHaveLength(6);
    expect(plans.flatMap(listScans)).toEqual([]);
    expect(plans[2]).toContain("signals_resolution_event");
  });
});

describe("event.countByConnection", () => {
  const NOW = Date.parse("2026-10-17T12:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  /** Writes one event received `msAgo` milliseconds before `NOW`. */
  const insertEventReceived = (msAgo: number, connection?: number) =>
    inTransaction(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        counter += 1;
        const receivedAt = new Date(NOW - msAgo).toISOString();
        yield* sql`
        INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at,
                            dedup_key, payload)
        VALUES ('acme', ${connection === undefined ? null : bytesOf(connection)}, 'acme',
                'acme.thing.opened', ${receivedAt}, ${receivedAt}, ${`key-${String(counter)}`}, '{}')`;
      }),
    );

  /** Returns 24 hourly counts, oldest first, with the given counts by hours ago. */
  const buildHourly = (byHoursAgo: Readonly<Record<number, number>>): ReadonlyArray<number> =>
    Array.from({ length: 24 }, (_, index) => byHoursAgo[23 - index] ?? 0);

  it("puts each event in the hour it arrived in, an hour's start in that hour, and leaves out 24 hours ago and later than now", async () => {
    const counts = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        for (const msAgo of [0, 1, HOUR, HOUR + 1, 2 * HOUR - 1, 2 * HOUR, 24 * HOUR - 1]) {
          yield* insertEventReceived(msAgo, 1);
        }
        yield* insertEventReceived(30 * 60 * 1000, 2);
        // Exactly 24 hours ago, a millisecond from now, and through no
        // Connection: none of them is counted.
        yield* insertEventReceived(24 * HOUR, 1);
        yield* insertEventReceived(-1, 1);
        yield* insertEventReceived(10);
        // A Connection whose only event is older than 24 hours has no entry.
        yield* insertEventReceived(25 * HOUR, 3);
        const events = yield* EventService;
        return yield* events.countByConnection();
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(counts.connections).toHaveLength(2);
    expect(counts.connections).toEqual(
      expect.arrayContaining([
        { connectionId: idOf(1), hourly: buildHourly({ 0: 2, 1: 3, 2: 1, 23: 1 }) },
        { connectionId: idOf(2), hourly: buildHourly({ 0: 1 }) },
      ]),
    );
  });

  it("refuses a session without event.read", async () => {
    const refusal = await run(
      Effect.flip(Effect.flatMap(EventService, (events) => events.countByConnection())),
      buildSessionActor([]),
    );
    expect(refusal).toMatchObject({ error: { code: "forbidden" } });
  });

  it("counts from the index alone, without reading the event rows", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* EventService;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* events.countByConnection().pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const [text, params] = statements[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail).join(" / ");
      }).pipe(Effect.orDie),
    );
    expect(plan).toMatch(/SEARCH events USING COVERING INDEX events_received_at_connection \(/);
  });
});
