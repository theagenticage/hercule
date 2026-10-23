/**
 * Tests the Office screen in the running app: its keys, its dossier card,
 * its drawer, and the `session` and `assistant` search params that name what
 * the drawer shows. The tests check that:
 *
 * - Tab on the Office selects the colleague who has waited longest;
 * - Tab on one of the card's controls moves the focus and keeps the selection;
 * - selecting a colleague reads its thread, so the drawer opens on it at once;
 * - Enter and Open thread open the drawer, and the param follows;
 * - the param opens the drawer, and Escape steps back from the drawer to the
 *   card, then from the card to nothing;
 * - the drawer shows neither the side pane toggle nor the tally pill,
 *   because the drawer has no side pane;
 * - the drawer keeps its thread, and the Office stays, when the read of a
 *   cached transcript finds the thread gone;
 * - Tab reaches a waiting assistant, among the waiting threads;
 * - an assistant's card shows its Request, its runner, its model and when it
 *   was last active, and an assistant with no session shows none of those;
 * - Open conversation, and an assistant's sidebar row, open its
 *   Conversation in the drawer, and the `assistant` param follows.
 * - an `assistant` param that no assistant has shows the assistant page's
 *   "not found" state, never the thread page's;
 * - the sessions of a live run are in the Office, a finished one counted as
 *   done, and a run that has ended brings none; a run session's card names
 *   it a workflow step and opens its session;
 * - a run push reads the live runs again, and their sessions only when the
 *   live runs change;
 * - a failed read of a new run's sessions shows the failure, rather than
 *   taking a live run's finished session out of the Office;
 * - the scene opens on the world with the work that ended in the last
 *   minute, a Thread marked Done and a finished run, which the world of now
 *   leaves out; that work is read once as the Office opens, and not again
 *   when the drawer opens;
 * - opened again, the Office reads the ended work and the live runs afresh
 *   before it opens, so what ended while it was closed walks out.
 *
 * jsdom draws no WebGL, so a stub that draws nothing stands in for the 3D
 * scene. Everything around the scene is the code that ships.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunSummary, Session, SessionRequest } from "@hercule/contract";
import { queryKeys } from "@hercule/client-core";
import {
  buildConversationHandlers,
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  THREAD_FIXTURES,
  type AssistantRecords,
} from "../app/testing";
import { transcriptQuery } from "../app/queries";
import type { mountOfficeScene as MountOfficeScene } from "./office-scene";
import { readOffice, setOffice } from "./office-store";

const { mountOfficeScene } = vi.hoisted(() => ({
  mountOfficeScene: vi.fn<typeof MountOfficeScene>(() => ({
    setWorld: () => undefined,
    dispose: () => undefined,
  })),
}));
vi.mock("./office-scene", () => ({ mountOfficeScene }));

/** Returns the sidebar fixture's thread with id `id`. */
const findFixtureThread = (id: string): Session =>
  SIDEBAR_FIXTURE.threads.find((thread) => thread.id === id)!;

const runbook = findFixtureThread(FIXTURE_THREAD_IDS.runbook);

/**
 * "Fix flaky webhook tests", waiting on its own command approval since after
 * the runbook started waiting. Its desk comes before the runbook's, so the
 * queue's order and the desks' order differ.
 */
const flakyAsking: Session = {
  ...findFixtureThread(FIXTURE_THREAD_IDS.flaky),
  openRequests: [{ ...runbook.openRequests[0]!, requestId: "req-2", itemId: "tool-2" }],
  lastActivityAt: "2026-09-10T09:06:00.000Z",
};

/**
 * Ada, an assistant whose current session has waited on the user's approval
 * of `make deploy` since before either thread started waiting.
 */
const ADA = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000001",
  name: "Ada",
  mainConversationId: "01a06d02-7800-7000-8000-000000000001",
});
const ADA_SESSION = buildFixtureAssistantSession(ADA, {
  id: "01a06d02-7400-7000-8000-000000000101",
  status: "busy",
  lastActivityAt: "2026-09-10T09:01:00.000Z",
  openRequests: [
    {
      requestId: "req-ada",
      itemId: "tool-ada",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "make deploy" },
    },
  ],
});

