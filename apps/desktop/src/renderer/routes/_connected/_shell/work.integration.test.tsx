/**
 * Tests the Work screen through the rendered app: the board's reads (once on
 * opening, again on a `task` push, none while the window is hidden), the cards
 * and their three facts, the filter and its chip, folding a lane, the states
 * of an empty board, Add to Work from a lane's `+`, and the offline line. Its
 * second part drives the board with the keyboard alone, and its third part
 * groups the board by an outside place, such as a repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildInbox } from "@hercule/client-core/inbox/testing";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import { buildBoard, buildCard, buildPlace, buildSummary } from "@hercule/client-core/work/testing";
import type {
  BoardStage,
  PluginDetail,
  Task,
  TaskDetail,
  WorkBoard,
  WorkCard,
} from "@hercule/contract";
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
  type Call,
  type Handler,
} from "../../../app/testing";
import { buildPendingIntentsKey, UNDO_WINDOW_MS } from "../../../app/pending-intents";
import { buildWorkViewKey } from "../../../screens/work/work-view-storage";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";

// The ids of the cards that drew, in order. A card's reading for a screen
// reader is built on every draw of that card and nowhere else, so the list
// shows which cards a change drew again.
const drawnCardIds = vi.hoisted(() => [] as string[]);
vi.mock("@hercule/client-core/work", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hercule/client-core/work")>();
  return {
    ...original,
    describeCardForReader: (...args: Parameters<typeof original.describeCardForReader>) => {
      drawnCardIds.push(args[0].id);
      return original.describeCardForReader(...args);
    },
  };
});

// The board stops the paws of a working colleague whose card is out of view.
beforeEach(() => {
  drawnCardIds.length = 0;
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
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
 * for a controller with no Task at all finds. `textGenerationUnavailableReason`
 * is why the controller says Text Generation cannot run, or null when it can.
 */
const openWork = async ({
  board = () => buildBoard(...CARDS),
  hasAnyTask = true,
  textGenerationUnavailableReason = null,
  handlers = {},
  retryFailedReads = true,
  path = "/work",
  platform = "mac",
}: {
  readonly board?: () => WorkBoard;
  readonly hasAnyTask?: boolean;
  readonly textGenerationUnavailableReason?: string | null;
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly retryFailedReads?: boolean;
  readonly path?: string;
  readonly platform?: DesktopPlatform;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [BOARD_PATH]: () => ({ body: board() }),
    "GET /api/v1/controller": {
      body: {
        id: buildTaskId(7000),
        publicKey: "cHVibGljLWtleQ==",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: {
          model: null,
          lastFailure: null,
          unavailableReason: textGenerationUnavailableReason,
        },
      },
    },
    "GET /api/v1/tasks": {
      body: { items: hasAnyTask ? [buildCreatedTask("Any", undefined)] : [] },
    },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer", platform }),
    {
      path,
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

  it("shows a card's summary, or says it is being written, and Find reaches the summary", async () => {
    const user = userEvent.setup();
    await openWork({
      board: () =>
        buildBoard(
          buildCard(buildTaskId(1), {
            title: "Plan the depot move",
            stage: "planned",
            summary: buildSummary("Three designs, depots worried.", {
              standing: "Stuck on the carrier quote.",
              stale: true,
            }),
          }),
          buildCard(buildTaskId(2), { title: "Tidy the depot labels" }),
        ),
    });

    const written = await screen.findByRole("button", {
      name: /^Plan the depot move, Planned, Three designs, depots worried\., /,
    });
    expect(written.textContent).toContain("Three designs, depots worried.");
    const pending = getCard("Tidy the depot labels");
    expect(pending.textContent).toContain("Writing a summary");
    expect(pending.getAttribute("aria-label")).toContain("Summary being written");

    await user.type(screen.getByRole("combobox", { name: "Find on the board" }), "carrier quote");
    expect(screen.queryByRole("button", { name: /^Tidy the depot labels/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Plan the depot move/ })).toBeTruthy();
  });

  it("draws no second line on a card with no summary while Text Generation cannot run", async () => {
    await openWork({
      textGenerationUnavailableReason: "Text generation is off.",
      board: () =>
        buildBoard(
          buildCard(buildTaskId(1), {
            title: "Plan the depot move",
            summary: buildSummary("Three designs, depots worried."),
          }),
          buildCard(buildTaskId(2), { title: "Tidy the depot labels" }),
        ),
    });

    const bare = await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    expect(bare.textContent).not.toContain("Writing a summary");
    expect(bare.getAttribute("aria-label")).not.toContain("Summary being written");
    expect(getCard("Plan the depot move").textContent).toContain("Three designs, depots worried.");
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

  it("draws only the card a board read changed", async () => {
    let title = "Order history hides cancelled items";
    const { live } = await openWork({
      board: () =>
        buildBoard(
          ...CARDS.map((card) => (card.id === buildTaskId(3) ? { ...card, title } : card)),
        ),
    });
    await screen.findByRole("button", { name: /^Order history hides cancelled items/ });
    await live.waitForFirstPushes();
    drawnCardIds.length = 0;

    title = "Order history hides refunded items";
    live.pushInvalidation("task", [buildTaskId(3)]);

    await screen.findByRole("button", { name: /^Order history hides refunded items/ });
    expect(new Set(drawnCardIds)).toEqual(new Set([buildTaskId(3)]));
  });

  it("draws only the two cards that gain or lose the tab stop when another card's details open", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    const other = CARDS[4]!;
    await openWork({
      handlers: {
        [detailPath(task.id)]: { body: buildDetail(task) },
        [detailPath(other.id)]: { body: buildDetail(other) },
      },
    });
    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );
    await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    drawnCardIds.length = 0;

    await user.click(getCard("Tidy the depot labels"));
    await screen.findByRole("dialog", { name: "Tidy the depot labels" });

    // The card that was pressed takes the tab stop from the one pressed before.
    expect(new Set(drawnCardIds)).toEqual(new Set([task.id, other.id]));
  });

  it("keeps the dent on the open Task's card when a read moves the card to another cell", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    let stage: BoardStage = "planned";
    const { live } = await openWork({
      board: () =>
        buildBoard(...CARDS.map((card) => (card.id === task.id ? { ...card, stage } : card))),
      handlers: { [detailPath(task.id)]: { body: buildDetail(task) } },
    });
    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );
    await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    await live.waitForFirstPushes();
    const before = getCard("Order history hides cancelled items");
    expect(before.hasAttribute("data-away")).toBe(true);

    stage = "building";
    live.pushInvalidation("task", [task.id]);

    await waitFor(() => {
      expect(getCard("Order history hides cancelled items").closest("[data-stage]")).not.toBe(
        before.closest("[data-stage]"),
      );
    });
    expect(getCard("Order history hides cancelled items").hasAttribute("data-away")).toBe(true);
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

  it("takes the keyboard focus when Work opens from the sidebar, so the keys act at once", async () => {
    const user = userEvent.setup();
    await openWork({
      handlers: {
        "GET /api/v1/external-entities/inbox": { body: buildInbox([]) },
        "GET /api/v1/external-entities/inbox/count": { body: buildInbox([]).counts },
      },
    });
    await user.click(await screen.findByRole("link", { name: /^Inbox/ }));
    await waitFor(() => {
      expect(document.querySelector(".inbox-desk")).not.toBeNull();
    });

    // The click leaves focus on the sidebar row, which is not the page.
    await user.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("button", { name: /^Tidy the depot labels/ });
    expect(document.activeElement).toBe(document.querySelector(".board-scroll"));
    await user.keyboard("{ArrowDown}");

    expect(document.activeElement?.closest(".desk-card")).not.toBeNull();
  });

  it("jumps between lanes with [ and ], and opens the card's details with Return", async () => {
    const user = userEvent.setup();
    const { router } = await openWork();
    await user.click(await screen.findByRole("button", { name: /^Tidy the depot labels/ }));

    await user.keyboard("[[");
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));
    await user.keyboard("]");
    expect(document.activeElement).toBe(getCard("Tidy the depot labels"));
    await user.keyboard("[[{Enter}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: buildTaskId(1) });
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

// ---------- The details pane ----------

const detailPath = (taskId: string): string => `GET /api/v1/tasks/${taskId}/detail`;

/** Returns the details of `card` as `task.readDetail` answers them. `overrides` change any part. */
const buildDetail = (card: WorkCard, overrides: Partial<TaskDetail> = {}): TaskDetail => ({
  task: {
    ...buildCreatedTask(card.title, card.projectId),
    id: card.id,
    stage: card.stage,
  },
  card,
  sessions: [],
  sessionCount: 0,
  runs: [],
  runCount: 0,
  entities: [],
  places: [],
  edges: [],
  ...overrides,
});

/** Counts the reads of one Task's details in `calls`. */
const countDetailReads = (calls: readonly Call[], taskId: string): number =>
  calls.filter((call) => `${call.method} ${call.path}` === detailPath(taskId)).length;

const SUMMARISED_CARD = buildCard(buildTaskId(1), {
  title: "Refund emails show the wrong currency",
  projectId: WEBSHOP.id,
  summary: buildSummary("Currency is read from the shop.", {
    standing: "The carrier quote is still missing.",
    left: "Ask the finance team which currency wins.",
  }),
});

describe("the Work screen's details pane", () => {
  it("opens from a card with the summary and what is left, reads the Task once, and closes with Esc", async () => {
    const user = userEvent.setup();
    const { calls, router } = await openWork({
      board: () => buildBoard(SUMMARISED_CARD, CARDS[4]!),
      handlers: {
        [detailPath(SUMMARISED_CARD.id)]: {
          body: buildDetail(SUMMARISED_CARD, {
            sessions: [
              {
                id: THREAD_ID,
                title: "Fix the currency",
                role: null,
                kind: "thread",
                status: "idle",
                openRequests: [],
                done: false,
              },
            ],
            sessionCount: 12,
          }),
        },
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
    );

    const pane = await screen.findByRole("dialog", {
      name: "Refund emails show the wrong currency",
    });
    expect(router.state.location.search).toEqual({ task: SUMMARISED_CARD.id });
    expect(await within(pane).findByText("The carrier quote is still missing.")).toBeTruthy();
    expect(within(pane).getByText("Ask the finance team which currency wins.")).toBeTruthy();
    expect(within(pane).getByText(WEBSHOP.name)).toBeTruthy();
    expect(within(pane).getByRole("button", { name: /Fix the currency/ })).toBeTruthy();
    expect(within(pane).getByText("and 11 more")).toBeTruthy();
    expect(within(pane).getByRole("button", { name: /^Done/ })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: /^Drop/ })).toBeTruthy();
    expect(countDetailReads(calls, SUMMARISED_CARD.id)).toBe(1);

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.search).toEqual({});
  });

  it("opens a Thread from its row, and the run from a failure", async () => {
    const user = userEvent.setup();
    const failed = CARDS[1]!;
    const { router } = await openWork({
      handlers: {
        [detailPath(failed.id)]: {
          body: buildDetail(failed, {
            sessions: [
              {
                id: THREAD_ID,
                title: "Cache the slots",
                role: null,
                kind: "thread",
                status: "idle",
                openRequests: [],
                done: false,
              },
            ],
            sessionCount: 1,
          }),
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /^Cache delivery slot lookups/ }));
    const pane = await screen.findByRole("dialog", { name: "Cache delivery slot lookups" });

    expect(
      await within(pane).findByText("Review PR failed: the branch changed mid-run."),
    ).toBeTruthy();
    await user.click(within(pane).getByRole("button", { name: "Open the run" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${failed.failure!.runId}`);
    });
  });

  it("shows a Thread's question with its answers, and opens that Thread", async () => {
    const user = userEvent.setup();
    const asking = CARDS[0]!;
    const { router } = await openWork({
      handlers: {
        [detailPath(asking.id)]: {
          body: buildDetail(asking, {
            sessions: [
              {
                id: THREAD_ID,
                title: "Currencies",
                role: null,
                kind: "thread",
                status: "idle",
                openRequests: [
                  {
                    requestId: asking.openQuestion!.requestId,
                    itemId: "item-1",
                    kind: "question",
                    detail: {
                      questions: [
                        {
                          header: "Currency",
                          question: "Which currency should win?",
                          options: [{ label: "The shop's" }, { label: "The customer's" }],
                          multiSelect: false,
                        },
                      ],
                    },
                  },
                ],
                done: false,
              },
            ],
            sessionCount: 1,
          }),
        },
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
    );
    const pane = await screen.findByRole("dialog", {
      name: "Refund emails show the wrong currency",
    });

    expect(await within(pane).findByRole("button", { name: "The shop's" })).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "The customer's" })).toBeTruthy();
    expect(within(pane).getByRole("textbox", { name: "Your answer" })).toBeTruthy();
    await user.click(within(pane).getByRole("button", { name: "Open thread" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${THREAD_ID}`);
    });
  });

  it("moves the Task when a stage of the path is chosen", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    const { calls } = await openWork({
      handlers: {
        [detailPath(task.id)]: { body: buildDetail(task) },
        [`POST /api/v1/tasks/${task.id}/move`]: () => ({
          body: { ...buildDetail(task).task, stage: "building" },
        }),
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );
    const pane = await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    await user.click(within(pane).getByRole("button", { name: "Building" }));

    await waitFor(() => {
      expect(
        calls.some(
          (call) => call.method === "POST" && call.path === `/api/v1/tasks/${task.id}/move`,
        ),
      ).toBe(true);
    });
  });

  it("moves the Task from the stage path with the keyboard alone", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    const { calls } = await openWork({
      handlers: {
        [detailPath(task.id)]: { body: buildDetail(task) },
        [`POST /api/v1/tasks/${task.id}/move`]: () => ({
          body: { ...buildDetail(task).task, stage: "building" },
        }),
      },
    });
    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );
    const pane = await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    const building = within(pane).getByRole("button", { name: "Building" });

    // The step is a tab stop, and Return on it moves the Task.
    expect(building.tabIndex).toBe(0);
    act(() => {
      building.focus();
    });
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(listCalls(calls, `POST /api/v1/tasks/${task.id}/move`)).toHaveLength(1);
    });
  });

  it("swaps to another card's Task without a second sheet, and reads the new Task once", async () => {
    const user = userEvent.setup();
    const first = CARDS[0]!;
    const second = CARDS[2]!;
    const { calls, router } = await openWork({
      handlers: {
        [detailPath(first.id)]: { body: buildDetail(first) },
        [detailPath(second.id)]: { body: buildDetail(second) },
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
    );
    await screen.findByRole("dialog", { name: "Refund emails show the wrong currency" });
    await user.click(getCard("Order history hides cancelled items"));

    await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(router.state.location.search).toEqual({ task: second.id });
    expect(countDetailReads(calls, second.id)).toBe(1);
  });

  it("reads the open Task again on a derived task push, which the board reads too", async () => {
    const user = userEvent.setup();
    let standing = "Waiting on the carrier.";
    const card = () =>
      buildCard(SUMMARISED_CARD.id, {
        ...SUMMARISED_CARD,
        summary: buildSummary("Currency is read from the shop.", { standing }),
      });
    const { calls, live } = await openWork({
      board: () => buildBoard(card()),
      handlers: { [detailPath(SUMMARISED_CARD.id)]: () => ({ body: buildDetail(card()) }) },
    });
    await user.click(
      await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
    );
    await screen.findByText("Waiting on the carrier.");
    await live.waitForFirstPushes();
    const before = countDetailReads(calls, SUMMARISED_CARD.id);

    standing = "The carrier answered.";
    live.pushInvalidation("task", [SUMMARISED_CARD.id], { derived: true });

    await screen.findByText("The carrier answered.");
    expect(countDetailReads(calls, SUMMARISED_CARD.id)).toBe(before + 1);
  });

  it("replaces the address with the survivor of a merge, keeps the sheet open, and does not read the survivor again", async () => {
    const user = userEvent.setup();
    const merged = CARDS[2]!;
    const survivor = CARDS[0]!;
    const { calls, router } = await openWork({
      handlers: {
        // Reading a merged Task answers with the Task it was merged into.
        [detailPath(merged.id)]: { body: buildDetail(survivor) },
        [detailPath(survivor.id)]: { body: buildDetail(survivor) },
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: survivor.id });
    });
    await screen.findByRole("dialog", { name: "Refund emails show the wrong currency" });
    expect(countDetailReads(calls, survivor.id)).toBe(0);
  });

  it("says a deleted Task is gone, and closes", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    const { router } = await openWork({
      handlers: {
        [detailPath(task.id)]: {
          status: 404,
          body: buildErrorBody("not_found", "no such Task"),
        },
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );

    expect(await screen.findByText("This Task no longer exists.")).toBeTruthy();
    await waitFor(
      () => {
        expect(router.state.location.search).toEqual({});
      },
      { timeout: 4_000 },
    );
  });

  it("says a Task is gone, offers nothing to do to it, and closes when a read after the first finds it deleted", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    let isDeleted = false;
    const { router, live } = await openWork({
      handlers: {
        [detailPath(task.id)]: () =>
          isDeleted
            ? { status: 404, body: buildErrorBody("not_found", "no such Task") }
            : { body: buildDetail(task) },
      },
    });
    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );
    const pane = await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    await within(pane).findByRole("button", { name: /^Done/ });
    await live.waitForFirstPushes();

    isDeleted = true;
    live.pushInvalidation("task", [task.id], { derived: true });

    expect(await screen.findByText("This Task no longer exists.")).toBeTruthy();
    expect(within(pane).queryByRole("button", { name: /^Done/ })).toBeNull();
    expect(within(pane).getByRole("button", { name: "Building" })).toHaveProperty("disabled", true);
    await waitFor(
      () => {
        expect(router.state.location.search).toEqual({});
      },
      { timeout: 4_000 },
    );
  });

  it("keeps the sheet when the read fails, and reads again from its button", async () => {
    const user = userEvent.setup();
    const task = CARDS[2]!;
    let fails = true;
    await openWork({
      retryFailedReads: false,
      handlers: {
        [detailPath(task.id)]: () =>
          fails
            ? { status: 500, body: buildErrorBody("internal", "the controller broke") }
            : { body: buildDetail(task) },
      },
    });

    await user.click(
      await screen.findByRole("button", { name: /^Order history hides cancelled items/ }),
    );
    const pane = await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
    expect(await within(pane).findByText(/Could not read the Task/)).toBeTruthy();

    fails = false;
    await user.click(within(pane).getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(within(pane).queryByText(/Could not read the Task/)).toBeNull();
    });
  });

  it("opens from the address on a reload, with the Task's own title before the details arrive", async () => {
    const task = CARDS[2]!;
    await openWork({
      handlers: { [detailPath(task.id)]: { body: buildDetail(task) } },
      path: `/work?task=${task.id}`,
    });

    await screen.findByRole("dialog", { name: "Order history hides cancelled items" });
  });
});

