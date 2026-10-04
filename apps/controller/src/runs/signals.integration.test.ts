/**
 * Integration tests for what a run does with its signal triggers, driven over
 * HTTP against a real controller:
 *
 * - the run holds one live subscription per signal trigger from the moment it
 *   is written, and keeps running once its steps are done, waiting for the
 *   next signal;
 * - a signal that fires adds a completed record of the trigger, whose output
 *   the steps after it read, and the run follows the trigger's edges;
 * - the trigger can fire again, as often as its edges allow;
 * - a `join: all` step waits for the first firing of a signal that leads
 *   into it;
 * - however the run ends, its subscriptions end with it, a pending record of
 *   a signal is cancelled, and later events fire nothing.
 *
 * Which events reach a signal trigger, and its correlation, are tested with
 * the event router (`daemon/events/routing/signal-routing-table`).
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import type { Run, Subscription } from "@hercule/contract";
import { runEffect, waitUntilRouted } from "../daemon/testing";
import { get, post } from "../http/testing";
import { WAIT_DEADLINE_MS } from "../sessions/testing";
import { emitLabeledEvent, withSetUpController, type SetUpController } from "../workflows/testing";
import type { Plugin } from "@hercule/plugin-host";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  buildLabelSignal,
  expectStatus,
  findStepRecords,
  LABEL_INPUT,
  readRun,
  requestCancel,
  startSentWorkflow,
  waitForRun,
  waitForRunToFinish,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/**
 * Starts a set-up controller whose event pipeline ticks every 10 ms instead
 * of every second, so a test that waits for several signals stays fast.
 */
const withSignalController = (
  body: (controller: SetUpController) => Promise<void>,
  plugins: ReadonlyArray<Plugin> = [],
) => withSetUpController(body, plugins, { eventRoutingInterval: Duration.millis(10) });

/**
 * Starts a run of `definition` with the input `label: "triage"`, and returns
 * the run once the step `open` has completed.
 */
const startAndWaitForOpen = async (
  { base, token }: SetUpController,
  definition: Record<string, unknown>,
): Promise<Run> => {
  const runId = await startSentWorkflow(base, token, {
    definition: { inputs: [LABEL_INPUT], ...definition },
    inputs: { label: "triage" },
  });
  return waitForRun(base, token, runId, "open completed", (run) =>
    findStepRecords(run, "open").some((record) => record.status === "completed"),
  );
};

/** Returns how many completed records the step `stepId` has in the run. */
const countCompleted = (run: Run, stepId: string): number =>
  findStepRecords(run, stepId).filter((record) => record.status === "completed").length;

