/**
 * Tests the routing of events to start triggers through the whole event
 * pipeline of a running controller: an event is emitted over HTTP, the event
 * router matches it against every start trigger, and the trigger effect
 * delivery starts the run. Every assertion reads what the API returns: the
 * run, the trigger's health, the notifications.
 *
 * A test that expects no run for an event cannot wait for something to
 * happen. It waits until the router's cursor has passed the event instead.
 * The router writes a trigger's match in the same transaction that moves the
 * cursor, so once the cursor has passed an event, the event has started every
 * run it ever will. Most such tests then emit an event that does match, and
 * wait for its run, to show that the trigger was listening all along.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Struct from "effect/Struct";
import type { EventWithFacts, Notification, Run, SpawnBound } from "@hercule/contract";
import { uuidFromString } from "../../../db";
import { del, get, post } from "../../../http/testing";
import { queryRuns, waitForRunToFinish } from "../../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../../../sessions/testing";
import {
  ACCEPTED_GITHUB_TOKEN,
  createConnection,
  createWorkflowOrFail,
  emitLabeledEvent,
  enableWorkflow,
  LABELED_REPO,
  pauseTrigger,
  readTrigger,
  resumeTrigger,
  updateWorkflow,
  withSetUpController,
  type SetUpController,
} from "../../../workflows/testing";
import { readEvent, readEventsOfKind } from "../../../events/testing";
import { runEffect, waitUntilRouted } from "../../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** The id of the one start trigger in every workflow these tests save. */
const TRIGGER_ID = "labeled";

/**
 * Starts a set-up controller whose event pipeline ticks every 10 ms instead
 * of every second, so a test that waits for several events stays fast.
 */
const withTriggerController = (body: (controller: SetUpController) => Promise<void>) =>
  withSetUpController(body, [], { eventRoutingInterval: Duration.millis(10) });

/** What a test sets on the labelled trigger. */
interface LabeledTrigger {
  readonly connectionId: string;
  readonly filter?: string;
  readonly spawnBound?: SpawnBound;
}

/**
 * Returns the source of a workflow with one start trigger on
 * `github.pr.labeled`. The trigger maps the first added label and the
 * repository onto the workflow's two inputs. The `label` input must be at
 * least three characters long, so a test can make the mapped inputs invalid
 * with a shorter label.
 */
const buildLabeledWorkflowSource = (trigger: LabeledTrigger): string =>
  [
    "name: File labelled pull requests",
    "inputs:",
    "  - name: label",
    "    schema:",
    "      type: string",
    "      minLength: 3",
    "    required: true",
    "  - name: repo",
    "    schema:",
    "      type: string",
    "    required: true",
    "triggers:",
    `  - id: ${TRIGGER_ID}`,
    "    kind: start",
    "    on:",
    "      kind: github.pr.labeled",
    `      connectionId: ${trigger.connectionId}`,
    ...(trigger.filter === undefined ? [] : [`      filter: '${trigger.filter}'`]),
    ...(trigger.spawnBound === undefined
      ? []
      : [
          "    spawnBound:",
          `      maxRuns: ${String(trigger.spawnBound.maxRuns)}`,
          `      windowSeconds: ${String(trigger.spawnBound.windowSeconds)}`,
        ]),
    "    inputs:",
    "      label: event.payload.added[0]",
    "      repo: event.payload.subject.repo",
    "steps:",
    "  - id: file_task",
    "    kind: action",
    "    action: task.create",
    "    params:",
    '      title: "Triage the {{ inputs.label }} pull request"',
    "      description: Filed by a trigger.",
    "",
  ].join("\n");

/** Saves and enables a workflow with the labelled trigger, and returns the workflow's id. */
const saveEnabledWorkflow = async (
  { base, token }: SetUpController,
  trigger: LabeledTrigger,
): Promise<string> => {
  const workflow = await createWorkflowOrFail(base, token, {
    source: buildLabeledWorkflowSource(trigger),
  });
  await enableWorkflow(base, token, workflow.id);
  return workflow.id;
};

