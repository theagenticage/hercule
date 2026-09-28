/**
 * Tests the platform event a run emits when it ends: the payload
 * `buildRunEndedEvent` builds for each way a run ends, stamped with the actor
 * it is given. Which actor the run engine passes is tested over HTTP, in
 * `engine.events.integration.test.ts`. Also tests the text of the
 * `core.run-failed` notification `buildRunFailedNotification` builds, and
 * when `decideRunFailedUnlessRaised` holds that notification back.
 */
import { describe, expect, it } from "vitest";
import type { Run } from "@hercule/contract";
import { TRIGGER_NOTIFICATION_QUIET_PERIOD } from "../workflows";
import {
  buildRunEndedEvent,
  buildRunFailedNotification,
  decideRunFailedUnlessRaised,
} from "./run-events";

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
    const event = buildRunEndedEvent(RUNNING_RUN, { status: "completed" }, FINISHED_AT, "system");

    expect(event.payload).toStrictEqual(RUNNING_FIELDS);
  });

  it("keeps an output of null, because null is a value a terminal step can return", () => {
    const event = buildRunEndedEvent(
      RUNNING_RUN,
      { status: "completed", output: null },
      FINISHED_AT,
      "system",
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
        "system",
      ),
    ).toStrictEqual({
      kind: "run.failed",
      actor: "system",
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
      "system",
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
      "system",
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

describe("buildRunFailedNotification", () => {
  const EVENT_ID = 42;

  it("names the failed edge's message when the run failed at an edge", () => {
    const notification = buildRunFailedNotification(
      RUNNING_RUN,
      {
        status: "failed",
        failureReason: "expression-error",
        failedStepId: "start",
        failedEdge: { index: 1, message: "No such key: no_such_field" },
      },
      EVENT_ID,
    );

    expect(notification).toStrictEqual({
      kind: "core.run-failed",
      title: "Run of File a task failed",
      body: "The run stopped after step `start`: No such key: no_such_field",
      subject: [
        { kind: "run", id: RUN_ID },
        { kind: "workflow", id: WORKFLOW_ID },
      ],
      eventId: EVENT_ID,
    });
  });

  it("names the error of the failed step's last record when the run failed at a step", () => {
    const run: Run = {
      ...RUNNING_RUN,
      steps: [
        {
          stepId: "create",
          iteration: 1,
          status: "failed",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          error: { code: "first", message: "The first try timed out." },
        },
        {
          stepId: "create",
          iteration: 2,
          status: "failed",
          startedAt: STARTED_AT,
          finishedAt: FINISHED_AT,
          error: { code: "second", message: "The tracker refused the title." },
        },
      ],
    };

    const notification = buildRunFailedNotification(
      run,
      { status: "failed", failureReason: "step-failed", failedStepId: "create" },
      EVENT_ID,
    );

    expect(notification.body).toBe("Step `create` failed: The tracker refused the title.");
  });

  it("falls back to the sentence for the failure reason, and leaves out the workflow of a sent run", () => {
    const notification = buildRunFailedNotification(
      { ...PENDING_RUN, workflowId: null },
      { status: "failed", failureReason: "controller-error" },
      EVENT_ID,
    );

    expect(notification.body).toBe(
      "The controller could not carry out the run. Its log has the details.",
    );
    expect(notification.subject).toStrictEqual([{ kind: "run", id: RUN_ID }]);
  });
});

describe("the core.run-failed notification of a run a start trigger started", () => {
  const TRIGGERED_RUN: Run = {
    ...RUNNING_RUN,
    origin: { kind: "trigger", triggerId: "labeled", eventId: 7 },
  };
  const TRIGGER_SUBJECT = { kind: "trigger", workflowId: WORKFLOW_ID, triggerId: "labeled" };
  const VALIDATION_ERROR = {
    status: "failed",
    failureReason: "validation-error",
    failureMessage: "The inputs the trigger mapped from the event are not valid.",
  } as const;

  it("names the trigger in its subject", () => {
    expect(buildRunFailedNotification(TRIGGERED_RUN, VALIDATION_ERROR, 42).subject).toStrictEqual([
      { kind: "run", id: RUN_ID },
      { kind: "workflow", id: WORKFLOW_ID },
      TRIGGER_SUBJECT,
    ]);
  });

  it("is held back within the trigger quiet period after one about the same trigger, when the run failed validation", () => {
    expect(decideRunFailedUnlessRaised(TRIGGERED_RUN, VALIDATION_ERROR)).toStrictEqual({
      within: TRIGGER_NOTIFICATION_QUIET_PERIOD,
      about: [TRIGGER_SUBJECT],
    });
  });

  it("is always raised when the run failed another way", () => {
    expect(
      decideRunFailedUnlessRaised(TRIGGERED_RUN, {
        status: "failed",
        failureReason: "step-failed",
        failedStepId: "create",
      }),
    ).toBeUndefined();
  });

  it("is always raised for a run no trigger started", () => {
    expect(decideRunFailedUnlessRaised(RUNNING_RUN, VALIDATION_ERROR)).toBeUndefined();
  });
});
