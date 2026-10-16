/**
 * Tests the Scheduler's Scheduled Wakes against a migrated database, with
 * every wake fired at a `now` the test chooses. The sessions port is a
 * recorder, so each test reads which input went to which session, or which
 * session the wake started, without a runner. The rules under test:
 *
 * - a heartbeat computes its first next time without firing, fires when that
 *   time has come within the firing tolerance, skips a time that is later,
 *   and never fires while disabled;
 * - editing a heartbeat forgets its next time, and a changed timezone
 *   recomputes it without firing;
 * - a reminder fires once, even hours late, and a cancelled one never fires;
 * - a daily rotation lists a conversation whose newest session is older than
 *   the latest `dailyAt` and has had a delivered input, and fires a flush.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Logger } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { InvalidState, type Heartbeat, type InputSource, type Rotation } from "@hercule/contract";
import { AfterCommit } from "../db/after-commit";
import { ConversationMessagesLayer } from "../conversations";
import { uuidFromString } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { reminderRepository } from "../reminders";
import { SessionService } from "../sessions";
import { Settings, SettingsLayer } from "../settings";
import { ConversationDeliveryLayer } from "./delivery";
import { assistantRepository } from "./repository";
import { ScheduledWakes, ScheduledWakesLayer, type DueWake } from "./scheduled-wakes";
import { AssistantSessions } from "./sessions";

const ASSISTANT = "0199e0e7-0000-7000-8000-0000000000a1";
const CONVERSATION = "0199e0e7-0000-7000-8000-0000000000c1";
const SESSION = "0199e0e7-0000-7000-8000-00000000005e";
const USER = "0199e0e7-0000-7000-8000-000000000001";
/** Stands in for the profile, instance and runner ids of a seeded session, which nothing reads. */
const PLACEHOLDER = "0199e0e7-0000-7000-8000-0000000000f0";
const CREATED = "2026-10-01T00:00:00.000Z";

const HEARTBEAT: Heartbeat = {
  enabled: true,
  schedule: "0 9 * * *",
  prompt: "check in",
  target: "web",
};
const ROTATION: Rotation = { contextFraction: 0.7, maxContextTokens: 200_000, dailyAt: "04:00" };

const at = (iso: string): Date => new Date(iso);

/** The heartbeat wake of the seeded assistant. */
const HEARTBEAT_WAKE = { _tag: "heartbeat", assistantId: ASSISTANT } as const;

/** What the recording sessions port saw: the inputs given, the sessions started and the sessions retired. */
interface Recorded {
  readonly retired: Array<string>;
  readonly given: Array<{ sessionId: string; source: InputSource; text: string }>;
  readonly started: Array<{ conversationId: string; source: InputSource; text: string }>;
}

/** The error a sessions port fails with when no runner can run the conversation's session. */
const NO_RUNNER = new InvalidState({
  error: { code: "invalid_state", message: "no runner can run the session" },
});

/** Builds the recording sessions port. With `unreachable`, every give fails with `NO_RUNNER`. */
const buildRecorder = (
  unreachable = false,
): { recorded: Recorded; layer: Layer.Layer<AssistantSessions | SessionService> } => {
  const recorded: Recorded = { retired: [], given: [], started: [] };
  const layer = Layer.succeed(AssistantSessions, {
    start: (request) =>
      Effect.sync(() => {
        recorded.started.push({
          conversationId: request.conversationId,
          source: request.source,
          text: request.text,
        });
      }),
    give: (request) =>
      unreachable
        ? Effect.fail(NO_RUNNER)
        : Effect.sync(() => {
            recorded.given.push({
              sessionId: request.sessionId,
              source: request.source,
              text: request.text,
            });
            return "given" as const;
          }),
    stop: () => Effect.void,
  });
  // The two session service operations the delivery service uses: every
  // session has had a turn, and retiring one is recorded.
  const sessionService = Layer.succeed(SessionService, {
    retire: (sessionId: string) => Effect.sync(() => void recorded.retired.push(sessionId)),
    hasHadTurn: () => Effect.succeed(true),
  } as unknown as SessionService["Service"]);
  return { recorded, layer: Layer.merge(layer, sessionService) };
};

const buildLayer = (
  sessions: Layer.Layer<AssistantSessions | SessionService>,
  listener: Layer.Layer<AfterCommit> = Layer.succeed(AfterCommit, { publish: () => Effect.void }),
) =>
  ScheduledWakesLayer.pipe(
    Layer.provideMerge(ConversationDeliveryLayer),
    Layer.provideMerge(Layer.mergeAll(sessions, SettingsLayer)),
    Layer.provideMerge(ConversationMessagesLayer),
    Layer.provideMerge(listener),
    Layer.provideMerge(TestDatabase),
  );