// ---------- Answering and Trying again from the pane ----------

const RESPOND_PATH = `POST /api/v1/sessions/${THREAD_ID}/respond-to-question`;
const ASKING = CARDS[0]!;
const ASKING_REQUEST_ID = ASKING.openQuestion!.requestId;

/** Returns the Task details of the asking card: one Thread holding its question, with two options. */
const buildAskingDetail = (): TaskDetail =>
  buildDetail(ASKING, {
    sessions: [
      {
        id: THREAD_ID,
        title: "Currencies",
        role: null,
        kind: "thread",
        status: "idle",
        openRequests: [
          {
            requestId: ASKING_REQUEST_ID,
            itemId: "item-1",
            kind: "question",
            detail: {
              questions: [
                {
                  header: "Currency",
                  question: "Which currency should win?",
                  options: [{ label: "The shop's" }, { label: "The customer's" }],
                  multiSelect: false,
                },
              ],
            },
          },
        ],
        done: false,
      },
    ],
    sessionCount: 1,
  });

/** Counts the calls to `route` (such as `POST /api/v1/...`) in `calls`. */
const listCalls = (calls: readonly Call[], route: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === route);

/** The answer of a send the controller takes. */
const ANSWER_TAKEN = {
  body: buildSession({
    id: THREAD_ID,
    permissionProfileId: buildTaskId(960),
    providerAccountId: buildTaskId(961),
    runnerId: buildTaskId(962),
  }),
};

/**
 * Opens Work with the asking card. `respond` answers each send. After the
 * first send it is taken, the board shows the card with no question, as the
 * controller does once the Thread moved on.
 */
const openAsking = async (respond: (attempt: number) => Handler = () => () => ANSWER_TAKEN) => {
  let sends = 0;
  const { openQuestion, ...answered } = ASKING;
  void openQuestion;
  return {
    ...(await openWork({
      board: () => buildBoard(sends > 0 ? answered : ASKING, ...CARDS.slice(1)),
      handlers: {
        [detailPath(ASKING.id)]: () => ({ body: buildAskingDetail() }),
        [RESPOND_PATH]: (call) => {
          sends += 1;
          const handler = respond(sends);
          return typeof handler === "function" ? handler(call) : handler;
        },
      },
    })),
  };
};

/** Opens the asking card's details and returns the pane, once its chips are there. */
const openAskingPane = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.click(
    await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
  );
  const pane = await screen.findByRole("dialog", { name: "Refund emails show the wrong currency" });
  await within(pane).findByRole("textbox", { name: "Your answer" });
  return pane;
};

/** How long the tests wait for an undo window they shortened, in milliseconds. */
const SHORT_WINDOW_MS = 1_500;

/**
 * Makes the undo window of a held answer `SHORT_WINDOW_MS` long, by shortening
 * the one timer of that length. Fake timers cannot be used here: Testing
 * Library's `findBy` and `waitFor` wait on a timer of their own, which a fake
 * clock never fires.
 */
