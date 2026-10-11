/**
 * Tests Intake in the packaged app, signed in to a real controller whose
 * signals the test raises with `hercule signal raise`, as spec 17 §Testing
 * asks (§Intake, slice 25):
 *
 * - Intake opens from the Hercule face's row and from Go › Intake, ⌘⇧I, and
 *   shows the Hercule face; View's two items change the face without
 *   leaving Intake;
 * - the Hercule segment's count, and the Intake row's, follow a raised
 *   signal and one answered elsewhere;
 * - the keys answer a signal: `J` moves the selection, `↩` opens the pane on
 *   the suggested answer, and a second `↩` presses it; Esc steps back;
 * - a new Now signal notifies while the window is not focused, and a click
 *   on the notification opens Intake with the signal selected.
 *
 * Done and Snooze are not built in this slice, so the count is not tested
 * against them yet.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import { buildCleanEnv, findCompiledBinary, runCli } from "../../scripts/controller-process";
import {
  arrangeFleet,
  chooseMenuItem,
  clickWaitingNotification,
  hideWindow,
  openSignedIn,
  readMenuItems,
  readWaitingNotifications,
  type ArrangedFleet,
} from "./harness";

/**
 * Raises a signal with `hercule signal raise`, as the user `fleet` signed in
 * as, and returns its id. `args` are the command's flags after `--reason`.
 * Fails when the command fails.
 */
async function raiseSignal(
  { url, home, fleet }: ArrangedFleet,
  kind: string,
  title: string,
  args: ReadonlyArray<string> = [],
): Promise<string> {
  const ran = await runCli(
    [
      "signal",
      "raise",
      "--kind",
      kind,
      "--title",
      title,
      "--reason",
      "Raised by a test",
      // The CLI asks for at least one event. Nothing checks that the event
      // exists, and no plugin in the test binary can emit one.
      "--event-id",
      "1",
      ...args,
      "--json",
    ],
    {
      home,
      binary: findCompiledBinary(),
      env: { HERCULE_API_URL: url, HERCULE_TOKEN: fleet.token },
    },
  );
  expect(ran.code, ran.stderr).toBe(0);
  return (JSON.parse(ran.stdout) as { signalId: string }).signalId;
}

/** Raises a proposal titled `title`, whose Accept creates a task of the same title. */
const raiseProposal = (arranged: ArrangedFleet, title: string): Promise<string> =>
  raiseSignal(arranged, "proposal", title, ["--task", JSON.stringify({ title, description: "" })]);

/**
 * Raises the signal `signalId` to the priority `urgent`, in the controller's
 * database. No operation does this: only a plugin's kind may be urgent, and
 * no plugin raises signals yet. The controller must be stopped, because it
 * holds its database locked while it runs.
 */
function makeSignalUrgent(home: string, signalId: string): void {
  const written = spawnSync(
    "bun",
    [
      "--eval",
      String.raw`
    import { Database } from "bun:sqlite";
    const database = new Database(process.argv[1]);
    const id = Buffer.from(process.argv[2].replaceAll("-", ""), "hex");
    const { changes } = database.query("UPDATE signals SET priority = 'urgent' WHERE id = ?").run(id);
    database.close();
    if (changes !== 1) throw new Error("no signal " + process.argv[2]);
  `,
      join(home, "data", "hercule.db"),
      signalId,
    ],
    { encoding: "utf8", env: buildCleanEnv() },
  );
  expect(written.status, written.stderr).toBe(0);
}

/** Returns which face the sidebar shows, by its selected segment and the label of the list under it. */
async function readSidebarFace(page: Page): Promise<{ tab: string | null; list: string | null }> {
  const tab = page.getByRole("tablist", { name: "Sidebar" }).locator('[aria-selected="true"]');
  const list = page.locator('nav[aria-label="Threads"], nav[aria-label="Hercule"]');
  // The segment's first text is its label; a To do count may follow it.
  return {
    tab: await tab.evaluate((element) => element.firstChild?.textContent ?? null),
    list: await list.getAttribute("aria-label"),
  };
}

