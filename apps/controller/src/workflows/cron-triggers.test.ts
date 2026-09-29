/**
 * Tests the Scheduler's rule for cron triggers, `listTriggersToSchedule` and
 * `scheduleTrigger`, on a migrated in-memory database. Both take the
 * current time as an argument, so each test moves time on by running a pass
 * with a later `now`.
 *
 * Every trigger here fires at 09:00 each day. In September, 09:00 in
 * Amsterdam is 07:00 UTC, and 09:00 in New York is 13:00 UTC.
 */
import { describe, expect, it } from "vitest";
import { Cron, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TriggerKey } from "@hercule/contract";
import { uuidFromString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { Settings, SettingsLayer } from "../settings";
import { CronTriggerScheduler, CronTriggerSchedulerLayer, decideFiring } from "./cron-triggers";
import { workflowRepository, type DeclaredTrigger } from "./repository";
import { declareCronTrigger } from "./testing";
import { TriggerHealthLayer } from "./trigger-health";

const layer = CronTriggerSchedulerLayer.pipe(
  Layer.provide(TriggerHealthLayer),
  Layer.provide(NotifierLayer),
  Layer.provide(AuditLogLayer),
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, CronTriggerScheduler | Settings | SqlClient.SqlClient>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.orDie));

const SAVED_AT = "2026-09-22T10:00:00.000Z";
/** The time of the first pass in most tests: after 09:00 in Amsterdam, before 09:00 in New York. */
const FIRST_PASS = "2026-09-22T12:00:00.000Z";
/** 09:00 in Amsterdam on the day after `FIRST_PASS`. */
const NEXT_MORNING = "2026-09-23T07:00:00.000Z";

const ALICE = "0199e0e7-0000-7000-8000-000000000001";
const BOB = "0199e0e7-0000-7000-8000-000000000002";

/** Inserts a workflow with the given triggers, enabled unless `enabled` is false. Returns its id. */
const storeWorkflow = (triggers: ReadonlyArray<DeclaredTrigger>, enabled = true) =>
  Effect.gen(function* () {
    const workflows = yield* workflowRepository;
    const stored = yield* workflows.insert(
      { source: "name: Nightly\nsteps: []\n", definition: { name: "Nightly", steps: [] } },
      SAVED_AT,
    );
    yield* workflows.reconcileTriggers(stored.id, triggers, SAVED_AT);
    if (enabled) yield* workflows.update(stored.id, { enabled: true }, SAVED_AT);
    return stored.id;
  });

/** Lists the cron triggers that have work at `now`, and returns them with the scheduler. */
const listTriggersToSchedule = (now: string) =>
  Effect.gen(function* () {
    const scheduler = yield* CronTriggerScheduler;
    return { scheduler, keys: yield* scheduler.listTriggersToSchedule(new Date(now)) };
  });

/** Runs one pass of the Scheduler at `now`: lists the triggers that have work, and schedules each. */
const firePass = (now: string) =>
  Effect.gen(function* () {
    const { scheduler, keys } = yield* listTriggersToSchedule(now);
    for (const key of keys) yield* scheduler.scheduleTrigger(key, new Date(now));
  });

/** Inserts a user created at `createdAt` and sets their timezone setting. */
const addUserInZone = (id: string, username: string, createdAt: string, timezone: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = yield* Settings;
    yield* sql`
      INSERT INTO users (id, username, password_hash, created_at, updated_at)
      VALUES (${uuidFromString(id)}, ${username}, 'x', ${createdAt}, ${createdAt})`;
    yield* settings.setForUser(id, "timezone", timezone);
  });

/** The Scheduler's columns of one trigger row. */
interface ScheduleState {
  readonly next_fire_at: string | null;
  readonly next_fire_zone: string | null;
  readonly last_fired_at: string | null;
  readonly skipped_from: string | null;
  readonly skipped_until: string | null;
}

