/**
 * Tests Blocked by, Blocks and the Initiative of a Task on the Work details
 * pane, through the rendered screen: the rows and "and N more", opening a
 * Task from a row, adding and removing a blocker with Undo, a blocker that
 * would close a loop, and putting the Task on an Initiative.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { Initiative, Task, TaskDetail, WorkCard, WorkCardBlocker } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Answer,
  type Call,
} from "../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
});

const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

const PROJECT_ID = SIDEBAR_FIXTURE.projects[0]!.id;
const CARD = buildCard(buildTaskId(1), { title: "Print depot pick lists", projectId: PROJECT_ID });
const LOYALTY = buildCard(buildTaskId(2), { title: "Round loyalty points", stage: "planned" });
const BASKET = buildCard(buildTaskId(3), { title: "Fix the basket total", stage: "landed" });
const ROTA = buildCard(buildTaskId(4), { title: "Send the depot rota", stage: "building" });
const GIFT = buildCard(buildTaskId(5), { title: "Gift wrap options" });
const RESTOCK = buildCard(buildTaskId(6), { title: "Restock the shelves" });
const BUCKET_ID = buildTaskId(7);
const BOARD_CARDS = [CARD, LOYALTY, BASKET, ROTA, GIFT, RESTOCK];

const TASK_PATH = `/api/v1/tasks/${CARD.id}`;
const ADD_PATH = `POST ${TASK_PATH}/blockers`;
const removePath = (blockerId: string): string => `DELETE ${TASK_PATH}/blockers/${blockerId}`;
const MOVE_PATH = `POST ${TASK_PATH}/move`;

const CHECKOUT: Initiative = {
  id: buildTaskId(901),
  name: "Accessible checkout",
  intent: "",
  hue: 245,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};
const SEARCH: Initiative = { ...CHECKOUT, id: buildTaskId(902), name: "Faster search", hue: 150 };

const toBlocker = (card: WorkCard): WorkCardBlocker => ({
  id: card.id,
  title: card.title,
  stage: card.stage,
});

const buildTask = (card: WorkCard): Task => ({
  id: card.id,
  title: card.title,
  description: "",
  status: "open",
  stage: card.stage,
  priority: "normal",
  labels: [],
  provenance: [],
  createdAt: "2026-11-02T09:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
  statusChangedAt: "2026-11-02T09:00:00.000Z",
  stageChangedAt: "2026-11-02T09:00:00.000Z",
});

const buildDetail = (
  card: WorkCard,
  blockers: readonly WorkCardBlocker[],
  blocks: readonly WorkCardBlocker[],
  totals: { readonly blockerCount?: number; readonly blockCount?: number } = {},
): TaskDetail => ({
  task: buildTask(card),
  card,
  sessions: [],
  sessionCount: 0,
  runs: [],
  runCount: 0,
  blockers,
  blockerCount: totals.blockerCount ?? blockers.length,
  blocks,
  blockCount: totals.blockCount ?? blocks.length,
  entities: [],
  places: [],
  edges: [],
});

/** Lists the Initiative every move of the Task named, oldest first (`null` takes it off). */
const readMovedInitiatives = (calls: readonly Call[]): unknown[] =>
  readBodies(calls, MOVE_PATH).map(
    (body) => (body as { initiativeId?: string | null }).initiativeId,
  );

/** Lists the bodies sent to `path`, oldest first. */
const readBodies = (calls: readonly Call[], path: string): unknown[] =>
  calls.filter((call) => `${call.method} ${call.path}` === path).map((call) => call.body);

const LOOP_MESSAGE =
  "Restock the shelves already waits on this Task, through Round loyalty points.";

