/**
 * Tests the Work screen through the rendered app: the board's reads (once on
 * opening, again on a `task` push, none while the window is hidden), the cards
 * and their three facts, the filter and its chip, folding a lane, the states
 * of an empty board, Add to Work from a lane's `+`, and the offline line. Its
 * second part drives the board with the keyboard alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { BoardStage, Task, WorkBoard, WorkCard } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../app/testing";

// The board stops the paws of a working colleague whose card is out of view.
beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
});

const WEBSHOP = SIDEBAR_FIXTURE.projects[0]!;
const OPS = SIDEBAR_FIXTURE.projects[1]!;

/** Returns a valid id for the Task or session numbered `n`. */
const buildTaskId = (n: number): string => `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

const THREAD_ID = buildTaskId(900);

const CARDS: readonly WorkCard[] = [
  buildCard(buildTaskId(1), {
    title: "Refund emails show the wrong currency",
    projectId: WEBSHOP.id,
    openQuestion: {
      sessionId: THREAD_ID,
      requestId: buildTaskId(901),
      text: "Which currency should win?",
    },
    openSessionId: THREAD_ID,
  }),
  buildCard(buildTaskId(2), {
    title: "Cache delivery slot lookups",
    projectId: WEBSHOP.id,
    stage: "in-review",
    failure: {
      runId: buildTaskId(902),
      workflowName: "Review PR",
      cause: "the branch changed mid-run",
    },
  }),
  buildCard(buildTaskId(3), {
    title: "Order history hides cancelled items",
    projectId: WEBSHOP.id,
    stage: "planned",
  }),
  buildCard(buildTaskId(4), {
    title: "Renew the payment gateway certificate",
    projectId: OPS.id,
    stage: "building",
    workingSessionId: buildTaskId(903),
  }),
  buildCard(buildTaskId(5), { title: "Tidy the depot labels" }),
];

const BOARD_PATH = "GET /api/v1/tasks/board";

/** Counts the board reads in `calls`. */
const countBoardReads = (calls: readonly Call[]): number =>
  calls.filter((call) => `${call.method} ${call.path}` === BOARD_PATH).length;

const buildCreatedTask = (title: string, projectId: string | undefined): Task => ({
  id: buildTaskId(50),
  title,
  description: "",
  status: "open",
  stage: "exploring",
  priority: "normal",
  labels: [],
  ...(projectId === undefined ? {} : { projectId }),
  provenance: [],
  createdAt: "2026-11-02T09:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
  statusChangedAt: "2026-11-02T09:00:00.000Z",
  stageChangedAt: "2026-11-02T09:00:00.000Z",
});

/**
 * Opens the app at Work. `board` is what the controller answers to each read,
 * and `handlers` replace the stub's answers. `hasAnyTask` is what the check
 * for a controller with no Task at all finds.
 */
const openWork = async ({
  board = () => buildBoard(...CARDS),
  hasAnyTask = true,
  handlers = {},
  retryFailedReads = true,
}: {
  readonly board?: () => WorkBoard;
  readonly hasAnyTask?: boolean;
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly retryFailedReads?: boolean;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [BOARD_PATH]: () => ({ body: board() }),
    "GET /api/v1/tasks": {
      body: { items: hasAnyTask ? [buildCreatedTask("Any", undefined)] : [] },
    },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path: "/work",
      retryFailedReads,
    },
  );
  return { calls, ...app };
};

/** Returns the card named `title`: its button, which the screen reader names from its words. */
const getCard = (title: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });

describe("the Work screen", () => {
  it("reads the board once and draws a lane per Project, with each card at its stage", async () => {
    const { calls } = await openWork();

    await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ });
    expect(countBoardReads(calls)).toBe(1);
    const webshop = screen.getByRole("heading", { name: /webshop/ }).closest("section")!;
    expect(
      within(within(webshop).getByRole("group", { name: /^In review/ })).getByRole("button", {
        name: /^Cache delivery slot lookups/,
      }),
    ).toBeTruthy();
    // A card of no Project stands in the last lane.
    const lanes = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(lanes.at(-1)).toContain("No project");
  });

  it("shows what a card asks, what broke, and names it for a screen reader in that order", async () => {
    await openWork();

    const asking = await screen.findByRole("button", {
      name: /^Refund emails show the wrong currency, Which currency should win\?, Exploring/,
    });
    expect(asking.textContent).toContain("Which currency should win?");
    const broken = getCard("Cache delivery slot lookups");
    expect(broken.textContent).toContain("Review PR failed: the branch changed mid-run.");
    expect(
      within(screen.getByRole("heading", { name: /webshop/ })).getByText("1 failed"),
    ).toBeTruthy();
  });

  it("reads the board again on a task push", async () => {
    let title = "Order history hides cancelled items";
    const { calls, live } = await openWork({
      board: () =>
        buildBoard(
          ...CARDS.map((card) => (card.id === buildTaskId(3) ? { ...card, title } : card)),
        ),
    });
    await screen.findByRole("button", { name: /^Order history hides cancelled items/ });
    await live.waitForFirstPushes();
    const before = countBoardReads(calls);

    title = "Order history hides refunded items";
    live.pushInvalidation("task", [buildTaskId(3)]);

    await screen.findByRole("button", { name: /^Order history hides refunded items/ });
    expect(countBoardReads(calls)).toBe(before + 1);
  });

  it("reads nothing while the window is hidden, and reads once when it shows", async () => {
    setVisibility("hidden");
    const { calls } = await openWork();
    await screen.findByLabelText("Loading the board");
    // Give a read that should not happen the time to start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countBoardReads(calls)).toBe(0);

    setVisibility("visible");

    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    expect(countBoardReads(calls)).toBe(1);
  });

  it("opens a card's newest Thread when it is pressed", async () => {
    const user = userEvent.setup();
    const { router } = await openWork();

    await user.click(
      await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${THREAD_ID}`);
    });
  });

  it("says a Task has no Thread yet, and goes nowhere, when a card with no Thread is pressed", async () => {
    const user = userEvent.setup();
    const { router } = await openWork();

    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    expect(await screen.findByText("This Task has no Thread yet.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/work");
  });

  it("narrows the board to the failed cards with the Failed filter, and shows its chip", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });

    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Failed/, hidden: true }));

    expect(screen.getByRole("button", { name: "Remove filter Failed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Tidy the depot labels/ })).toBeNull();
    expect(getCard("Cache delivery slot lookups")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove filter Failed" }));

    expect(screen.getByRole("button", { name: /^Tidy the depot labels/ })).toBeTruthy();
  });

  it("says no Task matches, and keeps the chip, when a filter leaves nothing", async () => {
    const user = userEvent.setup();
    await openWork({ board: () => buildBoard(CARDS[2]!) });
    await screen.findByRole("button", { name: /^Order history hides cancelled items/ });

    await user.click(
      screen.getByRole("menuitemcheckbox", { name: /^With an agent/, hidden: true }),
    );

    expect(await screen.findByText("No Tasks match this filter.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove filter With an agent" })).toBeTruthy();
  });

  it("opens a folded lane while a filter is on, and keeps the fold when it goes", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });

    await user.click(screen.getByRole("button", { name: /^ops/ }));
    expect(screen.queryByRole("button", { name: /^Renew the payment gateway/ })).toBeNull();

    await user.click(
      screen.getByRole("menuitemcheckbox", { name: /^With an agent/, hidden: true }),
    );
    expect(screen.getByRole("button", { name: /^Renew the payment gateway/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove filter With an agent" }));
    expect(screen.queryByRole("button", { name: /^Renew the payment gateway/ })).toBeNull();
  });

  it("keeps a folded lane folded after the screen is opened again", async () => {
    const user = userEvent.setup();
    await openWork();
    await user.click(await screen.findByRole("button", { name: /^ops/ }));
    expect(screen.queryByRole("button", { name: /^Renew the payment gateway/ })).toBeNull();

    cleanup();
    await openWork();

    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    expect(screen.queryByRole("button", { name: /^Renew the payment gateway/ })).toBeNull();
  });

  it("opens the rest of a crowded cell in place with its line", async () => {
    const user = userEvent.setup();
    const crowded = Array.from({ length: 8 }, (_, index) =>
      buildCard(buildTaskId(100 + index), {
        title: `Crowded card ${String(index)}`,
        projectId: OPS.id,
      }),
    );
    await openWork({ board: () => buildBoard(...crowded) });

    expect(await screen.findAllByRole("button", { name: /^Crowded card/ })).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "4 more" }));

    expect(screen.getAllByRole("button", { name: /^Crowded card/ })).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByRole("button", { name: /^Crowded card/ })).toHaveLength(4);
  });

  it("adds a Task to the lane whose plus was pressed, and says where it landed", async () => {
    const user = userEvent.setup();
    const { calls } = await openWork({
      handlers: {
        "POST /api/v1/tasks": (call) => ({
          body: buildCreatedTask(
            (call.body as { title: string }).title,
            (call.body as { projectId?: string }).projectId,
          ),
        }),
      },
    });

    await user.click(await screen.findByRole("button", { name: "Add to ops" }));
    await user.type(screen.getByRole("textbox", { name: "New Task" }), "Label the pallets{Enter}");

    expect(await screen.findByText("Added to Exploring in ops.")).toBeTruthy();
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/v1/tasks");
    expect(created?.body).toEqual({
      title: "Label the pallets",
      description: "",
      stage: "exploring",
      projectId: OPS.id,
    });
  });

  it("says a clear desk is clear, and a controller with no Task yet that nothing is here", async () => {
    await openWork({ board: () => buildBoard(), hasAnyTask: true });
    expect(await screen.findByText("All clear.")).toBeTruthy();

    cleanup();
    await openWork({ board: () => buildBoard(), hasAnyTask: false });
    expect(await screen.findByText("Nothing here yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Start a thread/ })).toBeTruthy();
  });

  it("shows the failure, with a way to try again, when it cannot tell whether any Task exists", async () => {
    let answers = 0;
    await openWork({
      board: () => buildBoard(),
      retryFailedReads: false,
      handlers: {
        "GET /api/v1/tasks": () => {
          answers += 1;
          if (answers === 1) throw new Error("connection refused");
          return { body: { items: [buildCreatedTask("Any", undefined)] } };
        },
      },
    });
    const user = userEvent.setup();

    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("All clear.")).toBeTruthy();
  });

  it("says when the board shows only some of the Tasks", async () => {
    await openWork({ board: () => ({ ...buildBoard(CARDS[2]!), truncated: true }) });

    expect(await screen.findByText(/The board shows the first 1,000 Tasks/)).toBeTruthy();
  });

  it("says since when the controller cannot be reached, in the toolbar", async () => {
    const { live } = await openWork();
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    await live.waitForFirstPushes();

    live.drop();

    expect(await screen.findByText(/^Offline since/)).toBeTruthy();
  });

  it("shows the read's failure with a way to try again when the board cannot be read", async () => {
    let answers = 0;
    await openWork({
      retryFailedReads: false,
      handlers: {
        [BOARD_PATH]: () => {
          answers += 1;
          // The loader reads once, and the screen reads again as it opens.
          if (answers <= 2) throw new Error("connection refused");
          return { body: buildBoard(CARDS[2]!) };
        },
      },
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    ).toBeTruthy();
  });
});