/** Inserts the owner, an assistant with the given fields, and its web conversation. */
const seedAssistant = (heartbeat: Heartbeat = HEARTBEAT, rotation: Rotation = ROTATION) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users (id, username, password_hash, created_at, updated_at)
      VALUES (${uuidFromString(USER)}, 'rogier', 'x', ${CREATED}, ${CREATED})`;
    const assistants = yield* assistantRepository;
    yield* assistants.insert({
      agentId: ASSISTANT,
      heartbeat,
      rotation,
      reply: "turn-end",
      at: CREATED,
    });
    yield* sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
      VALUES (${uuidFromString(CONVERSATION)}, ${uuidFromString(ASSISTANT)}, 'web', NULL, ${CREATED})`;
  });

/**
 * Inserts the conversation's session, created at `createdAt`, with the given
 * inputs. It has exited and is not retired, unless `state` says otherwise.
 */
const seedSession = (
  createdAt: string,
  inputs: ReadonlyArray<{ source: string; status: string }> = [],
  state: { status: string; retiredAt: string | null } = { status: "exited", retiredAt: null },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                     requested_access_mode, access_mode, spec, title, status,
                                     created_at, last_activity_at, conversation_id, retired_at)
      VALUES (${uuidFromString(SESSION)}, ${uuidFromString(PLACEHOLDER)}, ${uuidFromString(PLACEHOLDER)},
              ${uuidFromString(PLACEHOLDER)}, 'auto', 'auto', '{}', 'a session',
              ${state.status}, ${createdAt}, ${createdAt}, ${uuidFromString(CONVERSATION)},
              ${state.retiredAt})`;
    for (const [index, input] of inputs.entries()) {
      yield* sql`INSERT INTO session_inputs (id, session_id, source, actor, text, status, created_at)
        VALUES (${uuidFromString(`0199e0e7-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`)},
                ${uuidFromString(SESSION)}, ${input.source}, 'user', 'hi', ${input.status}, ${createdAt})`;
    }
  });

const runWake = <A, E>(
  body: (
    recorded: Recorded,
  ) => Effect.Effect<A, E, ScheduledWakes | Settings | SqlClient.SqlClient>,
  options: { unreachable?: boolean; listener?: Layer.Layer<AfterCommit> } = {},
) => {
  const { recorded, layer } = buildRecorder(options.unreachable);
  return Effect.runPromise(
    body(recorded).pipe(Effect.provide(buildLayer(layer, options.listener))),
  ).then((value) => ({ value, recorded }));
};

const heartbeatNext = Effect.gen(function* () {
  const assistants = yield* assistantRepository;
  const found = yield* assistants.readScheduled(ASSISTANT);
  return found._tag === "Some" ? found.value.heartbeatNextAt : undefined;
});

const isHeartbeat = (wake: DueWake): boolean => wake._tag === "heartbeat";

/** Inserts a pending reminder in the seeded conversation, due at `when`. */
const seedReminder = (text: string, when: string) =>
  Effect.gen(function* () {
    const reminders = yield* reminderRepository;
    return yield* reminders.insert({
      conversationId: CONVERSATION,
      at: when,
      text,
      createdAt: CREATED,
      actor: "user",
    });
  });

describe("a heartbeat", () => {
  it("computes its first next time without firing, and is not due again before then", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedSession(CREATED);
        const wakes = yield* ScheduledWakes;
        const now = at("2026-10-16T08:00:00.000Z");
        const due = yield* wakes.listDue(now);
        for (const wake of due) yield* wakes.fire(wake, now);
        return {
          due,
          next: yield* heartbeatNext,
          beforeNext: (yield* wakes.listDue(at("2026-10-16T08:59:59Z"))).filter(isHeartbeat),
        };
      }),
    );
    expect(value.due).toEqual([HEARTBEAT_WAKE]);
    expect(value.next).toBe("2026-10-16T09:00:00.000Z");
    expect(value.beforeNext).toEqual([]);
    expect(recorded.given).toEqual([]);
    expect(recorded.started).toEqual([]);
  });

  it("gives its prompt once as a heartbeat input to the conversation's newest session", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedSession(CREATED);
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        const now = at("2026-10-16T09:00:30Z");
        const due = yield* wakes.listDue(now);
        for (const wake of due) yield* wakes.fire(wake, now);
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:00:31Z"));
        return yield* heartbeatNext;
      }),
    );
    expect(recorded.given).toEqual([{ sessionId: SESSION, source: "heartbeat", text: "check in" }]);
    expect(value).toBe("2026-10-17T09:00:00.000Z");
  });

  it("is skipped when the newest session is retired and still live", async () => {
    const { recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedSession(CREATED, [], { status: "idle", retiredAt: CREATED });
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:00:00Z"));
      }),
    );
    expect(recorded.given).toEqual([]);
    expect(recorded.started).toEqual([]);
  });

  it("starts a session in the conversation when it has none", async () => {
    const { recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:00:00Z"));
      }),
    );
    expect(recorded.given).toEqual([]);
    expect(recorded.started).toEqual([
      { conversationId: CONVERSATION, source: "heartbeat", text: "check in" },
    ]);
  });

  it("skips a time more than 60 seconds late and moves on to the next", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedSession(CREATED);
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:01:01Z"));
        return yield* heartbeatNext;
      }),
    );
    expect(recorded.given).toEqual([]);
    expect(recorded.started).toEqual([]);
    expect(value).toBe("2026-10-17T09:00:00.000Z");
  });

  it("never fires while disabled", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant({ ...HEARTBEAT, enabled: false });
        yield* seedSession(CREATED);
        const wakes = yield* ScheduledWakes;
        const now = at("2026-10-16T09:00:00Z");
        yield* wakes.fire(HEARTBEAT_WAKE, now);
        return yield* wakes.listDue(now);
      }),
    );
    expect(value.filter(isHeartbeat)).toEqual([]);
    expect(recorded.given).toEqual([]);
    expect(recorded.started).toEqual([]);
  });

  it("falls back to the web conversation for most-recent when the owner has written in none", async () => {
    const { recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant({ ...HEARTBEAT, target: "most-recent" });
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:00:00Z"));
      }),
    );
    expect(recorded.started.map((start) => start.conversationId)).toEqual([CONVERSATION]);
  });

  it("forgets its next time when the heartbeat is edited", async () => {
    const { value } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        const before = yield* heartbeatNext;
        const assistants = yield* assistantRepository;
        yield* assistants.update(ASSISTANT, {
          heartbeat: { ...HEARTBEAT, schedule: "0 10 * * *" },
        });
        return { before, after: yield* heartbeatNext };
      }),
    );
    expect(value).toEqual({ before: "2026-10-16T09:00:00.000Z", after: null });
  });

  it("reads its schedule in its own timezone before the owner's", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant({ ...HEARTBEAT, timezone: "Europe/Amsterdam" });
        yield* seedSession(CREATED);
        const settings = yield* Settings;
        yield* settings.setForUser(USER, "timezone", "America/New_York");
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T06:00:00Z"));
        const next = yield* heartbeatNext;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T07:00:00Z"));
        return next;
      }),
    );
    // 09:00 in Amsterdam is 07:00 UTC while summer time lasts.
    expect(value).toBe("2026-10-16T07:00:00.000Z");
    expect(recorded.given).toHaveLength(1);
  });

  it("reads its schedule in the owner's timezone, or UTC when there is none", async () => {
    const { value } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        const settings = yield* Settings;
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T00:00:00Z"));
        const inUtc = yield* heartbeatNext;
        yield* settings.setForUser(USER, "timezone", "Asia/Tokyo");
        // The stored time was computed in another zone, so the heartbeat has work.
        const due = yield* wakes.listDue(at("2026-10-16T00:00:00Z"));
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T00:00:00Z"));
        return { inUtc, due: due.filter(isHeartbeat).length, inTokyo: yield* heartbeatNext };
      }),
    );
    expect(value).toEqual({
      inUtc: "2026-10-16T09:00:00.000Z",
      due: 1,
      // 09:00 in Tokyo is 00:00 UTC; the next one after 00:00 UTC is the day after.
      inTokyo: "2026-10-17T00:00:00.000Z",
    });
  });

  it("recomputes its next time without firing when the timezone changes", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedSession(CREATED);
        const settings = yield* Settings;
        const wakes = yield* ScheduledWakes;
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
        yield* settings.setForUser(USER, "timezone", "Europe/Amsterdam");
        // 09:00 UTC has come, but the stored time belongs to the old zone.
        yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:00:00Z"));
        return yield* heartbeatNext;
      }),
    );
    expect(recorded.given).toEqual([]);
    expect(value).toBe("2026-10-17T07:00:00.000Z");
  });
});

describe("a reminder", () => {
  const readReminder = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ status: string; fired_at: string | null }>`
      SELECT status, fired_at FROM reminders`;
    return rows[0];
  });

  it("fires once when its time has come, even hours late, and announces the conversation", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const { value, recorded } = await runWake(
      () =>
        Effect.gen(function* () {
          yield* seedAssistant();
          yield* seedSession(CREATED);
          yield* seedReminder("call Ada", "2026-10-16T06:00:00.000Z");
          const wakes = yield* ScheduledWakes;
          const now = at("2026-10-16T12:00:00Z");
          const due = yield* wakes.listDue(now);
          // Two passes over the same list: the second finds the reminder fired.
          for (const wake of due) yield* wakes.fire(wake, now);
          for (const wake of due) yield* wakes.fire(wake, now);
          return {
            due: due.filter((wake) => wake._tag === "reminder").length,
            row: yield* readReminder,
          };
        }),
      { listener },
    );
    expect(value).toEqual({
      due: 1,
      row: { status: "fired", fired_at: "2026-10-16T12:00:00.000Z" },
    });
    expect(recorded.given).toEqual([{ sessionId: SESSION, source: "reminder", text: "call Ada" }]);
    expect(announced).toContainEqual({
      _tag: "record",
      topic: "conversation",
      id: CONVERSATION,
      kind: "updated",
    });
  });

  it("is given to a retired session that is still live, to wait for the next session", async () => {
    const { recorded } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedSession(CREATED, [], { status: "idle", retiredAt: CREATED });
        yield* seedReminder("call Ada", "2026-10-16T06:00:00.000Z");
        const wakes = yield* ScheduledWakes;
        const now = at("2026-10-16T12:00:00Z");
        for (const wake of yield* wakes.listDue(now)) yield* wakes.fire(wake, now);
      }),
    );
    expect(recorded.given).toEqual([{ sessionId: SESSION, source: "reminder", text: "call Ada" }]);
    expect(recorded.started).toEqual([]);
  });

  it("is not due before its time", async () => {
    const { value } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant();
        yield* seedReminder("later", "2026-10-16T12:00:01.000Z");
        const wakes = yield* ScheduledWakes;
        return yield* wakes.listDue(at("2026-10-16T12:00:00Z"));
      }),
    );
    expect(value.filter((wake) => wake._tag === "reminder")).toEqual([]);
  });

  it("never fires once cancelled, even if it was listed before", async () => {
    const { value, recorded } = await runWake(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedAssistant();
        yield* seedSession(CREATED);
        yield* seedReminder("never", "2026-10-16T06:00:00.000Z");
        const wakes = yield* ScheduledWakes;
        const now = at("2026-10-16T12:00:00Z");
        const listed = yield* wakes.listDue(now);
        yield* sql`UPDATE reminders SET status = 'cancelled', cancelled_at = ${CREATED}, cancelled_by = 'user'`;
        const afterCancel = yield* wakes.listDue(now);
        for (const wake of listed) yield* wakes.fire(wake, now);
        return {
          afterCancel: afterCancel.filter((wake) => wake._tag === "reminder"),
          row: yield* readReminder,
        };
      }),
    );
    expect(value.afterCancel).toEqual([]);
    expect(value.row).toMatchObject({ status: "cancelled", fired_at: null });
    expect(recorded.given).toEqual([]);
    expect(recorded.started).toEqual([]);
  });
});

describe("a daily rotation", () => {
  // The latest 04:00 UTC before this instant is 2026-10-16T04:00:00Z.
  const NOW = at("2026-10-16T12:00:00Z");
  const BEFORE_ROTATION = "2026-10-15T20:00:00.000Z";
  const DELIVERED = [{ source: "user", status: "delivered" }];

  const listRotations = (sessions: Parameters<typeof seedSession>) =>
    Effect.gen(function* () {
      yield* seedAssistant();
      yield* seedSession(...sessions);
      const wakes = yield* ScheduledWakes;
      return (yield* wakes.listDue(NOW)).filter((wake) => wake._tag === "dailyRotation");
    });

  it("queues a flush input with source rotation when fired", async () => {
    const { recorded } = await runWake(() =>
      Effect.gen(function* () {
        const rotations = yield* listRotations([BEFORE_ROTATION, DELIVERED]);
        const wakes = yield* ScheduledWakes;
        for (const wake of rotations) yield* wakes.fire(wake, NOW);
      }),
    );
    expect(recorded.given).toHaveLength(1);
    expect(recorded.given[0]).toMatchObject({ sessionId: SESSION, source: "rotation" });
    expect(recorded.retired).toEqual([SESSION]);
  });

  it("does not list a session created after the latest dailyAt", async () => {
    const { value } = await runWake(() => listRotations(["2026-10-16T05:00:00.000Z", DELIVERED]));
    expect(value).toEqual([]);
  });

  it("does not list a session with no delivered input", async () => {
    const { value } = await runWake(() =>
      listRotations([BEFORE_ROTATION, [{ source: "user", status: "queued" }]]),
    );
    expect(value).toEqual([]);
  });

  it("does not list a session that is retired", async () => {
    const { value } = await runWake(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedAssistant();
        yield* seedSession(BEFORE_ROTATION, DELIVERED);
        yield* sql`UPDATE sessions SET retired_at = ${CREATED}`;
        const wakes = yield* ScheduledWakes;
        return yield* wakes.listDue(NOW);
      }),
    );
    expect(value.filter((wake) => wake._tag === "dailyRotation")).toEqual([]);
  });

  it("reads dailyAt in the rotation's timezone", async () => {
    const { value } = await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant(HEARTBEAT, { ...ROTATION, timezone: "Asia/Tokyo" });
        // 04:00 in Tokyo is 19:00 UTC the day before, so the latest one is
        // 2026-10-15T19:00:00Z and a session from 20:00 UTC is newer.
        yield* seedSession(BEFORE_ROTATION, DELIVERED);
        const wakes = yield* ScheduledWakes;
        return yield* wakes.listDue(NOW);
      }),
    );
    expect(value.filter((wake) => wake._tag === "dailyRotation")).toEqual([]);
  });
});

describe("a wake the conversation cannot take", () => {
  const seedAgent = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO agents (id, kind, name, system_prompt, instance_id, permission_profile_id,
                                   access_mode, disallowed_tools, created_at, updated_at)
      VALUES (${uuidFromString(ASSISTANT)}, 'assistant', 'Ada', '', ${uuidFromString(PLACEHOLDER)},
              ${uuidFromString(PLACEHOLDER)}, 'auto', '[]', ${CREATED}, ${CREATED})`;
  });

  it("marks a reminder fired and writes an unreachable notice that names it", async () => {
    const { value } = await runWake(
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedAssistant();
          yield* seedAgent;
          yield* seedSession(CREATED);
          yield* seedReminder("call Ada", "2026-10-16T06:00:00.000Z");
          const wakes = yield* ScheduledWakes;
          const now = at("2026-10-16T12:00:00Z");
          for (const wake of yield* wakes.listDue(now)) yield* wakes.fire(wake, now);
          const again = yield* wakes.listDue(now);
          return {
            again: again.filter((wake) => wake._tag === "reminder"),
            status: (yield* sql<{ status: string }>`SELECT status FROM reminders`)[0]?.status,
            notices: yield* sql<{ sender_role: string; text: string }>`
              SELECT sender_role, text FROM conversation_messages`,
          };
        }),
      { unreachable: true },
    );
    expect(value.status).toBe("fired");
    expect(value.again).toEqual([]);
    expect(value.notices).toEqual([
      {
        sender_role: "notice",
        text: 'Ada can\'t be reached: the reminder "call Ada" could not be delivered: no runner can run the session',
      },
    ]);
  });

  it("skips a heartbeat and moves on to its next time", async () => {
    const { value } = await runWake(
      () =>
        Effect.gen(function* () {
          yield* seedAssistant();
          yield* seedSession(CREATED);
          const wakes = yield* ScheduledWakes;
          yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T08:00:00Z"));
          yield* wakes.fire(HEARTBEAT_WAKE, at("2026-10-16T09:00:00Z"));
          return {
            next: yield* heartbeatNext,
            due: (yield* wakes.listDue(at("2026-10-16T09:00:30Z"))).filter(isHeartbeat),
          };
        }),
      { unreachable: true },
    );
    expect(value).toEqual({ next: "2026-10-17T09:00:00.000Z", due: [] });
  });

  it("warns once about a rotation timezone it cannot read", async () => {
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (options.logLevel === "Warn") warnings.push(String(options.message));
    });
    await runWake(() =>
      Effect.gen(function* () {
        yield* seedAssistant(HEARTBEAT, { ...ROTATION, timezone: "Mars/Olympus" });
        const wakes = yield* ScheduledWakes;
        yield* wakes.listDue(at("2026-10-16T12:00:00Z"));
        yield* wakes.listDue(at("2026-10-16T12:00:01Z"));
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(warnings.filter((text) => text.includes("rotation's timezone"))).toHaveLength(1);
  });
});
