/**
 * Tests the handoff service against a migrated test database, with the run
 * and Task services replaced by recorders:
 *
 * - who and what it refuses before it starts a run, whichever code calls it;
 * - the Task lookup of a handoff: which thread refs it accepts, and how
 *   SQLite runs the query.
 *
 * What a handoff writes is tested over HTTP in `handoffs.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import type { BoundAction, Task } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction, TestDatabase } from "../db/testing";
import { RunService } from "../runs";
import { TaskService, taskRepository } from "../tasks";
import { workflowRepository } from "../workflows";
import { findTaskToContinue, readThreadRef, SignalHandoffs, SignalHandoffsLayer } from "./handoffs";
import { signalRepository } from "./repository";

const REF = "github:issue:acme/api#7";

describe("readThreadRef", () => {
  const origin = (threadRef: string) =>
    ({ type: "event", eventId: 1, connectionId: "c", threadRef }) as const;

  it("returns the thread ref of a plugin signal when it is an External Ref", () => {
    expect(readThreadRef(origin(REF))).toEqual(Option.some(REF));
  });

  it("returns none for a thread ref in another form, and for a signal raised through the API", () => {
    expect(readThreadRef(origin("19b2c"))).toEqual(Option.none());
    expect(readThreadRef(origin("Github:issue:a#1"))).toEqual(Option.none());
    expect(readThreadRef({ type: "api", actor: "user", eventIds: [], reason: "r" })).toEqual(
      Option.none(),
    );
  });
});

describe("findTaskToContinue", () => {
  // The describe line runs this lookup for every distinct thread on every
  // read of To do, so it must start from the few provenance rows of the ref.
  // Without statistics SQLite otherwise starts from the status index and scans
  // every open task.
  it("starts from the provenance of the ref, not from the status index or a scan of the tasks", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        // The statements the repository runs, as SQLite receives them.
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* findTaskToContinue(tasks, REF).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            statements.push(statement.compile());
            return Effect.succeed(statement);
          }),
        );
        const [text, params] = statements.find(([text]) => text.includes("FROM tasks"))!;
        return yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    const details = plan.map((step) => step.detail);
    expect(details.some((detail) => detail.includes("task_provenance"))).toBe(true);
    expect(details.some((detail) => detail.includes("tasks_status_updated_at"))).toBe(false);
    expect(details.some((detail) => detail.startsWith("SCAN tasks"))).toBe(false);
  });
});

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const SESSION: Actor = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: ["run.start", "task.create", "task.update", "signal.write", "signal.read"],
  profileGrants: ["run.start", "task.create", "task.update", "signal.write", "signal.read"],
  assistantId: null,
  agentId: null,
};

const SIGNAL_ID = "0199e0e7-0005-7000-8000-000000000001";
const OTHER_SIGNAL_ID = "0199e0e7-0005-7000-8000-000000000002";
const AT = "2026-10-20T10:00:00.000Z";

/** The Task the recorder returns; the service under test ignores it. */
const RECORDED_TASK: Task = {
  id: "0199e0e7-0007-7000-8000-000000000001",
  title: "Merge the bumps",
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: AT,
  updatedAt: AT,
  statusChangedAt: AT,
};

