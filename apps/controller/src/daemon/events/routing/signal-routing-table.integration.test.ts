/**
 * Tests the routing of events to the signal triggers of running runs, through
 * the whole event pipeline of a running controller: an event is emitted over
 * HTTP, the event router matches it against every subscription a run holds,
 * and the run checks the trigger's correlation. Every assertion reads what
 * the API returns: the run, its subscriptions, the notifications.
 *
 * What the run does once a signal has fired is tested with the run engine
 * (`runs/signals.integration.test.ts`). Here a signal only leads to one step,
 * `follow_up`, so a fired signal shows as a completed `labeled` record.
 *
 * A test that expects no signal for an event waits until the router's cursor
 * has passed the event: the router writes a signal's record in the same
 * transaction that moves the cursor.
 */
import { describe, expect, it, vi } from "vitest";
import type { Notification, Run } from "@hercule/contract";
import { get, post } from "../../../http/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  buildLabelSignal,
  findStepRecords,
  LABEL_INPUT,
  queryRuns,
  readRun,
  startSentWorkflow,
  waitForRun,
  withSignalController,
} from "../../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../../../sessions/testing";
import {
  ACCEPTED_GITHUB_TOKEN,
  createConnection,
  createWorkflowOrFail,
  emitLabeledEvent,
  enableWorkflow,
  type SetUpController,
} from "../../../workflows/testing";
import { waitUntilRouted } from "../../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/**
 * Starts a run whose signal trigger is `buildLabelSignal(signal)`, with
 * `label` as its input, and returns the run once its entry step has completed
 * and it waits for the signal. The signal leads to the step `follow_up`.
 */
const startSignalRun = async (
  { base, token }: SetUpController,
  label: string,
  signal: Record<string, unknown> = {},
): Promise<Run> => {
  const runId = await startSentWorkflow(base, token, {
    definition: {
      name: "Follow up on a label",
      inputs: [LABEL_INPUT],
      triggers: [buildLabelSignal(signal)],
      steps: [buildCreateStep("open"), buildCreateStep("follow_up")],
      edges: [{ from: "labeled", to: "follow_up" }],
    },
    inputs: { label },
  });
  return waitForRun(base, token, runId, "the entry step completed", (run) =>
    findStepRecords(run, "open").some((record) => record.status === "completed"),
  );
};

/** Waits until the run's signal has fired `count` times and each firing reached `follow_up`. */
const waitForFirings = (
  { base, token }: SetUpController,
  runId: string,
  count: number,
): Promise<Run> =>
  waitForRun(base, token, runId, `the signal fired ${String(count)} time(s)`, (run) => {
    const completed = (stepId: string) =>
      findStepRecords(run, stepId).filter((record) => record.status === "completed").length;
    return completed("labeled") === count && completed("follow_up") === count;
  });

/** Returns how many records the run's signal trigger has, read after the event was routed. */
const countSignalRecords = async (
  { harness, base, token }: SetUpController,
  runId: string,
  routedEventId: number,
): Promise<number> => {
  await waitUntilRouted(harness, routedEventId);
  return findStepRecords(await readRun(base, token, runId), "labeled").length;
};

