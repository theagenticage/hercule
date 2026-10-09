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
 * - Tab reaches a waiting assistant, among the waiting threads;
 * - an assistant's card shows its Request, its runner, its model and when it
 *   was last active, and an assistant with no session shows none of those;
 * - Open conversation, and an assistant's sidebar row, open its
 *   Conversation in the drawer, and the `assistant` param follows.
 * - an `assistant` param that no assistant has shows the assistant page's
 *   "not found" state, never the thread page's.
 *
 * jsdom draws no WebGL, so a stub that draws nothing stands in for the 3D
 * scene. Everything around the scene is the code that ships.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, SessionRequest } from "@hercule/contract";
import { queryKeys } from "@hercule/client-core";
import {
  buildConversationHandlers,
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
import { readOffice, setOffice } from "./office-store";

vi.mock("./office-scene", () => ({
  mountOfficeScene: () => ({ setWorld: () => undefined, dispose: () => undefined }),
}));

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