/**
 * Opens the pane of "Print depot pick lists". The controller keeps its
 * blockers as state: adding or removing one changes what the next details
 * read answers, and says whether it changed anything.
 *
 * - `blockers` and `blocks` are what the first details read lists, and
 *   `totals` how many there are in all.
 * - `controllerBlockers` is what the controller has, when the first details
 *   read shows something else, as when another client changed them a moment ago.
 * - `refuseAdd` is the answer of every `task.addBlocker` call instead.
 * - `initiativeId` is the Initiative the Task is on.
 * - `answerMove` is the handler of every `task.move` call, to hold an answer
 *   back or refuse it. It gets `accept`, which changes the Initiative the
 *   controller has and answers as the default answer does.
 * - `detail.mode` (on the result) makes the next details reads answer, fail or
 *   never answer.
 */
const openPane = async ({
  blockers = [toBlocker(LOYALTY)],
  blocks = [],
  totals,
  controllerBlockers,
  refuseAdd,
  initiativeId,
  answerMove,
}: {
  readonly blockers?: readonly WorkCardBlocker[];
  readonly blocks?: readonly WorkCardBlocker[];
  readonly totals?: { readonly blockerCount?: number; readonly blockCount?: number };
  readonly controllerBlockers?: readonly WorkCardBlocker[];
  readonly refuseAdd?: { readonly status: number; readonly body: unknown };
  readonly initiativeId?: string;
  readonly answerMove?: (call: Call, accept: (call: Call) => Answer) => Answer | Promise<Answer>;
} = {}) => {
  let current = [...(controllerBlockers ?? blockers)];
  // True until the first change: the details read then shows what the user last saw.
  let isStale = controllerBlockers !== undefined;
  // The Initiative the controller has the Task on: a `task.move` changes it.
  let currentInitiativeId = initiativeId;
  const detail = { mode: "answer" as "answer" | "fail" | "never" };
  const readCard = (): WorkCard =>
    currentInitiativeId === undefined ? CARD : { ...CARD, initiativeId: currentInitiativeId };
  const card: WorkCard = readCard();
  const answerInitiative = (call: Call): Answer => {
    const next = (call.body as { initiativeId?: string | null }).initiativeId;
    if (next !== undefined) currentInitiativeId = next ?? undefined;
    return { body: buildTask(readCard()) };
  };
  const handlers = {
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/tasks/board": () => ({ body: buildBoard(readCard(), ...BOARD_CARDS.slice(1)) }),
    "GET /api/v1/tasks": { body: { items: [] } },
    "GET /api/v1/plugins": { body: [] },
    "GET /api/v1/initiatives": { body: { items: [CHECKOUT, SEARCH] } },
    [`GET ${TASK_PATH}/detail`]: (): Answer | Promise<Answer> => {
      if (detail.mode === "never") return new Promise<Answer>(() => undefined);
      if (detail.mode === "fail") {
        return { status: 500, body: buildErrorBody("internal", "The details could not be read.") };
      }
      return { body: buildDetail(readCard(), isStale ? blockers : current, blocks, totals) };
    },
    [`GET /api/v1/tasks/${LOYALTY.id}/detail`]: {
      body: buildDetail(LOYALTY, [], [toBlocker(CARD)]),
    },
    [MOVE_PATH]: (call: Call) =>
      answerMove === undefined ? answerInitiative(call) : answerMove(call, answerInitiative),
    [ADD_PATH]: (call: Call) => {
      if (refuseAdd !== undefined) return refuseAdd;
      isStale = false;
      const id = (call.body as { blockedByTaskId: string }).blockedByTaskId;
      const added = BOARD_CARDS.find((each) => each.id === id);
      const changed = added !== undefined && !current.some((each) => each.id === id);
      if (changed) current = [...current, toBlocker(added)];
      return { body: { task: buildTask(card), changed } };
    },
    ...Object.fromEntries(
      [...BOARD_CARDS, { id: BUCKET_ID }].map((each) => [
        removePath(each.id),
        () => {
          isStale = false;
          const changed = current.some((entry) => entry.id === each.id);
          current = current.filter((entry) => entry.id !== each.id);
          return { body: { task: buildTask(card), changed } };
        },
      ]),
    ),
  };
  const calls = stubApi(handlers);
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/work" },
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Print depot pick lists/ }));
  const pane = await screen.findByRole("dialog", { name: "Print depot pick lists" });
  return { calls, user, pane, detail, ...app };
};

