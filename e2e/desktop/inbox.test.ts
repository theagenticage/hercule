/**
 * Tests the Inbox in the packaged app, signed in to a real controller (spec
 * 17 §Inbox). Three journeys, kept to what only the packaged app proves:
 *
 * - the sidebar's Inbox row says how many things someone waits on and opens
 *   the Inbox; the rail lists the saved queries with their counts; the list
 *   draws rows, and a virtual list mounts only some of them; the pane shows
 *   the current row; J moves the current row and the pane follows; a token
 *   typed in the search narrows the list; the bar's floating controls are
 *   `no-drag`, so a press on them is the page's and not the window's;
 * - T takes the current thing on, so the controller has a Task with its
 *   title and the thing leaves the list; "With Hercule" then holds it, and G
 *   on it goes to that Task on Work, where its card is drawn;
 * - E dismisses the current thing and the undo key puts it back, each seen in
 *   the list and in the controller's count.
 *
 * GitHub cannot be reached offline, so the things are written into the
 * scratch database while the controller is stopped, in the shape the GitHub
 * plugin reports them (`writeInboxWorld`, which the perf script shares): 300
 * things of the invented Northwind Market world, each with an open signal,
 * from a Connection that holds no token, so the controller never polls it and
 * the rows stay as written.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { RUNS_ON_MAC } from "../../apps/desktop/scripts/packaged-app";
import { INBOX_CARDS, writeInboxWorld } from "../../apps/desktop/scripts/perf-inbox.ts";
import { arrangeFleet, openSignedIn, type ArrangedFleet } from "./harness";

/** The key that starts a shortcut: ⌘ on a Mac, Ctrl on Linux. */
const PRIMARY_KEY = RUNS_ON_MAC ? "Meta" : "Control";

/** The id of the saved query the Inbox opens on, the things someone waits on. */
const WAITS = "waits";

/** What the journeys hold of the open Inbox. */
interface OpenInbox {
  readonly arranged: ArrangedFleet;
  readonly page: Page;
  /** The sidebar's Inbox row. */
  readonly sidebarRow: Locator;
  /** The mounted rows of the list, top to bottom. */
  readonly rows: Locator;
  /** The pane beside the list. */
  readonly pane: Locator;
}

/** Writes the Northwind world into the database of the stopped controller whose Hercule Home is `home`. */
function seedInbox(home: string): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    writeInboxWorld(database);
  } finally {
    database.close();
  }
}

/** Returns how many things the controller says someone waits on. */
async function readWaitingCount({ client }: ArrangedFleet): Promise<number> {
  const { savedQueries } = await client.externalEntity.countInbox();
  return savedQueries.find((query) => query.id === WAITS)!.count;
}

/**
 * Starts a controller with the Northwind world, opens the app signed in to it
 * and returns once the sidebar's Inbox row is on screen, before it is
 * clicked.
 */
async function arrangeInbox(): Promise<OpenInbox> {
  const arranged = await arrangeFleet();
  await arranged.restartController(() => {
    seedInbox(arranged.home);
  });
  const { page } = await openSignedIn(arranged.url);
  await page
    .getByRole("tablist", { name: "Sidebar" })
    .getByRole("tab", { name: "Hercule" })
    .click();
  const sidebarRow = page
    .getByRole("navigation", { name: "Hercule", exact: true })
    .getByRole("link", { name: /^Inbox/ });
  return {
    arranged,
    page,
    sidebarRow,
    rows: page.getByRole("tree").getByRole("treeitem"),
    pane: page.getByLabel("The open thing"),
  };
}

/** Returns the title of the row `row`, as the list draws it. */
const readRowTitle = (row: Locator): Promise<string> =>
  row.locator(".ib-row-title").evaluate((title) => title.textContent ?? "");

/** Returns a pattern that matches `text` as a whole, for a locator's `hasText`, which otherwise matches a part. */
const buildExactText = (text: string): RegExp =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** Returns the locator of the row of the thing `ref` in the list, which is none while the list does not hold it. */
const locateRow = (page: Page, ref: string): Locator =>
  page.locator(`.ib-rows > .ib-row[data-ref="${ref}"]`);