/**
 * Returns the ids of the events that started the workflow's runs, in
 * ascending order. Fails the test if a run of the workflow has another origin.
 */
const listTriggeringEventIds = async (
  { base, token }: SetUpController,
  workflowId: string,
): Promise<ReadonlyArray<number>> => {
  const page = await queryRuns(base, token, `workflowId=${workflowId}`);
  return page.items
    .map((run) => {
      if (run.origin.kind !== "trigger") expect.fail(`not a triggered run: ${JSON.stringify(run)}`);
      return run.origin.eventId;
    })
    .sort((left, right) => left - right);
};

/**
 * Waits until the workflow has a run started by the event, and returns that
 * run once it has finished.
 */
const waitForRunStartedBy = async (
  controller: SetUpController,
  workflowId: string,
  eventId: number,
): Promise<Run> => {
  const { base, token } = controller;
  const runId = await waitUntil(`a run started by the event ${eventId}`, async () => {
    const page = await queryRuns(base, token, `workflowId=${workflowId}`);
    return page.items.find((run) => run.origin.kind === "trigger" && run.origin.eventId === eventId)
      ?.id;
  });
  return waitForRunToFinish(base, token, runId);
};

/** Returns the notifications of `kind` that name the workflow's trigger. */
const listTriggerNotifications = async (
  { base, token }: SetUpController,
  workflowId: string,
  kind: "core.trigger-error" | "core.run-failed" | "core.breaker-tripped",
): Promise<ReadonlyArray<Notification>> => {
  const response = await get(base, `/api/v1/notifications?kind=${kind}&limit=100`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
  return items.filter((notification) =>
    notification.subject.some(
      (subject) =>
        subject.kind === "trigger" &&
        subject.workflowId === workflowId &&
        subject.triggerId === TRIGGER_ID,
    ),
  );
};

describe("a start trigger that matches an event", () => {
  it("starts one run, stamped with the system actor, that names the trigger and the event and has the mapped inputs", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });

      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });
      const run = await waitForRunStartedBy(controller, workflowId, eventId);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.workflowId).toBe(workflowId);
      expect(run.origin).toEqual({ kind: "trigger", triggerId: TRIGGER_ID, eventId });
      expect(run.inputs).toEqual({ label: "triage", repo: LABELED_REPO });
      // The run keeps its own copy of the event, without the raw vendor
      // payload, which is kept in the log for debugging only.
      const event = await readEvent(base, token, eventId);
      expect(run.triggerEvent).toEqual(Struct.omit(event, ["raw"]));
      expect(run.triggerEvent).not.toHaveProperty("raw");
      // The step rendered the mapped input, so the inputs reached the plan.
      const [step] = run.steps;
      if (step?.status !== "completed")
        expect.fail(`the step did not complete: ${JSON.stringify(run)}`);
      expect(step.output).toMatchObject({ title: "Triage the triage pull request" });

      // Nobody asked for this run, so the controller starts it as the system.
      const bySystem = await queryRuns(base, token, "actor=system");
      expect(bySystem.items.map((summary) => summary.id)).toEqual([run.id]);
      expect((await queryRuns(base, token, "actor=user")).items).toEqual([]);

      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([eventId]);
    });
  });

  it("starts a run that no runner can run, which fails at its workspace step with workspace-failed", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const repo = await post(
        base,
        "/api/v1/resources",
        { kind: "repo", remote: "https://github.com/o/r.git" },
        token,
      );
      expect(repo.status, await repo.clone().text()).toBe(200);
      const { id: repoId } = (await repo.json()) as { readonly id: string };
      // A git.commit step runs only on a runner, and this controller has none.
      const workflow = await createWorkflowOrFail(base, token, {
        source: [
          "name: Commit on a label",
          "workspace:",
          "  kind: ephemeral",
          "  checkouts:",
          `    - resourceId: ${repoId}`,
          "triggers:",
          `  - id: ${TRIGGER_ID}`,
          "    kind: start",
          "    on:",
          "      kind: github.pr.labeled",
          "      connectionId: any",
          "steps:",
          "  - id: commit",
          "    kind: action",
          "    action: git.commit",
          "    params:",
          "      message: Save",
          "",
        ].join("\n"),
      });
      await enableWorkflow(base, token, workflow.id);

      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });
      const run = await waitForRunStartedBy(controller, workflow.id, eventId);

      // Which runners exist says nothing about the workflow, so the run is
      // not refused like one whose inputs do not validate.
      if (run.status !== "failed" || run.failureReason !== "workspace-failed") {
        expect.fail(`the run did not fail with workspace-failed: ${JSON.stringify(run)}`);
      }
      expect(run.failedStepId).toBe("commit");
      const [step] = run.steps;
      if (step?.status !== "failed") expect.fail(`the step did not fail: ${JSON.stringify(run)}`);
      expect(step.error).toEqual({
        code: "workspace_failed",
        message: "No runner can run git.commit; update a runner to this version.",
      });
    });
  });
});