/** Lists the live subscriptions the run holds, as `subscription.list` returns them to the user. */
const listRunSubscriptions = async (
  { base, token }: SetUpController,
  runId: string,
): Promise<ReadonlyArray<Subscription>> => {
  const response = await get(base, `/api/v1/subscriptions?holder=run:${runId}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly items: ReadonlyArray<Subscription> }).items;
};

/**
 * Checks that a run that has ended holds no subscription, and that a
 * correlated event emitted after the end adds no record of its signal.
 */
const expectSignalsEnded = async (controller: SetUpController, runId: string): Promise<void> => {
  const { harness, base, token } = controller;
  const ended = await readRun(base, token, runId);
  expect(ended.subscriptions).toEqual([]);
  expect(await listRunSubscriptions(controller, runId)).toEqual([]);
  const signals = findStepRecords(ended, "labeled").length;

  const late = await emitLabeledEvent(base, token, { added: ["triage"] });
  await waitUntilRouted(harness, late);
  expect(findStepRecords(await readRun(base, token, runId), "labeled")).toHaveLength(signals);
};

describe("a run with a signal trigger", () => {
  it("holds a live subscription, waits once its steps are done, and completes through the terminal step the signal leads to", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startAndWaitForOpen(controller, {
        name: "Finish on a label",
        triggers: [buildLabelSignal({ outputs: { label: "event.payload.added[0]" } })],
        steps: [
          buildCreateStep("open"),
          buildCreateStep("finish", {
            terminal: true,
            params: {
              title: "Follow up on {{ steps.labeled.output.label }}",
              description: "",
            },
          }),
        ],
        edges: [{ from: "labeled", to: "finish" }],
      });

      // Without the signal trigger, the run would have completed with `open`.
      expect(run.status).toBe("running");
      const [subscription] = run.subscriptions;
      expect(run.subscriptions).toHaveLength(1);
      expect(subscription).toMatchObject({
        target: { kind: "signal", triggerId: "labeled" },
        // A selector with no filter that takes any Connection reads only the kind.
        condition: 'event.kind == "github.pr.labeled"',
        holder: { kind: "run", id: run.id },
        health: { state: "ok" },
      });
      expect(await listRunSubscriptions(controller, run.id)).toEqual(run.subscriptions);

      await emitLabeledEvent(base, token, { added: ["triage"] });
      const completed = expectStatus(await waitForRunToFinish(base, token, run.id), "completed");

      expect(completed.steps.map((record) => [record.stepId, record.status])).toEqual([
        ["open", "completed"],
        ["labeled", "completed"],
        ["finish", "completed"],
      ]);
      expect(findStepRecords(completed, "labeled")[0]).toMatchObject({
        output: { label: "triage" },
      });
      expect(completed.output).toMatchObject({ title: "Follow up on triage" });
      await expectSignalsEnded(controller, run.id);
    });
  });

  it("fires again for each correlated event, and fails with iteration-limit when its edge has no traversal left", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startAndWaitForOpen(controller, {
        name: "Follow up twice",
        triggers: [buildLabelSignal()],
        steps: [buildCreateStep("open"), buildCreateStep("follow_up")],
        edges: [{ from: "labeled", to: "follow_up", maxTraversals: 2 }],
      });

      for (const count of [1, 2]) {
        await emitLabeledEvent(base, token, { added: ["triage"] });
        await waitForRun(
          base,
          token,
          run.id,
          `follow_up ran ${String(count)} time(s)`,
          (read) => countCompleted(read, "follow_up") === count,
        );
      }
      await emitLabeledEvent(base, token, { added: ["triage"] });
      const failed = expectStatus(await waitForRunToFinish(base, token, run.id), "failed");

      expect(failed).toMatchObject({
        failureReason: "iteration-limit",
        failedStepId: "labeled",
        failedEdge: { index: 0 },
      });
      expect(countCompleted(failed, "labeled")).toBe(3);
      expect(countCompleted(failed, "follow_up")).toBe(2);
      await expectSignalsEnded(controller, run.id);
    });
  });

  it("runs a join: all step once, after the first firing of a signal that leads into it", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startAndWaitForOpen(controller, {
        name: "Merge on a label",
        triggers: [buildLabelSignal()],
        steps: [
          buildCreateStep("open"),
          buildCreateStep("check"),
          buildCreateStep("merge", { join: "all" }),
        ],
        edges: [
          { from: "open", to: "check" },
          { from: "check", to: "merge" },
          { from: "labeled", to: "merge" },
        ],
      });
      const checked = await waitForRun(
        base,
        token,
        run.id,
        "check completed",
        (read) => countCompleted(read, "check") === 1,
      );
      // `check`'s edge has fired, but the signal can still fire.
      expect(findStepRecords(checked, "merge")).toEqual([]);

      await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitForRun(
        base,
        token,
        run.id,
        "merge ran",
        (read) => countCompleted(read, "merge") === 1,
      );

      const again = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(controller.harness, again);
      const fired = await waitForRun(
        base,
        token,
        run.id,
        "the signal fired twice",
        (read) => countCompleted(read, "labeled") === 2,
      );
      expect(findStepRecords(fired, "merge")).toHaveLength(1);
      expect(fired.status).toBe("running");
    });
  });

  it("delivers a signal whose record a restart left pending", async () => {
    await withSignalController(async (controller) => {
      const { harness, base, token } = controller;
      const run = await startAndWaitForOpen(controller, {
        name: "Follow up after a restart",
        triggers: [buildLabelSignal()],
        steps: [buildCreateStep("open"), buildCreateStep("follow_up")],
        edges: [{ from: "labeled", to: "follow_up" }],
      });
      // The row the router writes when an event fires the signal. The
      // controller stops before the run's execution picks it up.
      const at = new Date().toISOString();
      await runEffect(
        harness.sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, output, created_at)
          VALUES (unhex(replace(${run.id}, '-', '')), 'labeled', 1, 'pending',
                  ${JSON.stringify({ label: "triage" })}, ${at})`,
      );

      await harness.reboot();

      const delivered = await waitForRun(
        base,
        token,
        run.id,
        "follow_up ran",
        (read) => countCompleted(read, "follow_up") === 1,
      );
      expect(findStepRecords(delivered, "labeled")).toMatchObject([
        { status: "completed", output: { label: "triage" } },
      ]);
      expect(delivered.status).toBe("running");
    });
  });
});

