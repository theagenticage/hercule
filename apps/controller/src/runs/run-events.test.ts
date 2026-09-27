/**
 * Tests the platform event a run emits when it ends: the payload
 * `buildRunEndedEvent` builds for each way a run ends, and the actor
 * `readEndingActor` stamps it with for each kind of caller.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { Run } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { buildRunEndedEvent, readEndingActor } from "./run-events";

const RUN_ID = "0199f0b7-0000-7000-8000-00000000e001";
const WORKFLOW_ID = "0199f0b7-0000-7000-8000-00000000e002";
const SESSION_ID = "0199f0b7-0000-7000-8000-00000000e003";

const CREATED_AT = "2026-09-27T10:00:00.000Z";
const STARTED_AT = "2026-09-27T10:00:01.000Z";
const FINISHED_AT = "2026-09-27T10:05:00.000Z";

const PLAN = { name: "File a task", steps: [] };
const INPUTS = { title: "Fix login", priority: "high" };
const ORIGIN = { kind: "manual", actor: "user" } as const;

/** A run that has started and not ended yet. */
const RUNNING_RUN: Run = {
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  plan: PLAN,
  inputs: INPUTS,
  origin: ORIGIN,
  steps: [],
  edgeTraversals: [],
  createdAt: CREATED_AT,
  status: "running",
  startedAt: STARTED_AT,
};

/** A run of a workflow sent with `run.start`, which the engine has not picked up yet. */
const PENDING_RUN: Run = {
  id: RUN_ID,
  workflowId: null,
  plan: PLAN,
  inputs: {},
  origin: ORIGIN,
  steps: [],
  edgeTraversals: [],
  createdAt: CREATED_AT,
  status: "pending",
};

/** The fields every payload built from `RUNNING_RUN` starts with. */
const RUNNING_FIELDS = {
  runId: RUN_ID,
  workflowId: WORKFLOW_ID,
  origin: ORIGIN,
  inputs: INPUTS,
  startedAt: STARTED_AT,
  finishedAt: FINISHED_AT,
};

describe("buildRunEndedEvent", () => {
  it("builds run.completed with the terminal step's output, dated when the run ended", () => {
    const output = { id: "task-1", title: "Fix login" };

    expect(
      buildRunEndedEvent(RUNNING_RUN, { status: "completed", output }, FINISHED_AT, "user"),
    ).toStrictEqual({
      kind: "run.completed",
      actor: "user",
      at: FINISHED_AT,
      payload: { ...RUNNING_FIELDS, output },
    });
  });

  it("leaves output out of run.completed when no terminal step ended the run", () => {
    const event = buildRunEndedEvent(RUNNING_RUN, { status: "completed" }, FINISHED_AT, null);

    expect(event.payload).toStrictEqual(RUNNING_FIELDS);
  });

  it("keeps an output of null, because null is a value a terminal step can return", () => {
    const event = buildRunEndedEvent(
      RUNNING_RUN,
      { status: "completed", output: null },
      FINISHED_AT,
      null,
    );

    expect(event.payload).toStrictEqual({ ...RUNNING_FIELDS, output: null });
  });

  it("builds run.failed with the failure reason, the failed step and the failed edge", () => {
    const failedEdge = { index: 1, message: "No such key: no_such_field" };

    expect(
      buildRunEndedEvent(
        RUNNING_RUN,
        {
          status: "failed",
          failureReason: "expression-error",
          failedStepId: "start",
          failedEdge,
        },
        FINISHED_AT,
        null,
      ),
    ).toStrictEqual({
      kind: "run.failed",
      actor: null,
      at: FINISHED_AT,
      payload: {
        ...RUNNING_FIELDS,
        failureReason: "expression-error",
        failedStepId: "start",
        failedEdge,
      },
    });
  });

  it("leaves failedEdge out of run.failed when the run failed at a step rather than an edge", () => {
    const event = buildRunEndedEvent(
      RUNNING_RUN,
      { status: "failed", failureReason: "step-failed", failedStepId: "create" },
      FINISHED_AT,
      null,
    );

    expect(event.payload).toStrictEqual({
      ...RUNNING_FIELDS,
      failureReason: "step-failed",
      failedStepId: "create",
    });
  });

  it("leaves failedStepId out of run.failed when the controller failed the run outside any step", () => {
    const event = buildRunEndedEvent(
      RUNNING_RUN,
      { status: "failed", failureReason: "controller-error" },
      FINISHED_AT,
      null,
    );

    expect(event.payload).toStrictEqual({ ...RUNNING_FIELDS, failureReason: "controller-error" });
  });

  it("builds run.cancelled with only the fields every run event has, whether workspace is kept or not", () => {
    for (const keepWorkspace of [false, true]) {
      expect(
        buildRunEndedEvent(
          RUNNING_RUN,
          { status: "cancelled", keepWorkspace },
          FINISHED_AT,
          `session:${SESSION_ID}`,
        ),
        `keepWorkspace: ${String(keepWorkspace)}`,
      ).toStrictEqual({
        kind: "run.cancelled",
        actor: `session:${SESSION_ID}`,
        at: FINISHED_AT,
        payload: RUNNING_FIELDS,
      });
    }
  });

  it("leaves startedAt out for a run that ended while pending, and keeps its null workflowId", () => {
    const event = buildRunEndedEvent(
      PENDING_RUN,
      { status: "cancelled", keepWorkspace: false },
      FINISHED_AT,
      "user",
    );

    expect(event.payload).toStrictEqual({
      runId: RUN_ID,
      workflowId: null,
      origin: ORIGIN,
      inputs: {},
      finishedAt: FINISHED_AT,
    });
  });
});

describe("readEndingActor", () => {
  /** Returns what `readEndingActor` reads while `actor` is the current actor. */
  const readAs = (actor: Actor) =>
    Effect.runSync(Effect.provideService(readEndingActor, CurrentActor, actor));

  it("is the user when the user's request ended the run", () => {
    expect(
      readAs({
        _tag: "user",
        userId: "0199f0b7-0000-7000-8000-00000000e004",
        credential: { kind: "login", id: "0199f0b7-0000-7000-8000-00000000e005", tokenHash: "h" },
      }),
    ).toBe("user");
  });

  it("is session:<id> when a session's request ended the run", () => {
    expect(
      readAs({
        _tag: "session",
        sessionId: SESSION_ID,
        profileId: "0199f0b7-0000-7000-8000-00000000e006",
        grants: ["run.write"],
      }),
    ).toBe(`session:${SESSION_ID}`);
  });

  it("is null when the run ended on its own, while one of its steps executed as the run", () => {
    expect(readAs({ _tag: "run", runId: RUN_ID, stepId: "create" })).toBeNull();
  });

  it("is null when no caller ended the run, as when the controller fails it", () => {
    expect(readAs({ _tag: "none" })).toBeNull();
  });
});