/** Returns the notifications about a subscription whose condition could not be evaluated. */
const listConditionErrorNotifications = async (
  { base, token }: SetUpController,
  subscriptionId: string,
): Promise<ReadonlyArray<Notification>> => {
  const response = await get(
    base,
    "/api/v1/notifications?kind=core.subscription-condition-error&limit=100",
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
  return items.filter((notification) =>
    notification.subject.some(
      (subject) => subject.kind === "subscription" && subject.id === subscriptionId,
    ),
  );
};

describe("an event that matches a run's signal trigger", () => {
  it("fires the signal when it correlates with the run, and not when it does not", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startSignalRun(controller, "triage");

      const other = await emitLabeledEvent(base, token, { added: ["docs"] });
      expect(await countSignalRecords(controller, run.id, other)).toBe(0);

      const correlated = await emitLabeledEvent(base, token, { added: ["triage"] });
      const fired = await waitForFirings(controller, run.id, 1);
      // Without `outputs`, the signal's output is the event, without its raw payload.
      const [record] = findStepRecords(fired, "labeled");
      if (record?.status !== "completed") expect.fail(JSON.stringify(fired));
      expect(record.output).toMatchObject({ id: correlated, kind: "github.pr.labeled" });
      expect(record.output).not.toHaveProperty("raw");
      expect(fired.status).toBe("running");
    });
  });

  it("compares whole numbers exactly, even above the integers a JS number holds", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      // 2^62 + 1 as the run's id, and 2^62 on the first event. As JS numbers
      // the two are the same value.
      const run = await startSignalRun(controller, "4611686018427387905", {
        correlation: { event: "int(event.payload.added[0])", run: "int(inputs.label)" },
      });

      const neighbour = await emitLabeledEvent(base, token, { added: ["4611686018427387904"] });
      expect(await countSignalRecords(controller, run.id, neighbour)).toBe(0);

      await emitLabeledEvent(base, token, { added: ["4611686018427387905"] });
      await waitForFirings(controller, run.id, 1);
    });
  });

  it("maps the event onto the signal's output when the trigger has outputs", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startSignalRun(controller, "triage", {
        outputs: { repo: "event.payload.subject.repo", count: "size(event.payload.added)" },
      });

      await emitLabeledEvent(base, token, { added: ["triage", "bug"] });

      const [record] = findStepRecords(await waitForFirings(controller, run.id, 1), "labeled");
      expect(record).toMatchObject({ output: { repo: "octo/repo", count: 2 } });
    });
  });

  it("fires no signal while the run side of the correlation reads a step that has not completed, and fires once it has", async () => {
    const held = buildHeldAction();
    await withSignalController(
      async (controller) => {
        const { base, token } = controller;
        const runId = await startSentWorkflow(base, token, {
          definition: {
            name: "Follow up once the gate opens",
            triggers: [
              buildLabelSignal({
                correlation: {
                  event: "event.payload.added[0]",
                  run: 'steps.gate.output.released ? "open" : "closed"',
                },
              }),
            ],
            steps: [buildHeldStep(held, "gate"), buildCreateStep("follow_up")],
            edges: [{ from: "labeled", to: "follow_up" }],
          },
        });

        const early = await emitLabeledEvent(base, token, { added: ["open"] });
        expect(await countSignalRecords(controller, runId, early)).toBe(0);
        // A value the run does not have yet is not an error in the trigger.
        const waiting = await readRun(base, token, runId);
        expect(waiting.subscriptions.map((subscription) => subscription.health)).toEqual([
          { state: "ok" },
        ]);

        held.release();
        await waitForRun(base, token, runId, "the gate completed", (run) =>
          findStepRecords(run, "gate").some((record) => record.status === "completed"),
        );
        await emitLabeledEvent(base, token, { added: ["open"] });
        await waitForFirings(controller, runId, 1);
      },
      [held.plugin],
    );
  });

  it("fires the signal of a run that a start trigger started", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      // An event whose first label is `start` starts a run, with the second
      // label as the label its signal waits for.
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Start, then follow up on a label",
          inputs: [LABEL_INPUT],
          triggers: [
            {
              id: "started",
              kind: "start",
              on: {
                kind: "github.pr.labeled",
                connectionId: "any",
                filter: 'event.payload.added[0] == "start"',
              },
              inputs: { label: "event.payload.added[1]" },
            },
            buildLabelSignal(),
          ],
          steps: [buildCreateStep("open"), buildCreateStep("follow_up")],
          edges: [{ from: "labeled", to: "follow_up" }],
        },
      });
      await enableWorkflow(base, token, workflow.id);

      await emitLabeledEvent(base, token, { added: ["start", "triage"] });
      const runId = await waitUntil("the start trigger started a run", async () => {
        const page = await queryRuns(base, token, `workflowId=${workflow.id}`);
        return page.items[0]?.id;
      });
      const waiting = await waitForRun(base, token, runId, "open completed", (run) =>
        findStepRecords(run, "open").some((record) => record.status === "completed"),
      );
      expect(waiting.subscriptions).toMatchObject([
        { target: { kind: "signal", triggerId: "labeled" }, holder: { kind: "run", id: runId } },
      ]);

      await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForFirings(controller, runId, 1);
    });
  });
});