/** Reads the Scheduler's columns of one trigger row. */
const readScheduleState = (key: TriggerKey) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<ScheduleState>`
        SELECT next_fire_at, next_fire_zone, last_fired_at, skipped_from, skipped_until
        FROM triggers
        WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}`,
      (rows) => rows[0]!,
    ),
  );

/** A `cron.tick` event as the log holds it, with its payload parsed. */
interface StoredTick {
  readonly source: string;
  readonly connectionId: Uint8Array | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly payload: unknown;
}

/** Reads every `cron.tick` event in the log, in the order they were written. */
const readCronTicks = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{
      readonly source: string;
      readonly connection_id: Uint8Array | null;
      readonly occurred_at: string;
      readonly received_at: string;
      readonly payload: string;
    }>`
      SELECT source, connection_id, occurred_at, received_at, payload
      FROM events WHERE kind = 'cron.tick' ORDER BY id`,
    (rows): ReadonlyArray<StoredTick> =>
      rows.map((row) => ({
        source: row.source,
        connectionId: row.connection_id,
        occurredAt: row.occurred_at,
        receivedAt: row.received_at,
        payload: JSON.parse(row.payload) as unknown,
      })),
  ),
);

/**
 * Stores one cron trigger `nightly`, lets a first pass at `FIRST_PASS`
 * compute its next time, `NEXT_MORNING`, then runs a pass at each time in
 * `later`. Returns the trigger's schedule state and the ticks in the log.
 */
const firePassesAfterFirst = (
  later: ReadonlyArray<string>,
  options: { readonly paused?: boolean; readonly enabled?: boolean } = {},
) =>
  run(
    Effect.gen(function* () {
      const workflows = yield* workflowRepository;
      const workflowId = yield* storeWorkflow([declareCronTrigger("nightly")], options.enabled);
      const key = { workflowId, triggerId: "nightly" };
      if (options.paused === true) yield* workflows.setTriggerStatus(key, "paused", SAVED_AT);
      yield* firePass(FIRST_PASS);
      for (const now of later) yield* firePass(now);
      return {
        workflowId,
        state: yield* readScheduleState(key),
        ticks: yield* readCronTicks,
      };
    }),
  );

describe("the first pass over a new cron trigger", () => {
  it("computes the next time in the trigger's own timezone, and fires nothing", async () => {
    const { state, ticks } = await firePassesAfterFirst([]);

    expect(state).toEqual({
      next_fire_at: NEXT_MORNING,
      next_fire_zone: "Europe/Amsterdam",
      last_fired_at: null,
      skipped_from: null,
      skipped_until: null,
    });
    expect(ticks).toEqual([]);
  });

  it("computes the next time of a trigger with no timezone in the oldest user's timezone", async () => {
    const state = await run(
      Effect.gen(function* () {
        yield* addUserInZone(BOB, "bob", "2026-02-01T00:00:00.000Z", "Asia/Tokyo");
        yield* addUserInZone(ALICE, "alice", "2026-01-01T00:00:00.000Z", "America/New_York");
        const workflowId = yield* storeWorkflow([
          declareCronTrigger("nightly", { timezone: undefined }),
        ]);
        yield* firePass(FIRST_PASS);
        return yield* readScheduleState({ workflowId, triggerId: "nightly" });
      }),
    );

    expect(state).toMatchObject({
      next_fire_at: "2026-09-22T13:00:00.000Z",
      next_fire_zone: "America/New_York",
    });
  });

  it("computes the next time of a trigger with no timezone in UTC when no user has set one", async () => {
    const state = await run(
      Effect.gen(function* () {
        const workflowId = yield* storeWorkflow([
          declareCronTrigger("nightly", { timezone: undefined }),
        ]);
        yield* firePass(FIRST_PASS);
        return yield* readScheduleState({ workflowId, triggerId: "nightly" });
      }),
    );

    expect(state).toMatchObject({
      next_fire_at: "2026-09-23T09:00:00.000Z",
      next_fire_zone: "UTC",
    });
  });
});