/** Milo, an assistant that has had no session yet. */
const MILO = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000003",
  name: "Milo",
  mainConversationId: "01a06d02-7800-7000-8000-000000000003",
});

/** Ada and Milo, with the answers their Conversations read. */
const ASSISTANTS: readonly AssistantRecords[] = [
  { assistant: ADA, session: ADA_SESSION },
  { assistant: MILO, session: null },
];
const ASSISTANT_HANDLERS = {
  ...buildConversationHandlers({ assistant: ADA, session: ADA_SESSION, messages: [] }),
  ...buildConversationHandlers({ assistant: MILO, session: null, messages: [] }),
};

/**
 * Starts the app signed in at `path`, with the sidebar fixture's threads and
 * `flakyAsking` in place of the working flaky thread, so two colleagues wait.
 * `drawerThread`, the waiting runbook's unless given, answers its reads, for
 * the drawer. `handlers` add or replace answers. `assistants` are the
 * assistants the controller holds, none unless given.
 */
const openOffice = async (
  path = "/office",
  drawerThread = THREAD_FIXTURES.waiting,
  handlers: Parameters<typeof stubApi>[0] = {},
  assistants: readonly AssistantRecords[] = [],
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      threads: SIDEBAR_FIXTURE.threads.map((thread) =>
        thread.id === flakyAsking.id ? flakyAsking : thread,
      ),
      assistants,
    }),
    ...buildThreadHandlers(drawerThread),
    ...handlers,
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  await screen.findByRole("group", { name: "Who is doing what" });
  return { user: userEvent.setup(), calls, ...app };
};

/** Returns the dossier card of the colleague named `name`. */
const findCard = (name: string): HTMLElement => screen.getByRole("dialog", { name });

/** Returns the drawer while it shows a thread. */
const findDrawer = (): HTMLElement => screen.getByRole("complementary", { name: "Thread" });

/** Starts the app at `path` with Ada and Milo in the Office besides the threads. */
const openOfficeWithAssistants = (path = "/office") =>
  openOffice(path, THREAD_FIXTURES.waiting, ASSISTANT_HANDLERS, ASSISTANTS);

/** Returns the fact named `name` on `card`: its value's text. */
const readFact = (card: HTMLElement, name: string): string | null => {
  const term = within(card)
    .queryAllByRole("term")
    .find((each) => each.textContent === name);
  return term?.nextElementSibling?.textContent ?? null;
};

describe("Tab on the Office", () => {
  it("selects the colleague who has waited longest, and leaves the focus where it was", async () => {
    const { user } = await openOffice();

    await user.tab();

    expect(readOffice().selectedId).toBe(runbook.id);
    expect(findCard(runbook.title).dataset.open).toBe("true");
    expect(document.activeElement).toBe(document.body);

    await user.tab();

    expect(readOffice().selectedId).toBe(flakyAsking.id);
  });

  it("moves the focus inside the card, and keeps the selection", async () => {
    const { user } = await openOffice();
    await user.tab();
    const card = findCard(runbook.title);
    const close = within(card).getByRole("button", { name: "Close" });
    close.focus();

    await user.tab();

    expect(document.activeElement).not.toBe(close);
    expect(card.contains(document.activeElement)).toBe(true);
    expect(readOffice().selectedId).toBe(runbook.id);
  });
});