describe("a signal trigger whose correlation cannot be evaluated", () => {
  it("records the event side's error on the subscription's health, notifies once, and clears it on the next event it can evaluate", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startSignalRun(controller, "triage");
      const [subscription] = run.subscriptions;
      if (subscription === undefined) expect.fail(JSON.stringify(run));

      // Reading the first label of an empty list is an evaluation error.
      const firstFailure = await emitLabeledEvent(base, token, { added: [] });
      expect(await countSignalRecords(controller, run.id, firstFailure)).toBe(0);
      const [broken] = (await readRun(base, token, run.id)).subscriptions;
      if (broken?.health.state !== "error") expect.fail(JSON.stringify(broken));
      expect(broken.health.message).toMatch(
        /^The event side of the correlation of the signal trigger labeled could not be evaluated: .*index out of bounds/,
      );

      const secondFailure = await emitLabeledEvent(base, token, { added: [] });
      await waitUntilRouted(controller.harness, secondFailure);
      // The user hears about a broken trigger once, not once per event.
      const notified = await listConditionErrorNotifications(controller, subscription.id);
      expect(notified).toHaveLength(1);
      expect(notified[0]!.body).toBe(broken.health.message);

      await emitLabeledEvent(base, token, { added: ["triage"] });
      const fired = await waitForFirings(controller, run.id, 1);
      expect(fired.subscriptions.map((one) => one.health)).toEqual([{ state: "ok" }]);
    });
  });

  it("records an error when the run side gives a value that is neither a string nor a number", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startSignalRun(controller, "triage", {
        correlation: { event: "event.payload.added[0]", run: 'inputs.label == "triage"' },
      });

      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });

      expect(await countSignalRecords(controller, run.id, eventId)).toBe(0);
      const [broken] = (await readRun(base, token, run.id)).subscriptions;
      if (broken?.health.state !== "error") expect.fail(JSON.stringify(broken));
      expect(broken.health.message).toBe(
        "The run side of the correlation of the signal trigger labeled gave a value that is neither a string nor a number, so it cannot be compared",
      );
    });
  });
});

describe("the events a signal trigger selects", () => {
  it("fires no signal for an event from another Connection when the trigger names one", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const named = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const other = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const run = await startSignalRun(controller, "triage", {
        on: { kind: "github.pr.labeled", connectionId: named },
      });

      const fromOther = await emitLabeledEvent(base, token, {
        added: ["triage"],
        connectionId: other,
      });
      // An event that arrived through no Connection is not from the named one either.
      const fromNone = await emitLabeledEvent(base, token, { added: ["triage"] });
      expect(fromNone).toBeGreaterThan(fromOther);
      expect(await countSignalRecords(controller, run.id, fromNone)).toBe(0);

      await emitLabeledEvent(base, token, { added: ["triage"], connectionId: named });
      await waitForFirings(controller, run.id, 1);
    });
  });

  it("fires no signal when the filter is false", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startSignalRun(controller, "triage", {
        on: {
          kind: "github.pr.labeled",
          connectionId: "any",
          filter: '"urgent" in event.payload.added',
        },
      });

      const unwanted = await emitLabeledEvent(base, token, { added: ["triage"] });
      expect(await countSignalRecords(controller, run.id, unwanted)).toBe(0);

      await emitLabeledEvent(base, token, { added: ["triage", "urgent"] });
      await waitForFirings(controller, run.id, 1);
    });
  });
});

describe("an event routed a second time", () => {
  it("fires no second signal when an enrichment routes an event that already fired one", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startSignalRun(controller, "triage");
      const eventId = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForFirings(controller, run.id, 1);

      // An enrichment routes the amended event again inside its request,
      // with the same routing tables as the pipeline.
      const enriched = await post(
        base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: ["github:pr:octo/repo#7"] },
        token,
      );
      expect(enriched.status, await enriched.clone().text()).toBe(200);

      // A later firing proves the pipeline ticked after the enrichment, so a
      // second firing for the enriched event would have happened by then.
      await emitLabeledEvent(base, token, { added: ["triage"] });
      const fired = await waitForFirings(controller, run.id, 2);
      expect(findStepRecords(fired, "labeled").map((record) => record.iteration)).toEqual([1, 2]);
    });
  });
});