describe("SignalHandoffs.handOff", () => {
  /** What the recorders saw: the runs started and the handoffs recorded. */
  interface Calls {
    readonly runs: Array<unknown>;
    readonly handoffs: Array<unknown>;
  }

  /**
   * Arranges a workflow that takes an `offer` and a signal with a Hand to an
   * agent answer for it, then calls `handOff` as `actor`. Returns the error
   * or the run it returns, and what the recorders saw. `change` edits the
   * signal before it is stored.
   */
  const handOffAs = async (
    actor: Actor,
    change: (signal: {
      status: "open" | "resolved";
      actions: ReadonlyArray<BoundAction>;
    }) => void = () => undefined,
  ) => {
    const calls: Calls = { runs: [], handoffs: [] };
    const layer = SignalHandoffsLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(RunService)({
            startOnTask: (input, taskId) =>
              Effect.sync(() => {
                calls.runs.push({ input, taskId });
                return { runId: "0199e0e7-0006-7000-8000-000000000001" };
              }),
          }),
          Layer.mock(TaskService)({
            recordHandoff: (handoff) =>
              Effect.sync(() => {
                calls.handoffs.push(handoff);
                return RECORDED_TASK;
              }),
          }),
        ),
      ),
      Layer.provideMerge(TestDatabase),
    );
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const stored = yield* workflows.insert(
          {
            source: "steps: []\n",
            definition: {
              name: "Merge bot",
              inputs: [{ name: "signal", signal: { kinds: ["offer"] }, required: true }],
              steps: [],
            },
          },
          AT,
        );
        const signal = {
          status: "open" as "open" | "resolved",
          actions: [
            {
              id: `hand-to-${stored.id}`,
              label: "Hand to Merge bot",
              operation: {
                op: "signal.handOff",
                input: { signalId: SIGNAL_ID, workflowId: stored.id },
              },
            },
          ] as ReadonlyArray<BoundAction>,
        };
        change(signal);
        const signals = yield* signalRepository;
        yield* signals.insert(
          {
            id: SIGNAL_ID,
            kind: "offer",
            origin: { type: "api", actor: "user", eventIds: [], reason: "r" },
            title: "Merge the bumps",
            priority: "normal",
            blocks: [],
            actions: signal.actions,
            match: {},
            status: signal.status,
            ...(signal.status === "resolved"
              ? {
                  resolution: {
                    kind: "decided" as const,
                    actionId: "dismiss",
                    outcome: "Dismissed",
                    actor: "user",
                    origin: "web" as const,
                    at: AT,
                  },
                }
              : {}),
            createdAt: AT,
          },
          [],
        );
        const handoffs = yield* SignalHandoffs;
        return yield* Effect.provideService(
          Effect.result(handoffs.handOff({ signalId: SIGNAL_ID, workflowId: stored.id })),
          CurrentActor,
          actor,
        );
      }).pipe(inTransaction, Effect.provide(layer), Effect.orDie),
    );
    return { outcome, calls };
  };

  it("hands a signal off for the user, starting the run on the Task it records", async () => {
    const { calls } = await handOffAs(USER);

    expect(calls.runs).toMatchObject([{ input: { inputs: { signal: SIGNAL_ID } } }]);
    expect(calls.handoffs).toMatchObject([
      {
        entry: { signalId: SIGNAL_ID, runId: "0199e0e7-0006-7000-8000-000000000001" },
        newTask: { title: "Merge the bumps", priority: "normal" },
      },
    ]);
  });

  it("refuses a session that holds every grant a handoff uses, and starts no run", async () => {
    const { outcome, calls } = await handOffAs(SESSION);

    expect(outcome).toMatchObject({ failure: { error: { code: "forbidden" } } });
    expect(calls.runs).toEqual([]);
  });

  it("refuses a signal that is already resolved, and starts no run", async () => {
    const { outcome, calls } = await handOffAs(USER, (signal) => {
      signal.status = "resolved";
    });

    expect(outcome).toMatchObject({ failure: { error: { code: "invalid_state" } } });
    expect(calls.runs).toEqual([]);
  });

  it("refuses a workflow the signal does not offer, and starts no run", async () => {
    const { outcome, calls } = await handOffAs(USER, (signal) => {
      signal.actions = [];
    });

    expect(outcome).toMatchObject({ failure: { error: { code: "not_found" } } });
    expect(calls.runs).toEqual([]);
  });

  it("refuses an answer that hands off another signal, and starts no run", async () => {
    const { outcome, calls } = await handOffAs(USER, (signal) => {
      signal.actions = signal.actions.map((action) => ({
        ...action,
        operation: {
          op: "signal.handOff",
          input: { signalId: OTHER_SIGNAL_ID, workflowId: "any" },
        },
      }));
    });

    expect(outcome).toMatchObject({ failure: { error: { code: "validation" } } });
    expect(calls.runs).toEqual([]);
  });
});