describe("a change of the user's timezone", () => {
  it("recomputes the next time of the triggers with no timezone of their own, and only theirs", async () => {
    const { own, users, ticks } = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* addUserInZone(ALICE, "alice", "2026-01-01T00:00:00.000Z", "America/New_York");
        const workflowId = yield* storeWorkflow([
          declareCronTrigger("own"),
          declareCronTrigger("users", { timezone: undefined }),
        ]);
        yield* firePass(FIRST_PASS);
        yield* settings.setForUser(ALICE, "timezone", "Asia/Tokyo");
        yield* firePass("2026-09-22T12:00:01.000Z");
        return {
          own: yield* readScheduleState({ workflowId, triggerId: "own" }),
          users: yield* readScheduleState({ workflowId, triggerId: "users" }),
          ticks: yield* readCronTicks,
        };
      }),
    );

    expect(own).toMatchObject({ next_fire_at: NEXT_MORNING, next_fire_zone: "Europe/Amsterdam" });
    // 09:00 in Tokyo is 00:00 UTC.
    expect(users).toMatchObject({
      next_fire_at: "2026-09-23T00:00:00.000Z",
      next_fire_zone: "Asia/Tokyo",
    });
    expect(ticks).toEqual([]);
  });

  it("still fires a time that has come, although it was computed in the old timezone", async () => {
    const { users, ticks } = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* addUserInZone(ALICE, "alice", "2026-01-01T00:00:00.000Z", "America/New_York");
        const workflowId = yield* storeWorkflow([
          declareCronTrigger("users", { timezone: undefined }),
        ]);
        yield* firePass(FIRST_PASS);
        yield* settings.setForUser(ALICE, "timezone", "Asia/Tokyo");
        // 09:00 in New York has just passed.
        yield* firePass("2026-09-22T13:00:30.000Z");
        return {
          users: yield* readScheduleState({ workflowId, triggerId: "users" }),
          ticks: yield* readCronTicks,
        };
      }),
    );

    expect(ticks.map((tick) => tick.occurredAt)).toEqual(["2026-09-22T13:00:00.000Z"]);
    expect(users).toMatchObject({
      next_fire_at: "2026-09-23T00:00:00.000Z",
      next_fire_zone: "Asia/Tokyo",
      last_fired_at: "2026-09-22T13:00:00.000Z",
    });
  });
});

describe("a cron trigger that changed after it was listed", () => {
  it("fires once when it is scheduled twice from the same listing", async () => {
    const ticks = await run(
      Effect.gen(function* () {
        yield* storeWorkflow([declareCronTrigger("nightly")]);
        yield* firePass(FIRST_PASS);
        const now = "2026-09-23T07:00:30.000Z";
        const { scheduler, keys } = yield* listTriggersToSchedule(now);
        for (const key of [...keys, ...keys]) {
          yield* scheduler.scheduleTrigger(key, new Date(now));
        }
        return yield* readCronTicks;
      }),
    );

    expect(ticks).toHaveLength(1);
  });

  it("does not fire when it was paused between the listing and its scheduling", async () => {
    const { state, ticks } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow([declareCronTrigger("nightly")]);
        const key = { workflowId, triggerId: "nightly" };
        yield* firePass(FIRST_PASS);
        const now = "2026-09-23T07:00:30.000Z";
        const { scheduler, keys } = yield* listTriggersToSchedule(now);
        yield* workflows.setTriggerStatus(key, "paused", now);
        for (const listed of keys) yield* scheduler.scheduleTrigger(listed, new Date(now));
        return { state: yield* readScheduleState(key), ticks: yield* readCronTicks };
      }),
    );

    expect(ticks).toEqual([]);
    expect(state).toMatchObject({ next_fire_at: "2026-09-24T07:00:00.000Z", last_fired_at: null });
  });
});