const shortenUndoWindow = (): void => {
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
    ...rest: unknown[]
  ) =>
    realSetTimeout(
      callback,
      delay === UNDO_WINDOW_MS ? SHORT_WINDOW_MS : delay,
      ...rest,
    )) as typeof setTimeout);
};

/** Waits longer than the shortened undo window, so a send that was going to happen has. */
const waitOutUndoWindow = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, SHORT_WINDOW_MS * 2)));

const REFUSED_WHILE_AWAY = {
  status: 409,
  body: { error: { code: "invalid_state", message: "The runner is away." } },
};
const REFUSED_CLOSED = {
  status: 409,
  body: {
    error: {
      code: "invalid_state",
      message: "That question is not open.",
      details: { reason: "request-closed" },
    },
  },
};

describe("answering a question from the details pane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the sheet at once, draws the card as answered, and sends after the undo window", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking();
    const pane = await openAskingPane(user);
    shortenUndoWindow();

    await user.click(within(pane).getByRole("button", { name: "The shop's" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText("Answered “The shop's”.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(getCard("Refund emails show the wrong currency").textContent).not.toContain(
      "Which currency should win?",
    );
    // The card says what was answered while the answer is held, as the drawing does.
    expect(getCard("Refund emails show the wrong currency").textContent).toContain(
      "You said: “The shop's”.",
    );
    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(0);

    await waitFor(
      () => {
        expect(listCalls(calls, RESPOND_PATH)).toHaveLength(1);
      },
      { timeout: SHORT_WINDOW_MS * 2 },
    );
    expect(listCalls(calls, RESPOND_PATH)[0]?.body).toEqual({
      requestId: ASKING_REQUEST_ID,
      answers: { Currency: "The shop's" },
    });
    // The card stays answered once the send ended: the board read after it shows no question.
    await waitFor(() => {
      expect(getCard("Refund emails show the wrong currency").textContent).not.toContain(
        "Which currency should win?",
      );
    });
  });

  it("sends the suggested answer with Return on the card the pane was opened from", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking();
    await openAskingPane(user);
    shortenUndoWindow();
    // The pane ignores a Return pressed just as it showed the Task.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.activeElement).toBe(getCard("Refund emails show the wrong currency"));

    await user.keyboard("{Enter}");

    expect(await screen.findByText("Answered “The shop's”.")).toBeTruthy();
    await waitFor(
      () => {
        expect(listCalls(calls, RESPOND_PATH)).toHaveLength(1);
      },
      { timeout: SHORT_WINDOW_MS * 2 },
    );
  });

  it("sends the words the user typed, and sends nothing when Undo is pressed", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking();
    const pane = await openAskingPane(user);
    shortenUndoWindow();

    await user.type(within(pane).getByRole("textbox", { name: "Your answer" }), "Both{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText("Answered “Both”.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));
    await waitOutUndoWindow();

    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(0);
    expect(screen.getByText("Put back: Answered “Both”.")).toBeTruthy();
    // The question is back on its card.
    expect(getCard("Refund emails show the wrong currency").textContent).toContain(
      "Which currency should win?",
    );
  });

  it("keeps the words, brings the question back, and offers Send again when the send is refused", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking((attempt) =>
      attempt === 1 ? REFUSED_WHILE_AWAY : () => ANSWER_TAKEN,
    );
    const pane = await openAskingPane(user);
    shortenUndoWindow();
    await user.click(within(pane).getByRole("button", { name: "The shop's" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await waitOutUndoWindow();

    await waitFor(() => {
      expect(getCard("Refund emails show the wrong currency").textContent).toContain(
        "Which currency should win?",
      );
    });
    const reopened = await openAskingPane(user);
    expect(within(reopened).getByText("Your answer: “The shop's”")).toBeTruthy();
    expect(within(reopened).getByText("It was not sent: The runner is away.")).toBeTruthy();

    await user.click(within(reopened).getByRole("button", { name: "Send again" }));

    await waitFor(() => {
      expect(listCalls(calls, RESPOND_PATH)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Your answer: “The shop's”")).toBeNull();
    });
  });

  it("says the question is no longer open when Send again is refused for it, and never sends the words again", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openAsking((attempt) =>
      attempt === 1 ? REFUSED_WHILE_AWAY : REFUSED_CLOSED,
    );
    const pane = await openAskingPane(user);
    shortenUndoWindow();
    await user.click(within(pane).getByRole("button", { name: "The shop's" }));
    await waitOutUndoWindow();
    await waitFor(() => {
      expect(getCard("Refund emails show the wrong currency").textContent).toContain(
        "Which currency should win?",
      );
    });
    const reopened = await openAskingPane(user);

    await user.click(within(reopened).getByRole("button", { name: "Send again" }));

    expect(
      await within(reopened).findByText(
        "This question is no longer open, and your answer may have reached it.",
      ),
    ).toBeTruthy();
    expect(within(reopened).getByText("Your answer: “The shop's”")).toBeTruthy();
    expect(within(reopened).queryByRole("button", { name: "Send again" })).toBeNull();
    await waitOutUndoWindow();
    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(2);

    await user.click(within(reopened).getByRole("button", { name: "Discard" }));

    expect(within(reopened).queryByText("Your answer: “The shop's”")).toBeNull();
  });

  it("still sends when the user leaves Work during the undo window", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls, router } = await openAsking();
    const pane = await openAskingPane(user);
    shortenUndoWindow();
    await user.click(within(pane).getByRole("button", { name: "The shop's" }));

    await act(() => router.navigate({ to: "/" }));
    await waitOutUndoWindow();

    await waitFor(() => {
      expect(listCalls(calls, RESPOND_PATH)).toHaveLength(1);
    });
  });

  it("shows an answer left over from a closed app as unsent, and never sends it by itself", async () => {
    const user = userEvent.setup({ delay: null });
    localStorage.setItem(
      buildPendingIntentsKey(CONTROLLER_URL, SIDEBAR_FIXTURE.username),
      JSON.stringify([
        {
          intentId: "left-over",
          kind: "answer",
          taskId: ASKING.id,
          sessionId: THREAD_ID,
          requestId: ASKING_REQUEST_ID,
          answers: { Currency: "The shop's" },
          state: "pending",
          failure: null,
        },
      ]),
    );
    const { calls } = await openAsking();
    shortenUndoWindow();

    const pane = await openAskingPane(user);

    expect(within(pane).getByText("Your answer: “The shop's”")).toBeTruthy();
    expect(within(pane).getByText("The app closed before it was sent.")).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Send again" })).toBeTruthy();
    await waitOutUndoWindow();
    expect(listCalls(calls, RESPOND_PATH)).toHaveLength(0);
  });
});

