/**
 * Tests the sidebar's Done moves on lists of Threads: `useDoneMoves` with
 * the toast it feeds, against a stubbed controller that applies a list as it
 * would, all or nothing.
 *
 * The Threads are drawn by a small harness, not by the sidebar, so a test can
 * move three of them as one group without the group rows of the sidebar.
 */
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createClient, type HerculeClient } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { createQueryClient } from "../app/query-client";
import { threadAndAgentSessionsQuery } from "../app/queries";
import {
  buildErrorBody,
  CONTROLLER_URL,
  holdAnswer,
  SIDEBAR_FIXTURE,
  stubApi,
  type Handler,
} from "../app/testing";
import { createDoneToastStore, SidebarDoneToast } from "./done-toast";
import { useDoneMoves } from "./use-done-moves";

const MARK_DONE_PATH = "/api/v1/sessions/mark-done";
const REOPEN_PATH = "/api/v1/sessions/reopen";
const MARK_DONE = `POST ${MARK_DONE_PATH}`;
const REOPEN = `POST ${REOPEN_PATH}`;

/** The moment the controller says it marked Threads done. */
const DONE_AT = "2026-09-10T09:30:00.000Z";
/** The moment the controller says it reopened Threads. */
const REOPENED_AT = "2026-09-10T09:31:00.000Z";

/** Returns the Thread "Thread <number>", open, or Done when `done` is set. */
const buildThread = (number: number, done = false): Session => ({
  ...SIDEBAR_FIXTURE.threads[4]!,
  id: `01a06d02-7400-7000-8000-${String(1000 + number).padStart(12, "0")}`,
  title: `Thread ${String(number)}`,
  ...(done ? { done: { at: "2026-09-10T09:00:00.000Z", by: "user" as const } } : {}),
});

/**
 * Returns the controller's Threads, as `readThreads` answers them, with the
 * handlers of the two Done moves, which change those Threads as the controller
 * does: every Thread of the list, or none.
 */
const buildController = (initial: readonly Session[]) => {
  let threads = initial;
  const apply =
    (change: (session: Session) => Session) =>
    (call: { readonly body: unknown }): { body: Session[] } => {
      const { sessionIds } = call.body as { sessionIds: string[] };
      threads = threads.map((session) =>
        sessionIds.includes(session.id) ? change(session) : session,
      );
      return { body: threads.filter((session) => sessionIds.includes(session.id)) };
    };
  return {
    readThreads: () => threads,
    markDone: apply((session) => ({ ...session, done: { at: DONE_AT, by: "user" } })),
    reopen: apply((session) => {
      const { done, ...open } = session;
      void done;
      return { ...open, reopenedAt: REOPENED_AT };
    }),
  };
};

/**
 * Draws each Thread of the sidebar's read as "<title>: done" or "<title>:
 * open", with a button for each move a test makes, and the toast the moves
 * show. "Done Threads 1-3" marks those three Done in one call, "Done Thread 1"
 * marks the first alone, and the two Reopen buttons reopen those lists.
 */