const THREADS_FACE = { tab: "Threads", list: "Threads" };
const ORCHESTRATION_FACE = { tab: "Hercule", list: "Hercule" };

/**
 * Returns the title of the screen in the main pane's bar, such as "Intake",
 * or null when the screen draws no such bar, as the Office does.
 */
async function readScreenTitle(page: Page): Promise<string | null> {
  const [title] = await page.locator("main .bar .title").allTextContents();
  return title ?? null;
}

/** Returns the titles of Intake's rows, top to bottom. */
const readRowTitles = (page: Page): Promise<string[]> =>
  page.locator('section[aria-label="Signals"] .ask-title').allTextContents();

/** Returns the selected row's title, or null when no row is selected. */
async function readSelectedTitle(page: Page): Promise<string | null> {
  const selected = page.locator('section[aria-label="Signals"] .ask-row[aria-current="true"]');
  return (await selected.count()) === 0 ? null : selected.locator(".ask-title").textContent();
}

/** Returns the accessible names of the Hercule segment and the Intake row's count, "" when hidden. */
async function readToDoCounts(page: Page): Promise<{ segment: string; row: string }> {
  const segment = page.getByRole("tablist", { name: "Sidebar" }).getByRole("tab").nth(1);
  const rowCount = page.locator("a.nav-row", { hasText: "Intake" }).locator(".count");
  return {
    // The segment carries an accessible name only while it has a count.
    segment:
      (await segment.getAttribute("aria-label")) ?? ((await segment.textContent()) ?? "").trim(),
    row: (await rowCount.count()) === 0 ? "" : ((await rowCount.textContent()) ?? ""),
  };
}

/** The pane of the open signal. */
const openSignalPane = (page: Page) => page.getByRole("region", { name: "The open signal" });