describe("trying a failed run again from the details pane", () => {
  const FAILED = CARDS[1]!;
  const RERUN_PATH = `POST /api/v1/runs/${FAILED.failure!.runId}/rerun`;
  const UNDO_PATH = `POST /api/v1/tasks/${FAILED.id}/try-again/undo`;
  const NEW_RUN_ID = buildTaskId(950);

  const openFailedPane = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(await screen.findByRole("button", { name: /^Cache delivery slot lookups/ }));
    const pane = await screen.findByRole("dialog", { name: "Cache delivery slot lookups" });
    await within(pane).findByRole("button", { name: /^Try again/ });
    return pane;
  };

  const openFailed = (
    rerun: Handler = { body: { runId: NEW_RUN_ID } },
    undo: Handler = { body: {} },
  ) =>
    openWork({
      handlers: {
        [detailPath(FAILED.id)]: () => ({ body: buildDetail(FAILED) }),
        [RERUN_PATH]: rerun,
        [UNDO_PATH]: undo,
      },
    });

  it("starts the run once however often it is pressed, closes the sheet, and offers Undo", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openFailed();
    const pane = await openFailedPane(user);
    const button = within(pane).getByRole("button", { name: /^Try again/ });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText('Tried again on "Cache delivery slot lookups".')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(listCalls(calls, RERUN_PATH)).toHaveLength(1);
    expect(listCalls(calls, RERUN_PATH)[0]?.body).toEqual({});
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
  });

  it("tries again with Return on the card the pane was opened from, where the focus stays", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openFailed();
    await openFailedPane(user);
    // The pane ignores a Return pressed just as it showed the Task.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.activeElement).toBe(getCard("Cache delivery slot lookups"));

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(listCalls(calls, RERUN_PATH)).toHaveLength(1);
    });
  });

  it("tries again with Return on the title", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openFailed();
    const pane = await openFailedPane(user);
    await new Promise((resolve) => setTimeout(resolve, 300));
    within(pane).getByRole("heading", { name: "Cache delivery slot lookups" }).focus();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(listCalls(calls, RERUN_PATH)).toHaveLength(1);
    });
  });

  it("keeps the lock when the user leaves Work and comes back while the request is on its way", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls, router } = await openFailed(() => new Promise<never>(() => undefined));
    const pane = await openFailedPane(user);
    fireEvent.click(within(pane).getByRole("button", { name: /^Try again/ }));
    await waitFor(() => {
      expect(listCalls(calls, RERUN_PATH)).toHaveLength(1);
    });

    await act(() => router.navigate({ to: "/" }));
    await act(() => router.navigate({ to: "/work", search: { task: FAILED.id } }));
    const reopened = await screen.findByRole("dialog", { name: "Cache delivery slot lookups" });
    fireEvent.click(await within(reopened).findByRole("button", { name: /^Try again/ }));

    await act(() => Promise.resolve());
    expect(listCalls(calls, RERUN_PATH)).toHaveLength(1);
  });

  it.each([
    [
      "puts the failure back",
      { body: { outcome: "restored", stopRequested: true } },
      'Put back: Tried again on "Cache delivery slot lookups".',
    ],
    [
      "says why the Task stays as it is, and that the run was only asked to stop",
      {
        body: {
          outcome: "stopped",
          stopRequested: true,
          reason: "The Task is already done or dropped.",
        },
      },
      'Could not put back: Tried again on "Cache delivery slot lookups". The Task is already done or dropped. The run was asked to stop.',
    ],
    [
      "says the run already ran",
      { body: { outcome: "too-late", stopRequested: false } },
      'Could not put back: Tried again on "Cache delivery slot lookups". The run had already ended, so nothing was put back.',
    ],
  ])("undoes it and %s", async (_name, undo, line) => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openFailed({ body: { runId: NEW_RUN_ID } }, undo);
    const pane = await openFailedPane(user);
    fireEvent.click(within(pane).getByRole("button", { name: /^Try again/ }));

    await user.click(await screen.findByRole("button", { name: /^Undo/ }));

    expect(await screen.findByText(line)).toBeTruthy();
    expect(listCalls(calls, UNDO_PATH)).toHaveLength(1);
    expect(listCalls(calls, UNDO_PATH)[0]?.body).toEqual({ runId: NEW_RUN_ID });
  });

  it.each([
    ["d", "marked Done"],
    ["{Backspace}", "Dropped"],
  ])(
    "refuses %s on the card while the run is still starting, and sends nothing",
    async (key, past) => {
      const user = userEvent.setup({ delay: null });
      const { calls } = await openFailed(() => new Promise<never>(() => undefined));
      const pane = await openFailedPane(user);
      fireEvent.click(within(pane).getByRole("button", { name: /^Try again/ }));
      await waitFor(() => {
        expect(listCalls(calls, RERUN_PATH)).toHaveLength(1);
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      focusCard("Cache delivery slot lookups");

      await user.keyboard(key);

      expect(
        await screen.findByText(
          `"Cache delivery slot lookups" is starting again, so it cannot be ${past} yet. Try again in a moment.`,
        ),
      ).toBeTruthy();
      expect(listCalls(calls, `PATCH /api/v1/tasks/${FAILED.id}`)).toHaveLength(0);
      expect(getCard("Cache delivery slot lookups")).toBeTruthy();
    },
  );

  it("says why the run could not start, and keeps the failure", async () => {
    const user = userEvent.setup({ delay: null });
    await openFailed({
      status: 409,
      body: { error: { code: "invalid_state", message: "The runner is away." } },
    });
    const pane = await openFailedPane(user);

    fireEvent.click(within(pane).getByRole("button", { name: /^Try again/ }));

    expect(
      await screen.findByText(
        'Could not try "Cache delivery slot lookups" again: The runner is away.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });
});

// ---------- Done, Drop, Start a thread, Move a Thread to a new Task ----------

const PACK = buildCard(buildTaskId(201), { title: "Pack the returns", projectId: WEBSHOP.id });
const LABEL = buildCard(buildTaskId(202), { title: "Label the pallets", projectId: WEBSHOP.id });
const WEIGH = buildCard(buildTaskId(203), { title: "Weigh the parcels", projectId: WEBSHOP.id });
const IN_ONE_CELL: readonly WorkCard[] = [PACK, LABEL, WEIGH];

// `task.update` can answer not_found, not invalid_state, so that is the refusal to test.
const TASK_GONE = { status: 404, body: buildErrorBody("not_found", "The Task no longer exists.") };

/** Returns a Thread whose ids the contract accepts, which a read decodes. */
const buildDecodableThread = (over: Parameters<typeof buildSession>[0]) =>
  buildSession({
    providerAccountId: buildTaskId(960),
    permissionProfileId: buildTaskId(961),
    runnerId: buildTaskId(962),
    ...over,
  });

const SPAWNED_THREAD = buildDecodableThread({ id: buildTaskId(910) });

/** Returns `calls` to `route` with a body, such as `PATCH /api/v1/tasks/<id>`, as the bodies they sent. */
const readBodies = (calls: readonly Call[], route: string): readonly unknown[] =>
  listCalls(calls, route).map((call) => call.body);

/** Focuses the card named `title`, as the arrow keys would, so single keys act on it. */
const focusCard = (title: string): void => {
  act(() => {
    getCard(title).focus();
  });
};

/**
 * Opens Work with three Tasks in one cell on a controller that really ends and
 * moves them, so the board read after a change agrees with it. `refuseEnd`
 * makes `task.update` refuse. `threads` are the Threads each Task has, newest
 * first, for the details and for the read of the newest Thread.
 */
const openEndable = async ({
  refuseEnd = false,
  sessions = [],
  workspace = null,
  handlers = {},
  platform = "mac",
}: {
  readonly platform?: DesktopPlatform;
  readonly refuseEnd?: boolean;
  readonly sessions?: ReturnType<typeof buildSession>[];
  readonly workspace?: ReturnType<typeof buildWorkspace> | null;
  readonly handlers?: Readonly<Record<string, Handler>>;
} = {}) => {
  let cards: readonly WorkCard[] = IN_ONE_CELL;
  const sidebarSessions = buildSidebarHandlers(SIDEBAR_FIXTURE)["GET /api/v1/sessions"]!;
  const taskHandlers: Record<string, Handler> = {
    "GET /api/v1/sessions": (call) =>
      new URLSearchParams(call.search).get("taskId") === null
        ? typeof sidebarSessions === "function"
          ? sidebarSessions(call)
          : sidebarSessions
        : { body: { items: sessions } },
    "POST /api/v1/sessions": { body: SPAWNED_THREAD },
  };
  if (workspace !== null) {
    taskHandlers[`GET /api/v1/workspaces/${workspace.id}`] = { body: workspace };
  }
  for (const card of IN_ONE_CELL) {
    const toTask = (stage: BoardStage | "done") => ({
      ...buildCreatedTask(card.title, WEBSHOP.id),
      id: card.id,
      stage,
    });
    taskHandlers[`PATCH /api/v1/tasks/${card.id}`] = () => {
      if (refuseEnd) return TASK_GONE;
      cards = cards.filter((each) => each.id !== card.id);
      return { body: toTask("done") };
    };
    taskHandlers[`POST /api/v1/tasks/${card.id}/move`] = (call) => {
      const { afterTaskId } = call.body as { afterTaskId?: string | null };
      const others = cards.filter((each) => each.id !== card.id);
      const index =
        afterTaskId == null ? 0 : others.findIndex((each) => each.id === afterTaskId) + 1;
      cards = [...others.slice(0, index), card, ...others.slice(index)];
      return { body: toTask("exploring") };
    };
    taskHandlers[detailPath(card.id)] = {
      body: buildDetail(card, {
        sessions: sessions.map((session) => ({
          id: session.id,
          title: session.title,
          role: null,
          kind: "thread",
          status: "idle",
          openRequests: [],
          done: false,
        })),
        sessionCount: sessions.length,
      }),
    };
  }
  const app = await openWork({
    board: () => buildBoard(...cards),
    handlers: { ...taskHandlers, ...handlers },
    platform,
  });
  return { ...app, getBoardCards: () => cards };
};

describe("marking a Task Done or Dropped", () => {
  it("marks a Task Done from the pane's foot, closes the pane, and Undo puts it back in the same place", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await user.click(await screen.findByRole("button", { name: /^Label the pallets/ }));
    const pane = await screen.findByRole("dialog", { name: "Label the pallets" });

    await user.click(within(pane).getByRole("button", { name: /^Done/ }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^Label the pallets/ })).toBeNull();
    expect(
      screen.getByText('Marked "Label the pallets" Done. It has left the board.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(readBodies(calls, `PATCH /api/v1/tasks/${LABEL.id}`)).toEqual([{ stage: "done" }]);
    });

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(await screen.findByRole("button", { name: /^Label the pallets/ })).toBeTruthy();
    expect(screen.getByText('Put back: Marked "Label the pallets" Done.')).toBeTruthy();
    await waitFor(() => {
      expect(readBodies(calls, `POST /api/v1/tasks/${LABEL.id}/move`)).toEqual([
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: PACK.id },
      ]);
    });
    const cell = screen.getByRole("group", { name: /^Exploring, 3 cards/ });
    expect(
      within(cell)
        .getAllByRole("button")
        .map((card) => card.textContent?.slice(0, 8)),
    ).toEqual(["Pack the", "Label th", "Weigh th"]);
  });

  it("marks the focused card Done with D and Dropped with Backspace, without opening the pane, and moves focus to its neighbour", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("d");

    await waitFor(() => {
      expect(readBodies(calls, `PATCH /api/v1/tasks/${LABEL.id}`)).toEqual([{ stage: "done" }]);
    });
    expect(screen.queryByRole("button", { name: /^Label the pallets/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(getCard("Weigh the parcels"));

    await user.keyboard("{Backspace}");

    await waitFor(() => {
      expect(readBodies(calls, `PATCH /api/v1/tasks/${WEIGH.id}`)).toEqual([{ stage: "dropped" }]);
    });
    expect(screen.queryByRole("button", { name: /^Weigh the parcels/ })).toBeNull();
    expect(screen.getByText('Dropped "Weigh the parcels". It has left the board.')).toBeTruthy();
    expect(document.activeElement).toBe(getCard("Pack the returns"));
  });

  it("drops a Task from the pane's foot and Undo returns it", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await user.click(await screen.findByRole("button", { name: /^Weigh the parcels/ }));
    const pane = await screen.findByRole("dialog", { name: "Weigh the parcels" });

    await user.click(within(pane).getByRole("button", { name: /^Drop/ }));

    await waitFor(() => {
      expect(readBodies(calls, `PATCH /api/v1/tasks/${WEIGH.id}`)).toEqual([{ stage: "dropped" }]);
    });
    expect(screen.queryByRole("button", { name: /^Weigh the parcels/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(await screen.findByRole("button", { name: /^Weigh the parcels/ })).toBeTruthy();
    await waitFor(() => {
      expect(readBodies(calls, `POST /api/v1/tasks/${WEIGH.id}/move`)).toEqual([
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: LABEL.id },
      ]);
    });
  });

  it("brings the card back and says why, with no Undo, when the controller refuses", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable({ refuseEnd: true });
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("d");

    expect(
      await screen.findByText(
        'Marking "Label the pallets" Done did not save, so the card came back: The Task no longer exists. Try again.',
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Label the pallets/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("leaves D and Backspace to the Find field", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await screen.findByRole("button", { name: /^Label the pallets/ });

    await user.click(screen.getByRole("combobox", { name: "Find on the board" }));
    await user.keyboard("d{Backspace}");

    expect(listCalls(calls, `PATCH /api/v1/tasks/${LABEL.id}`)).toHaveLength(0);
  });
});

describe("starting a Thread on a Task", () => {
  const NEWEST = buildDecodableThread({
    id: buildTaskId(920),
    title: "Earlier thread",
    workspaceId: buildTaskId(930),
    runnerId: buildTaskId(931),
    taskId: LABEL.id,
  });
  const READY_WORKSPACE = buildWorkspace({
    id: buildTaskId(930),
    runnerId: buildTaskId(931),
    status: "ready",
  });

  /** Presses T on the card "Label the pallets", types `words` on the line that opens, and presses Return. */
  const startFromKey = async (
    user: ReturnType<typeof userEvent.setup>,
    words: string,
  ): Promise<void> => {
    focusCard("Label the pallets");
    await user.keyboard("t");
    const line = await screen.findByRole("textbox", { name: "What should this thread do?" });
    await user.type(line, `${words}{Enter}`);
  };

  it("asks what the thread should do before anything starts, then starts it on the Task and stays on Work", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls, router } = await openEndable({
      sessions: [NEWEST],
      workspace: READY_WORKSPACE,
    });
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("t");

    const line = await screen.findByRole("textbox", { name: "What should this thread do?" });
    expect(document.activeElement).toBe(line);
    expect(listCalls(calls, "POST /api/v1/sessions")).toHaveLength(0);

    await user.type(line, "Check the carrier labels{Enter}");

    await waitFor(() => {
      expect(readBodies(calls, "POST /api/v1/sessions")).toEqual([
        {
          prompt: "Check the carrier labels",
          taskId: LABEL.id,
          projectId: WEBSHOP.id,
          runnerId: READY_WORKSPACE.runnerId,
          workspace: { kind: "existing", workspaceId: READY_WORKSPACE.id },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(await screen.findByText('A thread started on "Label the pallets".')).toBeTruthy();
    expect(router.state.location.pathname).toBe("/work");
  });

  it("starts from the pane's foot too, and Esc takes the line back without starting", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await user.click(await screen.findByRole("button", { name: /^Label the pallets/ }));
    const pane = await screen.findByRole("dialog", { name: "Label the pallets" });

    await user.click(within(pane).getByRole("button", { name: /^Start a thread/ }));
    const line = within(pane).getByRole("textbox", { name: "What should this thread do?" });
    expect(within(pane).queryByRole("button", { name: /^Done/ })).toBeNull();
    await user.type(line, "Never mind{Escape}");

    expect(within(pane).queryByRole("textbox")).toBeNull();
    expect(within(pane).getByRole("button", { name: /^Done/ })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Label the pallets" })).toBeTruthy();
    expect(listCalls(calls, "POST /api/v1/sessions")).toHaveLength(0);
  });

  it("sends nothing for an empty line", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("t");
    await user.type(
      await screen.findByRole("textbox", { name: "What should this thread do?" }),
      "   {Enter}",
    );

    expect(listCalls(calls, "POST /api/v1/sessions")).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "What should this thread do?" })).toBeTruthy();
  });

  it("starts in the workspace of the Task's newest session even when that is not a Thread", async () => {
    const user = userEvent.setup({ delay: null });
    const sidebarSessions = buildSidebarHandlers(SIDEBAR_FIXTURE)["GET /api/v1/sessions"]!;
    const { calls } = await openEndable({
      workspace: READY_WORKSPACE,
      handlers: {
        // Only a read that does not ask for Threads alone finds the run's session.
        "GET /api/v1/sessions": (call) => {
          const query = new URLSearchParams(call.search);
          if (query.get("taskId") === null) {
            return typeof sidebarSessions === "function" ? sidebarSessions(call) : sidebarSessions;
          }
          return { body: { items: query.get("kind") === null ? [NEWEST] : [] } };
        },
      },
    });
    await screen.findByRole("button", { name: /^Label the pallets/ });

    await startFromKey(user, "Check the carrier labels");

    await waitFor(() => {
      expect(readBodies(calls, "POST /api/v1/sessions")).toEqual([
        {
          prompt: "Check the carrier labels",
          taskId: LABEL.id,
          projectId: WEBSHOP.id,
          runnerId: READY_WORKSPACE.runnerId,
          workspace: { kind: "existing", workspaceId: READY_WORKSPACE.id },
        },
      ]);
    });
  });

  it("starts without a workspace and says so when the newest Thread's workspace is no longer ready", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable({
      sessions: [NEWEST],
      workspace: { ...READY_WORKSPACE, status: "lost" },
    });
    await screen.findByRole("button", { name: /^Label the pallets/ });

    await startFromKey(user, "Check the carrier labels");

    await waitFor(() => {
      expect(readBodies(calls, "POST /api/v1/sessions")).toEqual([
        { prompt: "Check the carrier labels", taskId: LABEL.id, projectId: WEBSHOP.id },
      ]);
    });
    expect(
      await screen.findByText(
        'A thread started on "Label the pallets". The workspace of its last thread is no longer available, so the new thread started without one.',
      ),
    ).toBeTruthy();
  });

  it("says why when the controller refuses to start the thread", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable({
      handlers: {
        "POST /api/v1/sessions": {
          status: 409,
          body: buildErrorBody("invalid_state", "The Task is finished."),
        },
      },
    });
    await screen.findByRole("button", { name: /^Label the pallets/ });

    await startFromKey(user, "Check the carrier labels");

    expect(
      await screen.findByText(
        'Could not start a thread on "Label the pallets": The Task is finished. Your words are back in the pane.',
      ),
    ).toBeTruthy();
    // The pane closed when the words were sent. It opens again with the line holding them.
    const line = await screen.findByRole("textbox", { name: "What should this thread do?" });
    expect((line as HTMLInputElement).value).toBe("Check the carrier labels");
    expect(screen.getByRole("dialog", { name: "Label the pallets" })).toBeTruthy();
  });
});

describe("moving a Thread to a new Task", () => {
  const MISPLACED = buildDecodableThread({ id: buildTaskId(940), title: "Fix the labels" });
  const MOVE_PATH = `POST /api/v1/sessions/${MISPLACED.id}/move-to-task`;

  /** Opens the pane of "Label the pallets" and presses "Move to a new Task" on the Thread's row. */
  const askToMove = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    await user.click(await screen.findByRole("button", { name: /^Label the pallets/ }));
    const pane = await screen.findByRole("dialog", { name: "Label the pallets" });
    await user.click(
      // The button shows when the row is hovered or focused, which the stylesheet decides, so it has no accessible name here.
      await within(pane).findByText("Move to a new Task"),
    );
    return pane;
  };

  it("says the next thread still joins the old Task before it moves anything, and moves on the second press", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable({
      sessions: [MISPLACED],
      handlers: { [MOVE_PATH]: { body: { ...MISPLACED, taskId: buildTaskId(950) } } },
    });

    const pane = await askToMove(user);

    expect(
      within(pane).getByText('The next thread here still joins "Label the pallets".'),
    ).toBeTruthy();
    expect(listCalls(calls, MOVE_PATH)).toHaveLength(0);

    await user.click(within(pane).getByRole("button", { name: "Move" }));

    await waitFor(() => {
      expect(readBodies(calls, MOVE_PATH)).toEqual([{}]);
    });
    expect(await screen.findByText("Moved the thread to a new Task.")).toBeTruthy();
    expect(within(pane).queryByText(/still joins/)).toBeNull();
  });

  it("offers the move on a Thread and not on an Agent or run session", async () => {
    const user = userEvent.setup({ delay: null });
    const row = (id: number, title: string, kind: "thread" | "agent" | "run") => ({
      id: buildTaskId(id),
      title,
      role: null,
      kind,
      status: "idle" as const,
      openRequests: [],
      done: false,
    });
    await openEndable({
      handlers: {
        [detailPath(LABEL.id)]: {
          body: buildDetail(LABEL, {
            sessions: [
              row(941, "Fix the labels", "thread"),
              row(942, "Nightly import", "agent"),
              row(943, "Review PR step", "run"),
            ],
            sessionCount: 3,
          }),
        },
      },
    });

    await user.click(await screen.findByRole("button", { name: /^Label the pallets/ }));
    const pane = await screen.findByRole("dialog", { name: "Label the pallets" });
    await within(pane).findByText("Nightly import");

    expect(within(pane).getAllByText("Move to a new Task")).toHaveLength(1);
  });

  it("moves nothing when Esc takes the question back, and keeps the pane open", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable({ sessions: [MISPLACED] });
    const pane = await askToMove(user);

    await user.keyboard("{Escape}");

    expect(within(pane).queryByText(/still joins/)).toBeNull();
    expect(screen.getByRole("dialog", { name: "Label the pallets" })).toBeTruthy();
    expect(listCalls(calls, MOVE_PATH)).toHaveLength(0);
  });

  it("shows the controller's words when it refuses to move the thread", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable({
      sessions: [MISPLACED],
      handlers: {
        [MOVE_PATH]: {
          status: 409,
          body: buildErrorBody("invalid_state", "Only a Thread can move to another Task."),
        },
      },
    });
    const pane = await askToMove(user);

    await user.click(within(pane).getByRole("button", { name: "Move" }));

    expect(
      await screen.findByText(
        "Could not move the thread to a new Task: Only a Thread can move to another Task.",
      ),
    ).toBeTruthy();
  });
});