describe("a start trigger that does not match an event", () => {
  it("starts no run for an event of another kind", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });

      // Creating a task appends a task.created event to the log, which the
      // router reads like any other event.
      const created = await post(
        base,
        "/api/v1/tasks",
        { title: "Not a pull request", description: "" },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const [taskCreated] = await harness.platformEvents("task.created");
      expect(taskCreated).toBeDefined();
      await waitUntilRouted(harness, taskCreated!.id);

      const matching = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, matching);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([matching]);
    });
  });

  it("starts no run for an event from another Connection when the trigger names one", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const named = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const other = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: named });

      const fromOther = await emitLabeledEvent(base, token, {
        added: ["triage"],
        connectionId: other,
      });
      // An event that arrived through no Connection is not from the named one either.
      const fromNone = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, fromNone);

      const fromNamed = await emitLabeledEvent(base, token, {
        added: ["triage"],
        connectionId: named,
      });
      await waitForRunStartedBy(controller, workflowId, fromNamed);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([fromNamed]);
      expect(fromOther).toBeLessThan(fromNamed);
    });
  });

  it("starts no run when the filter is false", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, {
        connectionId: "any",
        filter: '"triage" in event.payload.added',
      });

      const unwanted = await emitLabeledEvent(base, token, { added: ["docs"] });
      await waitUntilRouted(harness, unwanted);

      const wanted = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, wanted);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([wanted]);
      // A filter that is false is not an error.
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health,
      ).toEqual({ state: "ok" });
    });
  });

  it("starts no run while the trigger is paused, and starts runs again for events after it is resumed", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });

      const paused = await pauseTrigger(base, token, workflowId, TRIGGER_ID);
      expect(paused.status, await paused.clone().text()).toBe(200);
      const whilePaused = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, whilePaused);

      const resumed = await resumeTrigger(base, token, workflowId, TRIGGER_ID);
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      const afterResume = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, afterResume);

      // The event that arrived while the trigger was paused is not kept for later.
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([afterResume]);
    });
  });

  it("starts no run while its workflow is disabled", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      // A workflow is saved disabled.
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildLabeledWorkflowSource({ connectionId: "any" }),
      });
      expect(workflow.enabled).toBe(false);

      const whileDisabled = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, whileDisabled);

      await enableWorkflow(base, token, workflow.id);
      const afterEnable = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflow.id, afterEnable);
      expect(await listTriggeringEventIds(controller, workflow.id)).toEqual([afterEnable]);
    });
  });
});

