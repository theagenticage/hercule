/**
 * Tests the Scheduler end to end on a running controller: a cron trigger comes
 * due, the Scheduler appends a `cron.tick` event, and the event pipeline
 * starts the trigger's run from it.
 *
 * A real schedule comes due at most once a minute, which no test can wait
 * for, and a real Bun listener cannot use a `TestClock`. So each test moves
 * the trigger's next scheduled time instead, straight in the database:
 *
 * 1. The test saves a workflow whose cron trigger fires at 02:00 UTC, and
 *    waits until the Scheduler has computed the trigger's next scheduled
 *    time. From then on the Scheduler leaves the row alone until that time
 *    comes, so the update in the next step cannot race a pass.
 * 2. The test sets the next scheduled time to an instant that has already
 *    passed: one second ago to make the trigger fire, or two days ago to make
 *    it too late to fire.
 * 3. The Scheduler, which looks every 10 ms here, finds the trigger due on its
 *    next pass. The test waits for the outcome, never for a fixed time.
 *
 * The trigger names its timezone, UTC, so the user's timezone setting, which
 * setup sets to Europe/Amsterdam, never makes the Scheduler recompute the
 * time the test wrote.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Struct from "effect/Struct";
import type { Event, Run } from "@hercule/contract";
import { uuidFromString } from "../../db";
import { get, post, readErrorBody } from "../../http/testing";
import { queryRuns, waitForRunToFinish } from "../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../../sessions/testing";
import {
  createWorkflowOrFail,
  emitLabeledEvent,
  enableWorkflow,
  readTrigger,
  withSetUpController,
  type SetUpController,
} from "../../workflows/testing";
import { readEvent } from "../../events/testing";
import { runEffect } from "../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const TRIGGER_ID = "nightly";

/**
 * A workflow whose cron trigger fires every night at 02:00 UTC and maps both
 * times of the tick onto the run's inputs. `previousFiredAt` accepts null,
 * because a trigger's first tick has no previous firing.
 */
const NIGHTLY_REPORT_SOURCE = `name: Nightly report
inputs:
  - name: scheduledFor
    schema:
      type: string
    required: true
  - name: previousFiredAt
    schema:
      type: [string, "null"]
    required: true
triggers:
  - id: ${TRIGGER_ID}
    kind: start
    source:
      kind: cron.tick
    schedule: "0 2 * * *"
    timezone: UTC
    inputs:
      scheduledFor: event.payload.scheduledFor
      previousFiredAt: event.payload.previousFiredAt
steps:
  - id: file_report
    kind: action
    action: task.create
    params:
      title: Write the nightly report
      description: Filed by the Scheduler.
`;

/**
 * Starts a set-up controller whose Scheduler and event pipeline each run
 * every 10 ms instead of every second.
 */
const withSchedulingController = (body: (controller: SetUpController) => Promise<void>) =>
  withSetUpController(body, [], {
    eventRoutingInterval: Duration.millis(10),
    schedulerInterval: Duration.millis(10),
  });

/**
 * Saves and enables the Nightly report workflow, then waits until the
 * Scheduler has computed its trigger's next scheduled time. Returns the
 * workflow's id.
 */
const saveScheduledWorkflow = async (controller: SetUpController): Promise<string> => {
  const { base, token } = controller;
  const workflow = await createWorkflowOrFail(base, token, { source: NIGHTLY_REPORT_SOURCE });
  await enableWorkflow(base, token, workflow.id);
  await waitUntil("computed the trigger's next scheduled time", async () => {
    const trigger = await readTrigger(controller.base, controller.token, {
      workflowId: workflow.id,
      triggerId: TRIGGER_ID,
    });
    return trigger.nextFireAt;
  });
  return workflow.id;
};

/**
 * Moves the trigger's next scheduled time, and the time it last fired, in the
 * database. This is how a test makes a schedule come due without waiting for
 * it.
 */
const moveSchedule = async (
  { harness }: SetUpController,
  workflowId: string,
  times: { readonly nextFireAt: string; readonly lastFiredAt: string | null },
): Promise<void> => {
  await runEffect(harness.sql`
    UPDATE triggers
    SET next_fire_at = ${times.nextFireAt}, last_fired_at = ${times.lastFiredAt}
    WHERE workflow_id = ${uuidFromString(workflowId)} AND trigger_id = ${TRIGGER_ID}`);
};

