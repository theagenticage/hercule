/**
 * Tests Intake in the packaged app, signed in to a real controller whose
 * signals the test raises with `hercule signal raise` (spec 17 §Testing).
 * `intake-moves.test.ts` and `intake-notification.test.ts` test the rest of
 * it:
 *
 * - Intake opens from the Hercule face's row and from Go › Intake, ⌘⇧I, and
 *   shows the Hercule face; View's two items change the face without
 *   leaving Intake;
 * - the Hercule segment's count, and the Intake row's, follow a raised
 *   signal and one answered elsewhere;
 * - the keys answer a signal: `J` moves the selection, `↩` opens the pane on
 *   the suggested answer, and a second `↩` presses it; Esc steps back;
 * - a GitHub failed-checks signal draws its Checks block with the log lines
 *   of each failed check.
 *
 * With `HERCULE_INTAKE_EVIDENCE=<dir>` set, the failed-checks test also
 * writes `checks-failed-light.png` and `checks-failed-dark.png` of the open
 * signal there, at 1440 × 900.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  chooseMenuItem,
  openSignedIn,
  readMenuItems,
  type ArrangedFleet,
} from "./harness";
import {
  raiseSignal,
  editDatabase,
  writeSignalColumns,
  readScreenTitle,
  readRowTitles,
  readSelectedTitle,
  readToDoCounts,
  selectRow,
  openSignalPane,
  evidence,
  PAUSE_MS,
} from "./intake-helpers";

/** Raises a proposal titled `title`, whose Accept creates a task of the same title. */
const raiseProposal = (arranged: ArrangedFleet, title: string): Promise<string> =>
  raiseSignal(arranged, "proposal", title, ["--task", JSON.stringify({ title, description: "" })]);

/**
 * Adds a GitHub Connection with the id `connectionId`, with no credentials.
 * Its status is `needs-reauth`, which is true of a Connection that holds no
 * token and keeps the controller from polling GitHub for it. Unlike
 * `disabled`, it still lets a signal's answer act through it. See `editDatabase`.
 */
function addGithubConnection(home: string, connectionId: string): void {
  editDatabase(
    home,
    String.raw`
    const [connectionId] = args;
    const at = new Date().toISOString();
    database
      .query(
        "INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status, labels, config, created_at, updated_at) VALUES (?, 'github', 'github/github', 'acme', 'acme', '1', 'needs-reauth', '[]', '{}', ?, ?)",
      )
      .run(Buffer.from(connectionId.replaceAll("-", ""), "hex"), at, at);
  `,
    [connectionId],
  );
}

/**
 * The failed-checks signal GitHub raises for a pull request, as the build of
 * `github/checks-failed` lays it out: two failed checks with the end of what
 * they reported, a passed count, and the Re-run failed checks answer.
 */
const FAILED_CHECKS = {
  title: "Rework the cart totals",
  asker: "GitHub Actions",
  rows: [
    {
      name: "unit",
      state: "failed",
      url: "https://github.com/acme/webshop/runs/2",
      log: [
        "FAIL  src/cart/totals.test.ts > totals > adds the shipping to the total",
        "AssertionError: expected 4290 to be 4590 // Object.is equality",
        "  - Expected: 4590",
        "  + Received: 4290",
        " ❯ src/cart/totals.test.ts:57:30",
        "Test Files  1 failed | 41 passed (42)",
        "     Tests  1 failed | 318 passed (319)",
      ].join("\n"),
    },
    {
      name: "types",
      state: "failed",
      url: "https://github.com/acme/webshop/runs/5",
      log: [
        "src/cart/totals.ts:88:14 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/cart/summary.tsx:31:9 - error TS2322: Type 'number | undefined' is not assignable to type 'number'.",
        "Found 2 errors in 2 files.",
      ].join("\n"),
    },
  ],
  passed: 3,
} as const;

/** The id of the GitHub Connection that the Re-run answer is bound to. */
const GITHUB_CONNECTION_ID = "01990000-0000-7000-8000-000000000001";

/**
 * Turns the signal `signalId` into the signal `github/checks-failed` builds
 * for pull request 1293 of acme/webshop, in the controller's database, with
 * the GitHub Connection its answer acts through. See `editDatabase`.
 */