function Harness({ client }: { readonly client: HerculeClient }) {
  const [toasts] = useState(createDoneToastStore);
  const { markDone, reopen, undo } = useDoneMoves(client, toasts);
  const { data = [] } = useQuery(threadAndAgentSessionsQuery(client));
  const idsOf = (numbers: readonly number[]) => numbers.map((number) => buildThread(number).id);
  return (
    <>
      <ul>
        {data.map((session) => (
          <li key={session.id}>{`${session.title}: ${session.done ? "done" : "open"}`}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          markDone(idsOf([1, 2, 3]));
        }}
      >
        Done Threads 1-3
      </button>
      <button
        type="button"
        onClick={() => {
          markDone(idsOf([1]));
        }}
      >
        Done Thread 1
      </button>
      <button
        type="button"
        onClick={() => {
          reopen(idsOf([1, 2, 3]));
        }}
      >
        Reopen Threads 1-3
      </button>
      <button
        type="button"
        onClick={() => {
          reopen(idsOf([1]));
        }}
      >
        Reopen Thread 1
      </button>
      <SidebarDoneToast store={toasts} onUndo={undo} />
    </>
  );
}

/**
 * Renders the harness against a controller that holds `threads`, with
 * `handlers` answering the operations they name instead of the controller,
 * and waits until the Threads are drawn. Returns the calls the controller
 * received and a function listing the Done moves among them.
 */
const startHarness = async (
  controller: ReturnType<typeof buildController>,
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  const calls = stubApi({
    "GET /api/v1/sessions": () => ({ body: { items: controller.readThreads() } }),
    [MARK_DONE]: controller.markDone,
    [REOPEN]: controller.reopen,
    ...handlers,
  });
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  const queryClient = createQueryClient();
  await queryClient.ensureQueryData(threadAndAgentSessionsQuery(client));
  render(
    <QueryClientProvider client={queryClient}>
      <Harness client={client} />
    </QueryClientProvider>,
  );
  return {
    calls,
    readMoves: () =>
      calls
        .filter((call) => call.method === "POST")
        .map((call) => `${call.path} ${JSON.stringify(call.body)}`),
    countReads: () => calls.filter((call) => call.method === "GET").length,
  };
};

/** Returns the JSON a request for `path` carries when it moves the Threads numbered `numbers`. */
const expectMove = (path: string, numbers: readonly number[]): string =>
  `${path} ${JSON.stringify({ sessionIds: numbers.map((number) => buildThread(number).id) })}`;

const OPEN_THREADS = [1, 2, 3, 4].map((number) => buildThread(number));

describe("the Done moves on a lone Thread", () => {
  it("marks it done before the controller answers, says so with Undo, and reopens exactly it from Undo", async () => {
    const held = holdAnswer();
    const controller = buildController(OPEN_THREADS);
    const { readMoves } = await startHarness(controller, { [MARK_DONE]: held.handler });

    await userEvent.click(screen.getByRole("button", { name: "Done Thread 1" }));

    expect(screen.getByText("Thread 1: done")).toBeTruthy();
    const toast = screen.getByText("Marked done").parentElement!;
    expect(toast.getAttribute("role")).toBe("status");
    held.answer(controller.markDone({ body: { sessionIds: [buildThread(1).id] } }));

    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(screen.getByText("Thread 1: open")).toBeTruthy();
    });
    expect(screen.queryByText("Marked done")).toBeNull();
    expect(readMoves()).toEqual([expectMove(MARK_DONE_PATH, [1]), expectMove(REOPEN_PATH, [1])]);
  });
});

