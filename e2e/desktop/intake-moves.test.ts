/**
 * Tests the moves of Intake in the packaged app, signed in to a real
 * controller whose signals the test raises with `hercule signal raise` (spec
 * 17 §Testing): `H` and a number snooze a signal into Later, `U` brings it
 * back, `E` marks one done, `X` and `⇧J` check two rows whose Done the bulk
 * bar sends, and Done lists all three.
 *
 * With `HERCULE_INTAKE_EVIDENCE=<dir>` set, one more test walks through the
 * moves for a reviewer, at a pace a person can follow, and records a video
 * of itself at 1440 × 900 into `<dir>`. Without it, that test is skipped,
 * because the test of the moves above already checks every step it shows.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  chooseMenuItem,
  createUserDataDirForTest,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  signInAndReadToken,
} from "./harness";
import {
  raiseSignal,
  readRowTitles,
  readToDoCounts,
  selectRow,
  evidence,
  PAUSE_MS,
} from "./intake-helpers";

/** Shows the view of Intake's list named `label`: "To do", "Later" or "Done". */
async function showView(page: Page, label: string): Promise<void> {
  const button = page.getByRole("group", { name: "View" }).getByRole("button", { name: label });
  await button.click();
  await expect.poll(() => button.getAttribute("aria-pressed")).toBe("true");
}