function makeSignalFailedChecks(home: string, signalId: string): void {
  addGithubConnection(home, GITHUB_CONNECTION_ID);
  writeSignalColumns(home, signalId, {
    kind: "github/checks-failed",
    title: FAILED_CHECKS.title,
    asker: FAILED_CHECKS.asker,
    place: "acme/webshop#1293",
    priority: "normal",
    blocks: JSON.stringify([
      { type: "checks", rows: FAILED_CHECKS.rows, passed: FAILED_CHECKS.passed, omitted: 0 },
    ]),
    actions: JSON.stringify([
      {
        id: "rerun",
        label: "Re-run failed checks",
        operation: {
          op: "github/checks.rerun",
          connectionId: GITHUB_CONNECTION_ID,
          input: { repo: "acme/webshop", number: 1293, sha: "abc123" },
        },
        primary: true,
      },
    ]),
  });
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

describe("Intake", () => {
  it("opens from the Hercule face's row and from Go › Intake, shows the Hercule face, and keeps Intake open while View changes the face", async () => {
    const arranged = await arrangeFleet();
    await raiseSignal(arranged, "fyi", "Release 4.2 shipped");
    const { app, page } = await openSignedIn(arranged.url);
    expect(await readSidebarFace(page)).toEqual(THREADS_FACE);
    expect((await readMenuItems(app, "Go"))[2]).toEqual({
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
    // The Office is on screen only once it has loaded and mounted. Where it
    // draws in software (Linux without a GPU) that takes seconds, and a face
    // chosen before then is overwritten when the Office mounts.
    await page.locator(".office").waitFor();
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

    // The list narrows to make room for the pane two frames after the pane
    // opens, and on a busy machine those frames can come seconds late. A pane
    // closed before the list has narrowed has no motion to wait for and stays
    // drawn, so the test waits for the narrowed list. The pane also draws the
    // new signal from scratch, which drops the focus, and the page gives it
    // back to the list a moment later; a key pressed in between reaches
    // nothing, so the test waits for the focus too.
    await page.locator(".asks.has-pane").waitFor();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('section[aria-label="Signals"]') !== null,
        ),
      )
      .toBe(true);
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

  it("draws a GitHub failed-checks signal's Checks block with the log lines of each failed check", async () => {
    const arranged = await arrangeFleet();
    const signalId = await raiseSignal(arranged, "fyi", "Raised to be failed checks");
    await arranged.restartController(() => makeSignalFailedChecks(arranged.home, signalId));
    const { app, page } = await openSignedIn(arranged.url);
    await chooseMenuItem(app, "Go", "Intake");
    await expect.poll(() => readRowTitles(page)).toEqual([FAILED_CHECKS.title]);
    await selectRow(page, FAILED_CHECKS.title);

    const pane = openSignalPane(page);
    await expect.poll(() => pane.locator(".ad-title").textContent()).toBe(FAILED_CHECKS.title);
    expect(await pane.locator(".ad-asked").textContent()).toMatch(/^GitHub Actions/);
    const rows = pane.locator(".b-check");
    expect(await rows.locator(".mono:not(.b-log)").allTextContents()).toEqual(["unit", "types"]);
    expect(await rows.locator("a").allTextContents()).toEqual(["Failed", "Failed"]);
    // The log keeps its line breaks: `textContent` of the `<pre>` is the log itself.
    expect(await pane.locator(".b-log").allTextContents()).toEqual(
      FAILED_CHECKS.rows.map((row) => row.log),
    );
    expect(await pane.locator(".b-checks-more").textContent()).toBe("3 passed");
    await pane.getByRole("button", { name: "Re-run failed checks" }).waitFor();
    // The plugin's own line for the answer, which the core writes only when
    // the answer's Connection exists.
    expect(await pane.locator(".ans-desc").first().textContent()).toContain(
      "Re-runs the failed checks on pull request #1293 in acme/webshop",
    );

    if (evidence === undefined) return;
    mkdirSync(evidence, { recursive: true });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900);
    });
    for (const theme of ["light", "dark"] as const) {
      await app.evaluate(({ nativeTheme }, chosen) => {
        nativeTheme.themeSource = chosen;
      }, theme);
      await page.waitForFunction(
        (dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark,
        theme === "dark",
      );
      await sleep(PAUSE_MS / 4);
      await page.screenshot({ path: join(evidence, `checks-failed-${theme}.png`) });
    }
  });
});