describe("the Done moves on a list of Threads", () => {
  it("marks three done in one request, says 'Marked 3 done', and reopens exactly those three from Undo", async () => {
    const held = holdAnswer();
    const controller = buildController(OPEN_THREADS);
    const { readMoves } = await startHarness(controller, { [MARK_DONE]: held.handler });

    await userEvent.click(screen.getByRole("button", { name: "Done Threads 1-3" }));

    for (const number of [1, 2, 3])
      expect(screen.getByText(`Thread ${String(number)}: done`)).toBeTruthy();
    expect(screen.getByText("Thread 4: open")).toBeTruthy();
    const toast = screen.getByText("Marked 3 done").parentElement!;
    held.answer(
      controller.markDone({ body: { sessionIds: OPEN_THREADS.slice(0, 3).map((s) => s.id) } }),
    );

    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

    await waitFor(() => {
      for (const number of [1, 2, 3])
        expect(screen.getByText(`Thread ${String(number)}: open`)).toBeTruthy();
    });
    expect(readMoves()).toEqual([
      expectMove(MARK_DONE_PATH, [1, 2, 3]),
      expectMove(REOPEN_PATH, [1, 2, 3]),
    ]);
  });

  it("reopens three in one request, says 'Reopened 3', and marks exactly those three done again from Undo", async () => {
    const controller = buildController([1, 2, 3, 4].map((number) => buildThread(number, true)));
    const { readMoves } = await startHarness(controller);
    expect(screen.getByText("Thread 1: done")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Reopen Threads 1-3" }));

    for (const number of [1, 2, 3])
      expect(screen.getByText(`Thread ${String(number)}: open`)).toBeTruthy();
    const toast = screen.getByText("Reopened 3").parentElement!;
    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

    await waitFor(() => {
      for (const number of [1, 2, 3])
        expect(screen.getByText(`Thread ${String(number)}: done`)).toBeTruthy();
    });
    expect(readMoves()).toEqual([
      expectMove(REOPEN_PATH, [1, 2, 3]),
      expectMove(MARK_DONE_PATH, [1, 2, 3]),
    ]);
  });

  it("says 'Reopened' for a lone Thread", async () => {
    const controller = buildController([buildThread(1, true)]);
    await startHarness(controller);

    await userEvent.click(screen.getByRole("button", { name: "Reopen Thread 1" }));

    expect(screen.getByText("Reopened")).toBeTruthy();
  });

  it("puts the list back and shows the error as an alert when the controller refuses the whole list", async () => {
    const controller = buildController(OPEN_THREADS);
    const { countReads } = await startHarness(controller, {
      [MARK_DONE]: { status: 409, body: buildErrorBody("invalid_state", "The thread is busy.") },
    });
    const readsBefore = countReads();

    await userEvent.click(screen.getByRole("button", { name: "Done Threads 1-3" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't mark 3 threads done: The thread is busy.");
    expect(within(alert).queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => {
      expect(countReads()).toBeGreaterThan(readsBefore);
    });
    for (const number of [1, 2, 3])
      expect(screen.getByText(`Thread ${String(number)}: open`)).toBeTruthy();
  });

  it("words the error of a refused Reopen for a lone Thread and for several", async () => {
    const controller = buildController([1, 2, 3].map((number) => buildThread(number, true)));
    await startHarness(controller, {
      [REOPEN]: { status: 409, body: buildErrorBody("invalid_state", "Not now.") },
    });

    await userEvent.click(screen.getByRole("button", { name: "Reopen Thread 1" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't reopen the thread: Not now.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Reopen Threads 1-3" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Couldn't reopen 3 threads: Not now.",
      );
    });
  });

  it("sends an Undo pressed before the Done is answered only after that answer, and keeps all three open throughout", async () => {
    const heldDone = holdAnswer();
    const heldReopen = holdAnswer();
    const controller = buildController(OPEN_THREADS);
    const { readMoves, countReads } = await startHarness(controller, {
      [MARK_DONE]: heldDone.handler,
      [REOPEN]: heldReopen.handler,
    });

    await userEvent.click(screen.getByRole("button", { name: "Done Threads 1-3" }));
    const toast = screen.getByText("Marked 3 done").parentElement!;
    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

    for (const number of [1, 2, 3])
      expect(screen.getByText(`Thread ${String(number)}: open`)).toBeTruthy();
    expect(readMoves()).toEqual([expectMove(MARK_DONE_PATH, [1, 2, 3])]);

    heldDone.answer(
      controller.markDone({ body: { sessionIds: OPEN_THREADS.slice(0, 3).map((s) => s.id) } }),
    );

    await waitFor(() => {
      expect(readMoves()).toEqual([
        expectMove(MARK_DONE_PATH, [1, 2, 3]),
        expectMove(REOPEN_PATH, [1, 2, 3]),
      ]);
    });
    // The Done's answer is not written while the Undo is pending, so no row
    // shows Done in between.
    for (const number of [1, 2, 3])
      expect(screen.getByText(`Thread ${String(number)}: open`)).toBeTruthy();

    const readsBeforeAnswer = countReads();
    heldReopen.answer(
      controller.reopen({ body: { sessionIds: OPEN_THREADS.slice(0, 3).map((s) => s.id) } }),
    );

    // The Undo is the last move, so its answer reads the list again.
    await waitFor(() => {
      expect(countReads()).toBeGreaterThan(readsBeforeAnswer);
    });
    for (const number of [1, 2, 3])
      expect(screen.getByText(`Thread ${String(number)}: open`)).toBeTruthy();
  });
});