describe("the thread drawer", () => {
  it("has the selected colleague's thread read before it opens", async () => {
    const { user, context } = await openOffice();

    await user.tab();

    await waitFor(() => {
      expect(context.queryClient.getQueryData(queryKeys.transcript(runbook.id))).toEqual(
        THREAD_FIXTURES.waiting.transcript,
      );
    });
    expect(context.queryClient.getQueryData(queryKeys.session(runbook.id))).toBeDefined();
    expect(context.queryClient.getQueryData(queryKeys.inputs(runbook.id))).toBeDefined();
  });

  it("opens on Enter, and the session param names its thread", async () => {
    const { user, router } = await openOffice();
    await user.tab();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: runbook.id });
    });
    expect(findDrawer().dataset.open).toBe("true");
    expect(findCard(runbook.title).dataset.open).toBe("false");
  });

  it("opens from the card's Open thread", async () => {
    const { user, router } = await openOffice();
    await user.tab();

    await user.click(screen.getByRole("button", { name: /Open thread/ }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: runbook.id });
    });
    expect(findDrawer().dataset.open).toBe("true");
  });

  it("opens on the thread the session param names, and Escape steps back one level at a time", async () => {
    const { user, router } = await openOffice(`/office?session=${runbook.id}`);
    expect(findDrawer().dataset.open).toBe("true");
    (document.activeElement as HTMLElement | null)?.blur();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(findDrawer().dataset.open).toBe("false");
    expect(findCard(runbook.title).dataset.open).toBe("true");

    await user.keyboard("{Escape}");

    expect(readOffice().selectedId).toBeNull();
    expect(findCard(runbook.title).dataset.open).toBe("false");
  });

  it("keeps showing the thread when the read of its transcript finds it gone, and stays on the Office", async () => {
    const waiting = THREAD_FIXTURES.waiting;
    const { router, context } = await openOffice("/office", waiting, {
      [`GET /api/v1/sessions/${runbook.id}/transcript`]: {
        status: 404,
        body: buildErrorBody("not_found", "no such session"),
      },
    });
    // A transcript cached before the drawer opens, as a saved copy leaves it.
    context.queryClient.setQueryData(queryKeys.transcript(runbook.id), waiting.transcript);

    await act(() => router.navigate({ to: "/office", search: { session: runbook.id } }));
    // The read that brings it up to date, which the thread's route starts
    // when it shows a copy, finds the thread gone while the drawer is open.
    await act(() =>
      context.queryClient.prefetchQuery({
        ...transcriptQuery(context.controller!.client, runbook.id),
        staleTime: 0,
      }),
    );

    expect(context.queryClient.getQueryState(queryKeys.transcript(runbook.id))?.status).toBe(
      "error",
    );
    expect(router.state.location.pathname).toBe("/office");
    expect(within(findDrawer()).getByRole("region", { name: "Transcript" })).toBeTruthy();
  });

  it("draws neither the side pane toggle nor the tally pill, because the drawer has no side pane", async () => {
    const delegating = THREAD_FIXTURES.delegating;
    const { calls } = await openOffice(`/office?session=${delegating.session.id}`, delegating);

    const drawer = findDrawer();
    expect(
      await within(drawer).findByRole("navigation", { name: "Threads in this workspace" }),
    ).toBeTruthy();
    // The drawer has read the thread's subagent, so only the missing side
    // pane keeps the tally pill out.
    expect(delegating.subagents).toHaveLength(1);
    expect(
      calls.some((call) => call.path === `/api/v1/sessions/${delegating.session.id}/subagents`),
    ).toBe(true);
    expect(within(drawer).queryByRole("button", { name: /side pane/ })).toBeNull();
    expect(within(drawer).queryByRole("button", { name: /^Subagents/ })).toBeNull();
  });

  it("keeps each Request's typed answer and sent answer while the user pages between them", async () => {
    const question: SessionRequest = {
      requestId: "req-question",
      itemId: "tool-question",
      kind: "question",
      detail: {
        questions: [
          {
            question: "Which storage should drafts use?",
            header: "Storage",
            options: [],
            multiSelect: false,
          },
        ],
      },
    };
    const waiting = THREAD_FIXTURES.waiting;
    const thread = {
      ...waiting,
      session: { ...waiting.session, openRequests: [...waiting.session.openRequests, question] },
    };
    const held = holdAnswer();
    const respond = `POST /api/v1/sessions/${runbook.id}/respond-to-approval-request`;
    const { user, calls } = await openOffice(`/office?session=${runbook.id}`, thread, {
      [respond]: held.handler,
    });
    const drawer = findDrawer();

    await user.click(await within(drawer).findByRole("button", { name: /^Allow\b/ }));
    await user.click(within(drawer).getByRole("button", { name: "Next Request" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Your own answer" }), "SQLite");
    await user.click(within(drawer).getByRole("button", { name: "Previous Request" }));

    expect(
      within(drawer)
        .getByRole("button", { name: /^Deny\b/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(within(drawer).getByRole("button", { name: /^Deny\b/ }));
    await user.click(within(drawer).getByRole("button", { name: "Next Request" }));

    expect(
      within(drawer).getByRole<HTMLInputElement>("textbox", { name: "Your own answer" }).value,
    ).toBe("SQLite");
    expect(calls.filter((call) => `${call.method} ${call.path}` === respond)).toHaveLength(1);
    held.answer({ body: thread.session });
  });
});

describe("an assistant in the Office", () => {
  it("is reached by Tab and Shift+Tab among the waiting threads, the longest waiting first", async () => {
    const { user } = await openOfficeWithAssistants();

    await user.tab();

    expect(readOffice().selectedId).toBe(ADA.id);

    await user.tab();

    expect(readOffice().selectedId).toBe(runbook.id);

    await user.keyboard("{Shift>}{Tab}{/Shift}");

    expect(readOffice().selectedId).toBe(ADA.id);
  });

  it("has a card with its Request, its runner, its model and when it was last active", async () => {
    const { user } = await openOfficeWithAssistants();

    await user.tab();

    const card = findCard("Ada");
    expect(card.dataset.open).toBe("true");
    expect(within(card).getByText("Assistant")).toBeTruthy();
    expect(within(card).getByText("waiting on you")).toBeTruthy();
    expect(within(card).getByRole("button", { name: /^Allow\b/ })).toBeTruthy();
    expect(readFact(card, "Runner")).toMatch(/^moss/);
    expect(readFact(card, "Model")).toBe(ADA_SESSION.modelSelection.model);
    expect(readFact(card, "Last active")).toMatch(/ ago$/);
    expect(within(card).getByRole("button", { name: /Open conversation/ })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /Open thread/ })).toBeNull();
  });

  it("has a card with no Request, model or last activity while it has no session", async () => {
    await openOfficeWithAssistants();

    act(() => {
      setOffice({ selectedId: MILO.id });
    });

    const card = findCard("Milo");
    expect(card.dataset.open).toBe("true");
    expect(within(card).getByText("idle")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /^Allow\b/ })).toBeNull();
    expect(readFact(card, "Runner")).toBe("no session");
    expect(readFact(card, "Model")).toBeNull();
    expect(readFact(card, "Last active")).toBeNull();
  });

  it("opens its Conversation in the drawer from Open conversation, and the assistant param names it", async () => {
    const { user, router } = await openOfficeWithAssistants();
    await user.tab();

    await user.click(screen.getByRole("button", { name: /Open conversation/ }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ assistant: ADA.id });
    });
    const drawer = screen.getByRole("complementary", { name: "Conversation" });
    expect(drawer.dataset.open).toBe("true");
    expect(await within(drawer).findByRole("button", { name: /^Allow\b/ })).toBeTruthy();
    expect(within(drawer).getByRole("textbox")).toBeTruthy();
  });

  it("opens its Conversation in the drawer from its sidebar row, and the row is marked", async () => {
    const { user, router } = await openOfficeWithAssistants();
    const row = screen.getByRole("link", { name: "Milo, idle" });

    await user.click(row);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ assistant: MILO.id });
    });
    expect(router.state.location.pathname).toBe("/office");
    expect(readOffice()).toMatchObject({ selectedId: MILO.id, drawer: true });
    expect(screen.getByRole("complementary", { name: "Conversation" }).dataset.open).toBe("true");
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("closes its Conversation on Escape, and the assistant param goes", async () => {
    const { user, router } = await openOfficeWithAssistants(`/office?assistant=${MILO.id}`);
    expect(screen.getByRole("complementary", { name: "Conversation" }).dataset.open).toBe("true");
    (document.activeElement as HTMLElement | null)?.blur();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(findCard("Milo").dataset.open).toBe("true");
  });

  it("shows that an assistant is not found when the assistant param names no assistant", async () => {
    await openOfficeWithAssistants("/office?assistant=01a06d02-7700-7000-8000-0000000000ff");

    const drawer = screen.getByRole("complementary", { name: "Conversation" });
    expect(drawer.dataset.open).toBe("true");
    expect(
      await within(drawer).findByRole("heading", { name: "This assistant was not found." }),
    ).toBeTruthy();
    expect(
      within(drawer).queryByRole("heading", { name: "This thread was not found." }),
    ).toBeNull();
  });
});