/** Returns the ISO instant `milliseconds` before now. */
const computeInstantBeforeNow = (milliseconds: number): string =>
  new Date(Date.now() - milliseconds).toISOString();

/** Returns the latest 02:00 UTC at or before `now`: the last time the schedule came due. */
const computeLatestScheduledTime = (now: Date): Date => {
  const latest = new Date(now);
  latest.setUTCHours(2, 0, 0, 0);
  if (latest > now) latest.setUTCDate(latest.getUTCDate() - 1);
  return latest;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checks that `nextFireAt` is a 02:00 UTC in the coming day. The check does
 * not compute the exact night from the clock, so a test that runs across
 * 02:00 UTC still passes.
 */
const expectNextNightlyTime = (nextFireAt: string | undefined): void => {
  expect(nextFireAt).toMatch(/T02:00:00\.000Z$/);
  const untilNext = Date.parse(nextFireAt ?? "") - Date.now();
  expect(untilNext).toBeGreaterThan(0);
  expect(untilNext).toBeLessThanOrEqual(DAY_MS);
};

/** Waits until the workflow has a run, and returns it once it has finished. */
const waitForTheOnlyRun = async (
  { base, token }: SetUpController,
  workflowId: string,
): Promise<Run> => {
  const runId = await waitUntil("the trigger started a run", async () => {
    const page = await queryRuns(base, token, `workflowId=${workflowId}`);
    return page.items[0]?.id;
  });
  const run = await waitForRunToFinish(base, token, runId);
  expect((await queryRuns(base, token, `workflowId=${workflowId}`)).items).toHaveLength(1);
  return run;
};

/** Returns every `cron.tick` event in the log. */
const listCronTicks = async ({ base, token }: SetUpController): Promise<ReadonlyArray<Event>> => {
  const response = await get(base, "/api/v1/events?kind=cron.tick&limit=100", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly items: ReadonlyArray<Event> }).items;
};

describe("a cron trigger whose scheduled time comes", () => {
  it("fires a cron.tick that starts one run with the scheduled time and the previous firing as inputs", async () => {
    await withSchedulingController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveScheduledWorkflow(controller);
      const scheduledFor = computeInstantBeforeNow(1000);
      const previousFiredAt = computeInstantBeforeNow(DAY_MS);

      await moveSchedule(controller, workflowId, {
        nextFireAt: scheduledFor,
        lastFiredAt: previousFiredAt,
      });
      const run = await waitForTheOnlyRun(controller, workflowId);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.inputs).toEqual({ scheduledFor, previousFiredAt });
      if (run.origin.kind !== "trigger") expect.fail(`not a triggered run: ${JSON.stringify(run)}`);
      expect(run.origin.triggerId).toBe(TRIGGER_ID);
      // The tick is an event like any other: it is in the log, from the
      // cron source, and happened at the scheduled time.
      const tick = await readEvent(base, token, run.origin.eventId);
      expect(tick).toMatchObject({
        kind: "cron.tick",
        source: "cron",
        connectionId: null,
        occurredAt: scheduledFor,
        dedupKey: `${workflowId}/${TRIGGER_ID}/${scheduledFor}`,
        payload: { workflowId, triggerId: TRIGGER_ID, scheduledFor, previousFiredAt },
      });
      expect(run.triggerEvent).toEqual(Struct.omit(tick, ["raw"]));
      expect((await queryRuns(base, token, "actor=system")).items.map((item) => item.id)).toEqual([
        run.id,
      ]);

      // The trigger records the firing and waits for the next 02:00.
      const fired = await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID });
      expect(fired.lastFiredAt).toBe(scheduledFor);
      expect(fired.skippedTicks).toBeUndefined();
      expectNextNightlyTime(fired.nextFireAt);
      expect(await listCronTicks(controller)).toHaveLength(1);
    });
  });

  it("fires the first tick of a trigger that never fired with a null previousFiredAt", async () => {
    await withSchedulingController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveScheduledWorkflow(controller);
      const scheduledFor = computeInstantBeforeNow(1000);

      await moveSchedule(controller, workflowId, { nextFireAt: scheduledFor, lastFiredAt: null });
      const run = await waitForTheOnlyRun(controller, workflowId);

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(run.inputs).toEqual({ scheduledFor, previousFiredAt: null });
      expect(run.triggerEvent?.payload).toEqual({
        workflowId,
        triggerId: TRIGGER_ID,
        scheduledFor,
        previousFiredAt: null,
      });
      expect(
        (await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID })).lastFiredAt,
      ).toBe(scheduledFor);
    });
  });

  it("fires even when a manual event already holds the dedup key of the tick, and keeps both events", async () => {
    await withSchedulingController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveScheduledWorkflow(controller);
      const scheduledFor = computeInstantBeforeNow(1000);
      const tickDedupKey = `${workflowId}/${TRIGGER_ID}/${scheduledFor}`;
      // A dedup key is unique only per source and Connection, so a manual
      // event cannot take a key the Scheduler will use and suppress the tick.
      const manualEventId = await emitLabeledEvent(base, token, {
        added: [],
        dedupKey: tickDedupKey,
      });

      await moveSchedule(controller, workflowId, {
        nextFireAt: scheduledFor,
        lastFiredAt: computeInstantBeforeNow(DAY_MS),
      });
      const run = await waitForTheOnlyRun(controller, workflowId);

      const ticks = await listCronTicks(controller);
      expect(ticks.map((tick) => tick.dedupKey)).toEqual([tickDedupKey]);
      expect(run.origin).toEqual({ kind: "trigger", triggerId: TRIGGER_ID, eventId: ticks[0]!.id });
      const manual = await readEvent(base, token, manualEventId);
      expect(manual).toMatchObject({ source: "manual", dedupKey: tickDedupKey });
    });
  });
});

