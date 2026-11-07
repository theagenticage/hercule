/**
 * Tests Work, the Overview's board of Tasks (spec 17 §Work), in the packaged
 * app signed in to a real controller. One journey, kept to what only the
 * packaged app proves:
 *
 * - a Thread started on the controller reaches the board by itself: its card
 *   arrives at Exploring, in the lane of its Project, and the cards that were
 *   there stay where they are;
 * - the card, dragged with real pointer events to another stage and between
 *   two cards there, lands on that row, and only the card that slips down
 *   moves;
 * - after the app quits and starts again, the card is still on that row;
 * - `hercule task update <id> --stage in-review` run in a terminal moves the
 *   card live to the end of its new cell, and `hercule task board` shows it
 *   there;
 * - ⌘1 and ⌘2 (Ctrl on Linux) switch between the Office and Work;
 * - a Thread started from a card with the T key joins that card's Task, and
 *   D on the card marks the Task Done and takes it off the board.
 *
 * The Thread comes from a scripted runner. The Tasks that fill the other
 * stages are created through the API, like the Thread's Project and its
 * sibling Threads. The invented world is Northwind Market's web shop.
 *
 * Playwright's key presses reach the page, not the menu bar, so ⌘1 and ⌘2
 * reach the page's own handler, which is the one that takes them on both
 * views (the Go menu's first two items never see them).
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readSettings, RUNS_ON_MAC } from "../../apps/desktop/scripts/packaged-app";
import type { BoardStage, WorkCard } from "../../packages/contract/src/index";
import { findCompiledBinary, runCli } from "../../scripts/controller-process";
import {
  arrangeFleet,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  type ArrangedFleet,
} from "./harness";

/** The key that starts a shortcut: ⌘ on a Mac, Ctrl on Linux. */
const PRIMARY_KEY = RUNS_ON_MAC ? "Meta" : "Control";

/** The cards of the board by cell, such as "Storefront: building", each cell's titles top to bottom. Empty cells are left out. */
type BoardCells = Readonly<Record<string, ReadonlyArray<string>>>;

/** The names of the two Projects, which are the names of the lanes. */
const STOREFRONT = "Storefront";
const BACK_OFFICE = "Back office";

/** A running controller with the invented Northwind Market world on its board, before the journey's Thread starts. */
interface ArrangedBoard {
  readonly arranged: ArrangedFleet;
  /** Starts a Thread titled `title` in the Storefront Project and returns once its Task is on the board. */
  readonly startStorefrontThread: (title: string) => Promise<WorkCard>;
  /** The lanes' names by Project id, for reading the page. */
  readonly laneNames: ReadonlyMap<string, string>;
}

/** Returns the board's cards as the controller reads them. */
async function readBoardCards({ client }: ArrangedFleet): Promise<ReadonlyArray<WorkCard>> {
  return (await client.task.queryBoard()).cards;
}

/**
 * Starts a controller for the current test with two Projects and, on the
 * board:
 *
 * - Back office, Exploring: "Reconcile the weekly payouts", a Thread;
 * - Storefront, Exploring: "Fix the cart total", a Thread;
 * - Storefront, Building: "Update shipping rates" and "Rewrite the returns
 *   page", in that order;
 * - Storefront, In review: "Refresh the sale banner".
 *
 * The Threads each end their first turn, so no agent is at work on the board
 * and no card has a second line.
 */
