/**
 * Tests the workflow list in the packaged app, signed in to a real
 * controller that holds no workflows yet (spec 17 §Workflows): Go ›
 * Workflows opens the list, with its filters and search in the floating
 * header, and the list says it is empty.
 *
 * A second test checks that a run pushed while the list is open pops the
 * marks it changes, and that Reduce motion stops that motion.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { arrangeFleet, chooseMenuItem, openSignedIn } from "./harness";

describe("Workflows", () => {
  it("opens from Go › Workflows, with its filters and search, and says when there are no workflows", async () => {
    const arranged = await arrangeFleet();
    const { app, page } = await openSignedIn(arranged.url);

    await chooseMenuItem(app, "Go", "Workflows");

    const filters = page.getByRole("navigation", { name: "Filter workflows" });
    await filters.getByRole("heading", { level: 1, name: "Workflows" }).waitFor();
    expect(await filters.getByRole("button").allTextContents()).toEqual([
      "All 0",
      "Needs you 0",
      "Failing 0",
      "Running 0",
      "Off 0",
    ]);
    expect(await filters.getByRole("button", { name: "All 0" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await expect.poll(() => page.getByText("No workflows yet").isVisible()).toBe(true);

    await page.keyboard.press("Meta+f");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null))
      .toBe("Search workflows");
  });
});

/** The page's global, with the name of each animation that started in the motion check's row. */
type AnimationLog = typeof globalThis & { rowAnimations?: string[] };

describe("Workflows' motion", () => {
  it("pops a row's marks when a pushed run changes them, and plays nothing with Reduce motion on", async () => {
    const { url, client } = await arrangeFleet();
    const { workflow } = await client.workflow.create({
      payload: {
        definition: {
          name: "Motion check",
          triggers: [{ id: "start", kind: "start", on: { schedule: "0 3 1 1 *" } }],
          steps: [{ id: "hold", kind: "action", action: "wait", params: { seconds: 600 } }],
        },
      },
    });
    const startRun = async () =>
      (await client.run.start({ payload: { workflowId: workflow.id } })).runId;
    const firstRunId = await startRun();
    const { app, page } = await openSignedIn(url);
    await chooseMenuItem(app, "Go", "Workflows");
    const row = page.locator(".table-row", { hasText: "Motion check" });
    // The run has started once its strip shows a mark, not the dot of a run
    // still starting, so no push from its start is still on the way.
    await row.locator(".strip-run > .mark").waitFor();

    await page.emulateMedia({ reducedMotion: "reduce" });
    // `animationstart` fires for every CSS animation Chromium starts, and it
    // bubbles, so one listener on the document hears every element.
    await page.evaluate(() => {
      const log: string[] = [];
      (globalThis as AnimationLog).rowAnimations = log;
      document.addEventListener("animationstart", (event) => {
        if ((event.target as Element).closest(".table-row")?.textContent?.includes("Motion check"))
          log.push(event.animationName);
      });
    });
    const readLog = () => page.evaluate(() => (globalThis as AnimationLog).rowAnimations);

    await client.run.cancel({ params: { id: firstRunId }, payload: {} });
    await row.getByRole("img", { name: "Cancelled" }).waitFor();
    expect(await readLog()).toEqual([]);

    // With Reduce motion off, a run that joins the strip steps the older
    // marks left and pops its own in. That proves the change above was one
    // that animates, so the empty log means something. The cancel's pop
    // never played, so nothing ended it: turning Reduce motion off plays it
    // now, and the log starts afresh once it is over.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.evaluate(() => (globalThis as AnimationLog).rowAnimations?.splice(0));
    await startRun();
    await expect.poll(readLog).toEqual(expect.arrayContaining(["strip-step", "mark-in"]));
  });
});
