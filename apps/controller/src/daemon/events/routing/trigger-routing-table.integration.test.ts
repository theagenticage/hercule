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
import * as Struct from "effect/Struct";
import type { Event, Notification, Run, Trigger } from "@hercule/contract";
import { uuidFromString } from "../../../db";
import { get, post, type ServerHarness } from "../../../http/testing";
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
  queryTriggers,
  resumeTrigger,
  withSetUpController,
  type SetUpController,
} from "../../../workflows/testing";
import { readCursorAndHead, runEffect } from "../../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** The id of the one start trigger in every workflow these tests save. */
const TRIGGER_ID = "labeled";

/**
 * Starts a set-up controller whose event pipeline ticks every 10 ms instead
 * of every second, so a test that waits for several events stays fast.
 */
const withTriggerController = (body: (controller: SetUpController) => Promise<void>) =>
  withSetUpController(body, [], { eventRoutingInterval: Duration.millis(10) });

/**
 * Returns the source of a workflow with one start trigger on
 * `github.pr.labeled`. The trigger maps the first added label and the
 * repository onto the workflow's two inputs. The `label` input must be at
 * least three characters long, so a test can make the mapped inputs invalid
 * with a shorter label.
 */
const buildLabeledWorkflowSource = (trigger: {
  readonly connectionId: string;
  readonly filter?: string;
}): string =>
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
    "    source:",
    "      kind: github.pr.labeled",
    `      connectionId: ${trigger.connectionId}`,
    ...(trigger.filter === undefined ? [] : [`      filter: '${trigger.filter}'`]),
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
  trigger: { readonly connectionId: string; readonly filter?: string },
): Promise<string> => {
  const workflow = await createWorkflowOrFail(base, token, {
    source: buildLabeledWorkflowSource(trigger),
  });
  await enableWorkflow(base, token, workflow.id);
  return workflow.id;
};

/**
 * Waits until the event router's cursor has passed the event. From then on
 * the event has written every trigger match it ever will, because the router
 * writes the matches and moves the cursor in one transaction.
 */
const waitUntilRouted = (harness: ServerHarness, eventId: number): Promise<void> =>
  waitUntil(`routed the event ${eventId}`, async () => {
    const { position } = await readCursorAndHead(harness);
    return position !== null && position >= eventId ? true : undefined;
  }).then(() => undefined);

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

const readTrigger = async (
  { base, token }: SetUpController,
  workflowId: string,
): Promise<Trigger> => {
  const triggers = await queryTriggers(base, token, `?workflowId=${workflowId}`);
  const trigger = triggers.find((item) => item.triggerId === TRIGGER_ID);
  expect(trigger, JSON.stringify(triggers)).toBeDefined();
  return trigger!;
};

const readEvent = async ({ base, token }: SetUpController, id: number): Promise<Event> => {
  const response = await get(base, `/api/v1/events/${String(id)}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Event;
};

/** Returns the notifications of `kind` that name the workflow's trigger. */
const listTriggerNotifications = async (
  { base, token }: SetUpController,
  workflowId: string,
  kind: "core.trigger-filter-error" | "core.run-failed",
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
      const event = await readEvent(controller, eventId);
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
      expect((await readTrigger(controller, workflowId)).health).toEqual({ state: "ok" });
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
      expect((await readTrigger(controller, workflowId)).health).toEqual({ state: "ok" });
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
  it("starts no run, and is discarded, when the trigger was paused after it matched", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, { connectionId: "any" });
      const paused = await pauseTrigger(base, token, workflowId, TRIGGER_ID);
      expect(paused.status, await paused.clone().text()).toBe(200);
      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, eventId);

      // Write the match the router would have written had the trigger been
      // paused a moment later, between the match and the run's start.
      await runEffect(harness.sql`
        INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, at)
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
});

describe("a start trigger whose filter cannot be evaluated", () => {
  it("records the error on the trigger's health, notifies once for a streak of failures, and clears the error on the next event it can evaluate", async () => {
    await withTriggerController(async (controller) => {
      const { harness, base, token } = controller;
      // Reading the first label of an empty list is an evaluation error.
      const workflowId = await saveEnabledWorkflow(controller, {
        connectionId: "any",
        filter: 'event.payload.added[0] == "triage"',
      });
      expect((await readTrigger(controller, workflowId)).health).toEqual({ state: "ok" });

      const firstFailure = await emitLabeledEvent(base, token, { added: [] });
      await waitUntilRouted(harness, firstFailure);
      const broken = await readTrigger(controller, workflowId);
      if (broken.health?.state !== "error") {
        expect.fail(`the trigger's health is not error: ${JSON.stringify(broken)}`);
      }
      expect(broken.health.message).toContain("index out of bounds");
      const notified = await listTriggerNotifications(
        controller,
        workflowId,
        "core.trigger-filter-error",
      );
      expect(notified).toHaveLength(1);
      expect(notified[0]!.body).toBe(broken.health.message);

      const secondFailure = await emitLabeledEvent(base, token, { added: [] });
      await waitUntilRouted(harness, secondFailure);
      expect((await readTrigger(controller, workflowId)).health?.state).toBe("error");
      // The user hears about a broken trigger once, not once per event.
      expect(
        await listTriggerNotifications(controller, workflowId, "core.trigger-filter-error"),
      ).toHaveLength(1);

      const evaluable = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRunStartedBy(controller, workflowId, evaluable);
      expect((await readTrigger(controller, workflowId)).health).toEqual({ state: "ok" });
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