describe("the Office's search params", () => {
  it("drops a thread that is not an id, and keeps the assistant beside it", async () => {
    const { router } = await openOfficeWithAssistants(
      `/office?session=not-an-id&assistant=${MILO.id}`,
    );

    expect(router.state.matches.at(-1)!.search).toEqual({ assistant: MILO.id });
  });
});

describe("the sessions of runs", () => {
  /** Returns a run of the workflow Review in `status`. */
  const buildRun = (id: string, status: "running" | "completed"): RunSummary =>
    status === "running"
      ? {
          id,
          workflowId: null,
          workflowName: "Review",
          origin: { kind: "manual", actor: "user" },
          createdAt: "2026-09-10T09:00:00.000Z",
          status,
          startedAt: "2026-09-10T09:00:00.000Z",
          activeStepIds: ["review"],
          awaitedSignalIds: [],
        }
      : {
          id,
          workflowId: null,
          workflowName: "Review",
          origin: { kind: "manual", actor: "user" },
          createdAt: "2026-09-10T08:00:00.000Z",
          status,
          startedAt: "2026-09-10T08:00:00.000Z",
          finishedAt: "2026-09-10T08:30:00.000Z",
        };
  const LIVE_RUN = buildRun("01a06d02-7a00-7000-8000-000000000001", "running");
  const ENDED_RUN = buildRun("01a06d02-7a00-7000-8000-000000000002", "completed");
  /** Returns the session of the step `stepId` of the run `runId`, made from a fixture thread. */
  const buildStepSession = (
    id: string,
    runId: string,
    stepId: string,
    over: Partial<Session>,
  ): Session => ({
    ...runbook,
    id,
    title: `Review · ${stepId}`,
    kind: "run",
    agentId: "01a06d02-7b00-7000-8000-000000000001",
    runId,
    stepId,
    projectId: null,
    openRequests: [],
    ...over,
  });
  const PLAN = buildStepSession("01a06d02-7400-7000-8000-000000000201", LIVE_RUN.id, "plan", {
    status: "exited",
  });
  const REVIEW = buildStepSession("01a06d02-7400-7000-8000-000000000202", LIVE_RUN.id, "review", {
    status: "busy",
  });
  const OLD = buildStepSession("01a06d02-7400-7000-8000-000000000203", ENDED_RUN.id, "review", {
    status: "busy",
  });

  /**
   * Starts the app in the Office with the fixture's threads, the two runs and
   * their sessions. `handlers` add or replace answers. A read that fails
   * shows its failure at once, without being tried again.
   */
  const openOfficeWithRuns = async (handlers: Parameters<typeof stubApi>[0] = {}) => {
    const calls = stubApi({
      ...buildSidebarHandlers({
        ...SIDEBAR_FIXTURE,
        agentSessions: [REVIEW, OLD],
        runs: [LIVE_RUN, ENDED_RUN],
        runSessions: [PLAN, REVIEW, OLD],
      }),
      ...handlers,
    });
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
    const app = await renderApp(fake, { path: "/office", retryFailedReads: false });
    await screen.findByRole("group", { name: "Who is doing what" });
    return { user: userEvent.setup(), calls, ...app };
  };

  it("seats a live run's sessions, counting the finished one as done, and none of an ended run", async () => {
    const { calls } = await openOfficeWithRuns();

    const counts = screen.getByRole("group", { name: "Who is doing what" });
    expect(within(counts).getByRole("button", { name: "1 done" })).toBeTruthy();
    // The Office reads the sessions of the live run only. The live
    // connection's first pushes can read them a second time, so the test
    // checks which runs are read, not how often.
    const runReads = calls
      .filter((call) => call.path === "/api/v1/sessions")
      .flatMap((call) => new URLSearchParams(call.search).getAll("runId"));
    expect(new Set(runReads)).toEqual(new Set([LIVE_RUN.id]));
    act(() => setOffice({ selectedId: OLD.id }));
    expect(screen.queryByRole("dialog", { name: OLD.title })).toBeNull();
  });

  it("names a run session's card a workflow step, and opens its session", async () => {
    const { user, router } = await openOfficeWithRuns();

    act(() => setOffice({ selectedId: REVIEW.id }));
    const card = findCard(REVIEW.title);
    expect(within(card).getByText("Workflow step")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: /Open session/ }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: REVIEW.id });
    });
  });

  it("reads the two lists of live runs again on a run push, and the runs' sessions only when the live runs change", async () => {
    const { calls, live } = await openOfficeWithRuns();
    await live.waitForFirstPushes();
    const before = calls.length;

    live.pushInvalidation("run", [LIVE_RUN.id]);

    const readStatuses = () =>
      calls
        .slice(before)
        .filter((call) => call.path === "/api/v1/runs")
        .map((call) => new URLSearchParams(call.search).get("status"));
    await waitFor(() => {
      expect(readStatuses().toSorted()).toEqual(["pending", "running"]);
    });
    expect(calls.slice(before).filter((call) => call.path === "/api/v1/sessions")).toEqual([]);
  });

  it("opens the scene on the work that ended a moment ago, read once as the Office opens", async () => {
    const aMomentAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    const JUST_ENDED_RUN: RunSummary = {
      id: "01a06d02-7a00-7000-8000-000000000004",
      workflowId: null,
      workflowName: "Review",
      origin: { kind: "manual", actor: "user" },
      createdAt: "2026-09-10T09:00:00.000Z",
      status: "completed",
      startedAt: "2026-09-10T09:00:00.000Z",
      finishedAt: aMomentAgo(10),
    };
    const JUST_ENDED = buildStepSession(
      "01a06d02-7400-7000-8000-000000000204",
      JUST_ENDED_RUN.id,
      "review",
      { status: "exited", exitedAt: aMomentAgo(12) },
    );
    const doneAt = aMomentAgo(5);
    const doneThread: Session = {
      ...flakyAsking,
      openRequests: [],
      done: { at: doneAt, by: "user" },
    };
    mountOfficeScene.mockClear();
    const calls = stubApi({
      ...buildSidebarHandlers({
        ...SIDEBAR_FIXTURE,
        threads: SIDEBAR_FIXTURE.threads.map((thread) =>
          thread.id === doneThread.id ? doneThread : thread,
        ),
        agentSessions: [REVIEW],
        runs: [LIVE_RUN, ENDED_RUN, JUST_ENDED_RUN],
        runSessions: [PLAN, REVIEW, OLD, JUST_ENDED],
      }),
      ...buildThreadHandlers(THREAD_FIXTURES.waiting),
    });
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
    const { router } = await renderApp(fake, { path: "/office" });
    await screen.findByRole("group", { name: "Who is doing what" });

    const [, , openingWorld, world] = mountOfficeScene.mock.calls[0]!;
    const leftAtById = new Map(openingWorld.colleagues.map(({ id, leftAt }) => [id, leftAt]));
    expect(leftAtById.get(doneThread.id)).toBe(doneAt);
    expect(leftAtById.get(JUST_ENDED.id)).toBe(JUST_ENDED_RUN.finishedAt);
    expect(leftAtById.get(REVIEW.id)).toBeNull();
    expect(leftAtById.has(OLD.id)).toBe(false);
    const present = world.colleagues.map(({ id }) => id);
    expect(present).not.toContain(doneThread.id);
    expect(present).not.toContain(JUST_ENDED.id);

    await act(() => router.navigate({ to: "/office", search: { session: runbook.id } }));
    await screen.findByRole("complementary", { name: "Thread" });
    const endedReads = calls.filter(
      (call) => call.path === "/api/v1/runs" && call.search.includes("activeSince"),
    );
    expect(endedReads).toHaveLength(1);
  });

  it("opens again on the work that ended while it was closed, read afresh, not on the last opening's reads", async () => {
    const aMomentAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    const stubRecords = (threads: readonly Session[], runs: readonly RunSummary[]) =>
      stubApi({
        ...buildSidebarHandlers({
          ...SIDEBAR_FIXTURE,
          threads,
          agentSessions: [REVIEW],
          runs,
          runSessions: [PLAN, REVIEW],
        }),
      });
    stubRecords(SIDEBAR_FIXTURE.threads, [LIVE_RUN]);
    mountOfficeScene.mockClear();
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
    const { router, live, context } = await renderApp(fake, { path: "/office" });
    await screen.findByRole("group", { name: "Who is doing what" });
    await live.waitForFirstPushes();
    await act(() => router.navigate({ to: "/" }));

    // While the Office is closed, the live run finishes and a thread is marked Done.
    const finishedAt = aMomentAgo(3);
    const finishedRun: RunSummary = {
      id: LIVE_RUN.id,
      workflowId: null,
      workflowName: "Review",
      origin: { kind: "manual", actor: "user" },
      createdAt: LIVE_RUN.createdAt,
      status: "completed",
      startedAt: LIVE_RUN.createdAt,
      finishedAt,
    };
    const doneAt = aMomentAgo(2);
    const doneThread: Session = {
      ...flakyAsking,
      openRequests: [],
      done: { at: doneAt, by: "user" },
    };
    stubRecords(
      SIDEBAR_FIXTURE.threads.map((thread) => (thread.id === doneThread.id ? doneThread : thread)),
      [finishedRun],
    );
    // The shell holds the `session` topic on every screen, so the thread
    // list learns of the Done mark at once. Nothing tells the Office's
    // cached live runs that the run finished.
    live.pushInvalidation("session", [doneThread.id]);
    await waitFor(() => {
      expect(context.queryClient.isFetching()).toBe(0);
    });
    await act(() => router.navigate({ to: "/office" }));
    await screen.findByRole("group", { name: "Who is doing what" });

    expect(mountOfficeScene).toHaveBeenCalledTimes(2);
    const [, , openingWorld, world] = mountOfficeScene.mock.calls[1]!;
    const leftAtById = new Map(openingWorld.colleagues.map(({ id, leftAt }) => [id, leftAt]));
    expect(leftAtById.get(doneThread.id)).toBe(doneAt);
    expect(leftAtById.get(REVIEW.id)).toBe(finishedAt);
    const present = world.colleagues.map(({ id }) => id);
    expect(present).not.toContain(doneThread.id);
    expect(present).not.toContain(REVIEW.id);
  });

  it("shows that the Office failed, rather than losing a live run's finished session, when a new run's read fails", async () => {
    const NEW_RUN = { ...LIVE_RUN, id: "01a06d02-7a00-7000-8000-000000000003" };
    let runs: readonly RunSummary[] = [LIVE_RUN];
    const sidebar = buildSidebarHandlers({
      ...SIDEBAR_FIXTURE,
      agentSessions: [REVIEW],
      runs: [LIVE_RUN],
      runSessions: [PLAN, REVIEW],
    });
    const answerSessions = sidebar["GET /api/v1/sessions"]!;
    const { context } = await openOfficeWithRuns({
      "GET /api/v1/runs": (call) => {
        const status = new URLSearchParams(call.search).get("status");
        return { body: { items: runs.filter((run) => run.status === status) } };
      },
      "GET /api/v1/sessions": (call) =>
        new URLSearchParams(call.search).getAll("runId").includes(NEW_RUN.id)
          ? { status: 500, body: buildErrorBody("unexpected", "The controller failed.") }
          : typeof answerSessions === "function"
            ? answerSessions(call)
            : answerSessions,
    });
    const counts = screen.getByRole("group", { name: "Who is doing what" });
    expect(within(counts).getByRole("button", { name: "1 done" })).toBeTruthy();

    runs = [LIVE_RUN, NEW_RUN];
    await act(() => context.queryClient.invalidateQueries({ queryKey: queryKeys.runs() }));

    expect(await screen.findByText(/Something went wrong rendering it/)).toBeTruthy();
  });
});