// ---------- Merging two cards ----------

describe("merging two cards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Opens Work with three Tasks in one cell on a controller that merges the Task in the path into `intoTaskId`, or refuses with `refusal`. */
  const openMergeable = async ({ refusal }: { readonly refusal?: string } = {}) => {
    let cards: readonly WorkCard[] = IN_ONE_CELL;
    const handlers: Record<string, Handler> = {};
    for (const card of IN_ONE_CELL) {
      handlers[`POST /api/v1/tasks/${card.id}/merge`] = (call) => {
        if (refusal !== undefined) {
          return { status: 409, body: buildErrorBody("invalid_state", refusal) };
        }
        const { intoTaskId } = call.body as { intoTaskId: string };
        cards = cards.filter((each) => each.id !== card.id);
        const survivor = cards.find((each) => each.id === intoTaskId)!;
        return { body: { ...buildCreatedTask(survivor.title, WEBSHOP.id), id: survivor.id } };
      };
      handlers[detailPath(card.id)] = { body: buildDetail(card) };
    }
    const app = await openWork({ board: () => buildBoard(...cards), handlers });
    return app;
  };

  /** Picks the card "Label the pallets" with `M`, walks down to "Weigh the parcels", and presses Return. */
  const mergeLabelIntoWeigh = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");
    await user.keyboard("m");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
  };

  it("picks with M, walks with the arrows, and Return holds the merge: the card leaves, and task.merge is sent after the undo window", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openMergeable();
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");
    shortenUndoWindow();

    await user.keyboard("m");
    expect(screen.getByText(/^Pick the card to merge this into/)).toBeTruthy();
    expect(getCard("Label the pallets").hasAttribute("data-merge-source")).toBe(true);
    await user.keyboard("{ArrowDown}");
    // The card the walk reached says whom it is merged into, and what stays.
    expect(getCard("Weigh the parcels").dataset["mergeLabel"]).toBe("Merge into Weigh the parcels");
    expect(getCard("Weigh the parcels").dataset["mergeKeeps"]).toBe(
      "Keeps its title, stage and place",
    );
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("button", { name: /^Label the pallets/ })).toBeNull();
    expect(screen.getByText('Merged into "Weigh the parcels".')).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(getCard("Weigh the parcels").hasAttribute("data-merge-target")).toBe(false);
    expect(document.querySelector(".work-desk")?.hasAttribute("data-merge-picking")).toBe(false);
    expect(listCalls(calls, `POST /api/v1/tasks/${LABEL.id}/merge`)).toHaveLength(0);

    await waitFor(
      () => {
        expect(readBodies(calls, `POST /api/v1/tasks/${LABEL.id}/merge`)).toEqual([
          { intoTaskId: WEIGH.id },
        ]);
      },
      { timeout: SHORT_WINDOW_MS * 2 },
    );
    // The survivor stays where it was, and the source stays gone once the board is read again.
    await waitOutUndoWindow();
    expect(screen.queryByRole("button", { name: /^Label the pallets/ })).toBeNull();
    expect(getCard("Weigh the parcels")).toBeTruthy();
  });

  it("sends nothing, and the card comes back, when Undo is pressed in the window", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openMergeable();
    shortenUndoWindow();
    await mergeLabelIntoWeigh(user);
    expect(screen.queryByRole("button", { name: /^Label the pallets/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));
    await waitOutUndoWindow();

    expect(getCard("Label the pallets")).toBeTruthy();
    expect(
      screen.getByText('Put back: Merged "Label the pallets" into "Weigh the parcels".'),
    ).toBeTruthy();
    expect(listCalls(calls, `POST /api/v1/tasks/${LABEL.id}/merge`)).toHaveLength(0);
  });

  it("brings the card back and shows the controller's words when task.merge is refused", async () => {
    const user = userEvent.setup({ delay: null });
    await openMergeable({ refusal: "Those Tasks have 20 labels together. Remove some first." });
    shortenUndoWindow();
    await mergeLabelIntoWeigh(user);

    await waitOutUndoWindow();

    expect(
      await screen.findByText(
        'The merge did not happen, so "Label the pallets" is back on the board: Those Tasks have 20 labels together. Remove some first.',
      ),
    ).toBeTruthy();
    expect(getCard("Label the pallets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("starts from the pane's Merge: the pane closes and a card is picked", async () => {
    const user = userEvent.setup({ delay: null });
    await openMergeable();
    await user.click(await screen.findByRole("button", { name: /^Label the pallets/ }));
    const pane = await screen.findByRole("dialog", { name: "Label the pallets" });

    await user.click(within(pane).getByRole("button", { name: /^Merge/ }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText(/^Pick the card to merge this into/)).toBeTruthy();
    expect(getCard("Label the pallets").hasAttribute("data-merge-source")).toBe(true);
  });

  it("cancels the pick on Esc, and merges nothing", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openMergeable();
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("m");
    // No other key means anything while a card is picked.
    await user.keyboard("d");
    await user.keyboard("{Escape}");

    expect(getCard("Label the pallets").hasAttribute("data-merge-source")).toBe(false);
    expect(document.querySelector(".work-desk")?.hasAttribute("data-merge-picking")).toBe(false);
    expect(listCalls(calls, `PATCH /api/v1/tasks/${LABEL.id}`)).toHaveLength(0);
    expect(screen.queryByText(/^Merged into/)).toBeNull();
  });

  it("says a merge the app closed on was not sent, shows the card, and never sends it by itself", async () => {
    localStorage.setItem(
      buildPendingIntentsKey(CONTROLLER_URL, SIDEBAR_FIXTURE.username),
      JSON.stringify([
        {
          intentId: "left-over",
          kind: "merge",
          taskId: LABEL.id,
          intoTaskId: WEIGH.id,
          state: "pending",
          failure: null,
        },
      ]),
    );
    const { calls } = await openMergeable();
    shortenUndoWindow();

    expect(
      await screen.findByText(
        'The merge did not happen, so "Label the pallets" is back on the board: The app closed before this was sent.',
      ),
    ).toBeTruthy();
    expect(getCard("Label the pallets")).toBeTruthy();
    await waitOutUndoWindow();
    expect(listCalls(calls, `POST /api/v1/tasks/${LABEL.id}/merge`)).toHaveLength(0);
  });

  it("merges nothing when Return is pressed on the picked card itself", async () => {
    const user = userEvent.setup({ delay: null });
    await openMergeable();
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("m");
    await user.keyboard("{Enter}");

    expect(getCard("Label the pallets").hasAttribute("data-merge-source")).toBe(false);
    expect(screen.queryByText(/^Merged into/)).toBeNull();
  });
});

