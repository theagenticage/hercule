/**
 * Tests the shell route's data and wiring: the loader's reads, the live
 * connection that keeps them current, File > New Thread, Go > Office, and
 * what the shell sends main for the dock badge, the notifications and the Go
 * menu, and opens when main asks for a thread or an assistant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling } from "@hercule/client-core";
import type { OpenRequest, Session, SessionRequest } from "@hercule/contract";
import { ageClock } from "../../app/age-clock";
import { projectsQuery, threadsQuery } from "../../app/queries";
import {
  triggersQuery,
  waitingRunSessionsQuery,
  workflowListQuery,
} from "../../screens/workflows/workflow-queries";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  buildConversationHandlers,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  startApp,
  stubApi,
  THREAD_FIXTURES,
  type Call,
  type Handler,
  type LiveStub,
} from "../../app/testing";

// The shell runs `invalidateWithoutCancelling` once for each query key a push
// lists, so its calls count the pushes the app has handled. The function
// itself is the real one.
vi.mock("@hercule/client-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hercule/client-core")>();
  return { ...actual, invalidateWithoutCancelling: vi.fn(actual.invalidateWithoutCancelling) };
});

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

afterEach(() => {
  onlineManager.setOnline(true);
});

/** Counts the reads of one path, such as `/api/v1/sessions`, among `calls`. */
const countReads = (calls: readonly Call[], path: string): number =>
  calls.filter((call) => call.method === "GET" && call.path === path).length;

/** Ada, an assistant whose current session waits on the user's approval of `make deploy`. */
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

/** Checks whether `call` reads the current session of one conversation, as an assistant's pose needs. */
const readsConversation = (call: Call): boolean =>
  call.path === "/api/v1/sessions" && new URLSearchParams(call.search).has("conversationId");

/** Counts the reads of one conversation's current session among `calls`. */
const countConversationReads = (calls: readonly Call[], conversationId: string): number =>
  calls.filter(
    (call) =>
      readsConversation(call) &&
      new URLSearchParams(call.search).get("conversationId") === conversationId,
  ).length;

/** Milo, an assistant whose current session is idle. */
const MILO = buildFixtureAssistant({
  id: "01a06d02-7700-7000-8000-000000000003",
  name: "Milo",
  mainConversationId: "01a06d02-7800-7000-8000-000000000003",
});
const MILO_SESSION = buildFixtureAssistantSession(MILO, {
  id: "01a06d02-7400-7000-8000-000000000103",
  status: "idle",
});

/** The sidebar fixture's handlers, with Ada and her waiting session added. */
const WITH_ADA = {
  ...buildSidebarHandlers({
    ...SIDEBAR_FIXTURE,
    assistants: [{ assistant: ADA, session: ADA_SESSION }],
  }),
  // Ada's page reads her Conversation, which holds no message.
  ...buildConversationHandlers({ assistant: ADA, session: ADA_SESSION, messages: [] }),
};

/**
 * Starts the app signed in, at `path`, with the sidebar fixture and
 * `handlers` on top, and waits until the live connection holds the shell's
 * seven subscriptions and every read has settled, including the reads the
 * first connection makes.
 */
const startShell = async ({
  handlers = {},
  path = "/",
}: { readonly handlers?: Readonly<Record<string, Handler>>; readonly path?: string } = {}) => {
  const calls = stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  await waitForShellLive(app.live, app.context.queryClient);
  return { calls, fake, ...app };
};

/** Waits until the live connection holds the shell's seven subscriptions and no read is running. */
const waitForShellLive = async (live: LiveStub, queryClient: QueryClient): Promise<void> => {
  await waitFor(() => {
    expect([...live.readTopics()].sort()).toEqual([
      "assistant",
      "connection",
      "provider",
      "runner",
      "session",
      "task",
      "workspace",
    ]);
    expect(queryClient.isFetching()).toBe(0);
  });
};