describe("Inbox", () => {
  it("opens from the sidebar's count, lists the saved queries with their counts, moves with J, narrows with a token, and keeps the bar's controls out of the drag strip", async () => {
    const { arranged, page, sidebarRow, rows, pane } = await arrangeInbox();
    const waiting = await readWaitingCount(arranged);
    expect(waiting).toBe(INBOX_CARDS);

    // The sidebar's row says how many things someone waits on, and opens the Inbox.
    await expect
      .poll(() => sidebarRow.getAttribute("aria-label"))
      .toMatch(new RegExp(`^Inbox, ${String(waiting)} waiting`));
    expect(await sidebarRow.locator(".count").textContent()).toBe(String(waiting));
    await sidebarRow.click();
    await page.locator(".ib").waitFor();

    // The rail lists the saved queries, the first one picked, each with its count.
    const rail = page.getByRole("navigation", { name: "Inbox lists" });
    const { savedQueries } = await arranged.client.externalEntity.countInbox();
    expect(savedQueries[0]!.id).toBe(WAITS);
    for (const query of savedQueries) {
      const entry = rail
        .locator(".ib-rail-row")
        .filter({ has: page.locator(".ib-rail-name", { hasText: buildExactText(query.name) }) });
      await entry.waitFor();
      await expect
        .poll(() => entry.locator(".ib-rail-count").textContent())
        .toBe(query.count > 0 ? String(query.count) : "");
    }
    expect(
      await rail
        .locator(".ib-rail-row")
        .filter({
          has: page.locator(".ib-rail-name", { hasText: buildExactText(savedQueries[0]!.name) }),
        })
        .getAttribute("aria-current"),
    ).toBe("true");

    // The list draws rows, but a virtual list does not mount all 300 of them.
    const head = page.locator(".ib-head");
    await head.waitFor();
    expect(await head.locator("h2").textContent()).toBe(savedQueries[0]!.name);
    await expect.poll(() => head.locator(".ib-head-count").textContent()).toBe(String(waiting));
    await rows.first().waitFor();
    const mounted = await rows.count();
    expect(mounted).toBeGreaterThan(5);
    expect(mounted).toBeLessThan(waiting / 2);

    // The first row is current, and the pane shows it.
    const first = rows.first();
    const second = rows.nth(1);
    const firstTitle = await readRowTitle(first);
    const secondTitle = await readRowTitle(second);
    expect(firstTitle).not.toBe(secondTitle);
    await expect.poll(() => first.getAttribute("class")).toContain("is-current");
    await expect.poll(() => pane.locator(".open-card-title").textContent()).toBe(firstTitle);

    // A click puts the focus in the list, where J moves the current row on and the pane follows.
    await first.click();
    await page.keyboard.press("j");
    await expect.poll(() => second.getAttribute("class")).toContain("is-current");
    expect(await first.getAttribute("class")).not.toContain("is-current");
    await expect.poll(() => pane.locator(".open-card-title").textContent()).toBe(secondTitle);
    await page.keyboard.press("k");
    await expect.poll(() => first.getAttribute("class")).toContain("is-current");
    await expect.poll(() => pane.locator(".open-card-title").textContent()).toBe(firstTitle);

    // A token narrows the list to the things its field matches, and removing it widens it again.
    await page.getByRole("combobox", { name: "Search the Inbox" }).click();
    await page.keyboard.type("from:juno-park ");
    const token = page.locator(".ib-sx-chip[data-token]");
    await token.waitFor();
    expect(await token.textContent()).toContain("juno-park");
    // Juno Park asks for the review of every fifth thing of the world: its pull requests.
    await expect
      .poll(() => head.locator(".ib-head-count").textContent())
      .toBe(String(INBOX_CARDS / 5));
    await token.getByRole("button", { name: /^Remove / }).click();
    await expect.poll(() => head.locator(".ib-head-count").textContent()).toBe(String(waiting));

    // The bar floats in the window's 52px drag strip: its controls opt out of
    // dragging, or a press on them would move the window and never reach the page.
    const controls = [
      page.locator(".ib-pill"),
      page.locator(".ib-search > *").first(),
      page.getByRole("button", { name: "Show the keys" }),
    ];
    for (const control of controls) {
      expect((await control.boundingBox())!.y).toBeLessThan(52);
      expect(
        await control.evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        ),
      ).toBe("no-drag");
    }
  });

  it("takes the current thing on with T, and goes to its Task on Work with G", async () => {
    const { arranged, page, sidebarRow, rows, pane } = await arrangeInbox();
    await sidebarRow.click();
    const first = rows.first();
    await first.waitFor();
    const title = await readRowTitle(first);
    const ref = (await first.getAttribute("data-ref"))!;
    await expect.poll(() => pane.locator(".open-card-title").textContent()).toBe(title);

    await first.click();
    await page.keyboard.press("t");
    await expect
      .poll(async () =>
        (await arranged.client.task.queryBoard()).cards.some((card) => card.title === title),
      )
      .toBe(true);
    await expect.poll(() => page.locator(".undo-line.is-on").textContent()).toContain("Took on");

    // The thing has left "Someone waits on me", and the next one is current. "With Hercule" lists
    // the things a Task holds, so it holds this one alone, and G on it goes to its Task, where the
    // Task's card is drawn.
    const [task] = (await arranged.client.task.queryBoard()).cards.filter(
      (card) => card.title === title,
    );
    await expect.poll(() => locateRow(page, ref).count()).toBe(0);
    await page
      .getByRole("navigation", { name: "Inbox lists" })
      .locator(".ib-rail-row")
      .filter({ has: page.locator(".ib-rail-name", { hasText: buildExactText("With Hercule") }) })
      .click();
    await locateRow(page, ref).click();
    await page.keyboard.press("g");
    const card = page.locator(`.work-desk [data-card-id="${task!.id}"]`);
    await card.waitFor();
    expect(await card.textContent()).toContain(title);
  });

  it("dismisses the current thing with E and puts it back with the undo key", async () => {
    const { arranged, page, sidebarRow, rows } = await arrangeInbox();
    await sidebarRow.click();
    const first = rows.first();
    await first.waitFor();
    const ref = (await first.getAttribute("data-ref"))!;
    const waiting = await readWaitingCount(arranged);

    await first.click();
    await page.keyboard.press("e");
    await expect.poll(() => locateRow(page, ref).count()).toBe(0);
    await expect.poll(() => readWaitingCount(arranged)).toBe(waiting - 1);
    await page.locator(".undo-line.is-on").waitFor();
    // The line is as wide as its content and centred on the list, not squeezed into half of it.
    const box = await page.locator(".undo-line.is-on").evaluate((line) => {
      const list = line.closest(".ib-list")!.getBoundingClientRect();
      const own = line.getBoundingClientRect();
      return {
        width: own.width,
        text: line.querySelector(".undo-text")!.getBoundingClientRect().width,
        off: own.left + own.width / 2 - (list.left + list.width / 2),
      };
    });
    expect(box.width).toBeGreaterThan(150);
    expect(box.text).toBeGreaterThan(40);
    expect(Math.abs(box.off)).toBeLessThan(1.5);

    await page.keyboard.press(`${PRIMARY_KEY}+z`);
    await expect.poll(() => locateRow(page, ref).count()).toBe(1);
    await expect.poll(() => readWaitingCount(arranged)).toBe(waiting);
  });
});