describe("a live cron trigger whose next time has come", () => {
  it("appends one cron tick for the scheduled time, and moves the trigger on to its next time", async () => {
    const { workflowId, state, ticks } = await firePassesAfterFirst(["2026-09-23T07:00:30.000Z"]);

    expect(ticks).toEqual([
      {
        source: "cron",
        connectionId: null,
        occurredAt: NEXT_MORNING,
        receivedAt: "2026-09-23T07:00:30.000Z",
        payload: {
          workflowId,
          triggerId: "nightly",
          scheduledFor: NEXT_MORNING,
          previousFiredAt: null,
        },
      },
    ]);
    expect(state).toEqual({
      next_fire_at: "2026-09-24T07:00:00.000Z",
      next_fire_zone: "Europe/Amsterdam",
      last_fired_at: NEXT_MORNING,
      skipped_from: null,
      skipped_until: null,
    });
  });

  it("names the time it last fired in the payload of every tick after the first", async () => {
    const { workflowId, ticks } = await firePassesAfterFirst([
      "2026-09-23T07:00:01.000Z",
      "2026-09-24T07:00:01.000Z",
    ]);

    expect(ticks.map((tick) => tick.payload)).toEqual([
      { workflowId, triggerId: "nightly", scheduledFor: NEXT_MORNING, previousFiredAt: null },
      {
        workflowId,
        triggerId: "nightly",
        scheduledFor: "2026-09-24T07:00:00.000Z",
        previousFiredAt: NEXT_MORNING,
      },
    ]);
  });

  it("still fires when the pass comes exactly 60 seconds after the scheduled time", async () => {
    const { ticks } = await firePassesAfterFirst(["2026-09-23T07:01:00.000Z"]);

    expect(ticks).toHaveLength(1);
  });

  it("fires once when a second pass comes at the same instant", async () => {
    const { ticks } = await firePassesAfterFirst([
      "2026-09-23T07:00:30.000Z",
      "2026-09-23T07:00:30.000Z",
    ]);

    expect(ticks).toHaveLength(1);
  });

  // The tick and the trigger's next time are written in one transaction, so
  // this cannot happen through the Scheduler. The dedup key is the second
  // guard, and this test sets the trigger back by hand to reach it.
  it("writes the tick once when the trigger is set back to a time it already fired for", async () => {
    const ticks = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* storeWorkflow([declareCronTrigger("nightly")]);
        yield* firePass(FIRST_PASS);
        yield* firePass("2026-09-23T07:00:30.000Z");
        yield* sql`UPDATE triggers SET next_fire_at = ${NEXT_MORNING}, last_fired_at = NULL`;
        yield* firePass("2026-09-23T07:00:40.000Z");
        return yield* readCronTicks;
      }),
    );

    expect(ticks).toHaveLength(1);
  });

  it("fires at 09:00 in its timezone across the end of summer time", async () => {
    // Summer time in Amsterdam ends on 25 October 2026, so 09:00 there is
    // 07:00 UTC the day before and 08:00 UTC that day.
    const { state, ticks } = await run(
      Effect.gen(function* () {
        const workflowId = yield* storeWorkflow([declareCronTrigger("nightly")]);
        yield* firePass("2026-10-24T12:00:00.000Z");
        yield* firePass("2026-10-25T08:00:05.000Z");
        return {
          state: yield* readScheduleState({ workflowId, triggerId: "nightly" }),
          ticks: yield* readCronTicks,
        };
      }),
    );

    expect(ticks.map((tick) => tick.occurredAt)).toEqual(["2026-10-25T08:00:00.000Z"]);
    expect(state.next_fire_at).toBe("2026-10-26T08:00:00.000Z");
  });
});

