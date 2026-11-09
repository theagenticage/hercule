/**
 * Tests that Tracking follows a run that is run again, in the packaged app,
 * signed in to a real controller (spec 17 §Tracking). The workflows are made
 * of the built-in `wait` action and of an action that fails, so a run ends by
 * itself with no runner and no provider:
 *
 * - Try again, in the pane of a Failed row, re-runs the workflow as it is
 *   stored now, so a fix made after the failure is picked up. The new run
 *   keeps the Task: the row turns Working on the same Task, then Finished;
 * - a run re-run from its page in Workflows keeps its Task too, and its row
 *   shows in Tracking, Working again.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { arrangeFleet, chooseMenuItem, openSignedIn, type ArrangedFleet } from "./harness";
import {
  MISSING_TASK_ID,
  WORKING_SECONDS,
  type WorkflowStep,
  buildWorkflowDefinition,
  createWorkflow,
  raiseSignal,
  listHandedOffTasks,
  tracking,
  readTrackingRows,
} from "./tracking-helpers";

/**
 * How long the re-run waits in the test that re-runs from the run's page, in
 * seconds. Long enough for its Working row to outlast the trip from the
 * run's page back to Intake. The test does not wait for the run to end.
 */
const RERUN_WORKING_SECONDS = 10;

/** Saves `step` as the one step of the stored workflow `workflowId` named `name`, as a user does who fixes it. */
async function replaceWorkflowStep(
  { client }: ArrangedFleet,
  workflowId: string,
  name: string,
  step: WorkflowStep,
): Promise<void> {
  await client.workflow.update({
    params: { id: workflowId },
    payload: { definition: buildWorkflowDefinition(name, step) },
  });
}

/** The pane of the open Tracking row. */
const openRowPane = (page: Page) => page.getByRole("region", { name: "The open Tracking row" });

describe("Tracking, running again", () => {
  it("presses Try again on a Failed row after the workflow is fixed: the row turns Working on the same Task, then Finished", async () => {
    const arranged = await arrangeFleet();
    const { client } = arranged;
    const workflowId = await createWorkflow(arranged, "Investigate", {
      action: "task.update",
      params: { taskId: MISSING_TASK_ID, title: "Never" },
    });
    const signalId = await raiseSignal(arranged, "Webhook deliveries fail");
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await client.signal.handOff({ params: { id: signalId }, payload: { workflowId } });
    await expect
      .poll(() => readTrackingRows(page), { timeout: 30_000 })
      .toEqual([{ state: "failed", title: "Webhook deliveries fail" }]);
    const [task] = await listHandedOffTasks(arranged);
    const failedRunId = task!.provenance[0]!.runId!;
    expect((await client.run.read({ params: { id: failedRunId } })).status).toBe("failed");

    // The user fixes the workflow, then opens the row. Try again is the
    // suggested answer of a Failed row.
    await replaceWorkflowStep(arranged, workflowId, "Investigate", {
      action: "wait",
      params: { seconds: WORKING_SECONDS },
    });
    await tracking(page).locator(".tr-run-item .tr-run").click();
    const tryAgain = openRowPane(page).locator('[data-answer="try-again"]');
    await tryAgain.waitFor();
    const tryAgainFace = tryAgain.locator("> span").first();
    expect(await tryAgain.textContent()).toContain("Try again");
    expect(await tryAgainFace.getAttribute("class")).toContain("btn--accent");
    expect(await openRowPane(page).locator(".ad-answers").textContent()).toContain(
      "Re-runs Investigate on Webhook deliveries fail from the start",
    );
    await tryAgain.click();

    // The same row turns Working, and no second Task appears.
    await expect
      .poll(() => readTrackingRows(page))
      .toEqual([{ state: "working", title: "Webhook deliveries fail" }]);
    await expect
      .poll(() => readTrackingRows(page), { timeout: 30_000 })
      .toEqual([{ state: "finished", title: "Webhook deliveries fail" }]);

    // The new run is the failed run run again, on the same Task. Finished
    // offers Try again too, without suggesting it.
    const tasks = (await client.task.query({ query: { limit: 10 } })).items;
    expect(tasks.map((each) => each.id)).toEqual([task!.id]);
    const reruns = (await client.run.query({ query: { originalRunId: failedRunId } })).items;
    expect(reruns).toHaveLength(1);
    const rerun = await client.run.read({ params: { id: reruns[0]!.id } });
    expect(rerun).toMatchObject({
      status: "completed",
      taskId: task!.id,
      originalRunId: failedRunId,
    });
    expect((await client.run.read({ params: { id: failedRunId } })).taskId).toBe(task!.id);
    await tryAgain.waitFor();
    expect(await tryAgainFace.getAttribute("class")).not.toContain("btn--accent");
  }, 120_000);

  it("keeps the Task of a run re-run from its page in Workflows, and shows the row in Tracking again", async () => {
    const arranged = await arrangeFleet();
    const { client } = arranged;
    const workflowId = await createWorkflow(arranged, "Review PR", {
      action: "wait",
      params: { seconds: 1 },
    });
    const signalId = await raiseSignal(arranged, "Review the pricing page");
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await client.signal.handOff({ params: { id: signalId }, payload: { workflowId } });
    await expect
      .poll(() => readTrackingRows(page), { timeout: 30_000 })
      .toEqual([{ state: "finished", title: "Review the pricing page" }]);
    const [task] = await listHandedOffTasks(arranged);
    const firstRunId = task!.provenance[0]!.runId!;

    // The new run waits longer than the first, so its Working row outlasts
    // the trip back to Intake. The dialog re-runs from the current workflow.
    await replaceWorkflowStep(arranged, workflowId, "Review PR", {
      action: "wait",
      params: { seconds: RERUN_WORKING_SECONDS },
    });
    await chooseMenuItem(app, "Go", "Workflows");
    await page.getByRole("link", { name: "Review PR", exact: true }).click();
    await page.locator("a.table-row.tbl-runs").click();
    await page.getByRole("button", { name: "Re-run…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Re-run", exact: true }).click();
    // The app opens the new run's page once the re-run starts, and a live
    // run offers Cancel. Leaving before that would let the late navigation
    // override Go > Intake.
    await page.getByRole("button", { name: "Cancel run…" }).waitFor();

    await chooseMenuItem(app, "Go", "Intake");
    await expect
      .poll(() => readTrackingRows(page))
      .toEqual([{ state: "working", title: "Review the pricing page" }]);

    const tasks = (await client.task.query({ query: { limit: 10 } })).items;
    expect(tasks.map((each) => each.id)).toEqual([task!.id]);
    const [rerunSummary] = (await client.run.query({ query: { originalRunId: firstRunId } })).items;
    expect(await client.run.read({ params: { id: rerunSummary!.id } })).toMatchObject({
      taskId: task!.id,
      originalRunId: firstRunId,
    });
  }, 120_000);
});
