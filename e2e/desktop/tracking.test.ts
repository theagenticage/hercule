/**
 * Tests Tracking in Intake in the packaged app, signed in to a real
 * controller (spec 17 §Tracking). The workflows are made of the built-in
 * `wait` action and of an action that fails, so a run ends by itself with no
 * runner and no provider:
 *
 * - a signal handed off from the pane lands in folded Tracking as a Working
 *   row, and becomes Finished when its run ends. The Finished row counts in
 *   the To do count of the Hercule segment, `T` opens Tracking, and `E` ticks
 *   the row off: the Task is `done` and the row leaves;
 * - a run that fails shows a Failed row that counts in To do and says why the
 *   run failed, and the row's Mark done control ticks it off;
 * - `hercule signal hand-off` with a session's token is refused and writes
 *   nothing. This one starts no window: a session needs a scripted runner,
 *   which the rest of `e2e/hand-off.test.ts` cannot import.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { Task } from "../../packages/contract/src/index";
import { findCompiledBinary, runCli } from "../../scripts/controller-process";
import { arrangeFleet, chooseMenuItem, openSignedIn, type ArrangedFleet } from "./harness";

/** A Task that does not exist, which makes the step that updates it fail. */
const MISSING_TASK_ID = "0199c0ff-7777-7000-8000-000000000001";

/**
 * How long the Working run waits before it ends, in seconds. Long enough for
 * a poll to see the Working row on a loaded machine, short enough to wait for
 * the Finished one.
 */
const WORKING_SECONDS = 6;

/** Creates an enabled workflow that takes an FYI signal and runs `step`, and returns its id. */
async function createWorkflow(
  { client }: ArrangedFleet,
  name: string,
  step: { readonly action: string; readonly params: Readonly<Record<string, string | number>> },
): Promise<string> {
  const { workflow } = await client.workflow.create({
    payload: {
      definition: {
        name,
        inputs: [{ name: "signal", signal: { kinds: ["fyi"] }, required: true }],
        steps: [{ id: "work", kind: "action", ...step }],
      },
    },
  });
  await client.workflow.update({ params: { id: workflow.id }, payload: { enabled: true } });
  return workflow.id;
}

/**
 * Raises an FYI signal titled `title` and returns its id. Create the
 * workflows first: a signal offers Hand to an agent for the workflows that
 * exist when it is raised.
 */
async function raiseSignal({ client }: ArrangedFleet, title: string): Promise<string> {
  const { signalId } = await client.signal.raise({
    payload: { kind: "fyi", title, reason: "Raised by a test", eventIds: [] },
  });
  return signalId;
}

/** Returns the Tasks that carry a handoff entry. */
async function listHandedOffTasks({ client }: ArrangedFleet): Promise<ReadonlyArray<Task>> {
  return (await client.task.query({ query: { handedOff: true, limit: 10 } })).items;
}

/** The pane of the open signal. */
const openSignalPane = (page: Page) => page.getByRole("region", { name: "The open signal" });

/** Tracking, folded or opened. */
// Not the sheet that is still dropping while Tracking closes: it is inert.
const tracking = (page: Page) => page.locator(".asks-list > section.tr-tray:not([inert])");

/** Returns the titles of Intake's signals, top to bottom. */
const readSignalTitles = (page: Page): Promise<string[]> =>
  page.locator('section[aria-label="Signals"] .ask-title').allTextContents();

/** Returns the state and the title of each row Tracking draws, top to bottom. */
const readTrackingRows = (page: Page): Promise<Array<{ state: string | null; title: string }>> =>
  tracking(page)
    .locator(".tr-run-item")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        state: row.getAttribute("data-state"),
        title: row.querySelector(".tr-run-title")?.textContent ?? "",
      })),
    );

/** Returns the label of the Hercule segment: "Hercule, 2 to do", or "Hercule" with no count. */
async function readHerculeSegment(page: Page): Promise<string> {
  const segment = page.getByRole("tablist", { name: "Sidebar" }).getByRole("tab").nth(1);
  return (await segment.getAttribute("aria-label")) ?? ((await segment.textContent()) ?? "").trim();
}

