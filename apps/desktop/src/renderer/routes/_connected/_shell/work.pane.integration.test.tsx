/**
 * Tests the details pane of the Work screen through the rendered app: opening
 * it from a card and from the address, its reads, a Task that is gone, moving
 * the Task along its stages, trying a failed run again, the runs of the Task,
 * and the outside things the Task is part of or links.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBoard, buildCard, buildPlace, buildSummary } from "@hercule/client-core/work/testing";
import type { TaskDetail } from "@hercule/contract";
import {
  buildErrorBody,
  setVisibility,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../app/testing";
import {
  buildDetail,
  buildTaskId,
  CARDS,
  DEPOT_REPOSITORY,
  detailPath,
  focusCard,
  getCard,
  listCalls,
  openRepositoryWork,
  openWork,
  readBodies,
  REPOSITORY_CARDS,
  SHARED_TITLE,
  THREAD_ID,
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
  /** A place of a kind that cannot group Tasks: it has no caption. */
  const UNGROUPED_ROUND = {
    ref: "forge:round:ungrouped",
    kind: "forge/round",
    noun: "Round",
    title: "Night round",
    restricted: false,
  } as const;
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

  it("lists the linked things with their identifier and state but not their kind, and a linked thing nobody can open as locked", async () => {
    const pane = await openPaneWith({
      entities: [PICK_LISTS, SECRET_ISSUE],
      places: [PICK_LISTS, SECRET_ISSUE],
    });

    const linked = await within(pane).findByRole("region", { name: "Linked" });
    expect(
      within(linked)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["DEP-12 Print the pick listsIn progress", "A Forge issue you cannot open"]);
    // Nothing is above the linked things, so no Part of section is drawn.
    expect(within(pane).queryByRole("region", { name: "Part of" })).toBeNull();
  });

  /** The Task of the depot repository: its issue is part of the depot and store repositories. */
  const REPOSITORY_ISSUE = buildPlace("forge:issue:depot-labels", "Print depot pick lists", {
    kind: "forge/issue",
    noun: "Issue",
    identifier: "DEP-13",
  });
  const openRepositoryPane = async () => {
    await openRepositoryWork({
      handlers: {
        [detailPath(REPOSITORY_CARDS[1]!.id)]: {
          body: buildDetail(REPOSITORY_CARDS[1]!, {
            entities: [REPOSITORY_ISSUE],
            places: [REPOSITORY_ISSUE, DEPOT_REPOSITORY, LOCKED_ROUND],
            edges: [
              { fromRef: REPOSITORY_ISSUE.ref, toRef: DEPOT_REPOSITORY.ref },
              { fromRef: REPOSITORY_ISSUE.ref, toRef: LOCKED_ROUND.ref },
            ],
          }),
        },
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: /^Print depot pick lists/ }));
    return screen.findByRole("dialog", { name: "Print depot pick lists" });
  };

  it("filters the board to a place when its row of Part of is clicked, and closes the details", async () => {
    const user = userEvent.setup();
    const pane = await openRepositoryPane();

    await user.click(await within(pane).findByRole("button", { name: /^depot-service/ }));

    expect(
      screen.getByRole("button", { name: "Remove filter Forge repository depot-service" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Print depot pick lists" })).toBeNull();
    });
    // Every Task of the place shows, and no other.
    expect(getCard(SHARED_TITLE)).toBeTruthy();
    expect(getCard("Print depot pick lists")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show the basket total/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Tidy the depot labels/ })).toBeNull();
  });

  it("replaces the filter and the Find text that were on, so every Task of the place shows", async () => {
    const user = userEvent.setup();
    const pane = await openRepositoryPane();
    // A State filter and a Find text are on while the details are open.
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: /^With an agent/, hidden: true }),
    );
    const find = screen.getByRole<HTMLInputElement>("combobox", { name: "Find on the board" });
    fireEvent.change(find, { target: { value: "no such Task" } });

    await user.click(await within(pane).findByRole("button", { name: /^depot-service/ }));

    expect(screen.queryByRole("button", { name: "Remove filter With an agent" })).toBeNull();
    expect(find.value).toBe("");
    expect(
      screen.getByRole("button", { name: "Remove filter Forge repository depot-service" }),
    ).toBeTruthy();
    expect(getCard(SHARED_TITLE)).toBeTruthy();
  });

  it("leaves a place that cannot group Tasks, and a place nobody can open, as plain rows", async () => {
    const pane = await openRepositoryPane();

    const partOf = await within(pane).findByRole("region", { name: "Part of" });
    // The depot repository is a button. The locked round is plain, and has no button.
    expect(within(partOf).getAllByRole("button")).toHaveLength(1);
    expect(within(partOf).getByText("A Forge round you cannot open")).toBeTruthy();
    // A place without a caption, which no facet can filter by, is plain too.
    cleanup();
    const plain = await openPaneWith({
      entities: [PICK_LISTS],
      places: [PICK_LISTS, UNGROUPED_ROUND],
      edges: [{ fromRef: ORDER, toRef: UNGROUPED_ROUND.ref }],
    });
    const plainPartOf = await within(plain).findByRole("region", { name: "Part of" });
    expect(within(plainPartOf).queryByRole("button")).toBeNull();
  });

  it("draws no Part of, and only the way to link something under Linked, for a Task that links nothing", async () => {
    const pane = await openPaneWith({});

    await within(pane).findByRole("button", { name: /^Done/ });
    expect(within(pane).queryByRole("region", { name: "Part of" })).toBeNull();
    const linked = within(pane).getByRole("region", { name: "Linked" });
    expect(within(linked).getByRole("button", { name: "Link something" })).toBeTruthy();
    expect(within(linked).queryByRole("listitem")).toBeNull();
  });
});