describe("a start trigger whose mapped inputs fail the workflow's input schema", () => {
  it("starts a run that fails at once with validation-error and says which input is invalid", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });

      // The label input must be at least three characters long.
      const eventId = await emitLabeledEvent(base, token, { added: ["x"] });
      const run = await waitForRunStartedBy(controller, workflowId, eventId);

      if (run.status !== "failed" || run.failureReason !== "validation-error") {
        expect.fail(`the run did not fail with validation-error: ${JSON.stringify(run)}`);
      }
      expect(run.failureMessage).toMatch(
        /^The inputs the trigger mapped from the event are not valid: .*inputs\.label/,
      );
      // Nothing ran: the run ended before its first step.
      expect(run.steps).toEqual([]);
      // The run still records what started it and what the trigger mapped.
      expect(run.origin).toEqual({ kind: "trigger", triggerId: TRIGGER_ID, eventId });
      expect(run.inputs).toEqual({ label: "x", repo: LABELED_REPO });
      expect(run.triggerEvent?.id).toBe(eventId);
      // The trigger itself is fine: its filter and mapping evaluated.
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health,
      ).toEqual({ state: "ok" });
    });
  });

  it("notifies about the first such run and not about the next ones within the hour", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });

      const first = await emitLabeledEvent(base, token, { added: ["x"] });
      await waitForRunStartedBy(controller, workflowId, first);
      const second = await emitLabeledEvent(base, token, { added: ["y"] });
      const secondRun = await waitForRunStartedBy(controller, workflowId, second);
      expect(secondRun.status).toBe("failed");

      // Every event fails the same way, so the user hears about it once.
      const notified = await listTriggerNotifications(controller, workflowId, "core.run-failed");
      expect(notified).toHaveLength(1);
    });
  });
});

describe("a start trigger's match whose run has not started yet", () => {
  it("starts no run, and is discarded, when its workflow was disabled after it matched", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });
      const disabled = await updateWorkflow(base, token, workflowId, { enabled: false });
      expect(disabled.status, await disabled.clone().text()).toBe(200);
      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, eventId);

      // Write the match the router would have written had the workflow been
      // disabled a moment later, between the match and the run's start. A
      // manual pause cannot race this way, because it holds the trigger's
      // pending matches in the same transaction that pauses it.
      await runEffect(harness.sql`
        INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, matched_at)
        VALUES (${uuidFromString(workflowId)}, ${TRIGGER_ID}, ${eventId}, 'pending',
                ${JSON.stringify({ label: "triage", repo: LABELED_REPO })}, ${new Date().toISOString()})`);

      await waitUntil("the match was discarded", async () => {
        const rows = await runEffect(harness.sql<{ readonly state: string }>`
          SELECT state FROM trigger_effects
          WHERE workflow_id = ${uuidFromString(workflowId)} AND event_id = ${eventId}`);
        return rows[0]?.state === "discarded" ? true : undefined;
      });
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([]);
    });
  });

  it("starts no run, and is discarded, when its event is no longer in the log", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });
      // Retention prunes only old events, so the test writes a match for an
      // event id the log never had, which reads the same as a pruned one.
      const prunedEventId = 1_000_000;
      await runEffect(harness.sql`
        INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, matched_at)
        VALUES (${uuidFromString(workflowId)}, ${TRIGGER_ID}, ${prunedEventId}, 'pending',
                ${JSON.stringify({ label: "triage", repo: LABELED_REPO })}, ${new Date().toISOString()})`);

      await waitUntil("the match was discarded", async () => {
        const rows = await runEffect(harness.sql<{ readonly state: string }>`
          SELECT state FROM trigger_effects
          WHERE workflow_id = ${uuidFromString(workflowId)} AND event_id = ${prunedEventId}`);
        return rows[0]?.state === "discarded" ? true : undefined;
      });
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([]);
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health,
      ).toEqual({ state: "ok" });
    });
  });

  it("is discarded, and records the error on the trigger's health once, when its start fails because of a bug, until a run starts again", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });
      // A match whose inputs are not an object is one the controller never
      // writes, so starting its run dies instead of failing.
      await runEffect(harness.sql`
        CREATE TRIGGER corrupt_inputs AFTER INSERT ON trigger_effects
        BEGIN UPDATE trigger_effects SET inputs = 'null' WHERE id = NEW.id; END`);

      const first = await emitLabeledEvent(base, token, { added: ["triage"] });
      const second = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntil("both matches were discarded", async () => {
        const rows = await runEffect(harness.sql<{ readonly state: string }>`
          SELECT state FROM trigger_effects
          WHERE workflow_id = ${uuidFromString(workflowId)} AND event_id IN (${first}, ${second})`);
        return rows.length === 2 && rows.every((row) => row.state === "discarded")
          ? true
          : undefined;
      });
      await runEffect(harness.sql`DROP TRIGGER corrupt_inputs`);

      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([]);
      const broken = await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID });
      if (broken.health?.state !== "error") {
        expect.fail(`the trigger's health is not error: ${JSON.stringify(broken)}`);
      }
      expect(broken.health.message).toContain(
        "could not start, because of a bug in the controller",
      );
      // Both starts failed, but the user is notified once, not once per event.
      const notified = await listTriggerNotifications(controller, workflowId, "core.trigger-error");
      expect(notified.map((notification) => notification.title)).toEqual([
        "A trigger could not start its run",
      ]);

      const repaired = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, repaired);
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health,
      ).toEqual({ state: "ok" });
    });
  });
});