async function arrangeBoard(): Promise<ArrangedBoard> {
  const arranged = await arrangeFleet();
  const { fleet, client } = arranged;
  const runner = await fleet.enlistRunner("studio");
  const storefront = await fleet.createProject(STOREFRONT);
  const backOffice = await fleet.createProject(BACK_OFFICE);

  const startThread = async (title: string, projectId: string): Promise<WorkCard> => {
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, projectId, prompt: title },
      [
        { kind: "message", text: "Looking into it." },
        { kind: "end", state: "completed" },
      ],
    );
    await played;
    await arranged.waitForStatus(thread.id, "idle");
    let card: WorkCard | undefined;
    await expect
      .poll(async () => {
        card = (await readBoardCards(arranged)).find((each) => each.title === title);
        return card?.stage;
      })
      .toBe("exploring");
    return card!;
  };

  await startThread("Reconcile the weekly payouts", backOffice.id);
  await startThread("Fix the cart total", storefront.id);
  for (const [title, stage] of [
    ["Update shipping rates", "building"],
    ["Rewrite the returns page", "building"],
    ["Refresh the sale banner", "in-review"],
  ] as const) {
    await client.task.create({
      payload: { title, description: "", stage, projectId: storefront.id },
    });
  }
  return {
    arranged,
    startStorefrontThread: (title) => startThread(title, storefront.id),
    laneNames: new Map([
      [storefront.id, STOREFRONT],
      [backOffice.id, BACK_OFFICE],
    ]),
  };
}

/** Returns the card of the Task `id`. */
const findCard = (page: Page, id: string): Locator => page.locator(`[data-card-id="${id}"]`);

/** Returns the board the page draws: the titles in each non-empty cell, top to bottom. */
async function readBoard(
  page: Page,
  titles: ReadonlyMap<string, string>,
  laneNames: ReadonlyMap<string, string>,
): Promise<BoardCells> {
  const cells = await page.locator(".board-cell").evaluateAll((elements) =>
    elements.map((cell) => ({
      laneId: (cell as HTMLElement).dataset["laneId"] ?? "",
      stage: (cell as HTMLElement).dataset["stage"] ?? "",
      ids: [...cell.querySelectorAll<HTMLElement>(":scope > [data-card-id]")].map(
        (card) => card.dataset["cardId"] ?? "",
      ),
    })),
  );
  return Object.fromEntries(
    cells
      .filter((cell) => cell.ids.length > 0)
      .map((cell) => [
        `${laneNames.get(cell.laneId) ?? cell.laneId}: ${cell.stage}`,
        cell.ids.map((id) => titles.get(id) ?? id),
      ]),
  );
}

/**
 * Drags the card `id` with the pointer, as a user does, and drops it between
 * the card `above` and the card below it in the cell of `stage`: down on the
 * card, a first move of more than the lift distance in several steps, a move
 * to the gap in several more, and up. Returns once the card is let go. The
 * drop is not checked here: the caller reads the board.
 *
 * Playwright's `click` and `dragTo` would not do. The board holds the pointer
 * on its scroller while a card is carried, and the card lifts only after the
 * pointer has moved a few pixels, which `dragTo` does not give.
 */
async function dragCardBelow(
  page: Page,
  id: string,
  above: { readonly id: string; readonly stage: BoardStage },
): Promise<void> {
  const card = findCard(page, id);
  await card.scrollIntoViewIfNeeded();
  const from = (await card.boundingBox())!;
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 4 });
  await page.locator(".work-desk[data-carrying]").waitFor();

  // The gap is measured after the lift: the card in the hand is out of the
  // layout by then, and the cell the pointer goes to has not moved.
  const target = (await findCard(page, above.id).boundingBox())!;
  const targetX = target.x + target.width / 2;
  const targetY = target.y + target.height + 1;
  await page.mouse.move(targetX, targetY, { steps: 20 });

  // The hollow that shows where the card lands is in the cell, right after
  // the card above, before the pointer is let go.
  await expect
    .poll(() =>
      page.locator(`.board-cell[data-stage="${above.stage}"] .board-slot`).evaluateAll((slots) =>
        slots.map((slot) => {
          const previous = slot.previousElementSibling as HTMLElement | null;
          return previous?.dataset["cardId"] ?? null;
        }),
      ),
    )
    .toEqual([above.id]);
  await page.mouse.up();
  await page.locator(".work-desk[data-carrying]").waitFor({ state: "detached" });
}