describe("Tracking", () => {
  it("follows a handoff from the pane: Working, then Finished and counted, opened with T and ticked off with E", async () => {
    const arranged = await arrangeFleet();
    await createWorkflow(arranged, "Review PR", {
      action: "wait",
      params: { seconds: WORKING_SECONDS },
    });
    const handedOff = await raiseSignal(arranged, "Review the pricing page");
    await raiseSignal(arranged, "Docs moved to the wiki");
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await expect.poll(() => readHerculeSegment(page)).toBe("Hercule, 2 to do");

    await page.locator(".ask-row", { hasText: "Review the pricing page" }).click();
    await openSignalPane(page).getByRole("button", { name: "Hand to Review PR" }).click();

    // The signal leaves the list and the Task lands in folded Tracking, at
    // work. Working work does not count, so only the other signal does.
    await expect.poll(() => readSignalTitles(page)).toEqual(["Docs moved to the wiki"]);
    await expect
      .poll(() => readTrackingRows(page))
      .toEqual([{ state: "working", title: "Review the pricing page" }]);
    expect(await tracking(page).evaluate((element) => element.classList.contains("is-open"))).toBe(
      false,
    );
    expect(await readHerculeSegment(page)).toBe("Hercule, 1 to do");
    const [task] = await listHandedOffTasks(arranged);
    expect(task).toMatchObject({ title: "Review the pricing page", status: "in-progress" });
    expect(task!.provenance).toMatchObject([{ signalId: handedOff, actor: "user" }]);
    expect(
      (await arranged.client.signal.read({ params: { id: handedOff } })).resolution,
    ).toMatchObject({ kind: "decided", outcome: "Handed to Review PR" });

    // The run ends, the row turns Finished, and it waits on the user: it
    // counts with the other signal.
    await expect
      .poll(() => readTrackingRows(page), { timeout: 30_000 })
      .toEqual([{ state: "finished", title: "Review the pricing page" }]);
    expect(await tracking(page).locator(".tr-run-sub").textContent()).toBe("Review PR finished");
    await expect.poll(() => readHerculeSegment(page)).toBe("Hercule, 2 to do");
    expect(
      (await arranged.client.run.read({ params: { id: task!.provenance[0]!.runId! } })).status,
    ).toBe("completed");

    // T opens Tracking over the list; the Finished row is under its heading.
    await page.locator(".ask-row", { hasText: "Docs moved to the wiki" }).click();
    await page.keyboard.press("t");
    await expect
      .poll(() => tracking(page).evaluate((element) => element.classList.contains("is-open")))
      .toBe(true);
    expect(await tracking(page).locator(".tr-sec").allTextContents()).toEqual(["Finished1"]);
    expect(await readTrackingRows(page)).toEqual([
      { state: "finished", title: "Review the pricing page" },
    ]);

    // J selects the row, and E ticks it off: the Task is done, the row leaves
    // and the count drops back to the one signal.
    await page.keyboard.press("j");
    await expect
      .poll(() =>
        tracking(page).locator('.tr-run[aria-current="true"] .tr-run-title').textContent(),
      )
      .toBe("Review the pricing page");
    await page.keyboard.press("e");
    await expect.poll(() => readTrackingRows(page)).toEqual([]);
    await expect
      .poll(async () => (await arranged.client.task.read({ params: { id: task!.id } })).status)
      .toBe("done");
    await expect.poll(() => readHerculeSegment(page)).toBe("Hercule, 1 to do");

    // Esc closes Tracking, and the signals are back.
    await page.keyboard.press("Escape");
    await expect
      .poll(() => tracking(page).evaluate((element) => element.classList.contains("is-open")))
      .toBe(false);
    expect(await readSignalTitles(page)).toEqual(["Docs moved to the wiki"]);
  }, 120_000);

  it("shows a run that fails as a Failed row that counts in To do and says why, and Mark done ticks it off", async () => {
    const arranged = await arrangeFleet();
    const investigateId = await createWorkflow(arranged, "Investigate", {
      action: "task.update",
      params: { taskId: MISSING_TASK_ID, title: "Never" },
    });
    const signalId = await raiseSignal(arranged, "Webhook deliveries fail");
    await raiseSignal(arranged, "Docs moved to the wiki");
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await expect.poll(() => readHerculeSegment(page)).toBe("Hercule, 2 to do");

    await arranged.client.signal.handOff({
      params: { id: signalId },
      payload: { workflowId: investigateId },
    });

    await expect
      .poll(() => readTrackingRows(page), { timeout: 30_000 })
      .toEqual([{ state: "failed", title: "Webhook deliveries fail" }]);
    // The line names the workflow and says it failed. The reason comes with the row data, which a later change wires.
    expect(await tracking(page).locator(".tr-run-sub").textContent()).toMatch(
      /^Investigate failed/,
    );
    await expect.poll(() => readHerculeSegment(page)).toBe("Hercule, 2 to do");

    // The Mark done control shows while the pointer is on the row.
    const row = tracking(page).locator(".tr-run-item");
    await row.hover();
    await row.getByRole("button", { name: "Mark done" }).click();
    await expect.poll(() => readTrackingRows(page)).toEqual([]);
    const [task] = (await arranged.client.task.query({ query: { limit: 10 } })).items;
    expect(task).toMatchObject({ title: "Webhook deliveries fail", status: "done" });
    await expect.poll(() => readHerculeSegment(page)).toBe("Hercule, 1 to do");
  }, 120_000);

  it("refuses a session's token on hercule signal hand-off, and leaves the signal open with no Task", async () => {
    const arranged = await arrangeFleet();
    const workflowId = await createWorkflow(arranged, "Review PR", {
      action: "wait",
      params: { seconds: 1 },
    });
    const signalId = await raiseSignal(arranged, "Only the user may hand this off");
    const runner = await arranged.fleet.enlistRunner("tracking-runner");
    const [thread] = await arranged.fleet.spawnThreads(1, { runner });

    const refused = await runCli(["signal", "hand-off", signalId, "--workflow", workflowId], {
      home: arranged.home,
      binary: findCompiledBinary(),
      env: {
        HERCULE_API_URL: arranged.url,
        HERCULE_TOKEN: runner.readSessionToken(thread!.id),
      },
    });

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("only the user may hand a signal off");
    expect((await arranged.client.signal.read({ params: { id: signalId } })).status).toBe("open");
    expect(await listHandedOffTasks(arranged)).toEqual([]);
  }, 120_000);
});