// ---------- Selecting several cards ----------

/** Returns the bar over the board that offers Done, Drop and Clear for the selected cards. */
const getSelectionBar = (): HTMLElement => screen.getByRole("toolbar", { hidden: true });

/** Returns whether the selection bar is shown: it is in the page at all times and fades out. */
const isSelectionBarShown = (): boolean => getSelectionBar().classList.contains("is-on");

/** Returns the titles of the cards of the one cell, top to bottom. */
const readCellTitles = (): readonly string[] =>
  within(screen.getByRole("group", { name: /^Exploring/ }))
    .getAllByRole("button")
    .map((card) => card.textContent?.slice(0, 8) ?? "");

describe("selecting several cards", () => {
  it("marks the focused card with X, counts the marked cards on a bar, and Esc clears them", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    expect(isSelectionBarShown()).toBe(false);
    // Until a card is marked, no card says whether it is pressed.
    expect(getCard("Pack the returns").hasAttribute("aria-pressed")).toBe(false);

    focusCard("Pack the returns");
    await user.keyboard("x");

    expect(getCard("Pack the returns").getAttribute("aria-pressed")).toBe("true");
    expect(getCard("Label the pallets").getAttribute("aria-pressed")).toBe("false");
    // The marked card has its ring, and every card keeps a check ready, which the marked one shows.
    expect(getCard("Pack the returns").classList.contains("is-selected")).toBe(true);
    expect(getCard("Label the pallets").classList.contains("is-selected")).toBe(false);
    expect(getCard("Pack the returns").querySelector(".card-check")).not.toBeNull();
    expect(isSelectionBarShown()).toBe(true);
    expect(getSelectionBar().textContent).toContain("1 selected");
    // One card needs no hint about carrying them all.
    expect(getSelectionBar().textContent).not.toContain("Drag any of them");

    focusCard("Weigh the parcels");
    await user.keyboard("x");

    expect(getSelectionBar().textContent).toContain("2 selected");
    expect(getSelectionBar().textContent).toContain("Drag any of them to move them all");

    // X on a marked card takes the mark off.
    await user.keyboard("x");
    expect(getSelectionBar().textContent).toContain("1 selected");
    await user.keyboard("x");
    await user.keyboard("{Escape}");

    expect(isSelectionBarShown()).toBe(false);
    expect(getCard("Pack the returns").hasAttribute("aria-pressed")).toBe(false);
    expect(getCard("Weigh the parcels").hasAttribute("aria-pressed")).toBe(false);
  });

  it("marks a card with ⌘-click on a Mac, and opens the pane for a plain click", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable();
    const pack = await screen.findByRole("button", { name: /^Pack the returns/ });

    await user.keyboard("{Meta>}");
    await user.click(pack);
    await user.click(getCard("Weigh the parcels"));
    await user.keyboard("{/Meta}");

    expect(getSelectionBar().textContent).toContain("2 selected");
    expect(screen.queryByRole("dialog", { name: "Pack the returns" })).toBeNull();

    // Ctrl is no modifier on a Mac, and a plain click opens the card even while some are marked.
    await user.keyboard("{Control>}");
    await user.click(getCard("Label the pallets"));
    await user.keyboard("{/Control}");

    expect(await screen.findByRole("dialog", { name: "Label the pallets" })).toBeTruthy();
    expect(getSelectionBar().textContent).toContain("2 selected");
  });

  it("marks a card with Ctrl-click on Linux, where ⌘ is not the modifier", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable({ platform: "linux" });
    await screen.findByRole("button", { name: /^Pack the returns/ });

    await user.keyboard("{Meta>}");
    await user.click(getCard("Weigh the parcels"));
    await user.keyboard("{/Meta}");
    expect(await screen.findByRole("dialog", { name: "Weigh the parcels" })).toBeTruthy();
    expect(isSelectionBarShown()).toBe(false);

    await user.keyboard("{Control>}");
    await user.click(getCard("Pack the returns"));
    await user.keyboard("{/Control}");

    expect(getSelectionBar().textContent).toContain("1 selected");
  });

  it("steps back one thing at a time: the pane first, then the marks", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Pack the returns");
    await user.keyboard("x");
    await user.click(getCard("Label the pallets"));
    await screen.findByRole("dialog", { name: "Label the pallets" });

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(isSelectionBarShown()).toBe(true);

    await user.keyboard("{Escape}");
    expect(isSelectionBarShown()).toBe(false);
  });

  it("lets a card leave the marks when the board stops drawing it", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Pack the returns");
    await user.keyboard("x");
    focusCard("Weigh the parcels");
    await user.keyboard("x");
    expect(getSelectionBar().textContent).toContain("2 selected");

    await user.type(screen.getByRole("combobox", { name: "Find on the board" }), "Pack");

    await waitFor(() => {
      expect(getSelectionBar().textContent).toContain("1 selected");
    });
  });

  it("marks every selected card Done with one update each, says so in one line, and one Undo puts them all back in place", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Pack the returns");
    await user.keyboard("x");
    focusCard("Weigh the parcels");
    await user.keyboard("x");

    await user.click(within(getSelectionBar()).getByRole("button", { name: "Done" }));

    expect(screen.getByText("Marked 2 Tasks Done. They have left the board.")).toBeTruthy();
    expect(readCellTitles()).toEqual(["Label th"]);
    expect(isSelectionBarShown()).toBe(false);
    await waitFor(() => {
      expect(readBodies(calls, `PATCH /api/v1/tasks/${PACK.id}`)).toEqual([{ stage: "done" }]);
      expect(readBodies(calls, `PATCH /api/v1/tasks/${WEIGH.id}`)).toEqual([{ stage: "done" }]);
    });

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    await waitFor(() => {
      expect(readCellTitles()).toEqual(["Pack the", "Label th", "Weigh th"]);
    });
    expect(screen.getByText("Put back: Marked 2 Tasks Done.")).toBeTruthy();
    await waitFor(() => {
      expect(readBodies(calls, `POST /api/v1/tasks/${PACK.id}/move`)).toEqual([
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: null },
      ]);
      expect(readBodies(calls, `POST /api/v1/tasks/${WEIGH.id}/move`)).toEqual([
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: LABEL.id },
      ]);
    });
    // Each card was sent once, and the Task in between was never touched.
    expect(listCalls(calls, `PATCH /api/v1/tasks/${LABEL.id}`)).toHaveLength(0);
    expect(listCalls(calls, `POST /api/v1/tasks/${LABEL.id}/move`)).toHaveLength(0);
  });

  it("restores neighbours that ended together in the order they stood", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Weigh the parcels");
    await user.keyboard("x");
    focusCard("Label the pallets");
    await user.keyboard("x");

    await user.click(within(getSelectionBar()).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    await waitFor(() => {
      expect(readCellTitles()).toEqual(["Pack the", "Label th", "Weigh th"]);
    });
    expect(readBodies(calls, `POST /api/v1/tasks/${LABEL.id}/move`)).toEqual([
      { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: PACK.id },
    ]);
    expect(readBodies(calls, `POST /api/v1/tasks/${WEIGH.id}/move`)).toEqual([
      { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: LABEL.id },
    ]);
  });

  it("drops every selected card from the bar, and clears the marks without sending anything with Clear", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Pack the returns");
    await user.keyboard("x");
    focusCard("Label the pallets");
    await user.keyboard("x");

    await user.click(within(getSelectionBar()).getByRole("button", { name: /^Clear/ }));

    expect(isSelectionBarShown()).toBe(false);
    expect(listCalls(calls, `PATCH /api/v1/tasks/${PACK.id}`)).toHaveLength(0);

    focusCard("Pack the returns");
    await user.keyboard("x");
    focusCard("Label the pallets");
    await user.keyboard("x");
    await user.click(within(getSelectionBar()).getByRole("button", { name: "Drop" }));

    expect(screen.getByText("Dropped 2 Tasks. They have left the board.")).toBeTruthy();
    await waitFor(() => {
      expect(readBodies(calls, `PATCH /api/v1/tasks/${PACK.id}`)).toEqual([{ stage: "dropped" }]);
      expect(readBodies(calls, `PATCH /api/v1/tasks/${LABEL.id}`)).toEqual([{ stage: "dropped" }]);
    });
  });

  it("names the one card when only one is selected, as D would", async () => {
    const user = userEvent.setup({ delay: null });
    await openEndable();
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Pack the returns");
    await user.keyboard("x");

    await user.click(within(getSelectionBar()).getByRole("button", { name: "Done" }));

    expect(screen.getByText('Marked "Pack the returns" Done. It has left the board.')).toBeTruthy();
  });

  it("brings back the card that was refused, and the key still undoes the one that saved", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openEndable({
      handlers: { [`PATCH /api/v1/tasks/${LABEL.id}`]: TASK_GONE },
    });
    await screen.findByRole("button", { name: /^Pack the returns/ });
    focusCard("Pack the returns");
    await user.keyboard("x");
    focusCard("Label the pallets");
    await user.keyboard("x");

    await user.click(within(getSelectionBar()).getByRole("button", { name: "Done" }));

    expect(
      await screen.findByText(
        /^Marking "Label the pallets" Done did not save, so the card came back/,
      ),
    ).toBeTruthy();
    expect(readCellTitles()).toEqual(["Label th", "Weigh th"]);
    // The line shows why and offers no Undo, but the key still undoes the card that did leave.
    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => {
      expect(readCellTitles()).toEqual(["Pack the", "Label th", "Weigh th"]);
    });
    expect(readBodies(calls, `POST /api/v1/tasks/${PACK.id}/move`)).toHaveLength(1);
    expect(listCalls(calls, `POST /api/v1/tasks/${LABEL.id}/move`)).toHaveLength(0);
  });
});