describe("a live cron trigger whose next time passed more than 60 seconds ago", () => {
  it("fires nothing, records the stretch of times it missed, and moves on to its next time", async () => {
    // The controller was down from before the first missed time until after
    // the fourth.
    const { state, ticks } = await firePassesAfterFirst(["2026-09-26T12:00:00.000Z"]);

    expect(ticks).toEqual([]);
    expect(state).toEqual({
      next_fire_at: "2026-09-27T07:00:00.000Z",
      next_fire_zone: "Europe/Amsterdam",
      last_fired_at: null,
      skipped_from: NEXT_MORNING,
      skipped_until: "2026-09-26T07:00:00.000Z",
    });
  });

  it("records a single missed time when the pass is 61 seconds late", async () => {
    const { state, ticks } = await firePassesAfterFirst(["2026-09-23T07:01:01.000Z"]);

    expect(ticks).toEqual([]);
    expect(state).toMatchObject({ skipped_from: NEXT_MORNING, skipped_until: NEXT_MORNING });
  });

  it("fires for the latest time when that one is on time, and records the times before it as missed", async () => {
    // The controller was down from before the first missed time, and came
    // back 30 seconds after the fourth.
    const { workflowId, state, ticks } = await firePassesAfterFirst(["2026-09-26T07:00:30.000Z"]);

    expect(ticks.map((tick) => tick.payload)).toEqual([
      {
        workflowId,
        triggerId: "nightly",
        scheduledFor: "2026-09-26T07:00:00.000Z",
        previousFiredAt: null,
      },
    ]);
    expect(state).toEqual({
      next_fire_at: "2026-09-27T07:00:00.000Z",
      next_fire_zone: "Europe/Amsterdam",
      last_fired_at: "2026-09-26T07:00:00.000Z",
      skipped_from: NEXT_MORNING,
      skipped_until: "2026-09-25T07:00:00.000Z",
    });
  });

  it("keeps when it last fired, and names that time in the payload of its next tick", async () => {
    const { workflowId, state, ticks } = await firePassesAfterFirst([
      "2026-09-23T07:00:01.000Z",
      "2026-09-26T12:00:00.000Z",
      "2026-09-27T07:00:01.000Z",
    ]);

    expect(state).toMatchObject({
      last_fired_at: "2026-09-27T07:00:00.000Z",
      skipped_from: "2026-09-24T07:00:00.000Z",
      skipped_until: "2026-09-26T07:00:00.000Z",
    });
    // A missed time does not count as a fire, so the stretch since the last
    // run is from the first tick to the second.
    expect(ticks.map((tick) => tick.payload)).toEqual([
      { workflowId, triggerId: "nightly", scheduledFor: NEXT_MORNING, previousFiredAt: null },
      {
        workflowId,
        triggerId: "nightly",
        scheduledFor: "2026-09-27T07:00:00.000Z",
        previousFiredAt: NEXT_MORNING,
      },
    ]);
  });
});

describe("a cron trigger that cannot fire", () => {
  const MOVED_ON_WITHOUT_A_NOTE: ScheduleState = {
    next_fire_at: "2026-09-24T07:00:00.000Z",
    next_fire_zone: "Europe/Amsterdam",
    last_fired_at: null,
    skipped_from: null,
    skipped_until: null,
  };

  it("moves a paused trigger on to its next time without firing", async () => {
    const { state, ticks } = await firePassesAfterFirst(["2026-09-23T07:00:30.000Z"], {
      paused: true,
    });

    expect(ticks).toEqual([]);
    expect(state).toEqual(MOVED_ON_WITHOUT_A_NOTE);
  });

  it("moves the trigger of a disabled workflow on to its next time without firing", async () => {
    const { state, ticks } = await firePassesAfterFirst(["2026-09-23T07:00:30.000Z"], {
      enabled: false,
    });

    expect(ticks).toEqual([]);
    expect(state).toEqual(MOVED_ON_WITHOUT_A_NOTE);
  });

  it("records no missed times for a paused trigger, however late the pass", async () => {
    const { state, ticks } = await firePassesAfterFirst(["2026-09-26T12:00:00.000Z"], {
      paused: true,
    });

    expect(ticks).toEqual([]);
    expect(state).toEqual({ ...MOVED_ON_WITHOUT_A_NOTE, next_fire_at: "2026-09-27T07:00:00.000Z" });
  });
});