describe("a start trigger whose filter cannot be evaluated", () => {
  it("records the error on the trigger's health, notifies once while it keeps failing, and clears the error on the next event it can evaluate", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      // Reading the first label of an empty list is an evaluation error.
      const workflowId = await saveEnabledWorkflow(controller, {
        connectionId: "any",
        filter: 'event.payload.added[0] == "triage"',
      });
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health,
      ).toEqual({ state: "ok" });

      const firstFailure = await emitLabeledEvent(base, token, { added: [] });
      await waitUntilRouted(harness, firstFailure);
      const broken = await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID });
      if (broken.health?.state !== "error") {
        expect.fail(`the trigger's health is not error: ${JSON.stringify(broken)}`);
      }
      expect(broken.health.message).toContain("index out of bounds");
      const notified = await listTriggerNotifications(controller, workflowId, "core.trigger-error");
      expect(notified).toHaveLength(1);
      expect(notified[0]!.body).toBe(broken.health.message);

      const secondFailure = await emitLabeledEvent(base, token, { added: [] });
      await waitUntilRouted(harness, secondFailure);
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health?.state,
      ).toBe("error");
      // The user hears about a broken trigger once, not once per event.
      expect(
        await listTriggerNotifications(controller, workflowId, "core.trigger-error"),
      ).toHaveLength(1);

      const evaluable = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, evaluable);
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).health,
      ).toEqual({ state: "ok" });
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([evaluable]);
    });
  });
});

describe("an event routed a second time", () => {
  it("starts no second run when an enrichment routes an event the trigger already matched", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });
      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, eventId);

      // An enrichment routes the amended event again inside its request,
      // with the same routing tables as the pipeline.
      const enriched = await post(
        base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: ["github:pr:octo/repo#7"] },
        token,
      );
      expect(enriched.status, await enriched.clone().text()).toBe(200);

      // A later match proves the pipeline ticked after the enrichment, so a
      // second run for the enriched event would have started by then.
      const later = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, later);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([eventId, later]);
    });
  });
});