describe("the runs of a Task in the details pane", () => {
  const ASKING = CARDS[0]!;
  const RUNNING_ID = buildTaskId(970);
  const FINISHED_ID = buildTaskId(971);
  const RUNNING = {
    id: RUNNING_ID,
    workflowId: null,
    workflowName: "Review PR",
    status: "running" as const,
    createdAt: "2026-09-29T09:00:00.000Z",
    awaitedSignalIds: [],
  };
  const FINISHED = {
    ...RUNNING,
    id: FINISHED_ID,
    workflowName: "Check the refund rules",
    status: "completed" as const,
    finishedAt: "2026-09-29T09:05:00.000Z",
  };
  const STOP_PATH = `POST /api/v1/runs/${RUNNING_ID}/cancel`;
  /** The run `run.cancel` returns once the controller has taken the request. */
  const CANCELLED = {
    id: RUNNING_ID,
    workflowId: null,
    plan: { name: "Review PR", inputs: [], triggers: [], steps: [], edges: [] },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    runnerId: buildTaskId(7001),
    workspaceId: buildTaskId(7002),
    subscriptions: [],
    createdAt: RUNNING.createdAt,
    status: "cancelled",
    finishedAt: "2026-09-29T09:06:00.000Z",
    steps: [],
    edgeTraversals: [],
  };

  /** Opens the pane of the asking Task, whose details list a running and a finished run, and returns it. */
  const openPane = async (handlers: Readonly<Record<string, Handler>> = {}) => {
    const user = userEvent.setup({ delay: null });
    const opened = await openWork({
      handlers: {
        [detailPath(ASKING.id)]: {
          body: buildDetail(ASKING, { runs: [RUNNING, FINISHED], runCount: 5 }),
        },
        ...handlers,
      },
    });
    await user.click(
      await screen.findByRole("button", { name: /^Refund emails show the wrong currency/ }),
    );
    const pane = await screen.findByRole("dialog", { name: ASKING.title });
    await within(pane).findByText("Check the refund rules");
    return { ...opened, user, pane };
  };

  it("lists the runs with where each one is, and says how many more there are", async () => {
    const { pane } = await openPane();

    expect(within(pane).getByRole("button", { name: /Review PR\s*Running/ })).toBeTruthy();
    expect(
      within(pane).getByRole("button", { name: /Check the refund rules\s*Done/ }),
    ).toBeTruthy();
    expect(within(pane).getByText("and 3 more")).toBeTruthy();
    // Only a live run offers Stop.
    expect(within(pane).getAllByText("Stop")).toHaveLength(1);
  });

  it("opens the run from its row", async () => {
    const { user, pane, router } = await openPane();

    await user.click(within(pane).getByRole("button", { name: /Check the refund rules/ }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${FINISHED_ID}`);
    });
  });

  it("stops a live run, keeps its workspace, and says it was asked to stop, with no Undo", async () => {
    const { user, pane, calls } = await openPane({ [STOP_PATH]: { body: CANCELLED } });

    // The button shows when the row is hovered or focused, which the stylesheet decides.
    await user.click(within(pane).getByText("Stop"));

    expect(await screen.findByText('Asked "Review PR" to stop.')).toBeTruthy();
    expect(readBodies(calls, STOP_PATH)).toEqual([{ keepWorkspace: true }]);
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("says why when the controller refuses to stop the run", async () => {
    const { user, pane } = await openPane({
      [STOP_PATH]: {
        status: 409,
        body: buildErrorBody("invalid_state", "The run has already ended."),
      },
    });

    await user.click(within(pane).getByText("Stop"));

    expect(
      await screen.findByText('Could not stop "Review PR": The run has already ended.'),
    ).toBeTruthy();
  });
});

// ---------- Grouping by an outside place ----------

/** The invented source of the repositories: its one-square mark is how a test tells it is drawn. */
const FORGE: PluginDetail = {
  id: "forge",
  displayName: "Forge",
  mark: { paths: ["M2 2h12v12H2z"] },
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
};

const REPOSITORY_KIND = "forge/repository";
const REPOSITORY_CAPTION = "Forge repository";
const DEPOT_REPOSITORY = buildPlace("forge:repo:depot", "depot-service", {
  kind: REPOSITORY_KIND,
  noun: "Repository",
  caption: REPOSITORY_CAPTION,
  status: { shape: "ring", tone: "active", label: "Active" },
  progress: { fraction: 3 / 7, done: 3, total: 7 },
});
const STORE_REPOSITORY = buildPlace("forge:repo:store", "store-web", {
  kind: REPOSITORY_KIND,
  noun: "Repository",
  caption: REPOSITORY_CAPTION,
});
const DEPOT_LANE = `place:${DEPOT_REPOSITORY.ref}`;
const STORE_LANE = `place:${STORE_REPOSITORY.ref}`;

const SHARED_ID = buildTaskId(30);
const SHARED_TITLE = "Share the pallet scan library";

/** Four Tasks: one in the depot repository, one in the store repository, one in both, and one in none. */
const REPOSITORY_CARDS: readonly WorkCard[] = [
  buildCard(SHARED_ID, {
    title: SHARED_TITLE,
    entityMarks: [{ plugin: "forge", kind: "forge/pull-request" }],
    contextRefs: [DEPOT_REPOSITORY.ref, STORE_REPOSITORY.ref],
  }),
  buildCard(buildTaskId(31), {
    title: "Print depot pick lists",
    entityMarks: [{ plugin: "forge", kind: "forge/issue" }],
    contextRefs: [DEPOT_REPOSITORY.ref],
  }),
  buildCard(buildTaskId(32), {
    title: "Show the basket total",
    projectId: WEBSHOP.id,
    entityMarks: [{ plugin: "forge", kind: "forge/issue" }],
    contextRefs: [STORE_REPOSITORY.ref],
  }),
  buildCard(buildTaskId(33), { title: "Tidy the depot labels", stage: "planned" }),
];

const buildRepositoryBoard = (cards: readonly WorkCard[] = REPOSITORY_CARDS): WorkBoard => ({
  ...buildBoard(...cards),
  places: [DEPOT_REPOSITORY, STORE_REPOSITORY],
  groupings: [{ kind: REPOSITORY_KIND, caption: REPOSITORY_CAPTION }],
});

/** Opens Work on a board of repositories, with the repositories' plugin installed. */
const openRepositoryWork = (
  options: {
    readonly board?: () => WorkBoard;
    readonly handlers?: Readonly<Record<string, Handler>>;
  } = {},
) =>
  openWork({
    board: options.board ?? (() => buildRepositoryBoard()),
    handlers: { "GET /api/v1/plugins": { body: [FORGE] }, ...options.handlers },
  });

/** Chooses a grouping in the Group by menu, which jsdom keeps open in the page. */
const groupBy = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole("menuitemradio", { name, hidden: true }));
};

/** Returns the section of the lane whose head names `name`. */
const getLane = (name: RegExp | string): HTMLElement =>
  screen.getByRole("heading", { level: 3, name }).closest("section")!;

/** Returns every card named `title` that the board draws, one for each lane it is in. */
const getCardsNamed = (title: string): HTMLElement[] =>
  screen.getAllByRole("button", { name: new RegExp(`^${title}`) });

describe("the Work screen grouped by an outside place", () => {
  it("draws a lane per repository, with its mark and what it says about itself, and the lane of what has none last", async () => {
    await openRepositoryWork();
    await screen.findByRole("button", { name: /^Print depot pick lists/ });

    await groupBy(REPOSITORY_CAPTION);

    const names = screen
      .getAllByRole("heading", { level: 3 })
      .flatMap((heading) => heading.querySelector(".board-lane-name")?.textContent ?? []);
    expect(names).toEqual(["depot-service", "store-web", `No ${REPOSITORY_CAPTION}`]);
    const depot = getLane(/^depot-service/);
    expect(depot.querySelector(".board-lane-folder svg path")).not.toBeNull();
    expect(within(depot).getByText(/Forge repository · Active/)).toBeTruthy();
    // Progress shows only where the source reports it.
    expect(within(depot).getByText("3 of 7")).toBeTruthy();
    expect(within(getLane(/^store-web/)).queryByText(/ of /)).toBeNull();
    expect(screen.getByRole("button", { name: /^Group by\s*Forge repository$/ })).toBeTruthy();
  });

  it("puts a Task in two repositories in both, counts it once, and says so on each card", async () => {
    await openRepositoryWork();
    await screen.findByRole("button", { name: /^Print depot pick lists/ });

    await groupBy(REPOSITORY_CAPTION);

    const copies = getCardsNamed(SHARED_TITLE);
    expect(copies).toHaveLength(2);
    expect(copies.map((copy) => copy.closest("section")?.dataset["laneId"])).toEqual([
      DEPOT_LANE,
      STORE_LANE,
    ]);
    for (const copy of copies) {
      const also = copy.querySelector<HTMLElement>(".card-also")!;
      expect(also.textContent).toBe("In 2 repositories");
      expect(also.title).toBe("depot-service, store-web");
    }
    // Only one of the two cards is the stop that Tab leads onto.
    expect(
      screen.getAllByRole("button").filter((button) => button.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });

  it("draws the mark of the source on the foot of each card that links it, and none on one that links nothing", async () => {
    await openRepositoryWork();

    const linked = await screen.findByRole("button", { name: /^Print depot pick lists/ });
    expect(linked.querySelector(".card-meta .card-src svg path")).not.toBeNull();
    expect(linked.querySelector(".card-src")?.getAttribute("title")).toBe("Forge");
    expect(getCard("Tidy the depot labels").querySelector(".card-src")).toBeNull();
  });

  it("keeps the grouping after the screen is opened again, and draws Project when its kind has gone", async () => {
    await openRepositoryWork();
    await screen.findByRole("button", { name: /^Print depot pick lists/ });
    await groupBy(REPOSITORY_CAPTION);
    expect(screen.getByRole("heading", { level: 3, name: /^depot-service/ })).toBeTruthy();

    cleanup();
    await openRepositoryWork();
    expect(await screen.findByRole("heading", { level: 3, name: /^depot-service/ })).toBeTruthy();

    cleanup();
    await openRepositoryWork({ board: () => buildBoard(...CARDS) });
    expect(await screen.findByRole("heading", { level: 3, name: /^webshop/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Group by\s*Project$/ })).toBeTruthy();
    // The choice is kept, in case the kind comes back.
    const saved = localStorage.getItem(buildWorkViewKey(CONTROLLER_URL, SIDEBAR_FIXTURE.username));
    expect(JSON.parse(saved ?? "{}")).toMatchObject({ groupBy: REPOSITORY_KIND });
  });

  it("filters by a repository with a captioned chip, and leaves the Project of every Task alone", async () => {
    const user = userEvent.setup();
    await openRepositoryWork();
    await screen.findByRole("button", { name: /^Print depot pick lists/ });

    await user.click(screen.getByRole("menuitem", { name: /^Forge repository/, hidden: true }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /^store-web/, hidden: true }));

    expect(
      screen.getByRole("button", { name: "Remove filter Forge repository store-web" }),
    ).toBeTruthy();
    expect(getCard("Show the basket total")).toBeTruthy();
    expect(getCard(SHARED_TITLE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Print depot pick lists/ })).toBeNull();
    // The Task is still in its own Project's lane.
    expect(
      within(getLane(/^webshop/)).getByRole("button", { name: /^Show the basket total/ }),
    ).toBeTruthy();
  });

  it("filters by the source of the cards", async () => {
    const user = userEvent.setup();
    await openRepositoryWork();
    await screen.findByRole("button", { name: /^Print depot pick lists/ });

    await user.click(screen.getByRole("menuitem", { name: /^Source/, hidden: true }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /^No source/, hidden: true }));

    expect(getCard("Tidy the depot labels")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Print depot pick lists/ })).toBeNull();
  });

  it("walks the keys inside the lane of the copy that has the focus, not the lane of its twin", async () => {
    const user = userEvent.setup();
    await openRepositoryWork();
    await screen.findByRole("button", { name: /^Print depot pick lists/ });
    await groupBy(REPOSITORY_CAPTION);
    const inStore = getCardsNamed(SHARED_TITLE)[1]!;

    // The depot lane has two cards in Exploring and the store lane has two as well.
    await user.click(inStore);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(getCard("Show the basket total"));
    expect(getCard("Show the basket total").closest("section")?.dataset["laneId"]).toBe(STORE_LANE);

    // Up from the first card of the store lane goes into the depot lane's last card, not to a twin.
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(getCard("Print depot pick lists"));
  });

  it("moves a Task a stage from its copy in the second lane, with no Project and no place to follow, and keeps the focus there", async () => {
    const user = userEvent.setup();
    let cards = REPOSITORY_CARDS;
    const { calls } = await openRepositoryWork({
      board: () => buildRepositoryBoard(cards),
      handlers: {
        [`POST /api/v1/tasks/${SHARED_ID}/move`]: (call) => {
          const { stage } = call.body as { stage: BoardStage };
          cards = cards.map((card) => (card.id === SHARED_ID ? { ...card, stage } : card));
          return { body: { ...buildCreatedTask(SHARED_TITLE, undefined), id: SHARED_ID, stage } };
        },
      },
    });
    await screen.findByRole("button", { name: /^Print depot pick lists/ });
    await groupBy(REPOSITORY_CAPTION);
    await user.click(getCardsNamed(SHARED_TITLE)[1]!);

    await user.keyboard(withShift("{ArrowRight}"));

    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith("/move"))).toHaveLength(1);
    });
    expect(calls.find((call) => call.path.endsWith("/move"))?.body).toEqual({ stage: "planned" });
    const copies = getCardsNamed(SHARED_TITLE);
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.closest(".board-cell")?.getAttribute("data-stage")).toBe("planned");
    }
    expect(document.activeElement).toBe(copies[1]);
  });
});

describe("the Work screen's lanes for outside places, in their edge cases", () => {
  const ODD_REPOSITORY = buildPlace('forge:repo:"odd"\\name', "odd-service", {
    kind: REPOSITORY_KIND,
    noun: "Repository",
    caption: REPOSITORY_CAPTION,
  });
  const oddBoard = (...cards: readonly WorkCard[]): WorkBoard => ({
    ...buildBoard(...cards),
    places: [ODD_REPOSITORY],
    groupings: [{ kind: REPOSITORY_KIND, caption: REPOSITORY_CAPTION }],
  });
  const inOdd = (n: number, projectId: string | undefined): WorkCard =>
    buildCard(buildTaskId(60 + n), {
      title: `Odd task ${String(n)}`,
      ...(projectId === undefined ? {} : { projectId }),
      contextRefs: [ODD_REPOSITORY.ref],
    });

  it("folds and opens a lane whose place ref holds quotes and a backslash", async () => {
    const user = userEvent.setup();
    await openRepositoryWork({ board: () => oddBoard(inOdd(1, undefined), inOdd(2, undefined)) });
    await screen.findByRole("button", { name: /^Odd task 1/ });
    await groupBy(REPOSITORY_CAPTION);
    await user.click(getCard("Odd task 1"));

    await user.keyboard("f");

    expect(screen.queryByRole("button", { name: /^Odd task 1/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^odd-service/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    await user.keyboard("f");
    expect(getCard("Odd task 1")).toBeTruthy();
  });

  it.each([
    [
      "the Project that most of its cards are in",
      [inOdd(1, WEBSHOP.id), inOdd(2, WEBSHOP.id), inOdd(3, OPS.id), inOdd(4, undefined)],
      WEBSHOP.id,
    ],
    ["no Project when two Projects tie", [inOdd(1, WEBSHOP.id), inOdd(2, OPS.id)], undefined],
    [
      "no Project when as many cards have none as the best Project has",
      [inOdd(1, WEBSHOP.id), inOdd(2, undefined)],
      undefined,
    ],
  ])("adds a Task from the lane's plus into %s", async (_, cards, projectId) => {
    const user = userEvent.setup();
    const { calls } = await openRepositoryWork({
      board: () => oddBoard(...cards),
      handlers: {
        "POST /api/v1/tasks": (call) => ({
          body: buildCreatedTask(
            (call.body as { title: string }).title,
            (call.body as { projectId?: string }).projectId,
          ),
        }),
      },
    });
    await screen.findByRole("button", { name: /^Odd task 1/ });
    await groupBy(REPOSITORY_CAPTION);

    await user.click(screen.getByRole("button", { name: "Add to odd-service" }));
    await user.type(screen.getByRole("textbox", { name: "New Task" }), "Label the crates{Enter}");

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.path === "/api/v1/tasks")).toBe(
        true,
      );
    });
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/v1/tasks");
    expect(created?.body).toEqual({
      title: "Label the crates",
      description: "",
      stage: "exploring",
      ...(projectId === undefined ? {} : { projectId }),
    });
  });
});

// ---------- What the details pane says a Task is part of ----------

describe("the details pane's outside things", () => {
  const ORDER = "forge:issue:pick-lists";
  const SECRET = "forge:issue:secret";
  const DEPOT_ROUND = buildPlace("forge:round:depot", "Depot round", {
    kind: "forge/round",
    noun: "Round",
  });
  const STORE_ROUND = buildPlace("forge:round:store", "Store round", {
    kind: "forge/round",
    noun: "Round",
  });
  /** A place no Connection can read: it has no title. */
  const LOCKED_ROUND = {
    ref: "forge:round:private",
    kind: "forge/round",
    noun: "Round",
    restricted: true,
  } as const;
  const PICK_LISTS = buildPlace(ORDER, "Print the pick lists", {
    kind: "forge/issue",
    noun: "Issue",
    identifier: "DEP-12",
    status: { shape: "ring", tone: "active", label: "In progress" },
  });
  const SECRET_ISSUE = {
    ref: SECRET,
    kind: "forge/issue",
    noun: "Issue",
    restricted: true,
  } as const;
  const CARD = buildCard(buildTaskId(40), { title: "Print depot pick lists" });

  const openPaneWith = async (detail: Partial<TaskDetail>) => {
    const user = userEvent.setup();
    await openRepositoryWork({
      board: () => buildBoard(CARD),
      handlers: { [detailPath(CARD.id)]: { body: buildDetail(CARD, detail) } },
    });
    await user.click(await screen.findByRole("button", { name: /^Print depot pick lists/ }));
    return screen.findByRole("dialog", { name: "Print depot pick lists" });
  };

  it("lists a place under two parents by both paths, each once, and a place nobody can open as locked", async () => {
    const pane = await openPaneWith({
      entities: [PICK_LISTS],
      places: [PICK_LISTS, DEPOT_ROUND, STORE_ROUND, LOCKED_ROUND],
      edges: [
        { fromRef: ORDER, toRef: DEPOT_ROUND.ref },
        { fromRef: ORDER, toRef: STORE_ROUND.ref },
        { fromRef: DEPOT_ROUND.ref, toRef: LOCKED_ROUND.ref },
        { fromRef: STORE_ROUND.ref, toRef: LOCKED_ROUND.ref },
      ],
    });

    const partOf = await within(pane).findByRole("region", { name: "Part of" });
    expect(
      within(partOf)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["Depot roundRound", "Store roundRound", "A Forge round you cannot open"]);
    expect(partOf.querySelectorAll(".relation-row.is-locked")).toHaveLength(1);
  });

  it("lists the linked things with their identifier, and a linked thing nobody can open as locked", async () => {
    const pane = await openPaneWith({
      entities: [PICK_LISTS, SECRET_ISSUE],
      places: [PICK_LISTS, SECRET_ISSUE],
    });

    const linked = await within(pane).findByRole("region", { name: "Linked" });
    expect(
      within(linked)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["DEP-12 Print the pick listsIssue · In progress", "A Forge issue you cannot open"]);
    // Nothing is above the linked things, so no Part of section is drawn.
    expect(within(pane).queryByRole("region", { name: "Part of" })).toBeNull();
  });

  it("draws neither section for a Task that links nothing", async () => {
    const pane = await openPaneWith({});

    await within(pane).findByRole("button", { name: /^Done/ });
    expect(within(pane).queryByRole("region", { name: "Part of" })).toBeNull();
    expect(within(pane).queryByRole("region", { name: "Linked" })).toBeNull();
  });
});
