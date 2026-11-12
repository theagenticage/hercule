/**
 * Tests what the Work screen does to Tasks through the rendered app: marking
 * a Task Done or Dropped with Undo, starting a Thread on a Task, moving a
 * Thread to a new Task, merging two cards, and selecting several cards to act
 * on them at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import type { BoardStage, WorkCard } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubIntersectionObserver,
  type Handler,
} from "../../../app/testing";
import { buildPendingIntentsKey } from "../../../app/pending-intents";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";
import {
  buildCreatedTask,
  buildDetail,
  buildTaskId,
  detailPath,
  focusCard,
  getCard,
  listCalls,
  openWork,
  readBodies,
  SHORT_WINDOW_MS,
  shortenUndoWindow,
  waitOutUndoWindow,
  WEBSHOP,
} from "./-work.testing";

// The board stops the paws of a working colleague whose card is out of view.
beforeEach(() => {
  stubIntersectionObserver();
});

afterEach(() => {
  setVisibility("visible");
  localStorage.clear();
});

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

/** Returns the bar over the board that offers Done, Drop and Clear for the selected cards. */
const getSelectionBar = (): HTMLElement => screen.getByRole("toolbar", { hidden: true });

/** Returns whether the selection bar is shown: it is in the page at all times and fades out. */
const isSelectionBarShown = (): boolean => getSelectionBar().classList.contains("is-on");

/** Returns the titles of the cards of the one cell, top to bottom. */
const readCellTitles = (): readonly string[] =>
  within(screen.getByRole("group", { name: /^Exploring/ }))
    .getAllByRole("button")
    .map((card) => card.textContent?.slice(0, 8) ?? "");

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
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: PACK.id, refuseIfMerged: true },
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
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: LABEL.id, refuseIfMerged: true },
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

describe("merging two cards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Opens Work with three Tasks in one cell on a controller that merges the Task in the path into `intoTaskId`, or refuses with `refusal`.
   * Its merge check answers with `checkRefusal` when there is one, and says the merge would go ahead otherwise.
   */
  const openMergeable = async ({
    refusal,
    checkRefusal,
  }: { readonly refusal?: string; readonly checkRefusal?: string } = {}) => {
    let cards: readonly WorkCard[] = IN_ONE_CELL;
    const handlers: Record<string, Handler> = {};
    for (const card of IN_ONE_CELL) {
      handlers[`GET /api/v1/tasks/${card.id}/merge-check`] = {
        body: checkRefusal === undefined ? {} : { refusal: checkRefusal },
      };
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
    // Once the controller has checked the merge, the card the walk reached says whom it is merged into, and what stays.
    await waitFor(() => {
      expect(getCard("Weigh the parcels").dataset["mergeLabel"]).toBe(
        "Merge into Weigh the parcels",
      );
    });
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

  it("shows the refusal on the card the walk reached, and Return merges nothing and says why", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openMergeable({
      checkRefusal: "Pack already waits on this Task.",
    });
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");
    shortenUndoWindow();

    await user.keyboard("m");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(getCard("Weigh the parcels").dataset["mergeLabel"]).toBe(
        "Cannot merge: Pack already waits on this Task",
      );
    });
    await user.keyboard("{Enter}");

    expect(
      screen.getByText('"Label the pallets" was not merged: Pack already waits on this Task.'),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Label the pallets/ })).toBeTruthy();
    expect(document.querySelector(".work-desk")?.hasAttribute("data-merge-picking")).toBe(false);
    await waitOutUndoWindow();
    expect(listCalls(calls, `POST /api/v1/tasks/${LABEL.id}/merge`)).toHaveLength(0);
  });

  it("asks the controller once for a pair, however often the walk comes back to it", async () => {
    const user = userEvent.setup({ delay: null });
    const { calls } = await openMergeable();
    await screen.findByRole("button", { name: /^Label the pallets/ });
    focusCard("Label the pallets");

    await user.keyboard("m");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(getCard("Weigh the parcels").dataset["mergeCheck"]).toBe("allowed");
    });
    await user.keyboard("{ArrowUp}{ArrowDown}");
    await waitFor(() => {
      expect(getCard("Weigh the parcels").dataset["mergeCheck"]).toBe("allowed");
    });

    expect(listCalls(calls, `GET /api/v1/tasks/${LABEL.id}/merge-check`)).toHaveLength(1);
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
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: null, refuseIfMerged: true },
      ]);
      expect(readBodies(calls, `POST /api/v1/tasks/${WEIGH.id}/move`)).toEqual([
        { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: LABEL.id, refuseIfMerged: true },
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
      { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: PACK.id, refuseIfMerged: true },
    ]);
    expect(readBodies(calls, `POST /api/v1/tasks/${WEIGH.id}/move`)).toEqual([
      { stage: "exploring", projectId: WEBSHOP.id, afterTaskId: LABEL.id, refuseIfMerged: true },
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