describe("a start trigger's spawn bound", () => {
  /** One run an hour: the second event in an hour trips the breaker. */
  const ONE_AN_HOUR = { maxRuns: 1, windowSeconds: 3600 };

  /**
   * Saves a workflow whose trigger runs under `ONE_AN_HOUR`, and emits three
   * events: the first starts a run, the second trips the breaker, and the
   * third is held behind it. Returns the workflow's id and the event ids.
   */
  const tripBreaker = async (controller: SetUpController) => {
    const { harness, base, token } = controller;
    const workflowId = await saveEnabledWorkflow(controller, {
      connectionId: "any",
      spawnBound: ONE_AN_HOUR,
    });
    const first = await emitLabeledEvent(base, token, { added: ["triage"] });
    await waitForRunStartedBy(controller, workflowId, first);
    const tripping = await emitLabeledEvent(base, token, { added: ["triage"] });
    const queued = await emitLabeledEvent(base, token, { added: ["triage"] });
    await waitUntilRouted(harness, queued);
    return { workflowId, first, tripping, queued };
  };

  /** Lists the ids of the events the trigger holds, newest first, through `event.query`. */
  const listHeldEventIds = async (
    { base, token }: SetUpController,
    workflowId: string,
  ): Promise<ReadonlyArray<number>> => {
    const response = await get(
      base,
      `/api/v1/events?workflowId=${workflowId}&triggerId=${TRIGGER_ID}`,
      token,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const { items } = (await response.json()) as { readonly items: ReadonlyArray<EventWithFacts> };
    return items.map((event) => event.id);
  };

  /**
   * Moves the start of every run the trigger started back by two hours, so
   * they leave its window, as if the window had passed.
   */
  const ageRunsOutOfWindow = (controller: SetUpController, workflowId: string) =>
    runEffect(controller.harness.sql`
      UPDATE trigger_effects
      SET spawned_at = strftime('%Y-%m-%dT%H:%M:%fZ', spawned_at, '-2 hours')
      WHERE workflow_id = ${uuidFromString(workflowId)} AND state = 'spawned'`);

  it("pauses the trigger on the event over the bound, holds it and the events after it, and raises one decision", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const { workflowId, first, tripping, queued } = await tripBreaker(controller);

      expect(await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).toMatchObject({
        status: "paused",
        pausedBy: "breaker",
        spawnBound: { ...ONE_AN_HOUR, isDefault: false },
        runsInWindow: 1,
        heldCount: 2,
      });
      expect(await listHeldEventIds(controller, workflowId)).toEqual([queued, tripping]);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([first]);

      const decisions = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        status: "open",
        title: `Trigger ${TRIGGER_ID} of File labelled pull requests paused at its spawn bound`,
      });
      expect(decisions[0]!.actions.map((action) => [action.id, action.label])).toEqual([
        ["resume", "Resume"],
        ["resume-discard", "Resume and discard held events"],
      ]);
    });
  });

  it("refuses a held events query that names only the workflow or only the trigger", async () => {
    await withTriggerController(async ({ base, token }) => {
      const workflowOnly = await get(
        base,
        "/api/v1/events?workflowId=0192f0a1-0000-7000-8000-00000000dead",
        token,
      );
      expect(workflowOnly.status).toBe(400);
      expect(await workflowOnly.text()).toContain(
        "workflowId and triggerId name a trigger together",
      );
      const triggerOnly = await get(base, `/api/v1/events?triggerId=${TRIGGER_ID}`, token);
      expect(triggerOnly.status).toBe(400);
    });
  });

  it("resumes when the user answers Resume, then starts the held events oldest first as the window frees up", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const { workflowId, first, tripping, queued } = await tripBreaker(controller);
      const [decision] = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );

      const answered = await post(
        base,
        `/api/v1/notifications/${decision!.id}/act`,
        { actionId: "resume" },
        token,
      );
      expect(answered.status, await answered.clone().text()).toBe(200);
      const [resolved] = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );
      expect(resolved).toMatchObject({
        status: "resolved",
        resolution: { kind: "decided", actionId: "resume" },
      });
      // The window still holds the first event's run, so nothing starts yet.
      expect(await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).toMatchObject({
        status: "active",
        heldCount: 2,
      });

      await ageRunsOutOfWindow(controller, workflowId);
      await waitForRunStartedBy(controller, workflowId, tripping);
      // The run just started fills the window again, so the newer event waits.
      expect(await listHeldEventIds(controller, workflowId)).toEqual([queued]);

      await ageRunsOutOfWindow(controller, workflowId);
      await waitForRunStartedBy(controller, workflowId, queued);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([
        first,
        tripping,
        queued,
      ]);
      // Starting held events never trips the breaker again.
      expect(
        await listTriggerNotifications(controller, workflowId, "core.breaker-tripped"),
      ).toHaveLength(1);
    });
  });

  it("discards the held events and answers the decision when the trigger is resumed with discardHeld", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const { workflowId, first } = await tripBreaker(controller);

      const resumed = await resumeTrigger(base, token, workflowId, TRIGGER_ID, {
        discardHeld: true,
      });
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      expect(await resumed.json()).toMatchObject({ status: "active", heldCount: 0 });
      expect(await listHeldEventIds(controller, workflowId)).toEqual([]);
      const [decision] = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );
      expect(decision).toMatchObject({
        status: "resolved",
        resolution: { kind: "decided", actionId: "resume-discard" },
      });

      await ageRunsOutOfWindow(controller, workflowId);
      const next = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, next);
      expect(await listTriggeringEventIds(controller, workflowId)).toEqual([first, next]);
    });
  });

  /** Counts the workflow's trigger effects that are held, read from the database. */
  const countHeldRows = async (controller: SetUpController, workflowId: string) => {
    const [row] = await runEffect(controller.harness.sql<{ readonly count: number }>`
      SELECT count(*) AS count FROM trigger_effects
      WHERE workflow_id = ${uuidFromString(workflowId)} AND state = 'held'`);
    return row?.count;
  };

  it("withdraws the decision and removes the held events when the workflow is deleted", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const { workflowId } = await tripBreaker(controller);

      const deleted = await del(base, `/api/v1/workflows/${workflowId}`, token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const [decision] = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );
      expect(decision).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", reason: "workflow deleted" },
      });
      expect(await countHeldRows(controller, workflowId)).toBe(0);
    });
  });

  it("withdraws the decision and removes the held events when a save removes the trigger", async () => {
    await withTriggerController(async (controller) => {
      const { base, token } = controller;
      const { workflowId } = await tripBreaker(controller);

      const source = buildLabeledWorkflowSource({ connectionId: "any", spawnBound: ONE_AN_HOUR });
      const saved = await updateWorkflow(base, token, workflowId, {
        source: source.replace(`id: ${TRIGGER_ID}`, "id: renamed"),
      });
      expect(saved.status, await saved.clone().text()).toBe(200);

      const [decision] = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );
      expect(decision).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", reason: "trigger removed" },
      });
      expect(await countHeldRows(controller, workflowId)).toBe(0);
    });
  });

  it("discards the held events when a save changes the trigger's filter, and records how many", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const { workflowId } = await tripBreaker(controller);

      const saved = await updateWorkflow(base, token, workflowId, {
        source: buildLabeledWorkflowSource({
          connectionId: "any",
          filter: '"triage" in event.payload.added',
          spawnBound: ONE_AN_HOUR,
        }),
      });
      expect(saved.status, await saved.clone().text()).toBe(200);

      // The held events matched the old filter, which may not hold for the new one.
      expect(await listHeldEventIds(controller, workflowId)).toEqual([]);
      expect(await countHeldRows(controller, workflowId)).toBe(0);
      const updates = await runEffect(
        Effect.provideService(
          readEventsOfKind("workflow.updated"),
          SqlClient.SqlClient,
          harness.sql,
        ),
      );
      expect(updates.at(-1)?.payload).toMatchObject({ workflowId, discardedCount: 2 });
    });
  });

  it("holds no new events once a trigger the breaker paused is paused manually, and keeps the ones it holds", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const { workflowId, tripping, queued } = await tripBreaker(controller);

      const paused = await pauseTrigger(base, token, workflowId, TRIGGER_ID);
      expect(paused.status, await paused.clone().text()).toBe(200);
      expect(await paused.json()).toMatchObject({ status: "paused", pausedBy: "manual" });
      const whilePausedManually = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, whilePausedManually);

      expect(await listHeldEventIds(controller, workflowId)).toEqual([queued, tripping]);
      // The decision still asks the user to resume the trigger.
      const [decision] = await listTriggerNotifications(
        controller,
        workflowId,
        "core.breaker-tripped",
      );
      expect(decision?.status).toBe("open");
    });
  });
});