describe("Intake", () => {
  it("opens from the Hercule face's row and from Go › Intake, shows the Hercule face, and keeps Intake open while View changes the face", async () => {
    const arranged = await arrangeFleet();
    await raiseSignal(arranged, "fyi", "Release 4.2 shipped");
    const { app, page } = await openSignedIn(arranged.url);
    expect(await readSidebarFace(page)).toEqual(THREADS_FACE);
    expect((await readMenuItems(app, "Go"))[1]).toEqual({
      label: "Intake",
      accelerator: "CmdOrCtrl+Shift+I",
      enabled: true,
    });

    await page.getByRole("tablist", { name: "Sidebar" }).getByRole("tab").nth(1).click();
    await page.locator('nav[aria-label="Hercule"] a.nav-row', { hasText: "Intake" }).click();
    await expect.poll(() => readScreenTitle(page)).toBe("Intake");
    expect(await readRowTitles(page)).toEqual(["Release 4.2 shipped"]);
    expect(
      await page.locator("a.nav-row", { hasText: "Intake" }).getAttribute("aria-current"),
    ).toBe("page");

    await chooseMenuItem(app, "View", "Threads");
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
    expect(await readScreenTitle(page)).toBe("Intake");
    await chooseMenuItem(app, "View", "Hercule");
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
    expect(await readScreenTitle(page)).toBe("Intake");

    // The Office keeps the face; Go › Intake brings back Intake and its face.
    await chooseMenuItem(app, "Go", "Office");
    await expect.poll(() => readScreenTitle(page)).not.toBe("Intake");
    expect(await readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
    await chooseMenuItem(app, "View", "Threads");
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
    await chooseMenuItem(app, "Go", "Intake");
    await expect.poll(() => readScreenTitle(page)).toBe("Intake");
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
  });

  it("counts a raised signal on the Hercule segment and the Intake row, and drops it once it is answered elsewhere", async () => {
    const arranged = await arrangeFleet();
    const { page } = await openSignedIn(arranged.url);
    // The Intake row is on the Hercule face; the segment shows on both faces.
    await page.getByRole("tablist", { name: "Sidebar" }).getByRole("tab").nth(1).click();
    expect(await readToDoCounts(page)).toEqual({ segment: "Hercule", row: "" });

    const first = await raiseProposal(arranged, "Fix the flaky login test");
    await expect
      .poll(() => readToDoCounts(page))
      .toEqual({ segment: "Hercule, 1 to do", row: "1" });
    await raiseSignal(arranged, "fyi", "Release 4.2 shipped");
    await expect
      .poll(() => readToDoCounts(page))
      .toEqual({ segment: "Hercule, 2 to do", row: "2" });

    await arranged.client.signal.act({ params: { id: first }, payload: { actionId: "dismiss" } });
    await expect
      .poll(() => readToDoCounts(page))
      .toEqual({ segment: "Hercule, 1 to do", row: "1" });
  });

  it("answers a signal from the keys: J moves, ↩ puts the focus on the suggested answer, a second ↩ presses it, and Esc steps back", async () => {
    const arranged = await arrangeFleet();
    await raiseProposal(arranged, "Fix the flaky login test");
    await raiseProposal(arranged, "Bump the checkout timeout");
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await expect
      .poll(() => readRowTitles(page))
      .toEqual(["Fix the flaky login test", "Bump the checkout timeout"]);

    await page.locator(".ask-row", { hasText: "Fix the flaky login test" }).click();
    await expect.poll(() => readSelectedTitle(page)).toBe("Fix the flaky login test");
    await expect(openSignalPane(page).locator(".ad-title").textContent()).resolves.toBe(
      "Fix the flaky login test",
    );

    await page.keyboard.press("j");
    await expect.poll(() => readSelectedTitle(page)).toBe("Bump the checkout timeout");
    await expect
      .poll(() => openSignalPane(page).locator(".ad-title").textContent())
      .toBe("Bump the checkout timeout");

    // Esc closes the pane and keeps the row selected; a second Esc clears
    // the selection.
    await page.keyboard.press("Escape");
    await expect.poll(() => openSignalPane(page).count()).toBe(0);
    expect(await readSelectedTitle(page)).toBe("Bump the checkout timeout");
    await page.keyboard.press("Escape");
    await expect.poll(() => readSelectedTitle(page)).toBeNull();

    // `↩` on a row opens the pane and puts the focus on the suggested
    // answer, Accept, without pressing it.
    await page.locator(".ask-row", { hasText: "Bump the checkout timeout" }).focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null))
      .toBe("Accept");
    expect(await readRowTitles(page)).toHaveLength(2);
    expect((await arranged.client.task.query({ query: { limit: 10 } })).items).toEqual([]);

    await page.keyboard.press("Enter");
    await expect
      .poll(async () =>
        (await arranged.client.task.query({ query: { limit: 10 } })).items.map(
          (task) => task.title,
        ),
      )
      .toEqual(["Bump the checkout timeout"]);
    await expect.poll(() => readRowTitles(page)).toEqual(["Fix the flaky login test"]);
    expect(await readToDoCounts(page)).toEqual({ segment: "Hercule, 1 to do", row: "1" });
  });

  it("notifies a new Now signal while the window is not focused, and opens Intake on it when the notification is clicked", async () => {
    const arranged = await arrangeFleet();
    await raiseSignal(arranged, "fyi", "Earlier news");
    const { app, page } = await openSignedIn(arranged.url);
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 1 to do" });
    await hideWindow(app);

    const urgent = await raiseSignal(arranged, "fyi", "Checkout is down", ["--priority", "high"]);
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 2 to do" });
    expect(await readWaitingNotifications(app)).toEqual([]);
    // The app reads To do again once it reconnects, and the list then holds
    // an urgent signal it has not seen.
    await arranged.restartController(() => makeSignalUrgent(arranged.home, urgent));

    await expect
      .poll(() => readWaitingNotifications(app))
      .toEqual([{ title: expect.any(String) as string, body: "Checkout is down", state: "shown" }]);

    await clickWaitingNotification(app, 0);
    await expect.poll(() => isWindowVisible(app)).toBe(true);
    await expect.poll(() => readScreenTitle(page)).toBe("Intake");
    await expect.poll(() => readSelectedTitle(page)).toBe("Checkout is down");
    expect(await openSignalPane(page).locator(".ad-title").textContent()).toBe("Checkout is down");
    expect(await page.locator(".asks-sec", { hasText: "Now" }).count()).toBe(1);
  });
});