/** Runs `hercule` with `args` in a terminal of the user, against the journey's controller, and returns its output. Fails when it exits with an error. */
async function runTerminal(
  { home, url, fleet }: ArrangedFleet,
  args: ReadonlyArray<string>,
): Promise<string> {
  const ran = await runCli(args, {
    home,
    binary: findCompiledBinary(),
    env: { HERCULE_API_URL: url, HERCULE_TOKEN: fleet.token },
  });
  if (ran.code !== 0) {
    throw new Error(`hercule ${args.join(" ")} exited with ${String(ran.code)}:\n${ran.stderr}`);
  }
  return ran.stdout;
}

/** Opens Work from the Hercule face of the sidebar, by its Overview row, and waits for the board's cards. */
async function openWork(page: Page): Promise<void> {
  await page
    .getByRole("tablist", { name: "Sidebar" })
    .getByRole("tab", { name: "Hercule" })
    .click();
  await page
    .getByRole("navigation", { name: "Hercule", exact: true })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await page.locator(".work-desk .board-lane").first().waitFor();
}

describe("Work", () => {
  it("shows a started Thread as a card, keeps a dragged card where it was dropped across a restart, moves it live from the terminal, and shares ⌘1 and ⌘2 with the Office", async () => {
    const { arranged, startStorefrontThread, laneNames } = await arrangeBoard();
    const first = await openSignedIn(arranged.url);
    const { page } = first;
    await keepWindowOnTop(first.app);
    // The page saves the token without waiting for main, so the test waits
    // for the file: without a token the restart would not be signed in.
    await expect.poll(() => readSettings(first.userDataDir)["token"]).toBeTypeOf("string");
    await openWork(page);

    const titles = new Map((await readBoardCards(arranged)).map((card) => [card.id, card.title]));
    const readPageBoard = () => readBoard(page, titles, laneNames);
    const beforeThread: BoardCells = {
      "Back office: exploring": ["Reconcile the weekly payouts"],
      "Storefront: exploring": ["Fix the cart total"],
      "Storefront: building": ["Update shipping rates", "Rewrite the returns page"],
      "Storefront: in-review": ["Refresh the sale banner"],
    };
    await expect.poll(readPageBoard).toEqual(beforeThread);

    // A Thread started now arrives by itself at the end of Exploring, in the
    // lane of its Project, and nothing else moves.
    const refund = await startStorefrontThread("Add a refund button");
    titles.set(refund.id, refund.title);
    const withThread: BoardCells = {
      ...beforeThread,
      "Storefront: exploring": ["Fix the cart total", "Add a refund button"],
    };
    await expect.poll(readPageBoard).toEqual(withThread);
    expect(refund.projectId).toBeDefined();
    expect(await findCard(page, refund.id).getAttribute("data-stage")).toBe("exploring");

    // Dragged between the two cards in Building, the card lands there and the
    // card below it slips down.
    const shippingRates = (await readBoardCards(arranged)).find(
      (card) => card.title === "Update shipping rates",
    )!;
    await dragCardBelow(page, refund.id, { id: shippingRates.id, stage: "building" });
    const withDrop: BoardCells = {
      ...withThread,
      "Storefront: exploring": ["Fix the cart total"],
      "Storefront: building": [
        "Update shipping rates",
        "Add a refund button",
        "Rewrite the returns page",
      ],
    };
    await expect.poll(readPageBoard).toEqual(withDrop);
    await expect
      .poll(async () => {
        const stored = (await readBoardCards(arranged)).find((card) => card.id === refund.id);
        return stored?.stage;
      })
      .toBe("building");

    // Quit and start again: the card is on the same row.
    await first.close();
    const { page: reopened } = await launchForTest(first.userDataDir);
    await openWork(reopened);
    await expect.poll(() => readBoard(reopened, titles, laneNames)).toEqual(withDrop);

    // In a terminal, the Task moves to In review: the open board moves the
    // card at once, to the end of its new cell, and nothing else moves.
    await runTerminal(arranged, ["task", "update", refund.id, "--stage", "in-review"]);
    const afterTerminal: BoardCells = {
      ...withDrop,
      "Storefront: building": ["Update shipping rates", "Rewrite the returns page"],
      "Storefront: in-review": ["Refresh the sale banner", "Add a refund button"],
    };
    await expect.poll(() => readBoard(reopened, titles, laneNames)).toEqual(afterTerminal);

    // `hercule task board` reads the same board.
    const listed = JSON.parse(await runTerminal(arranged, ["task", "board", "--json"])) as {
      readonly cards: ReadonlyArray<Pick<WorkCard, "title" | "stage">>;
    };
    expect(listed.cards.find((card) => card.title === "Add a refund button")?.stage).toBe(
      "in-review",
    );

    // ⌘1 shows the Office, and ⌘2 shows Work again with the board as it was.
    const views = reopened.getByRole("group", { name: "Overview views" });
    await reopened.keyboard.press(`${PRIMARY_KEY}+1`);
    await reopened.locator(".office").waitFor();
    await expect
      .poll(() => views.getByRole("button", { name: "Office" }).getAttribute("aria-pressed"))
      .toBe("true");
    await reopened.keyboard.press(`${PRIMARY_KEY}+2`);
    await reopened.locator(".work-desk .board-lane").first().waitFor();
    await expect
      .poll(() => views.getByRole("button", { name: "Work" }).getAttribute("aria-pressed"))
      .toBe("true");
    await expect.poll(() => readBoard(reopened, titles, laneNames)).toEqual(afterTerminal);
  }, 180_000);

  it("starts a Thread on a card with T, which joins its Task, and takes the card off the board with D", async () => {
    const { arranged, laneNames } = await arrangeBoard();
    const { app, page } = await openSignedIn(arranged.url);
    await keepWindowOnTop(app);
    await openWork(page);

    // "Update shipping rates" has no Thread yet, so any Thread on its Task is the one the journey starts.
    const cards = await readBoardCards(arranged);
    const titles = new Map(cards.map((card) => [card.id, card.title]));
    const shippingRates = cards.find((card) => card.title === "Update shipping rates")!;
    const readThreadsOfTask = async () =>
      (
        await arranged.client.session.query({
          query: { taskId: shippingRates.id, kind: "thread", limit: 10 },
        })
      ).items;
    expect(await readThreadsOfTask()).toEqual([]);
    const card = findCard(page, shippingRates.id);
    await card.waitFor();

    // T on the focused card opens the pane with a line for what the Thread
    // should do. Return sends it, and the pane closes.
    await card.focus();
    await page.keyboard.press("t");
    const line = page.getByRole("textbox", { name: "What should this thread do?" });
    await line.fill("Compare the carriers' rates");
    await line.press("Enter");
    await line.waitFor({ state: "detached" });

    // The Thread joined the Task by name, in the Task's Project.
    await expect
      .poll(async () =>
        (await readThreadsOfTask()).map(({ taskId, projectId }) => ({ taskId, projectId })),
      )
      .toEqual([{ taskId: shippingRates.id, projectId: shippingRates.projectId }]);

    // D on the card marks the Task Done. The card leaves the board and
    // nothing else moves.
    await card.focus();
    await page.keyboard.press("d");
    await card.waitFor({ state: "detached" });
    await expect
      .poll(
        async () => (await arranged.client.task.read({ params: { id: shippingRates.id } })).stage,
      )
      .toBe("done");
    await expect
      .poll(() => readBoard(page, titles, laneNames))
      .toEqual({
        "Back office: exploring": ["Reconcile the weekly payouts"],
        "Storefront: exploring": ["Fix the cart total"],
        "Storefront: building": ["Rewrite the returns page"],
        "Storefront: in-review": ["Refresh the sale banner"],
      });
  }, 180_000);
});