describe("a run with a signal trigger that ends", () => {
  it("cancels a pending record of the signal and ends its subscriptions when a terminal step completes", async () => {
    const held = buildHeldAction();
    await withSignalController(
      async (controller) => {
        const { harness, base, token } = controller;
        const runId = await startSentWorkflow(base, token, {
          definition: {
            name: "Finish while a signal waits",
            inputs: [LABEL_INPUT],
            triggers: [buildLabelSignal()],
            steps: [
              { ...buildHeldStep(held, "gate"), terminal: true },
              buildCreateStep("follow_up"),
            ],
            edges: [{ from: "labeled", to: "follow_up" }],
          },
          inputs: { label: "triage" },
        });
        await waitForRun(base, token, runId, "gate started", (run) =>
          findStepRecords(run, "gate").some((record) => record.status === "running"),
        );
        // A signal the run's execution has not delivered yet: it is busy
        // with `gate`, and reads the run again only when `gate` ends.
        const at = new Date().toISOString();
        await runEffect(
          harness.sql`
            INSERT INTO run_steps (run_id, step_id, iteration, status, output, created_at)
            VALUES (unhex(replace(${runId}, '-', '')), 'labeled', 1, 'pending', '{}', ${at})`,
        );

        held.release();
        const completed = expectStatus(await waitForRunToFinish(base, token, runId), "completed");

        expect(findStepRecords(completed, "labeled")).toMatchObject([{ status: "cancelled" }]);
        expect(findStepRecords(completed, "follow_up")).toEqual([]);
        await expectSignalsEnded(controller, runId);
      },
      [held.plugin],
    );
  });

  it("ends its subscriptions when it is cancelled, and a re-run holds new ones", async () => {
    await withSignalController(async (controller) => {
      const { base, token } = controller;
      const run = await startAndWaitForOpen(controller, {
        name: "Cancel while waiting",
        triggers: [buildLabelSignal()],
        steps: [buildCreateStep("open"), buildCreateStep("follow_up")],
        edges: [{ from: "labeled", to: "follow_up" }],
      });
      const [original] = run.subscriptions;

      const cancelled = await requestCancel(base, token, run.id);
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
      expectStatus(await waitForRunToFinish(base, token, run.id), "cancelled");
      await expectSignalsEnded(controller, run.id);

      // A workflow sent with `run.start` is never stored, so only a replay can re-run it.
      const rerun = await post(base, `/api/v1/runs/${run.id}/rerun`, { mode: "replay" }, token);
      expect(rerun.status, await rerun.clone().text()).toBe(200);
      const { runId } = (await rerun.json()) as { readonly runId: string };
      const waiting = await waitForRun(
        base,
        token,
        runId,
        "open completed",
        (read) => countCompleted(read, "open") === 1,
      );
      expect(waiting.subscriptions).toHaveLength(1);
      expect(waiting.subscriptions[0]!.id).not.toBe(original!.id);
      expect(waiting.subscriptions[0]!.holder).toEqual({ kind: "run", id: runId });
    });
  });
});
