/**
 * Tests the shell route's data and wiring: the loader's reads, the live
 * connection that keeps them current, and File > New Thread.
 *
 * Each test makes the sidebar's reads active with query observers of its
 * own, so that an invalidation reads again whatever the sidebar's components
 * happen to read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryObserver, type QueryClient } from "@tanstack/react-query";
import type { Session } from "@hercule/contract";
import { ageClock } from "../../app/age-clock";
import type { RouterContext } from "../../app/context";
import { invalidateWithoutCancelling } from "../../app/live-invalidation";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
  type LiveStub,
} from "../../app/testing";

// The shell runs `invalidateWithoutCancelling` once for each query key a push
// lists, so its calls count the pushes the app has handled. The function
// itself is the real one.
vi.mock("../../app/live-invalidation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/live-invalidation")>();
  return { ...actual, invalidateWithoutCancelling: vi.fn(actual.invalidateWithoutCancelling) };
});

/** The query observers the current test made, removed after it. */
const observers: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of observers.splice(0)) unsubscribe();
  onlineManager.setOnline(true);
});

/** Makes the sidebar's list reads active, as the sidebar's components do. */
const observeSidebarReads = (queryClient: QueryClient, context: RouterContext): void => {
  const client = context.controller!.client;
  for (const options of [
    threadsQuery(client),
    projectsQuery(client),
    workspacesQuery(client),
    resourcesQuery(client),
    runnersQuery(client),
    providersQuery(client),
  ]) {
    const observer = new QueryObserver(
      queryClient,
      options as ConstructorParameters<typeof QueryObserver>[1],
    );
    observers.push(observer.subscribe(() => {}));
  }
};

/** Counts the reads of one path, such as `/api/v1/sessions`, among `calls`. */
const countReads = (calls: readonly Call[], path: string): number =>
  calls.filter((call) => call.method === "GET" && call.path === path).length;

/**
 * Starts the app signed in, at `path`, with the sidebar fixture and
 * `handlers` on top, and waits until the live connection holds the shell's
 * four subscriptions and every read has settled, including the reads the
 * first connection makes.
 */
const startShell = async ({
  handlers = {},
  path = "/",
}: { readonly handlers?: Readonly<Record<string, Handler>>; readonly path?: string } = {}) => {
  const calls = stubApi({ ...buildSidebarHandlers(SIDEBAR_FIXTURE), ...handlers });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  observeSidebarReads(app.context.queryClient, app.context);
  await waitForShellLive(app.live, app.context.queryClient);
  return { calls, fake, ...app };
};

/** Waits until the live connection holds the shell's four subscriptions and no read is running. */
const waitForShellLive = async (live: LiveStub, queryClient: QueryClient): Promise<void> => {
  await waitFor(() => {
    expect([...live.readTopics()].sort()).toEqual(["provider", "runner", "session", "task"]);
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
            call.query.cursor === undefined
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
    expect(reads.slice(0, 2).map((call) => call.query)).toEqual([
      { thread: "true", limit: "500" },
      { thread: "true", limit: "500", cursor: "page-2" },
    ]);
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
    // The first connection does not read them: the loader just did.
    for (const path of ["/api/v1/projects", "/api/v1/workspaces", "/api/v1/resources"]) {
      expect(countReads(calls, path), path).toBe(1);
    }
    const refresh = vi.spyOn(ageClock, "refresh");

    live.drop();
    await waitFor(
      () => {
        for (const path of ["/api/v1/projects", "/api/v1/workspaces", "/api/v1/resources"]) {
          expect(countReads(calls, path), path).toBe(2);
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

  it("opens a Draft Thread in no project at once when there is no project to pick", async () => {
    const { fake, router } = await startShell({
      path: `/threads/${FIXTURE_THREAD_IDS.runbook}`,
      handlers: { "GET /api/v1/projects": { body: { items: [] } } },
    });

    fake.sendMenuCommand("newThread");
    await waitFor(() => {
      expect(router.state.location.href).toBe("/");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