describe("a cron trigger more than a minute late", () => {
  it("fires no tick and starts no run, and shows the missed times as skipped ticks", async () => {
    await withSchedulingController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveScheduledWorkflow(controller);
      // As if the controller had been down since two nights ago.
      const missedFrom = new Date(
        computeLatestScheduledTime(new Date()).getTime() - 2 * DAY_MS,
      ).toISOString();

      await moveSchedule(controller, workflowId, { nextFireAt: missedFrom, lastFiredAt: null });
      const skipped = await waitUntil("recorded the skipped ticks", async () => {
        const trigger = await readTrigger(base, token, { workflowId, triggerId: TRIGGER_ID });
        return trigger.skippedTicks === undefined ? undefined : trigger;
      });

      expect(skipped.skippedTicks?.from).toBe(missedFrom);
      // The stretch ends at the last 02:00 before the pass, and the trigger
      // waits for the 02:00 after it.
      expectNextNightlyTime(skipped.nextFireAt);
      expect(skipped.skippedTicks?.until).toBe(
        new Date(Date.parse(skipped.nextFireAt ?? "") - DAY_MS).toISOString(),
      );
      expect(skipped.lastFiredAt).toBeUndefined();
      // The Scheduler writes the skip and the tick, when there is one, in one
      // transaction, so once the skip is visible no tick can still appear.
      expect(await listCronTicks(controller)).toEqual([]);
      expect((await queryRuns(base, token, `workflowId=${workflowId}`)).items).toEqual([]);
    });
  });
});

describe("event.enrich on a cron tick", () => {
  it("returns not_found and leaves the tick unchanged, because the Scheduler wrote it", async () => {
    await withSchedulingController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveScheduledWorkflow(controller);
      await moveSchedule(controller, workflowId, {
        nextFireAt: computeInstantBeforeNow(1000),
        lastFiredAt: null,
      });
      await waitForTheOnlyRun(controller, workflowId);
      const [tick] = await listCronTicks(controller);
      expect(tick).toBeDefined();

      const response = await post(
        base,
        `/api/v1/events/${String(tick!.id)}/enrich`,
        { url: "https://example.com/report", refs: ["github:pr:octo/repo#7"] },
        token,
      );

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      expect(await readEvent(base, token, tick!.id)).toEqual(tick);
    });
  });
});
