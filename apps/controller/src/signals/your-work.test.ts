/**
 * Tests the Your work read against a migrated test database:
 *
 * - which Tasks it lists: open Tasks that carry the thread ref of an open
 *   signal, snoozed or not, and no other;
 * - what a row holds, and the order of the rows;
 * - who may read it;
 * - the query plan of its two statements.
 *
 * The whole read through HTTP is tested in `your-work.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type { Grant, Signal, TaskStatus } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository, type NewTask } from "../tasks";
import { signalRepository } from "./repository";
import { YourWork, YourWorkLayer } from "./your-work";

const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";
const REF_A = "github:pr:acme/api#1";
const REF_B = "github:pr:acme/api#2";
const AT = "2026-10-20T10:00:00.000Z";
const FAR_FUTURE = "9999-01-01T00:00:00.000Z";
const SIGNAL_1 = "0199e0e7-0005-7000-8000-000000000001";
const SIGNAL_2 = "0199e0e7-0005-7000-8000-000000000002";
const SIGNAL_3 = "0199e0e7-0005-7000-8000-000000000003";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const buildSession = (grants: ReadonlyArray<Grant>): Actor => ({
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants,
  profileGrants: grants,
  assistantId: null,
  agentId: null,
});

/** Builds an open signal of a plugin kind, raised from an event on the thread `threadRef`. */
const buildEventSignal = (id: string, threadRef: string): Signal => ({
  id,
  kind: "github/review-requested",
  origin: { type: "event", eventId: 1, connectionId: CONNECTION_ID, threadRef },
  title: "Review requested",
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: AT,
});

const NEW_TASK: NewTask = {
  title: "A task",
  description: "",
  status: "open",
  priority: "normal",
  labels: [],
  projectId: undefined,
  provenance: [{ ref: REF_A }],
  at: AT,
  actor: "user",
};

/** Builds the Your work read over a fresh database, and runs `body` as `actor`. */
const runYourWork = <A, E>(
  actor: Actor,
  body: Effect.Effect<A, E, SqlClient.SqlClient | YourWork>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(YourWorkLayer.pipe(Layer.provideMerge(TestDatabase))),
    ),
  );

/** Reads Your work as the user, as a list of `title: signal ids`. */
const readRows = (
  arrange: Effect.Effect<void, unknown, SqlClient.SqlClient>,
): Promise<ReadonlyArray<string>> =>
  runYourWork(
    USER,
    Effect.gen(function* () {
      yield* inTransaction(arrange);
      const yourWork = yield* YourWork;
      return (yield* yourWork.query()).tasks.map(
        (task) => `${task.title}: ${task.signalIds.join(" ")}`,
      );
    }),
  );