describe("a cron trigger whose timezone is not a known one", () => {
  /** Reads the trigger's recorded error and the notifications raised about triggers. */
  const readHealth = (key: TriggerKey) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [trigger] = yield* sql<{
        readonly health_error_message: string | null;
        readonly health_error_at: string | null;
      }>`
        SELECT health_error_message, health_error_at FROM triggers
        WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}`;
      const notifications = yield* sql<{ readonly title: string; readonly body: string }>`
        SELECT title, body FROM notifications WHERE kind = 'core.trigger-error'`;
      return { ...trigger!, notifications };
    });

  it("gets no next time and records the error on its health once, then is scheduled and cleared once the timezone is known", async () => {
    const { broken, again, fixed } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflowId = yield* storeWorkflow([declareCronTrigger("nightly")]);
        const key = { workflowId, triggerId: "nightly" };
        // Saving a workflow refuses an unknown timezone, so the test writes
        // one the way a newer timezone database would drop a known one.
        yield* sql`UPDATE triggers SET timezone = 'Mars/Olympus_Mons'
                   WHERE workflow_id = ${uuidFromString(workflowId)}`;
        yield* firePass(FIRST_PASS);
        const broken = { state: yield* readScheduleState(key), ...(yield* readHealth(key)) };
        yield* firePass("2026-09-22T12:00:01.000Z");
        const again = yield* readHealth(key);
        yield* sql`UPDATE triggers SET timezone = 'Europe/Amsterdam'
                   WHERE workflow_id = ${uuidFromString(workflowId)}`;
        yield* firePass("2026-09-22T12:00:02.000Z");
        const fixed = { state: yield* readScheduleState(key), ...(yield* readHealth(key)) };
        return { broken, again, fixed };
      }),
    );

    expect(broken.state).toMatchObject({ next_fire_at: null, next_fire_zone: null });
    expect(broken.health_error_message).toMatch(
      /^The schedule "0 9 \* \* \*" cannot be read in the timezone Mars\/Olympus_Mons: .+\. Set a known timezone on the trigger in the workflow\.$/,
    );
    expect(broken.notifications).toEqual([
      {
        title: "A trigger's next scheduled time could not be computed",
        body: broken.health_error_message,
      },
    ]);
    // A later pass fails the same way and writes nothing, so the error keeps
    // the time it was first recorded and the user hears about it once.
    expect(again).toEqual({
      health_error_message: broken.health_error_message,
      health_error_at: broken.health_error_at,
      notifications: broken.notifications,
    });
    expect(fixed.state).toMatchObject({
      next_fire_at: NEXT_MORNING,
      next_fire_zone: "Europe/Amsterdam",
    });
    expect(fixed).toMatchObject({ health_error_message: null, health_error_at: null });
  });
});

describe("deciding what a due trigger fires for", () => {
  const cron = Cron.parseUnsafe("0 9 * * *", "Europe/Amsterdam");

  it("fires for its scheduled time when that is the latest and on time", () => {
    expect(decideFiring(cron, NEXT_MORNING, new Date("2026-09-23T07:00:30.000Z"))).toEqual({
      firedAt: NEXT_MORNING,
    });
  });

  it("fires for the latest time and misses the ones before it, when the latest is on time", () => {
    expect(decideFiring(cron, NEXT_MORNING, new Date("2026-09-25T07:00:30.000Z"))).toEqual({
      firedAt: "2026-09-25T07:00:00.000Z",
      skipped: { from: NEXT_MORNING, until: "2026-09-24T07:00:00.000Z" },
    });
  });

  it("misses every time up to the latest, and fires for none, when even the latest is late", () => {
    expect(decideFiring(cron, NEXT_MORNING, new Date("2026-09-25T08:00:00.000Z"))).toEqual({
      skipped: { from: NEXT_MORNING, until: "2026-09-25T07:00:00.000Z" },
    });
  });

  it("fires for a scheduled time that lies after the latest, because it came from another timezone", () => {
    // 09:00 in New York, while the schedule is now read in Amsterdam.
    const owed = "2026-09-23T13:00:00.000Z";
    expect(decideFiring(cron, owed, new Date("2026-09-23T13:00:30.000Z"))).toEqual({
      firedAt: owed,
    });
  });
});