describe("the shell's loader", () => {
  it("reads everything the sidebar shows before the shell renders", async () => {
    const { calls, context } = await startShell();
    for (const path of [
      "/api/v1/sessions",
      "/api/v1/projects",
      "/api/v1/workspaces",
      "/api/v1/resources",
      "/api/v1/runners",
      "/api/v1/providers",
      "/api/v1/user",
      "/api/v1/assistants",
    ]) {
      expect(countReads(calls, path), path).toBeGreaterThan(0);
    }
    const client = context.controller!.client;
    expect(context.queryClient.getQueryData(threadsQuery(client).queryKey)).toHaveLength(
      SIDEBAR_FIXTURE.threads.length,
    );
  });

  it("reads only threads, and follows the cursor to the last page", async () => {
    const [first, ...rest] = SIDEBAR_FIXTURE.threads;
    const { calls, context } = await startShell({
      handlers: {
        "GET /api/v1/sessions": (call) => ({
          body:
            new URLSearchParams(call.search).get("cursor") === null
              ? { items: [first], nextCursor: "page-2" }
              : { items: rest },
        }),
      },
    });
    const client = context.controller!.client;
    expect(context.queryClient.getQueryData(threadsQuery(client).queryKey)).toEqual(
      SIDEBAR_FIXTURE.threads,
    );
    const reads = calls.filter((call) => call.path === "/api/v1/sessions");
    expect(
      reads.slice(0, 2).map((call) => Object.fromEntries(new URLSearchParams(call.search))),
    ).toEqual([
      { thread: "true", limit: "500" },
      { thread: "true", limit: "500", cursor: "page-2" },
    ]);
  });

  it("waits for each assistant's current session before the shell renders", async () => {
    const held = holdAnswer();
    const calls = stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      ...WITH_ADA,
      "GET /api/v1/sessions": (call) =>
        readsConversation(call) ? held.handler() : { body: { items: SIDEBAR_FIXTURE.threads } },
    });
    await startApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }));
    await waitFor(() => {
      expect(calls.some(readsConversation)).toBe(true);
    });
    // Rendered now, the shell would show Ada idle until her session arrived.
    expect(screen.queryByRole("navigation", { name: "Assistants" })).toBeNull();

    held.answer({ body: { items: [ADA_SESSION] } });

    const section = await screen.findByRole("navigation", { name: "Assistants" });
    expect(within(section).getByRole("link", { name: "Ada, waiting on you" })).toBeTruthy();
  });

  it("shows the sign-in screen, with the caches emptied, when the controller rejects the saved token", async () => {
    stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      "GET /api/v1/user": { status: 401, body: buildErrorBody("unauthenticated", "token revoked") },
    });
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "revoked" });
    const { router, context } = await renderApp(fake);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(fake.tokenWrites).toEqual([null]);
    expect(await screen.findByRole("textbox", { name: "Username" })).toBeTruthy();
    // The other reads succeeded before the controller rejected the token.
    // Kept, they would show as the sidebar of whoever signs in next.
    const client = context.controller!.client;
    expect(context.queryClient.getQueryData(threadsQuery(client).queryKey)).toBeUndefined();
  });
});