describe("signal.queryYourWork", () => {
  it("lists an open Task that carries the thread ref of an open signal, with that signal's id", async () => {
    const rows = await runYourWork(
      USER,
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* signals.insert(buildEventSignal(SIGNAL_1, REF_A), []);
            yield* tasks.insert({ ...NEW_TASK, title: "open" });
            yield* tasks.insert({ ...NEW_TASK, title: "working", status: "in-progress" });
          }),
        );
        return (yield* (yield* YourWork).query()).tasks;
      }),
    );

    expect(rows.map((task) => [task.title, task.status, task.updatedAt, task.signalIds])).toEqual([
      ["open", "open", AT, [SIGNAL_1]],
      ["working", "in-progress", AT, [SIGNAL_1]],
    ]);
  });

  it("lists a Task once, with the ids of every open signal it belongs to, however many refs and signals match", async () => {
    const rows = await readRows(
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        yield* signals.insert(buildEventSignal(SIGNAL_3, REF_B), []);
        yield* signals.insert(buildEventSignal(SIGNAL_1, REF_A), []);
        // Two signals on one thread, and a third on another thread of the same Task.
        yield* signals.insert(buildEventSignal(SIGNAL_2, REF_A), []);
        yield* tasks.insert({
          ...NEW_TASK,
          title: "two threads",
          provenance: [{ ref: REF_A }, { ref: REF_B }, { ref: REF_A }],
        });
      }),
    );

    expect(rows).toEqual([`two threads: ${SIGNAL_1} ${SIGNAL_2} ${SIGNAL_3}`]);
  });

  it("lists the Task of a snoozed signal and of one whose snooze ran out alike, so a snooze running out between this read and To do's changes nothing, and leaves out resolved and core signals", async () => {
    const rows = await readRows(
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        const snoozed = "0199e0e7-0005-7000-8000-0000000000a1";
        const ranOut = "0199e0e7-0005-7000-8000-0000000000a2";
        const resolved = "0199e0e7-0005-7000-8000-0000000000a3";
        yield* signals.insert(buildEventSignal(snoozed, "github:pr:acme/api#10"), []);
        yield* signals.insert(buildEventSignal(ranOut, "github:pr:acme/api#11"), []);
        yield* signals.insert(buildEventSignal(resolved, "github:pr:acme/api#12"), []);
        // A core signal, raised through the API, has no thread ref, so no
        // Task belongs to it even when a Task carries the ref "unused".
        yield* signals.insert(
          {
            ...buildEventSignal("0199e0e7-0005-7000-8000-0000000000a4", "unused"),
            kind: "fyi",
            origin: { type: "api", actor: "user", eventIds: [], reason: "r" },
          },
          [],
        );
        yield* signals.snooze([snoozed], { until: FAR_FUTURE, snoozedAt: AT, actor: "user" });
        yield* signals.snooze([ranOut], { until: AT, snoozedAt: AT, actor: "user" });
        yield* signals.resolve(resolved, {
          kind: "decided",
          actionId: "done",
          outcome: "Done",
          actor: "user",
          origin: "web",
          at: AT,
        });
        for (const [title, ref] of [
          ["snoozed", "github:pr:acme/api#10"],
          ["ran out", "github:pr:acme/api#11"],
          ["resolved", "github:pr:acme/api#12"],
          ["core", "unused"],
        ] as const) {
          yield* tasks.insert({ ...NEW_TASK, title, provenance: [{ ref }] });
        }
      }),
    );

    expect(rows.toSorted()).toEqual([
      "ran out: 0199e0e7-0005-7000-8000-0000000000a2",
      "snoozed: 0199e0e7-0005-7000-8000-0000000000a1",
    ]);
  });

  it("leaves out Tasks that are done, cancelled or deleted, and Tasks with no matching ref", async () => {
    const rows = await readRows(
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        yield* signals.insert(buildEventSignal(SIGNAL_1, REF_A), []);
        for (const status of ["done", "cancelled"] as const satisfies ReadonlyArray<TaskStatus>) {
          yield* tasks.insert({ ...NEW_TASK, title: status, status });
        }
        const deleted = yield* tasks.insert({ ...NEW_TASK, title: "deleted" });
        yield* tasks.softDelete(deleted.id, AT);
        yield* tasks.insert({ ...NEW_TASK, title: "other ref", provenance: [{ ref: REF_B }] });
        yield* tasks.insert({ ...NEW_TASK, title: "no ref", provenance: [] });
        yield* tasks.insert({ ...NEW_TASK, title: "kept" });
      }),
    );

    expect(rows).toEqual([`kept: ${SIGNAL_1}`]);
  });

  it("returns nothing when no signal is open", async () => {
    const rows = await readRows(
      taskRepository.pipe(Effect.flatMap((tasks) => tasks.insert(NEW_TASK))),
    );

    expect(rows).toEqual([]);
  });

  it("orders the Tasks by the last update, newest first, then by id", async () => {
    const rows = await runYourWork(
      USER,
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* signals.insert(buildEventSignal(SIGNAL_1, REF_A), []);
            yield* tasks.insert({ ...NEW_TASK, title: "oldest", at: "2026-10-20T09:00:00.000Z" });
            yield* tasks.insert({ ...NEW_TASK, title: "newest", at: "2026-10-20T12:00:00.000Z" });
            yield* tasks.insert({ ...NEW_TASK, title: "middle", at: "2026-10-20T11:00:00.000Z" });
          }),
        );
        return (yield* (yield* YourWork).query()).tasks;
      }),
    );

    expect(rows.map((task) => task.title)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks a tie in the last update by the Task's id", async () => {
    const rows = await runYourWork(
      USER,
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* signals.insert(buildEventSignal(SIGNAL_1, REF_A), []);
            for (let n = 0; n < 5; n++) yield* tasks.insert({ ...NEW_TASK, title: `task ${n}` });
          }),
        );
        return (yield* (yield* YourWork).query()).tasks;
      }),
    );

    const ids = rows.map((task) => task.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(ids.toSorted());
  });

  it("lets a session read it when its profile holds both the signal and the task read grant, as it can read the same facts from those operations", async () => {
    const result = await runYourWork(
      buildSession(["signal.read", "task.read"]),
      Effect.flatMap(YourWork, (yourWork) => yourWork.query()),
    );

    expect(result).toEqual({ tasks: [] });
  });

  it.each([
    ["the signal read grant", ["task.read"], "signal.read"],
    ["the task read grant", ["signal.read"], "task.read"],
  ] as const)(
    "refuses a session that lacks %s, and names the grant, so signal access alone never reveals a Task title",
    async (_, grants, missing) => {
      const error = await runYourWork(
        buildSession(grants),
        Effect.flip(Effect.flatMap(YourWork, (yourWork) => yourWork.query())),
      );

      expect(error).toMatchObject({ error: { code: "forbidden", details: { grant: missing } } });
    },
  );
});

describe("the query plan of Your work's statements", () => {
  /**
   * Returns the plan SQLite chooses for the statement of Your work whose text
   * contains `fragment`. One signal is open, because the Task statement
   * only runs when a signal gives it a ref.
   */
  const planOf = (fragment: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const signals = yield* signalRepository;
        yield* inTransaction(signals.insert(buildEventSignal(SIGNAL_1, REF_A), []));
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* YourWork.pipe(
          Effect.flatMap((yourWork) => yourWork.query()),
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const [text, params] = statements.find(([text]) => text.includes(fragment))!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(YourWorkLayer.pipe(Layer.provideMerge(TestDatabase))),
        Effect.orDie,
      ),
    );

  it("reads the open signals from an index that holds only the open signals, never the resolved ones", async () => {
    const plan = await planOf("FROM signals");

    // Each of these indexes holds the open signals only, so the scan never
    // reads the resolved ones, which are the vast majority.
    expect(plan.filter((step) => step.startsWith("SCAN signals"))).toEqual([
      expect.stringMatching(/^SCAN signals USING (COVERING )?INDEX signals_open/),
    ]);
    expect(plan.some((step) => step.includes("sqlite_autoindex_signals"))).toBe(false);
  });

  it("starts the Task statement from the provenance ref index, not from the status index or a scan of the Tasks", async () => {
    const plan = await planOf("FROM task_provenance");

    expect(plan).toContain("SEARCH p USING INDEX task_provenance_ref (ref=?)");
    expect(plan.some((step) => step.includes("tasks_status"))).toBe(false);
    expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false);
  });
});