/**
 * Opens Work on a controller whose `task.move` really moves the card, so the
 * board read after a move agrees with it. `listMoves` returns the move
 * requests sent so far.
 */
const openMovableWork = async () => {
  let cards: readonly WorkCard[] = CARDS;
  const moveHandlers = Object.fromEntries(
    CARDS.map((card) => [
      `POST /api/v1/tasks/${card.id}/move`,
      (call: Call) => {
        const { stage = card.stage } = call.body as { stage?: BoardStage };
        cards = cards.map((each) => (each.id === card.id ? { ...each, stage } : each));
        return { body: { ...buildCreatedTask(card.title, undefined), id: card.id, stage } };
      },
    ]),
  );
  const app = await openWork({ board: () => buildBoard(...cards), handlers: moveHandlers });
  const listMoves = (): readonly Call[] =>
    app.calls.filter((call) => call.method === "POST" && call.path.endsWith("/move"));
  return { ...app, listMoves };
};

/** Presses Shift with the key, such as `{ArrowRight}`, in the syntax of `user.keyboard`. */
const withShift = (key: string): string => `{Shift>}${key}{/Shift}`;

describe("the Work screen's keys", () => {
  it("walks the board with the arrows and with H J K L, from where the pointer rests until a key takes over", async () => {
    const user = userEvent.setup();
    await openWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    // The pointer rests on a card: the walk starts there, not at the focused card.
    await user.pointer({
      target: getCard("Order history hides cancelled items"),
      coords: { clientX: 100, clientY: 100 },
    });
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(getCard("Cache delivery slot lookups"));

    // The key has taken over: the next step is from the focused card.
    await user.keyboard("h");
    expect(document.activeElement).toBe(getCard("Order history hides cancelled items"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));
    await user.keyboard("j");
    expect(document.activeElement).toBe(getCard("Tidy the depot labels"));
    await user.keyboard("k");
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));
    // Nothing further to the left: the focus stays.
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));
  });

  it("jumps between lanes with [ and ], and opens the card's Thread with Return", async () => {
    const user = userEvent.setup();
    const { router } = await openWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    await user.keyboard("[[");
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));
    await user.keyboard("]");
    expect(document.activeElement).toBe(getCard("Tidy the depot labels"));
    await user.keyboard("[[{Enter}");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${THREAD_ID}`);
    });
  });

  it("moves a card a stage with Shift and an arrow, keeps focus on it, and puts it back with Undo", async () => {
    const user = userEvent.setup();
    const { listMoves } = await openMovableWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    await user.keyboard(withShift("{ArrowRight}"));

    const planned = screen.getByRole("group", { name: "Planned, 1 card, in No project" });
    const moved = within(planned).getByRole("button", { name: /^Tidy the depot labels/ });
    expect(document.activeElement).toBe(moved);
    expect(await screen.findByText('Moved "Tidy the depot labels" to Planned.')).toBeTruthy();
    await waitFor(() => {
      expect(listMoves()).toHaveLength(1);
    });
    expect(listMoves()[0]).toMatchObject({
      path: `/api/v1/tasks/${buildTaskId(5)}/move`,
      body: { stage: "planned" },
    });

    await user.keyboard("{Meta>}z{/Meta}");

    expect(
      await screen.findByText('Put back: Moved "Tidy the depot labels" to Planned.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(listMoves()).toHaveLength(2);
    });
    expect(listMoves()[1]?.body).toEqual({
      stage: "exploring",
      projectId: null,
      afterTaskId: null,
    });
    expect(
      within(screen.getByRole("group", { name: "Exploring, 1 card, in No project" })).getByRole(
        "button",
        { name: /^Tidy the depot labels/ },
      ),
    ).toBeTruthy();
  });

  it("puts focus on the line that holds the card when a move hides it behind 'landed'", async () => {
    const user = userEvent.setup();
    await openMovableWork();
    await user.click(await screen.findByRole("button", { name: /^Renew the payment gateway/ }));

    await user.keyboard(withShift("{ArrowRight}"));
    await user.keyboard(withShift("{ArrowRight}"));

    expect(screen.queryByRole("button", { name: /^Renew the payment gateway/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "1 landed" }));
  });

  it("moves a card to a stage with 1 to 5, and the Display switch turns the single keys off but not the arrows", async () => {
    const user = userEvent.setup();
    const { listMoves } = await openMovableWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    await user.keyboard("3");
    await waitFor(() => {
      expect(listMoves()).toHaveLength(1);
    });
    expect(listMoves()[0]?.body).toEqual({ stage: "building" });

    await user.click(
      screen.getByRole("menuitemcheckbox", { name: /^Single-key shortcuts/, hidden: true }),
    );
    await user.click(getCard("Tidy the depot labels"));
    // Neither a digit nor A does anything now. The arrow still moves the card, and
    // being the second request shows that the digit sent none.
    await user.keyboard("1");
    await user.keyboard("a");
    await user.keyboard(withShift("{ArrowLeft}"));

    await waitFor(() => {
      expect(listMoves()).toHaveLength(2);
    });
    expect(listMoves()[1]?.body).toEqual({ stage: "planned" });
    expect(screen.queryByRole("textbox", { name: "New Task" })).toBeNull();
  });

  it("opens Add to Work with A, and leaves a key typed in a text field to the field", async () => {
    const user = userEvent.setup();
    const { listMoves } = await openMovableWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    const find = screen.getByRole<HTMLInputElement>("combobox", { name: "Find on the board" });
    await user.click(find);
    await user.keyboard("a1");

    expect(find.value).toBe("a1");
    expect(screen.queryByRole("textbox", { name: "New Task" })).toBeNull();
    expect(listMoves()).toHaveLength(0);

    await user.keyboard("{Escape}");
    await user.click(getCard("Tidy the depot labels"));
    await user.keyboard("a");

    expect(await screen.findByRole("textbox", { name: "New Task" })).toBeTruthy();
  });

  it("acts on the card under the pointer for every key, also when focus is on a card of another lane", async () => {
    const user = userEvent.setup();
    const { listMoves } = await openMovableWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));
    // Focus is on a card in No project, and the pointer rests on a card in ops.
    await user.pointer({
      target: getCard("Renew the payment gateway certificate"),
      coords: { clientX: 100, clientY: 100 },
    });

    await user.keyboard("a");
    expect(await screen.findByText("Starts in Exploring, in ops.")).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.keyboard(withShift("{ArrowRight}"));
    await waitFor(() => {
      expect(listMoves()).toHaveLength(1);
    });
    expect(listMoves()[0]).toMatchObject({
      path: `/api/v1/tasks/${buildTaskId(4)}/move`,
      body: { stage: "in-review" },
    });
  });

  it("folds the current lane with F and every lane with Shift F", async () => {
    const user = userEvent.setup();
    await openWork();
    await user.click(await screen.findByRole("button", { name: /^Renew the payment gateway/ }));

    await user.keyboard("f");

    expect(screen.queryByRole("button", { name: /^Renew the payment gateway/ })).toBeNull();
    const opsHead = screen.getByRole("button", { name: /^ops/ });
    expect(opsHead.getAttribute("aria-expanded")).toBe("false");
    // The card folded away, so focus stays on its lane and a second F opens it again.
    expect(document.activeElement).toBe(opsHead);
    await user.keyboard("f");
    expect(getCard("Renew the payment gateway certificate")).toBeTruthy();

    await user.keyboard(withShift("F"));
    expect(screen.queryByRole("button", { name: /^Tidy the depot labels/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Refund emails/ })).toBeNull();
    await user.keyboard(withShift("F"));
    expect(screen.getByRole("button", { name: /^Tidy the depot labels/ })).toBeTruthy();
  });

  it("steps back one thing at a time with Esc: the keys, then Find, then the filter", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Failed/, hidden: true }));
    await user.click(document.body);

    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keys" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter Failed" })).toBeTruthy();

    const find = screen.getByRole<HTMLInputElement>("combobox", { name: "Find on the board" });
    await user.type(find, "Cache");
    await user.keyboard("{Escape}");
    expect(find.value).toBe("");
    expect(screen.getByRole("button", { name: "Remove filter Failed" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Remove filter Failed" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Tidy the depot labels/ })).toBeTruthy();
  });

  it("walks the Find matches with the arrows, starting again at the first when the text changes", async () => {
    const user = userEvent.setup();
    await openWork();
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    const find = screen.getByRole("combobox", { name: "Find on the board" });

    // Three titles hold "ca": the Cache, the cancelled items and the certificate.
    await user.type(find, "ca");
    expect(find.getAttribute("aria-activedescendant")).toBe(`desk-find-${buildTaskId(2)}`);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(find.getAttribute("aria-activedescendant")).toBe(`desk-find-${buildTaskId(4)}`);
    await user.keyboard("{ArrowDown}");
    expect(find.getAttribute("aria-activedescendant")).toBe(`desk-find-${buildTaskId(4)}`);
    await user.keyboard("{ArrowUp}");
    expect(find.getAttribute("aria-activedescendant")).toBe(`desk-find-${buildTaskId(3)}`);
    // "c" keeps the cancelled items among its matches, but the choice was made for "ca".
    await user.keyboard("{Backspace}");
    expect(find.getAttribute("aria-activedescendant")).toBe(`desk-find-${buildTaskId(1)}`);
  });
});

describe("the Work screen's board changes by themselves", () => {
  it("draws a run that failed, and says so on the toolbar's line", async () => {
    let hasFailed = false;
    const { live } = await openWork({
      board: () =>
        buildBoard(
          ...CARDS.map((card) =>
            card.id === buildTaskId(3) && hasFailed
              ? {
                  ...card,
                  failure: {
                    runId: buildTaskId(910),
                    workflowName: "Deploy",
                    cause: "the build broke",
                  },
                }
              : card,
          ),
        ),
    });
    await screen.findByRole("button", { name: /^Order history hides cancelled items/ });
    await live.waitForFirstPushes();

    hasFailed = true;
    live.pushInvalidation("task", [buildTaskId(3)]);

    expect(await screen.findByText("Deploy failed")).toBeTruthy();
    expect(getCard("Order history hides cancelled items").textContent).toContain(
      "Deploy failed: the build broke.",
    );
  });

  it("draws a Task that arrives in its cell, and says so on the toolbar's line", async () => {
    let hasArrived = false;
    const arrival = buildCard(buildTaskId(60), { title: "Count the pallets", projectId: OPS.id });
    const { live } = await openWork({
      board: () => buildBoard(...CARDS, ...(hasArrived ? [arrival] : [])),
    });
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    await live.waitForFirstPushes();

    hasArrived = true;
    live.pushInvalidation("task", [buildTaskId(60)]);

    expect(await screen.findByText("New: Count the pallets")).toBeTruthy();
    expect(getCard("Count the pallets")).toBeTruthy();
  });

  it("moves nothing for a Task that arrives past the rows its cell shows, and says it arrived", async () => {
    const crowded = Array.from({ length: 8 }, (_, index) =>
      buildCard(buildTaskId(100 + index), {
        title: `Crowded card ${String(index)}`,
        projectId: OPS.id,
      }),
    );
    let hasArrived = false;
    const arrival = buildCard(buildTaskId(110), { title: "Crowded card late", projectId: OPS.id });
    const { live } = await openWork({
      board: () => buildBoard(...crowded, ...(hasArrived ? [arrival] : [])),
    });
    await screen.findByRole("button", { name: "4 more" });
    await live.waitForFirstPushes();

    hasArrived = true;
    live.pushInvalidation("task", [buildTaskId(110)]);

    expect(await screen.findByText("New: Crowded card late")).toBeTruthy();
    expect(screen.getByRole("button", { name: "5 more" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Crowded card late/ })).toBeNull();
  });
});