/** Returns the Initiative menu of `pane`. jsdom has no popover API, so it is always in the page but not in the accessibility tree. */
const readInitiativeMenu = (pane: HTMLElement): HTMLElement =>
  document.getElementById(
    within(pane)
      .getByRole("button", { name: /^Initiative:/ })
      .getAttribute("popovertarget") ?? "",
  )!;

const findBlockedBy = (pane: HTMLElement): Promise<HTMLElement> =>
  within(pane).findByRole("region", { name: "Blocked by" });

describe("Blocked by and Blocks on the details pane", () => {
  it("lists the Tasks in each, with the stage they are at and 'and N more' past the list", async () => {
    const { pane } = await openPane({
      blockers: [
        toBlocker(LOYALTY),
        toBlocker(BASKET),
        { id: BUCKET_ID, title: "Move the old photo bucket", stage: "done" },
      ],
      totals: { blockerCount: 15 },
      blocks: [toBlocker({ ...ROTA })],
    });

    const blockedBy = await findBlockedBy(pane);
    const rows = within(blockedBy).getAllByRole("listitem");

    expect(rows.map((row) => row.textContent)).toEqual([
      "Round loyalty pointsPlanned",
      "Fix the basket totalLanded",
      "Move the old photo bucketDone",
    ]);
    expect(within(blockedBy).getByText("and 12 more")).toBeTruthy();
    expect(within(blockedBy).getByRole("heading").textContent).toBe("Blocked by 15");
    // "Add a blocker" is the section's last row, after the blockers.
    expect(blockedBy.lastElementChild?.textContent).toContain("Add a blocker");
    // A blocker that landed or finished no longer holds the Task back, so it reads quietly.
    expect(rows.map((row) => row.classList.contains("is-quiet"))).toEqual([false, true, true]);
    const blocks = within(pane).getByRole("region", { name: "Blocks" });
    expect(within(blocks).getAllByRole("listitem")[0]!.textContent).toBe(
      "Send the depot rotaBuilding",
    );
    expect(within(blocks).queryByText(/more$/)).toBeNull();
  });

  it("opens a Task at a board stage and leaves a Done Task as plain history", async () => {
    const { pane } = await openPane({
      blockers: [
        toBlocker(LOYALTY),
        { id: BUCKET_ID, title: "Move the old photo bucket", stage: "done" },
      ],
    });
    const blockedBy = await findBlockedBy(pane);

    expect(within(blockedBy).getByRole("button", { name: /^Round loyalty points/ })).toBeTruthy();
    expect(
      within(blockedBy).queryByRole("button", { name: /^Move the old photo bucket/ }),
    ).toBeNull();
    // Even a history row can be removed.
    expect(
      within(blockedBy).getByRole("button", { name: "Stop waiting on Move the old photo bucket" }),
    ).toBeTruthy();
  });

  it("shows the Task a row opens, and Esc goes back to the one it came from before it closes", async () => {
    const { user, pane } = await openPane();
    const blockedBy = await findBlockedBy(pane);

    await user.click(within(blockedBy).getByRole("button", { name: /^Round loyalty points/ }));

    expect(await screen.findByRole("dialog", { name: "Round loyalty points" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("dialog", { name: "Print depot pick lists" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("offers Add a blocker on a Task that waits on nothing, under a Blocked by heading with no count", async () => {
    const { pane } = await openPane({ blockers: [] });

    const blockedBy = await findBlockedBy(pane);

    expect(within(blockedBy).getByRole("button", { name: "Add a blocker" })).toBeTruthy();
    expect(within(blockedBy).getByRole("heading").textContent?.trim()).toBe("Blocked by");
    expect(within(pane).queryByRole("region", { name: "Blocks" })).toBeNull();
  });
});

describe("adding and removing a blocker", () => {
  it("adds the Task a search finds, says so with Undo, and Undo removes it", async () => {
    const { calls, user, pane } = await openPane();
    const blockedBy = await findBlockedBy(pane);

    await user.click(within(blockedBy).getByRole("button", { name: "Add a blocker" }));
    await user.type(within(blockedBy).getByRole("textbox", { name: "Add a blocker" }), "gift");
    await user.click(await within(blockedBy).findByRole("button", { name: /^Gift wrap options/ }));

    expect(readBodies(calls, ADD_PATH)).toEqual([{ blockedByTaskId: GIFT.id }]);
    expect(
      await screen.findByText("Print depot pick lists now waits on Gift wrap options."),
    ).toBeTruthy();
    expect(
      await within(blockedBy).findByRole("button", { name: /^Gift wrap options/ }),
    ).toBeTruthy();
    // The search closed.
    expect(within(blockedBy).getByRole("button", { name: "Add a blocker" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByText("Put back: Made Print depot pick lists wait on Gift wrap options."),
    ).toBeTruthy();
    expect(readBodies(calls, removePath(GIFT.id))).toEqual([undefined]);
  });

  it("does not offer the Task itself or a Task it waits on already", async () => {
    const { user, pane } = await openPane();
    const blockedBy = await findBlockedBy(pane);

    await user.click(within(blockedBy).getByRole("button", { name: "Add a blocker" }));
    await user.type(within(blockedBy).getByRole("textbox", { name: "Add a blocker" }), "r");

    // "r" matches "Round loyalty points" (a blocker already) and "Print depot pick lists" (the Task
    // itself), which are left out, and the three Tasks below, with Landed ones last.
    const found = blockedBy.querySelector<HTMLElement>(".link-search-found")!;
    expect(
      within(found)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Send the depot rotaBuilding",
      "Gift wrap optionsExploring",
      "Restock the shelvesExploring",
    ]);
  });

  it("shows the controller's message under Blocked by when the Task would wait in a loop", async () => {
    const { user, pane } = await openPane({
      refuseAdd: {
        status: 409,
        body: {
          error: {
            code: "invalid_state",
            message: LOOP_MESSAGE,
            details: { reason: "blocker-cycle" },
          },
        },
      },
    });
    const blockedBy = await findBlockedBy(pane);

    await user.click(within(blockedBy).getByRole("button", { name: "Add a blocker" }));
    await user.type(within(blockedBy).getByRole("textbox", { name: "Add a blocker" }), "restock");
    await user.click(
      await within(blockedBy).findByRole("button", { name: /^Restock the shelves/ }),
    );

    expect((await within(blockedBy).findByRole("alert")).textContent).toBe(LOOP_MESSAGE);
    expect(
      await screen.findByText(
        "Print depot pick lists was not made to wait on Restock the shelves.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    // The refusal goes when the user tries something else.
    await user.click(within(blockedBy).getByRole("button", { name: "Add a blocker" }));
    expect(within(blockedBy).getByRole("alert")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Print depot pick lists" })).toBeTruthy();
  });

  it("says why on the undo line when the add is refused for another reason", async () => {
    const { user, pane } = await openPane({
      refuseAdd: { status: 404, body: buildErrorBody("not_found", "That Task does not exist.") },
    });
    const blockedBy = await findBlockedBy(pane);

    await user.click(within(blockedBy).getByRole("button", { name: "Add a blocker" }));
    await user.type(within(blockedBy).getByRole("textbox", { name: "Add a blocker" }), "gift");
    await user.click(await within(blockedBy).findByRole("button", { name: /^Gift wrap options/ }));

    expect(
      await screen.findByText(
        "Print depot pick lists was not made to wait on Gift wrap options: That Task does not exist. Try again.",
      ),
    ).toBeTruthy();
    expect(within(blockedBy).queryByRole("alert")).toBeNull();
  });

  it("removes a blocker, says so with Undo, and Undo adds it again", async () => {
    const { calls, user, pane } = await openPane();
    const blockedBy = await findBlockedBy(pane);

    await user.click(
      within(blockedBy).getByRole("button", { name: "Stop waiting on Round loyalty points" }),
    );

    expect(
      await screen.findByText("Print depot pick lists no longer waits on Round loyalty points."),
    ).toBeTruthy();
    expect(readBodies(calls, removePath(LOYALTY.id))).toEqual([undefined]);
    await waitFor(() => {
      expect(within(blockedBy).queryByRole("button", { name: /^Round loyalty points/ })).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByText(
        "Put back: Took Round loyalty points off what Print depot pick lists waits on.",
      ),
    ).toBeTruthy();
    expect(readBodies(calls, ADD_PATH)).toEqual([{ blockedByTaskId: LOYALTY.id }]);
    expect(
      await within(blockedBy).findByRole("button", { name: /^Round loyalty points/ }),
    ).toBeTruthy();
  });

  it("offers no Undo for removing a blocker the Task no longer had", async () => {
    const { user, pane } = await openPane({ controllerBlockers: [] });
    const blockedBy = await findBlockedBy(pane);

    await user.click(
      within(blockedBy).getByRole("button", { name: "Stop waiting on Round loyalty points" }),
    );

    expect(
      await screen.findByText(
        "Print depot pick lists did not wait on Round loyalty points, so nothing was removed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });
});

describe("the Initiative of a Task on the details pane", () => {
  it("shows the Initiative in the crumbs after the Project, and with its flag in its own row", async () => {
    const { pane } = await openPane({ initiativeId: CHECKOUT.id });

    const row = await within(pane).findByRole("button", {
      name: "Initiative: Accessible checkout",
    });

    expect(row.textContent).toBe("Accessible checkout");
    const crumb = pane.querySelector<HTMLElement>(".task-pane-crumb")!;
    expect(crumb.textContent).toBe(`${SIDEBAR_FIXTURE.projects[0]!.name} · Accessible checkout`);
    expect(row.querySelector(".hue-flag")).not.toBeNull();
  });

  it("says no initiative for a Task on none, and draws no Initiative in the crumbs", async () => {
    const { pane } = await openPane();

    const row = await within(pane).findByRole("button", { name: "Initiative: none" });

    expect(row.textContent).toBe("No initiative");
    expect(pane.querySelector(".task-pane-crumb .hue-flag")).toBeNull();
  });

  it("lists the open Initiatives, then No initiative, then New initiative", async () => {
    const { pane } = await openPane();
    await within(pane).findByRole("button", { name: "Initiative: none" });

    const menu = readInitiativeMenu(pane);

    expect(
      within(menu)
        .getAllByRole("menuitemradio", { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(["Accessible checkout", "Faster search", "No initiative", "New initiative…"]);
  });

  it("opens the Initiative sheet from New initiative, in the Task's Project, and closes the details", async () => {
    const { user, pane } = await openPane();
    await within(pane).findByRole("button", { name: "Initiative: none" });
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "New initiative…", hidden: true }),
    );

    expect(await screen.findByRole("heading", { name: "New initiative" })).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Project" }).value).toBe(
      CARD.projectId,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Print depot pick lists" })).toBeNull();
    });
  });

  it("puts the Task on the Initiative chosen, says so with Undo, and Undo puts it back", async () => {
    const { calls, user, pane } = await openPane({ initiativeId: CHECKOUT.id });
    const row = await within(pane).findByRole("button", {
      name: "Initiative: Accessible checkout",
    });
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Faster search", hidden: true }),
    );

    expect(await screen.findByText("Put Print depot pick lists on Faster search.")).toBeTruthy();
    expect(readMovedInitiatives(calls)).toEqual([SEARCH.id]);
    expect(row.textContent).toBe("Faster search");

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(
      await screen.findByText("Put back: Put Print depot pick lists on Faster search."),
    ).toBeTruthy();
    expect(readMovedInitiatives(calls)).toEqual([SEARCH.id, CHECKOUT.id]);
    await waitFor(() => {
      expect(row.textContent).toBe("Accessible checkout");
    });
  });

  it("takes the Task off its Initiative with No initiative, and sends nothing for the one it is on", async () => {
    const { calls, user, pane } = await openPane({ initiativeId: CHECKOUT.id });
    await within(pane).findByRole("button", { name: "Initiative: Accessible checkout" });
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Accessible checkout", hidden: true }),
    );
    expect(readMovedInitiatives(calls)).toEqual([]);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "No initiative", hidden: true }),
    );

    expect(await screen.findByText("Took Print depot pick lists off its initiative.")).toBeTruthy();
    expect(readMovedInitiatives(calls)).toEqual([null]);
  });

  it("offers no Undo when the Task comes off an Initiative that is closed, which nothing can put it back on", async () => {
    const { calls, user, pane } = await openPane({ initiativeId: buildTaskId(999) });
    await within(pane).findByRole("button", { name: "Initiative: none" });
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "No initiative", hidden: true }),
    );

    expect(
      await screen.findByText("Took Print depot pick lists off its closed initiative."),
    ).toBeTruthy();
    expect(readMovedInitiatives(calls)).toEqual([null]);
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("shows a pick at once and waits with the next pick until the controller has answered the first", async () => {
    const answers: (() => void)[] = [];
    const { calls, user, pane } = await openPane({
      // The Task is on none, and every answer waits until the test lets it through.
      answerMove: (call, accept) =>
        new Promise<Answer>((resolve) => {
          answers.push(() => {
            resolve(accept(call));
          });
        }),
    });
    const row = await within(pane).findByRole("button", { name: "Initiative: none" });
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Faster search", hidden: true }),
    );
    expect(row.textContent).toBe("Faster search");
    // A second pick would start its Undo from a pick that may still be refused.
    expect((row as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    answers[0]!();
    await waitFor(() => {
      expect((row as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Accessible checkout", hidden: true }),
    );
    expect(row.textContent).toBe("Accessible checkout");
    await waitFor(() => {
      expect(answers).toHaveLength(2);
    });
    answers[1]!();
    await user.click(await screen.findByRole("button", { name: /^Undo/ }));
    await waitFor(() => {
      expect(answers).toHaveLength(3);
    });
    answers[2]!();

    await waitFor(() => {
      expect(readMovedInitiatives(calls)).toEqual([
        SEARCH.id,
        CHECKOUT.id,
        // Undo of the second pick puts back Faster search, which the pane showed after the first.
        SEARCH.id,
      ]);
    });
    await waitFor(() => {
      expect(row.textContent).toBe("Faster search");
    });
  });

  it("keeps the menu disabled while a pick is in flight, and Undo of the next pick restores the original Initiative after the first is refused", async () => {
    const answers: (() => void)[] = [];
    let moves = 0;
    const { calls, user, pane } = await openPane({
      initiativeId: CHECKOUT.id,
      // The first pick waits and is then refused; the later moves are accepted.
      answerMove: (call, accept) => {
        moves += 1;
        if (moves > 1) return Promise.resolve(accept(call));
        return new Promise<Answer>((resolve) => {
          answers.push(() => {
            resolve({
              status: 409,
              body: buildErrorBody("invalid_state", "That initiative was closed."),
            });
          });
        });
      },
    });
    const row = (await within(pane).findByRole("button", {
      name: "Initiative: Accessible checkout",
    })) as HTMLButtonElement;
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Faster search", hidden: true }),
    );
    expect(row.textContent).toBe("Faster search");
    expect(row.disabled).toBe(true);

    answers[0]!();
    expect(await screen.findByText(/That initiative was closed\./)).toBeTruthy();
    await waitFor(() => {
      expect(row.disabled).toBe(false);
    });
    expect(row.textContent).toBe("Accessible checkout");
    await user.click(
      within(menu).getByRole("menuitemradio", { name: "No initiative", hidden: true }),
    );
    await user.click(await screen.findByRole("button", { name: /^Undo/ }));

    await waitFor(() => {
      expect(readMovedInitiatives(calls)).toEqual([
        SEARCH.id,
        null,
        // Not Faster search: the first pick was refused, so the Task stayed on Accessible checkout.
        CHECKOUT.id,
      ]);
    });
  });

  it("sends the card back and starts the next pick's Undo from the Initiative the Task is really on, after a refused pick", async () => {
    let moves = 0;
    const { calls, user, pane } = await openPane({
      // The Task is on none. The first pick is refused, the second accepted.
      answerMove: (call, accept) => {
        moves += 1;
        return Promise.resolve(
          moves === 1
            ? {
                status: 409,
                body: buildErrorBody("invalid_state", "That initiative was closed."),
              }
            : accept(call),
        );
      },
    });
    const row = await within(pane).findByRole("button", { name: "Initiative: none" });
    const menu = readInitiativeMenu(pane);

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Faster search", hidden: true }),
    );
    expect(await screen.findByText(/That initiative was closed\./)).toBeTruthy();
    await waitFor(() => {
      expect(row.textContent).toBe("No initiative");
    });
    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Accessible checkout", hidden: true }),
    );
    await user.click(await screen.findByRole("button", { name: /^Undo/ }));

    await waitFor(() => {
      expect(readMovedInitiatives(calls)).toEqual([
        SEARCH.id,
        CHECKOUT.id,
        // Not Faster search: the first pick was refused, so the Task was on none.
        null,
      ]);
    });
  });

  it.each([
    ["fails", "fail"],
    ["never answers", "never"],
  ] as const)(
    "shows the Initiative the controller confirmed and starts the next Undo from it, when the details read after the pick %s",
    async (_name, mode) => {
      const { calls, detail, user, pane } = await openPane();
      const row = await within(pane).findByRole("button", { name: "Initiative: none" });
      const menu = readInitiativeMenu(pane);
      detail.mode = mode;

      await user.click(
        within(menu).getByRole("menuitemradio", { name: "Faster search", hidden: true }),
      );
      await waitFor(() => {
        expect(row.textContent).toBe("Faster search");
      });
      // The menu waits until the controller has answered the first pick.
      await waitFor(() => {
        expect((row as HTMLButtonElement).disabled).toBe(false);
      });
      await user.click(
        within(menu).getByRole("menuitemradio", { name: "Accessible checkout", hidden: true }),
      );
      await waitFor(() => {
        expect(row.textContent).toBe("Accessible checkout");
      });
      await user.click(await screen.findByRole("button", { name: /^Undo/ }));

      await waitFor(() => {
        expect(readMovedInitiatives(calls)).toEqual([
          SEARCH.id,
          CHECKOUT.id,
          // Back to Faster search, which the pane showed, not to none.
          SEARCH.id,
        ]);
      });
      await waitFor(() => {
        expect(row.textContent).toBe("Faster search");
      });
    },
  );

  it("leaves the Initiative the pane shows alone when the pick is refused, even if the details read fails", async () => {
    const { detail, user, pane } = await openPane({
      initiativeId: CHECKOUT.id,
      answerMove: () =>
        Promise.resolve({
          status: 409,
          body: buildErrorBody("invalid_state", "That initiative was closed."),
        }),
    });
    const row = await within(pane).findByRole("button", {
      name: "Initiative: Accessible checkout",
    });
    const menu = readInitiativeMenu(pane);
    detail.mode = "fail";

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Faster search", hidden: true }),
    );

    expect(await screen.findByText(/That initiative was closed\./)).toBeTruthy();
    await waitFor(() => {
      expect(row.textContent).toBe("Accessible checkout");
    });
  });
});