describe("Intake, the moves", () => {
  it("snoozes a signal into Later with H, brings it back with U, marks one done with E, and marks two checked rows done from the bulk bar", async () => {
    const arranged = await arrangeFleet();
    const titles = ["Release 4.2 shipped", "Docs moved to the wiki", "Staging was rebuilt"];
    for (const title of titles) await raiseSignal(arranged, "fyi", title);
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await expect
      .poll(async () => (await readRowTitles(page)).toSorted())
      .toEqual(titles.toSorted());
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 3 to do" });

    // H opens the snooze menu on the selected row, and a choice's number
    // snoozes it. Tomorrow is always open to choose.
    await selectRow(page, "Release 4.2 shipped");
    await page.keyboard.press("h");
    const menu = page.getByRole("menu", { name: "Snooze until" });
    const tomorrow = menu.getByRole("menuitem", { name: /^Tomorrow/ });
    const tomorrowKey = (await tomorrow.locator("kbd").textContent()) ?? "";
    await page.keyboard.press(tomorrowKey);
    await expect.poll(() => menu.count()).toBe(0);
    await expect
      .poll(async () => (await readRowTitles(page)).toSorted())
      .toEqual(["Docs moved to the wiki", "Staging was rebuilt"]);
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 2 to do" });
    // A move ignores the keys until the one before it ends, and the toast
    // shows when it has.
    await expect
      .poll(() => page.locator(".asks-toast[role=status]").textContent())
      .toBe("Snoozed until tomorrow 09:00");

    // Later lists it under the day it comes back, with the time at the row's
    // end; U brings it back to To do.
    await showView(page, "Later");
    await expect.poll(() => readRowTitles(page)).toEqual(["Release 4.2 shipped"]);
    expect(await page.locator(".asks-sec").textContent()).toBe("Back tomorrow1");
    expect(await page.locator(".ask-until").textContent()).toBe("09:00");
    await selectRow(page, "Release 4.2 shipped");
    await page.keyboard.press("u");
    await expect.poll(() => readRowTitles(page)).toEqual([]);
    await expect
      .poll(() => page.locator(".asks-toast[role=status]").textContent())
      .toBe("Back on To do");
    await showView(page, "To do");
    await expect
      .poll(async () => (await readRowTitles(page)).toSorted())
      .toEqual(titles.toSorted());
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 3 to do" });

    // E marks the selected row done, and the toast says so.
    await selectRow(page, "Docs moved to the wiki");
    await page.keyboard.press("e");
    await expect
      .poll(async () => (await readRowTitles(page)).toSorted())
      .toEqual(["Release 4.2 shipped", "Staging was rebuilt"]);
    await expect
      .poll(() => page.locator(".asks-toast[role=status]").textContent())
      .toBe("Done · Docs moved to the wiki");

    // X checks the first row and ⇧J adds the next one; the bulk bar's Done
    // sends both.
    const [first] = await readRowTitles(page);
    await selectRow(page, first!);
    await page.keyboard.press("x");
    await page.keyboard.press("Shift+J");
    const bar = page.getByRole("toolbar", { name: "Checked rows" });
    await expect.poll(() => bar.locator(".asks-toast-text").textContent()).toBe("2 selected");
    await bar.getByRole("button", { name: /^Done/ }).click();
    await expect.poll(() => readRowTitles(page)).toEqual([]);
    await expect.poll(() => bar.count()).toBe(0);
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule" });

    await showView(page, "Done");
    await expect
      .poll(async () => (await readRowTitles(page)).toSorted())
      .toEqual(titles.toSorted());
  });

  it.skipIf(evidence === undefined)(
    "walks through the moves for the evidence: snooze, Later, unsnooze, Done, the bulk bar and the Done view",
    async () => {
      mkdirSync(evidence!, { recursive: true });
      const arranged = await arrangeFleet();
      const titles = [
        "Release 4.2 shipped",
        "Docs moved to the wiki",
        "Staging was rebuilt",
        "Nightly backup finished",
      ];
      for (const title of titles) await raiseSignal(arranged, "fyi", title);
      const userDataDir = createUserDataDirForTest();
      writeSettings(userDataDir, {
        controllerUrl: arranged.url,
        window: { bounds: { x: 0, y: 0, width: 1440, height: 940 }, fullScreen: false },
      });
      const { app, page, close } = await launchForTest(
        userDataDir,
        async (application) => {
          await application.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900);
          });
        },
        { recordVideo: { dir: evidence!, size: { width: 1440, height: 900 } } },
      );
      onTestFinished(async () => {
        await close();
        const videoPath = page.video()?.path();
        if (videoPath !== undefined) console.log("Intake journey recording:", await videoPath);
      });
      await signInAndReadToken(page, arranged.url);
      await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
      // The video records only frames that are drawn, and macOS draws none
      // for a window that another test's window covers.
      await keepWindowOnTop(app);
      const toast = page.locator(".asks-toast[role=status]");

      await chooseMenuItem(app, "Go", "Intake");
      await expect.poll(async () => (await readRowTitles(page)).length).toBe(titles.length);
      await sleep(PAUSE_MS);

      // A row shows its moves while the pointer is over it; its Snooze
      // button opens the snooze menu, and a choice snoozes the row.
      const snoozed = page.locator(".ask-item", { hasText: "Release 4.2 shipped" });
      await snoozed.hover();
      await sleep(PAUSE_MS);
      await snoozed.getByRole("button", { name: "Snooze" }).click();
      const menu = page.getByRole("menu", { name: "Snooze until" });
      await menu.waitFor();
      await sleep(PAUSE_MS);
      await menu.getByRole("menuitem", { name: /^Tomorrow/ }).click();
      await expect.poll(() => toast.textContent()).toBe("Snoozed until tomorrow 09:00");
      await sleep(PAUSE_MS);

      // Later lists the row with the time it comes back; U brings it back.
      await showView(page, "Later");
      await expect.poll(() => readRowTitles(page)).toEqual(["Release 4.2 shipped"]);
      await sleep(PAUSE_MS);
      await selectRow(page, "Release 4.2 shipped");
      await page.keyboard.press("u");
      await expect.poll(() => toast.textContent()).toBe("Back on To do");
      await sleep(PAUSE_MS);
      await showView(page, "To do");
      await expect.poll(async () => (await readRowTitles(page)).length).toBe(titles.length);
      await sleep(PAUSE_MS);

      // E marks the selected row done.
      await selectRow(page, "Docs moved to the wiki");
      await sleep(PAUSE_MS / 2);
      await page.keyboard.press("e");
      await expect.poll(() => toast.textContent()).toBe("Done · Docs moved to the wiki");
      await sleep(PAUSE_MS);

      // X checks rows; the bulk bar previews what its Done does under the
      // pointer, and a click sends it.
      const [first] = await readRowTitles(page);
      await selectRow(page, first!);
      await page.keyboard.press("x");
      await sleep(PAUSE_MS / 2);
      await page.keyboard.press("Shift+J");
      await sleep(PAUSE_MS / 2);
      await page.keyboard.press("Shift+J");
      const bar = page.getByRole("toolbar", { name: "Checked rows" });
      await expect.poll(() => bar.locator(".asks-toast-text").textContent()).toBe("3 selected");
      await sleep(PAUSE_MS);
      const bulkDone = bar.getByRole("button", { name: /^Done/ });
      await bulkDone.hover();
      await expect.poll(() => bar.locator(".asks-toast-text").textContent()).toMatch(/^Done 3/);
      await sleep(PAUSE_MS * 1.5);
      await bulkDone.click();
      await expect.poll(() => readRowTitles(page)).toEqual([]);
      await sleep(PAUSE_MS);

      await showView(page, "Done");
      await expect
        .poll(async () => (await readRowTitles(page)).toSorted())
        .toEqual(titles.toSorted());
      await sleep(PAUSE_MS * 1.5);
    },
  );
});