describe("the shell's live connection", () => {
  it("reads the thread list again when a session push arrives", async () => {
    const { calls, live } = await startShell();
    const before = countReads(calls, "/api/v1/sessions");

    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.flaky]);
    });
    await waitFor(() => {
      expect(countReads(calls, "/api/v1/sessions")).toBe(before + 1);
    });
  });

  it("reads the thread list again on a push while Chromium reports the Mac offline", async () => {
    const { calls, live } = await startShell();
    const before = countReads(calls, "/api/v1/sessions");

    onlineManager.setOnline(false);
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.flaky]);
    });
    await waitFor(() => {
      expect(countReads(calls, "/api/v1/sessions")).toBe(before + 1);
    });
  });

  it("keeps at most one read running and one waiting through a storm of pushes, and ends on the last state", async () => {
    // The controller's thread list changes with every push. A read returns
    // the list as it was when the read arrived, and is answered only when
    // the test says so.
    let version = 0;
    let holdReads = false;
    let running = 0;
    let mostRunning = 0;
    const held: Array<() => void> = [];
    const buildThreads = (at: number): readonly Session[] => [
      { ...SIDEBAR_FIXTURE.threads[0]!, title: `version ${String(at)}` },
    ];
    const answerThreads: Handler = () => {
      const listed = { body: { items: buildThreads(version) } };
      if (!holdReads) return listed;
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      return new Promise((resolve) => {
        held.push(() => {
          running -= 1;
          resolve(listed);
        });
      });
    };
    const { calls, live, context } = await startShell({
      handlers: { "GET /api/v1/sessions": answerThreads },
    });
    const queryClient = context.queryClient;
    const threadsKey = threadsQuery(context.controller!.client).queryKey;
    holdReads = true;
    const before = countReads(calls, "/api/v1/sessions");

    // Counts the pushes the app has handled: each invalidates the `sessions`
    // prefix once.
    const invalidate = vi.mocked(invalidateWithoutCancelling);
    invalidate.mockClear();
    const countHandledPushes = () =>
      invalidate.mock.calls.filter(([, queryKey]) => JSON.stringify(queryKey) === '["sessions"]')
        .length;

    const PUSHES = 10;
    for (let push = 1; push <= PUSHES; push += 1) {
      version = push;
      act(() => {
        live.pushInvalidation("session");
      });
    }
    await waitFor(() => {
      expect(countHandledPushes()).toBe(PUSHES);
    });
    // The first push started a read, and every later one joined it.
    expect(countReads(calls, "/api/v1/sessions")).toBe(before + 1);
    expect(held).toHaveLength(1);

    // That read saw version 1. Once it is answered, one more read starts,
    // and sees the last version.
    act(() => {
      held.shift()!();
    });
    await waitFor(() => {
      expect(held).toHaveLength(1);
    });
    act(() => {
      held.shift()!();
    });
    await waitFor(() => {
      expect(queryClient.getQueryData<readonly Session[]>(threadsKey)?.[0]?.title).toBe(
        `version ${String(PUSHES)}`,
      );
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(countReads(calls, "/api/v1/sessions")).toBe(before + 2);
    expect(mostRunning).toBe(1);
  });

  it("reads the runners again on a runner push, and the providers on a provider push", async () => {
    const { calls, live } = await startShell();
    const runnersBefore = countReads(calls, "/api/v1/runners");
    const providersBefore = countReads(calls, "/api/v1/providers");

    act(() => {
      live.pushInvalidation("provider");
    });
    await waitFor(() => {
      expect(countReads(calls, "/api/v1/providers")).toBe(providersBefore + 1);
    });
    expect(countReads(calls, "/api/v1/runners")).toBe(runnersBefore);

    act(() => {
      live.pushInvalidation("runner", [SIDEBAR_FIXTURE.runners[0]!.id]);
    });
    await waitFor(() => {
      expect(countReads(calls, "/api/v1/runners")).toBe(runnersBefore + 1);
    });
  });

  it("reads the projects, workspaces and resources again after a reconnect, and has the age clock read the time", async () => {
    const { calls, live } = await startShell();
    // Workspace subscriptions cover changes since the loader read. Projects and resources have no topic yet.
    for (const path of ["/api/v1/projects", "/api/v1/workspaces", "/api/v1/resources"]) {
      expect(countReads(calls, path), path).toBe(path === "/api/v1/workspaces" ? 2 : 1);
    }
    const refresh = vi.spyOn(ageClock, "refresh");

    live.drop();
    await waitFor(
      () => {
        for (const path of ["/api/v1/projects", "/api/v1/workspaces", "/api/v1/resources"]) {
          expect(countReads(calls, path), path).toBe(path === "/api/v1/workspaces" ? 3 : 2);
        }
      },
      { timeout: 5000 },
    );
    expect(refresh).toHaveBeenCalled();
    refresh.mockRestore();
  });

  it("shows the sign-in screen when the controller rejects the token the live connection uses", async () => {
    stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      "POST /api/v1/auth/ws-ticket": {
        status: 401,
        body: buildErrorBody("unauthenticated", "token revoked"),
      },
    });
    const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "revoked" });
    const { router } = await renderApp(fake);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(fake.tokenWrites).toEqual([null]);
  });

  it("empties the caches when the controller rejects the token after the shell is up, so signing in again reads afresh", async () => {
    let revoked = false;
    const { calls, live, router, context } = await startShell({
      handlers: {
        "POST /api/v1/auth/ws-ticket": () =>
          revoked
            ? { status: 401, body: buildErrorBody("unauthenticated", "token revoked") }
            : { body: { ticket: "ws-ticket" } },
        "POST /api/v1/auth/login": {
          body: { token: "fresh-bearer", expiresAt: "2026-10-29T12:00:00.000Z" },
        },
      },
    });
    const projectsKey = projectsQuery(context.controller!.client).queryKey;
    expect(context.queryClient.getQueryData(projectsKey)).toBeDefined();

    // The token is revoked from another device, and the connection drops.
    // Reconnecting needs a ticket, which the controller refuses.
    revoked = true;
    live.drop();
    expect(
      await screen.findByRole("textbox", { name: "Username" }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(context.queryClient.getQueryData(projectsKey)).toBeUndefined();

    revoked = false;
    const projectReads = countReads(calls, "/api/v1/projects");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Username" }), "rogier");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(countReads(calls, "/api/v1/projects")).toBe(projectReads + 1);
  });
});

describe("File > New Thread", () => {
  it("opens the project picker, whose pick opens a Draft Thread in that project", async () => {
    const { fake, router } = await startShell({ path: `/threads/${FIXTURE_THREAD_IDS.runbook}` });

    fake.sendMenuCommand("newThread");
    const picker = await screen.findByRole("dialog", { name: "New thread in" });
    expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.runbook}`);

    await userEvent.click(within(picker).getByRole("button", { name: /^ops/ }));
    await waitFor(() => {
      expect(router.state.location.href).toBe(`/?project=${SIDEBAR_FIXTURE.projects[1]!.id}`);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the project picker also when there is no project, to offer No project and New project", async () => {
    const { fake, router } = await startShell({
      path: `/threads/${FIXTURE_THREAD_IDS.runbook}`,
      handlers: { "GET /api/v1/projects": { body: { items: [] } } },
    });

    fake.sendMenuCommand("newThread");
    const picker = await screen.findByRole("dialog", { name: "New thread in" });
    expect(
      within(picker)
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual(["No project", "New project"]);
    expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.runbook}`);
  });
});

describe("Go > Workflows", () => {
  it("opens Workflows, and closes the project picker", async () => {
    const { context, fake, router } = await startShell({
      path: `/threads/${FIXTURE_THREAD_IDS.runbook}`,
    });
    // The list's reads need a contract addition the controller does not
    // have yet, so the cache holds what they would read: no workflow.
    const client = context.controller!.client;
    context.queryClient.setQueryData(workflowListQuery().queryKey, []);
    context.queryClient.setQueryData(triggersQuery(client).queryKey, []);
    context.queryClient.setQueryData(waitingRunSessionsQuery().queryKey, []);
    fake.sendMenuCommand("newThread");
    await screen.findByRole("dialog", { name: "New thread in" });

    fake.sendMenuCommand("openWorkflows");

    expect(await screen.findByText("No workflows yet")).toBeTruthy();
    expect(router.state.location.href).toBe("/workflows");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Go > Office", () => {
  it("opens the Office, and closes the project picker", async () => {
    const { fake, router } = await startShell({ path: `/threads/${FIXTURE_THREAD_IDS.runbook}` });
    fake.sendMenuCommand("newThread");
    await screen.findByRole("dialog", { name: "New thread in" });

    fake.sendMenuCommand("openOffice");

    expect(await screen.findByText("The Office")).toBeTruthy();
    expect(router.state.location.href).toBe("/office");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a thread chosen in the Go menu in the Office's drawer while the Office is open", async () => {
    const { fake, router } = await startShell({
      path: "/office",
      handlers: buildThreadHandlers(THREAD_FIXTURES.finished),
    });

    fake.openDestination({ kind: "thread", sessionId: FIXTURE_THREAD_IDS.bunPin });

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: FIXTURE_THREAD_IDS.bunPin });
    });
    expect(router.state.location.pathname).toBe("/office");
  });

  it("opens a thread with no colleague in the Office on its own screen, even while the Office is open", async () => {
    const { fake, router } = await startShell({ path: "/office" });

    // "Rotate the backups key" has exited and cannot be resumed, so it is
    // away and has no colleague.
    fake.openDestination({ kind: "thread", sessionId: FIXTURE_THREAD_IDS.backupsKey });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.backupsKey}`);
    });
  });
});

/** The fixture's one waiting thread, as the shell sends it to main. */
const RUNBOOK_WAITING = {
  destination: { kind: "thread", sessionId: FIXTURE_THREAD_IDS.runbook },
  requestId: "req-1",
  openRequestIds: ["req-1"],
  title: "Write the retry runbook",
  body: "Run git push?",
};

describe("the threads and assistants waiting on the user", () => {
  it("are sent to main when the shell opens", async () => {
    const { fake } = await startShell();

    expect(fake.waitingLists).toEqual([[RUNBOOK_WAITING]]);
  });

  it("are sent to main with a waiting assistant under its name, newest first among the threads", async () => {
    const { fake } = await startShell({ handlers: WITH_ADA });

    expect(fake.waitingLists).toEqual([
      [
        RUNBOOK_WAITING,
        {
          destination: { kind: "assistant", assistantId: ADA.id },
          requestId: "req-ada",
          openRequestIds: ["req-ada"],
          title: "Ada",
          body: "Run make deploy?",
        },
      ],
    ]);
  });

  it("are sent to main again when a thread starts waiting, and when its Request is answered elsewhere", async () => {
    const TEST_REQUEST: OpenRequest = {
      requestId: "req-2",
      itemId: "tool-2",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "pnpm test" },
    };
    let threads = SIDEBAR_FIXTURE.threads;
    const setFlakyRequests = (openRequests: readonly OpenRequest[]): void => {
      threads = threads.map((thread) =>
        thread.id === FIXTURE_THREAD_IDS.flaky ? { ...thread, openRequests } : thread,
      );
    };
    const { fake, live } = await startShell({
      handlers: { "GET /api/v1/sessions": () => ({ body: { items: threads } }) },
    });

    setFlakyRequests([TEST_REQUEST]);
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.flaky]);
    });
    await waitFor(() => {
      expect(fake.waitingLists.at(-1)).toEqual([
        RUNBOOK_WAITING,
        {
          destination: { kind: "thread", sessionId: FIXTURE_THREAD_IDS.flaky },
          requestId: "req-2",
          openRequestIds: ["req-2"],
          title: "Fix flaky webhook tests",
          body: "Run pnpm test?",
        },
      ]);
    });

    // Answered elsewhere, such as in the web app.
    setFlakyRequests([]);
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.flaky]);
    });
    await waitFor(() => {
      expect(fake.waitingLists.at(-1)).toEqual([RUNBOOK_WAITING]);
    });
  });

  it("are sent to main with the newest of a thread's Requests for its notification, naming a subagent that asks", async () => {
    const buildCommandRequest = (requestId: string, command: string): SessionRequest => ({
      requestId,
      itemId: `tool-${requestId}`,
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command },
    });
    let threads = SIDEBAR_FIXTURE.threads;
    const setFlakyRequests = (openRequests: readonly SessionRequest[]): void => {
      threads = threads.map((thread) =>
        thread.id === FIXTURE_THREAD_IDS.flaky ? { ...thread, openRequests } : thread,
      );
      act(() => {
        live.pushInvalidation("session", [FIXTURE_THREAD_IDS.flaky]);
      });
    };
    const { fake, live } = await startShell({
      handlers: { "GET /api/v1/sessions": () => ({ body: { items: threads } }) },
    });
    const FLAKY = { kind: "thread", sessionId: FIXTURE_THREAD_IDS.flaky };
    const readFlaky = () =>
      fake.waitingLists
        .at(-1)
        ?.find((each) => JSON.stringify(each.destination) === JSON.stringify(FLAKY));

    setFlakyRequests([
      buildCommandRequest("req-2", "pnpm test"),
      {
        ...buildCommandRequest("req-3", "git push"),
        subagentId: "agent-1",
        subagentName: "Review the diff",
      },
    ]);
    await waitFor(() => {
      expect(readFlaky()).toEqual({
        destination: FLAKY,
        requestId: "req-3",
        openRequestIds: ["req-2", "req-3"],
        title: "Fix flaky webhook tests",
        body: "Review the diff asks: Run git push?\n+1 more waiting",
      });
    });

    // The subagent's Request is answered; the older one stays open.
    setFlakyRequests([buildCommandRequest("req-2", "pnpm test")]);
    await waitFor(() => {
      expect(readFlaky()).toMatchObject({ requestId: "req-2", openRequestIds: ["req-2"] });
    });
  });

  it("are not sent again when a change leaves them as they were", async () => {
    let threads = SIDEBAR_FIXTURE.threads;
    const { fake, live } = await startShell({
      handlers: { "GET /api/v1/sessions": () => ({ body: { items: threads } }) },
    });

    threads = threads.map((thread) =>
      thread.id === FIXTURE_THREAD_IDS.bunPin
        ? { ...thread, title: "Bump the Bun pin to 1.3" }
        : thread,
    );
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.bunPin]);
    });

    // The Go menu is sent the new title, so the page has read the changed list.
    await waitFor(() => {
      expect(fake.goMenus).toHaveLength(2);
    });
    expect(fake.waitingLists).toEqual([[RUNBOOK_WAITING]]);
  });
});

/** Returns the Go menu item that opens the thread `sessionId`, titled `title`. */
const buildThreadItem = (sessionId: string, title: string) => ({
  destination: { kind: "thread", sessionId },
  title,
});

describe("the Go menu", () => {
  it("sends main the sidebar's threads, top to bottom, once", async () => {
    const { fake } = await startShell();

    expect(fake.goMenus).toEqual([
      [
        buildThreadItem(FIXTURE_THREAD_IDS.runbook, "Write the retry runbook"),
        buildThreadItem(FIXTURE_THREAD_IDS.flaky, "Fix flaky webhook tests"),
        buildThreadItem(FIXTURE_THREAD_IDS.bunPin, "Bump the Bun pin"),
        buildThreadItem(FIXTURE_THREAD_IDS.backupsKey, "Rotate the backups key"),
        buildThreadItem(FIXTURE_THREAD_IDS.pricingPage, "Sketch the pricing page"),
      ],
    ]);
  });

  it("sends main a waiting assistant where Waiting on you shows it, under its name", async () => {
    const { fake } = await startShell({ handlers: WITH_ADA });

    expect(fake.goMenus.at(-1)?.slice(0, 3)).toEqual([
      buildThreadItem(FIXTURE_THREAD_IDS.runbook, "Write the retry runbook"),
      { destination: { kind: "assistant", assistantId: ADA.id }, title: "Ada" },
      buildThreadItem(FIXTURE_THREAD_IDS.flaky, "Fix flaky webhook tests"),
    ]);
  });

  it("sends main the threads again when the sidebar's threads change", async () => {
    let threads = SIDEBAR_FIXTURE.threads;
    const { fake, live } = await startShell({
      handlers: { "GET /api/v1/sessions": () => ({ body: { items: threads } }) },
    });

    threads = threads.map((thread) =>
      thread.id === FIXTURE_THREAD_IDS.bunPin
        ? { ...thread, title: "Bump the Bun pin to 1.3" }
        : thread,
    );
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.bunPin]);
    });

    await waitFor(() => {
      expect(fake.goMenus).toHaveLength(2);
    });
    expect(fake.goMenus[1]?.map((item) => item.title)).toEqual([
      "Write the retry runbook",
      "Fix flaky webhook tests",
      "Bump the Bun pin to 1.3",
      "Rotate the backups key",
      "Sketch the pricing page",
    ]);
  });

  it("opens the thread main asks for, and closes the project picker", async () => {
    const { fake, router } = await startShell();
    fake.sendMenuCommand("newThread");
    await screen.findByRole("dialog", { name: "New thread in" });

    fake.openDestination({ kind: "thread", sessionId: FIXTURE_THREAD_IDS.bunPin });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.bunPin}`);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the assistant main asks for on its screen, and closes the project picker", async () => {
    const { fake, router } = await startShell({ handlers: WITH_ADA });
    fake.sendMenuCommand("newThread");
    await screen.findByRole("dialog", { name: "New thread in" });

    fake.openDestination({ kind: "assistant", assistantId: ADA.id });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/assistants/${ADA.id}`);
    });
    expect(screen.queryByRole("dialog", { name: "New thread in" })).toBeNull();
  });

  it("opens the assistant main asks for in the Office's drawer while the Office is open", async () => {
    const { fake, router } = await startShell({ path: "/office", handlers: WITH_ADA });

    fake.openDestination({ kind: "assistant", assistantId: ADA.id });

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ assistant: ADA.id });
    });
    expect(router.state.location.pathname).toBe("/office");
  });
});

describe("the assistants", () => {
  it("are read again when the live connection reports a change to one", async () => {
    const { calls, live } = await startShell({ handlers: WITH_ADA });
    const reads = countReads(calls, "/api/v1/assistants");

    act(() => {
      live.pushInvalidation("assistant", [ADA.id]);
    });

    await waitFor(() => {
      expect(countReads(calls, "/api/v1/assistants")).toBe(reads + 1);
    });
  });

  describe("on a session push, read an assistant's current session again", () => {
    /** Starts the shell with Ada and Milo, and returns how often each one's current session was read. */
    const startWithAdaAndMilo = async () => {
      const shell = await startShell({
        handlers: buildSidebarHandlers({
          ...SIDEBAR_FIXTURE,
          assistants: [
            { assistant: ADA, session: ADA_SESSION },
            { assistant: MILO, session: MILO_SESSION },
          ],
        }),
      });
      const countReadsOf = () => ({
        ada: countConversationReads(shell.calls, ADA.mainConversationId),
        milo: countConversationReads(shell.calls, MILO.mainConversationId),
      });
      return { ...shell, countReadsOf };
    };

    /**
     * Pushes a `session` change naming `ids`, each with its conversation from
     * `conversationIds` when given, and waits until every read it starts has
     * settled.
     */
    const pushAndSettle = async (
      { calls, live, context }: Awaited<ReturnType<typeof startWithAdaAndMilo>>,
      ids?: readonly string[],
      conversationIds?: Readonly<Record<string, string | null>>,
    ) => {
      const threadReads =
        countReads(calls, "/api/v1/sessions") - calls.filter(readsConversation).length;
      act(() => {
        live.pushInvalidation("session", ids, conversationIds);
      });
      // The thread list is read again on every push, so its read marks the
      // push as handled.
      await waitFor(() => {
        expect(countReads(calls, "/api/v1/sessions") - calls.filter(readsConversation).length).toBe(
          threadReads + 1,
        );
        expect(context.queryClient.isFetching()).toBe(0);
      });
    };

    /** A session the app has never read, such as a new one. */
    const NEW_SESSION_ID = "01a06d02-7400-7000-8000-000000000999";

    it("for no assistant, when the push names only threads", async () => {
      const shell = await startWithAdaAndMilo();
      const before = shell.countReadsOf();

      await pushAndSettle(shell, [FIXTURE_THREAD_IDS.flaky, FIXTURE_THREAD_IDS.bunPin], {
        [FIXTURE_THREAD_IDS.flaky]: null,
        [FIXTURE_THREAD_IDS.bunPin]: null,
      });

      expect(shell.countReadsOf()).toEqual(before);
    });

    it("for no assistant, when the push names a session the app does not know in no conversation", async () => {
      // Such as a workflow run's session, which the desktop app never reads.
      const shell = await startWithAdaAndMilo();
      const before = shell.countReadsOf();

      await pushAndSettle(shell, [NEW_SESSION_ID], { [NEW_SESSION_ID]: null });

      expect(shell.countReadsOf()).toEqual(before);
    });

    it("for that assistant only, when the push names its current session", async () => {
      const shell = await startWithAdaAndMilo();
      const before = shell.countReadsOf();

      await pushAndSettle(shell, [ADA_SESSION.id, FIXTURE_THREAD_IDS.flaky], {
        [ADA_SESSION.id]: ADA.mainConversationId,
        [FIXTURE_THREAD_IDS.flaky]: null,
      });

      expect(shell.countReadsOf()).toEqual({ ada: before.ada + 1, milo: before.milo });
    });

    it("for that assistant only, when the push names a new session in its conversation", async () => {
      // The new session becomes Ada's current session, though the app has
      // never read it.
      const shell = await startWithAdaAndMilo();
      const before = shell.countReadsOf();

      await pushAndSettle(shell, [NEW_SESSION_ID], { [NEW_SESSION_ID]: ADA.mainConversationId });

      expect(shell.countReadsOf()).toEqual({ ada: before.ada + 1, milo: before.milo });
    });

    it("for every assistant, when the push does not name the conversation of a session", async () => {
      // A controller that predates `conversationIds` sends none, and the
      // session may then be a new one in any assistant's conversation.
      const shell = await startWithAdaAndMilo();
      const before = shell.countReadsOf();

      await pushAndSettle(shell, [FIXTURE_THREAD_IDS.flaky]);

      expect(shell.countReadsOf()).toEqual({ ada: before.ada + 1, milo: before.milo + 1 });
    });

    it("for every assistant, when the push names no session", async () => {
      const shell = await startWithAdaAndMilo();
      const before = shell.countReadsOf();

      await pushAndSettle(shell);

      expect(shell.countReadsOf()).toEqual({ ada: before.ada + 1, milo: before.milo + 1 });
    });
  });

  it("show the screen's failure, not an idle assistant, when a new assistant's session cannot be read", async () => {
    const ben = buildFixtureAssistant({
      id: "01a06d02-7700-7000-8000-000000000002",
      name: "Ben",
      mainConversationId: "01a06d02-7800-7000-8000-000000000002",
    });
    let assistants = [ADA];
    const { live } = await startShell({
      handlers: {
        ...WITH_ADA,
        "GET /api/v1/assistants": () => ({ body: { items: assistants } }),
        "GET /api/v1/sessions": (call) => {
          const conversationId = new URLSearchParams(call.search).get("conversationId");
          if (conversationId === null) return { body: { items: SIDEBAR_FIXTURE.threads } };
          if (conversationId === ben.mainConversationId) {
            return { status: 500, body: buildErrorBody("internal", "The database is locked.") };
          }
          return { body: { items: [ADA_SESSION] } };
        },
      },
    });

    assistants = [ADA, ben];
    act(() => {
      live.pushInvalidation("assistant", [ben.id]);
    });

    expect(await screen.findByRole("heading", { name: "This screen did not load" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Ben, idle" })).toBeNull();
  });

  it("keep an assistant's pose when its session cannot be read again", async () => {
    let failing = false;
    const { calls, context, live } = await startShell({
      handlers: {
        ...WITH_ADA,
        "GET /api/v1/sessions": (call) => {
          if (!readsConversation(call)) return { body: { items: SIDEBAR_FIXTURE.threads } };
          return failing
            ? { status: 500, body: buildErrorBody("internal", "The database is locked.") }
            : { body: { items: [ADA_SESSION] } };
        },
      },
    });
    const section = screen.getByRole("navigation", { name: "Assistants" });
    expect(within(section).getByRole("link", { name: "Ada, waiting on you" })).toBeTruthy();
    const reads = calls.filter(readsConversation).length;

    failing = true;
    act(() => {
      live.pushInvalidation("session", [ADA_SESSION.id]);
    });

    await waitFor(() => {
      expect(calls.filter(readsConversation).length).toBeGreaterThan(reads);
      expect(context.queryClient.isFetching()).toBe(0);
    });
    expect(within(section).getByRole("link", { name: "Ada, waiting on you" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This screen did not load" })).toBeNull();
  });
});
