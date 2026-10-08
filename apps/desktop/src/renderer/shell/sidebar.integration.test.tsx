/**
 * Tests the sidebar as the signed-in app renders it, against the stubbed
 * controller: what it lists, how assistive technology reads it, what its
 * links open, how few rows a live push draws again, and where keyboard focus
 * goes when the list changes under it.
 *
 * jsdom lays nothing out, so every element reports a height and a width of
 * 0, and the virtualized list would mount no row. Each test stubs
 * `offsetHeight` and `offsetWidth`, which the list reads to size its visible
 * part, as a 272 x 800 sidebar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describePose } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import {
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  NO_SIDEBAR_RECORDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type Handler,
  type SidebarRecords,
} from "../app/testing";
import { buildDraftKey } from "../app/pending-submissions";
import { ITEM_HEIGHTS } from "./sidebar-items";

// Every thread row names its thread with `describePose`, so its calls count
// the rows that drew. The function itself is the real one.
vi.mock("@hercule/client-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hercule/client-core")>();
  return { ...actual, describePose: vi.fn(actual.describePose) };
});

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(272, 800);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Starts the app signed in at `path`, with the controller holding `records`
 * and answering the thread list from `readThreads` when given, and returns
 * the thread list's `nav` with the app. `handlers` replace the controller's
 * answers to the operations they name.
 */
const startSidebar = async ({
  records = SIDEBAR_FIXTURE,
  readThreads,
  handlers = {},
  path = "/",
}: {
  readonly records?: SidebarRecords;
  readonly readThreads?: () => readonly Session[];
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly path?: string;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(records),
    ...(readThreads === undefined
      ? {}
      : { "GET /api/v1/sessions": () => ({ body: { items: readThreads() } }) }),
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  return { calls, nav, ...app };
};

/** "Sketch the pricing page": idle, in no project. The base of the threads a test makes. */
const PLAIN_THREAD = SIDEBAR_FIXTURE.threads[4]!;

/** The command approval "Write the retry runbook" waits on. */
const APPROVAL = SIDEBAR_FIXTURE.threads[0]!.openRequests[0]!;

/**
 * Returns `count` threads titled "Thread 1" to "Thread <count>", the last the
 * newest, each created when it was last active, and each with `over` applied.
 * Their ids are UUIDv7s the contract accepts.
 */
const buildThreads = (count: number, over: Partial<Session> = {}): Session[] =>
  Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 8, 10, 8, 0, index)).toISOString();
    return {
      ...PLAIN_THREAD,
      id: `01a06d02-7400-7000-8000-${String(1000 + index).padStart(12, "0")}`,
      title: `Thread ${String(index + 1)}`,
      createdAt: at,
      lastActivityAt: at,
      ...over,
    };
  }).reverse();

/** Returns the text of the sidebar's thread counts, such as "1 working · 1 waiting · 2 idle". */
const readCounts = (): string | null => document.querySelector(".side-sum")?.textContent ?? null;

/** Returns the key of the list item that holds keyboard focus, or `null` when none does. */
const readFocusedKey = (): string | null =>
  document.activeElement?.closest("[data-key]")?.getAttribute("data-key") ?? null;

describe("the sidebar", () => {
  it("lists Waiting on you, then each project, each thread named by its title and its state", async () => {
    const { nav } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });

    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Waiting on you 1", "webshop", "ops", "No project"]);
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label") ?? link.getAttribute("title")),
    ).toEqual([
      "Write the retry runbook, waiting on you",
      "New thread in webshop",
      "Write the retry runbook, waiting on you",
      "Fix flaky webhook tests, working",
      "Bump the Bun pin, idle",
      "New thread in ops",
      "Rotate the backups key, can't be reached",
      "New thread in no project",
      "Sketch the pricing page, idle",
    ]);
    expect(readCounts()).toBe("1 working · 1 waiting · 2 idle");
    expect(screen.getByText("rogier")).toBeTruthy();
  });

  it(`heads the threads in no project "No project", with an outline tile and a +, above those threads`, async () => {
    const { nav, router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });

    const heading = within(nav).getByRole("heading", { name: "No project" });
    // `proj--none` draws the tile as an empty outline, in no project's tint.
    expect(heading.querySelector(".proj")?.className).toBe("proj proj--none");
    // The heading is the last section's, so every item below it is in its group.
    const items = [...nav.querySelectorAll(".side-item")];
    expect(
      items.slice(items.indexOf(heading) + 1).map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Sketch the pricing page, idle"]);
    await userEvent.click(within(heading).getByRole("link", { name: "New thread in no project" }));
    await waitFor(() => {
      expect(router.state.location.href).toBe("/");
    });
  });

  it("describes each row by its question, or by its model, its project, workspace, machine and branch, and its age", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T09:25:00.000Z"), toFake: ["Date"] });
    const { nav } = await startSidebar();

    const [waitingRow, projectRow] = within(nav).getAllByRole("link", {
      name: "Write the retry runbook, waiting on you",
    });
    expect(waitingRow!.getAttribute("aria-describedby")).not.toBeNull();
    expect(
      within(nav).getByRole("link", {
        name: "Write the retry runbook, waiting on you",
        description: "Run git push?",
      }),
    ).toBe(waitingRow);
    // In its project the row ends with the waiting mark, which the name
    // already says, so the end does not describe it. A worktree's name is its
    // branch, so the branch is not named again.
    expect(
      within(nav).getByRole("link", {
        name: "Write the retry runbook, waiting on you",
        description: "claude-sonnet-5 in webshop, workspace hercule/thread-3f1, on moss",
      }),
    ).toBe(projectRow);
    expect(
      within(nav).getByRole("link", {
        name: "Bump the Bun pin, idle",
        description:
          "claude-sonnet-5 in webshop, webshop main workspace, on moss, branch main 22 minutes ago",
      }),
    ).toBeTruthy();
    expect(
      within(nav).getByRole("link", {
        name: "Rotate the backups key, can't be reached",
        description: "claude-sonnet-5 in ops, no workspace, on moss 23 minutes ago",
      }),
    ).toBeTruthy();
  });

  it("hides every face, mark and avatar from assistive technology", async () => {
    const { nav } = await startSidebar();
    const sidebar = nav.closest("aside")!;

    expect(sidebar.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(within(sidebar).queryAllByRole("img")).toEqual([]);
  });

  it("marks the open thread as the current page in both places it is listed", async () => {
    const { nav } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.runbook}` });

    const current = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Write the retry runbook, waiting on you",
      "Write the retry runbook, waiting on you",
    ]);
    for (const link of current) expect(link.classList.contains("is-on")).toBe(true);
  });

  it("opens a new thread in a project from its +", async () => {
    const { nav, router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
    const [webshop, ops] = SIDEBAR_FIXTURE.projects;

    const readHref = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(readHref("New thread in webshop")).toBe(`/?project=${webshop!.id}`);
    expect(readHref("New thread in ops")).toBe(`/?project=${ops!.id}`);

    await userEvent.click(within(nav).getByRole("link", { name: "New thread in webshop" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ project: webshop!.id });
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("puts New thread, Search and the Office in one row, each named with its shortcut", async () => {
    await startSidebar();

    const actions = document.querySelector(".side-actions")!;
    expect(
      [...actions.children].map((action) => [
        action.tagName,
        action.getAttribute("title") ?? action.textContent,
      ]),
    ).toEqual([
      ["BUTTON", "New thread ⌘N"],
      ["BUTTON", "Search ⌘K"],
      ["A", "Office ⌘⇧O"],
    ]);
  });

  it("opens the Office from its button, and marks the button as the current page while the Office is open", async () => {
    const { router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
    const office = screen.getByRole("link", { name: "Office ⌘⇧O" });
    expect(office.getAttribute("aria-current")).toBeNull();

    await userEvent.click(office);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/office");
    });
    expect(office.getAttribute("aria-current")).toBe("page");
    expect(office.classList.contains("is-on")).toBe(true);
    expect(await screen.findByText("The Office")).toBeTruthy();
  });

  it("opens a thread in the Office's drawer while the Office is open, and marks its row as the current page", async () => {
    const { nav, router } = await startSidebar({
      path: "/office",
      handlers: buildThreadHandlers(THREAD_FIXTURES.finished),
    });
    const bunPin = within(nav).getByRole("link", { name: "Bump the Bun pin, idle" });
    expect(bunPin.getAttribute("href")).toBe(`/office?session=${FIXTURE_THREAD_IDS.bunPin}`);

    await userEvent.click(bunPin);
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ session: FIXTURE_THREAD_IDS.bunPin });
    });
    expect(router.state.location.pathname).toBe("/office");
    const current = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Bump the Bun pin, idle",
    ]);
    expect(screen.getByRole("link", { name: "Office ⌘⇧O" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("opens a thread with no colleague in the Office on its own screen, even while the Office is open", async () => {
    const { nav } = await startSidebar({ path: "/office" });

    expect(
      within(nav)
        .getByRole("link", { name: "Rotate the backups key, can't be reached" })
        .getAttribute("href"),
    ).toBe(`/threads/${FIXTURE_THREAD_IDS.backupsKey}`);
    // A waiting thread always has a colleague, in its row of Waiting on you
    // and in its project's.
    expect(
      within(nav)
        .getAllByRole("link", { name: "Write the retry runbook, waiting on you" })
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      `/office?session=${FIXTURE_THREAD_IDS.runbook}`,
      `/office?session=${FIXTURE_THREAD_IDS.runbook}`,
    ]);
  });

  it("opens a thread on its own screen again once the Office is closed", async () => {
    const { nav, router } = await startSidebar({ path: "/office" });

    await act(() => router.navigate({ to: "/" }));
    expect(
      within(nav).getByRole("link", { name: "Bump the Bun pin, idle" }).getAttribute("href"),
    ).toBe(`/threads/${FIXTURE_THREAD_IDS.bunPin}`);
  });

  it("opens the project picker from New thread", async () => {
    await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });

    await userEvent.click(screen.getByRole("button", { name: "New thread ⌘N" }));
    expect(await screen.findByRole("dialog", { name: "New thread in" })).toBeTruthy();
  });

  it("draws the Draft Thread as the current, first row of its project, saying where it will work, and follows the pick", async () => {
    const [webshop] = SIDEBAR_FIXTURE.projects;
    const [, thread3f1] = SIDEBAR_FIXTURE.workspaces;
    const { nav, router } = await startSidebar({
      path: `/?project=${webshop!.id}&workspace=${thread3f1!.id}`,
    });

    /** Returns the key of each item from the draft's project heading to its last thread row. */
    const readDraftProject = (): readonly (string | null)[] => {
      const keys = [...nav.querySelectorAll(".side-item")].map((item) =>
        item.getAttribute("data-key"),
      );
      return keys.slice(
        keys.indexOf(`header:project:${webshop!.id}`),
        keys.indexOf(`thread:${FIXTURE_THREAD_IDS.bunPin}`) + 1,
      );
    };
    const draft = await waitFor(() => {
      const row = nav.querySelector<HTMLElement>('[data-key="draft"]');
      expect(row).not.toBeNull();
      return row!;
    });
    expect(draft.getAttribute("aria-current")).toBe("page");
    expect(draft.textContent).toBe("New thread" + "hercule/thread-3f1 · moss" + "draft");
    // The draft's project comes first, and the draft is its first row.
    expect(readDraftProject()).toEqual([
      `header:project:${webshop!.id}`,
      "draft",
      `thread:${FIXTURE_THREAD_IDS.runbook}`,
      `thread:${FIXTURE_THREAD_IDS.flaky}`,
      `thread:${FIXTURE_THREAD_IDS.bunPin}`,
    ]);

    const { pendingSubmissions } = router.options.context.controller!;
    const key = buildDraftKey(webshop!.id, thread3f1!.id);
    act(() => {
      pendingSubmissions.writePicks(key, {
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: SIDEBAR_FIXTURE.resources[0]!.id }],
        },
      });
    });
    expect(nav.querySelector('[data-key="draft"]')?.textContent).toBe(
      "New thread" + "New workspace · moss" + "draft",
    );
    expect(readDraftProject()[1]).toBe("draft");
  });

  it(`draws a Draft Thread in no project as the first row under "No project", which stays last`, async () => {
    const { nav } = await startSidebar();

    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Waiting on you 1", "webshop", "ops", "No project"]);
    const heading = within(nav).getByRole("heading", { name: "No project" });
    const items = [...nav.querySelectorAll(".side-item")];
    expect(items.slice(items.indexOf(heading) + 1).map((item) => item.textContent)).toEqual([
      "New thread" + "No workspace · moss" + "draft",
      expect.stringContaining("Sketch the pricing page"),
    ]);
  });

  it("tints the draft's row, and a thread's row while its composer holds unsent text, with a pencil before the title", async () => {
    const { nav, router } = await startSidebar();
    const { pendingSubmissions } = router.options.context.controller!;
    /** Returns whether `row` is tinted and has a pencil before its title. */
    const isMarkedUnsent = (row: Element): boolean =>
      row.classList.contains("is-unsent") && row.querySelector(".side-name svg") !== null;
    const draft = await waitFor(() => {
      const row = nav.querySelector('[data-key="draft"]');
      expect(row).not.toBeNull();
      return row!;
    });
    const bunPin = () => within(nav).getByRole("link", { name: /^Bump the Bun pin/ });

    expect(isMarkedUnsent(draft)).toBe(true);
    expect(isMarkedUnsent(bunPin())).toBe(false);

    act(() => {
      pendingSubmissions.writeText(FIXTURE_THREAD_IDS.bunPin, "Also bump Node");
    });
    expect(isMarkedUnsent(bunPin())).toBe(true);
    expect(bunPin().getAttribute("aria-label")).toBe("Bump the Bun pin, idle, unsent message");

    act(() => {
      pendingSubmissions.writeText(FIXTURE_THREAD_IDS.bunPin, "");
    });
    expect(isMarkedUnsent(bunPin())).toBe(false);
    expect(bunPin().getAttribute("aria-label")).toBe("Bump the Bun pin, idle");
  });

  it("draws Hide the sidebar and Search as buttons that do nothing yet", async () => {
    const { calls, router, live } = await startSidebar({
      path: `/threads/${FIXTURE_THREAD_IDS.flaky}`,
    });
    await live.waitForFirstPushes();
    const buttons = [
      screen.getByRole("button", { name: "Hide the sidebar" }),
      screen.getByRole("button", { name: "Search ⌘K" }),
    ];
    const href = router.state.location.href;
    const sent = calls.length;

    for (const button of buttons) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      await userEvent.click(button);
    }
    expect(router.state.location.href).toBe(href);
    expect(calls).toHaveLength(sent);
    expect(screen.getByRole("navigation", { name: "Threads" })).toBeTruthy();
  });

  it("draws again only the row whose thread a live push changed", async () => {
    let threads: readonly Session[] = SIDEBAR_FIXTURE.threads;
    const { nav, live } = await startSidebar({ readThreads: () => threads });
    await waitFor(() => {
      expect(live.readTopics()).toContain("session");
    });
    const drawn = vi.mocked(describePose);
    drawn.mockClear();

    threads = threads.map((session) =>
      session.id === FIXTURE_THREAD_IDS.flaky ? { ...session, status: "idle" } : session,
    );
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.flaky]);
    });

    await within(nav).findByRole("link", { name: "Fix flaky webhook tests, idle" });
    expect(drawn.mock.calls).toEqual([["idle"]]);
    expect(readCounts()).toBe("0 working · 1 waiting · 3 idle");
  });

  it("draws only the new rows when a new thread pushes every row below it down", async () => {
    let threads: readonly Session[] = SIDEBAR_FIXTURE.threads;
    const { nav, live } = await startSidebar({ readThreads: () => threads });
    await waitFor(() => {
      expect(live.readTopics()).toContain("session");
    });
    const drawn = vi.mocked(describePose);
    drawn.mockClear();

    // A new thread in webshop waits on an approval: a row at the top of
    // Waiting on you and a row at the top of webshop, with every row below
    // each of them moving down.
    const [primary] = SIDEBAR_FIXTURE.workspaces;
    const [arrived] = buildThreads(1, {
      title: "Pin the lockfile",
      status: "busy",
      openRequests: [APPROVAL],
      projectId: SIDEBAR_FIXTURE.projects[0]!.id,
      workspaceId: primary!.id,
      createdAt: "2026-09-10T09:06:00.000Z",
      lastActivityAt: "2026-09-10T09:06:00.000Z",
    });
    threads = [arrived!, ...threads];
    act(() => {
      live.pushInvalidation("session", [arrived!.id]);
    });

    await waitFor(() => {
      expect(
        within(nav).getAllByRole("link", { name: "Pin the lockfile, waiting on you" }),
      ).toHaveLength(2);
    });
    expect(drawn.mock.calls).toEqual([["waiting"], ["waiting"]]);
    expect(within(nav).getByRole("heading", { name: "Waiting on you 2" })).toBeTruthy();
  });

  it("shows the 3 newest waiting threads, and shows the rest in place from the more row, focusing the first of them", async () => {
    const waiting = buildThreads(5, { status: "busy", openRequests: [APPROVAL] });
    const { nav } = await startSidebar({ records: { ...NO_SIDEBAR_RECORDS, threads: waiting } });

    const listWaitingRows = () =>
      [...nav.querySelectorAll("[data-key^='waiting:']")].map((row) => row.textContent);
    expect(listWaitingRows()).toEqual([
      "Thread 5Run git push?",
      "Thread 4Run git push?",
      "Thread 3Run git push?",
    ]);
    expect(within(nav).getByRole("heading", { name: "Waiting on you 5" })).toBeTruthy();

    await userEvent.click(within(nav).getByRole("button", { name: "2 more waiting on you" }));

    expect(listWaitingRows()).toHaveLength(5);
    expect(within(nav).queryByRole("button", { name: /more/ })).toBeNull();
    expect(readFocusedKey()).toBe(`waiting:thread:${waiting[3]!.id}`);
  });

  it("shows 5 threads of a project, and every thread once its more row is pressed", async () => {
    const webshop = SIDEBAR_FIXTURE.projects[0]!;
    const threads = buildThreads(8, { projectId: webshop.id });
    const { nav } = await startSidebar({
      records: { ...SIDEBAR_FIXTURE, threads },
    });

    expect(nav.querySelectorAll("[data-key^='thread:']")).toHaveLength(5);
    const more = within(nav).getByRole("button", { name: "3 more threads" });

    more.focus();
    await userEvent.keyboard("{Enter}");

    expect(nav.querySelectorAll("[data-key^='thread:']")).toHaveLength(8);
    expect(readFocusedKey()).toBe(`thread:${threads[5]!.id}`);
  });

  it("mounts only the rows near the visible part of a long list, and keeps the focused row mounted", async () => {
    const webshop = SIDEBAR_FIXTURE.projects[0]!;
    const threads = buildThreads(500, { projectId: webshop.id });
    const { nav } = await startSidebar({ records: { ...SIDEBAR_FIXTURE, threads } });

    await userEvent.click(within(nav).getByRole("button", { name: "495 more threads" }));
    const focused = `thread:${threads[5]!.id}`;
    expect(readFocusedKey()).toBe(focused);
    expect(nav.querySelectorAll("[data-key]").length).toBeLessThanOrEqual(45);

    // Scroll far down the list, to about the 235th row: the rows there
    // mount, and the focused row, far above them, stays.
    act(() => {
      Object.defineProperty(nav, "scrollTop", {
        configurable: true,
        value: 235 * ITEM_HEIGHTS["thread-row"],
      });
      fireEvent.scroll(nav);
    });
    await waitFor(() => {
      expect(within(nav).queryByRole("link", { name: "Thread 260, idle" })).not.toBeNull();
    });
    expect(nav.querySelectorAll("[data-key]").length).toBeLessThanOrEqual(45);
    expect(readFocusedKey()).toBe(focused);
    expect(within(nav).queryByRole("link", { name: "Thread 495, idle" })).not.toBeNull();
  });

  it("moves focus to Waiting on you when the focused waiting row is answered", async () => {
    let threads: readonly Session[] = [
      ...SIDEBAR_FIXTURE.threads,
      { ...buildThreads(1)[0]!, status: "busy", openRequests: [APPROVAL] },
    ];
    const { nav, live } = await startSidebar({ readThreads: () => threads });
    await waitFor(() => {
      expect(live.readTopics()).toContain("session");
    });
    const [waitingRow] = within(nav).getAllByRole("link", {
      name: "Write the retry runbook, waiting on you",
    });
    act(() => {
      waitingRow!.focus();
    });
    expect(readFocusedKey()).toBe(`waiting:thread:${FIXTURE_THREAD_IDS.runbook}`);

    threads = threads.map((session) =>
      session.id === FIXTURE_THREAD_IDS.runbook ? { ...session, openRequests: [] } : session,
    );
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.runbook]);
    });

    await waitFor(() => {
      expect(
        nav.querySelector(`[data-key='waiting:thread:${FIXTURE_THREAD_IDS.runbook}']`),
      ).toBeNull();
    });
    expect(readFocusedKey()).toBe("header:waiting");
    expect(document.activeElement?.textContent).toBe("Waiting on you 1");
  });

  it("lists only the Draft Thread when there are no threads", async () => {
    const { nav } = await startSidebar({ records: NO_SIDEBAR_RECORDS });

    const items = [...nav.querySelectorAll(".side-item")].map((item) => item.textContent);
    expect(items).toEqual(["No project", "New thread" + "No workspace · no machine" + "draft"]);
    expect(within(nav).queryByText("No threads yet")).toBeNull();
    expect(readCounts()).toBe("0 working · 0 waiting · 0 idle");
  });

  it("says so when there are no threads and no draft is open", async () => {
    // The last thread was deleted while it was open, so the thread screen
    // says it was not found, and no draft is being written.
    const { nav } = await startSidebar({
      records: NO_SIDEBAR_RECORDS,
      path: "/threads/01a06d02-7400-7000-8000-0000000000ff",
    });

    expect(screen.getByRole("heading", { name: "This thread was not found." })).toBeTruthy();
    expect(within(nav).getByText("No threads yet")).toBeTruthy();
    expect(within(nav).queryAllByRole("link")).toEqual([]);
  });
});

describe("the sidebar's assistants", () => {
  const ADA = buildFixtureAssistant({
    id: "01a06d02-7700-7000-8000-000000000001",
    name: "Ada",
    mainConversationId: "01a06d02-7800-7000-8000-000000000001",
  });
  const MILO = buildFixtureAssistant({
    id: "01a06d02-7700-7000-8000-000000000002",
    name: "Milo",
    mainConversationId: "01a06d02-7800-7000-8000-000000000002",
  });
  /** Ada's current session, waiting on the user's approval of `git push`, older than every thread. */
  const ADA_WAITING = buildFixtureAssistantSession(ADA, {
    id: "01a06d02-7400-7000-8000-000000000101",
    status: "busy",
    openRequests: [APPROVAL],
    lastActivityAt: "2026-09-10T08:00:00.000Z",
  });

  it("lists every assistant, by name, in the pinned section between the threads and the foot", async () => {
    await startSidebar({
      records: {
        ...SIDEBAR_FIXTURE,
        assistants: [
          { assistant: MILO, session: null },
          { assistant: ADA, session: ADA_WAITING },
        ],
      },
    });

    const section = screen.getByRole("navigation", { name: "Assistants" });
    expect(
      within(section)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Ada, waiting on you", "Milo, idle"]);
    expect(section.nextElementSibling?.classList.contains("side-foot")).toBe(true);
    // The foot counts threads only, not the waiting assistant.
    expect(readCounts()).toBe("1 working · 1 waiting · 2 idle");
  });

  it("lists a waiting assistant in Waiting on you, linked to its screen", async () => {
    const { nav } = await startSidebar({
      records: { ...SIDEBAR_FIXTURE, assistants: [{ assistant: ADA, session: ADA_WAITING }] },
    });

    const row = nav.querySelector(`[data-key='waiting:assistant:${ADA.id}']`)!;
    expect(row.getAttribute("href")).toBe(`/assistants/${ADA.id}`);
    expect(row.textContent).toBe("Ada" + "Run git push?");
    expect(within(nav).getByText("Waiting on you").parentElement?.textContent).toBe(
      "Waiting on you 2",
    );
  });

  it("shows the section also when there are no threads", async () => {
    await startSidebar({
      records: { ...NO_SIDEBAR_RECORDS, assistants: [{ assistant: MILO, session: null }] },
    });
    expect(screen.getByRole("navigation", { name: "Assistants" })).toBeTruthy();
  });

  it("draws no section when there are no assistants", async () => {
    await startSidebar();
    expect(screen.queryByRole("navigation", { name: "Assistants" })).toBeNull();
  });
});

describe("the sidebar's card of thread details", () => {
  /** Returns the text of the card beside the sidebar, empty while it is hidden. */
  const readCard = (): string => document.querySelector(".thread-hover")?.textContent ?? "";

  /**
   * Starts the sidebar, with the controller answering the thread list from
   * `readThreads` when given, then fakes the timers, so the hover delay runs
   * only when a test advances it. Returns the list, the live connection, and
   * the rows of "Bump the Bun pin" and "Fix flaky webhook tests".
   *
   * With `readThreads`, it first waits for the live connection to subscribe
   * to the threads, so a test can push a change to them.
   */
  const startHovering = async (readThreads?: () => readonly Session[]) => {
    const { nav, live } = await startSidebar(readThreads === undefined ? {} : { readThreads });
    if (readThreads !== undefined) {
      await waitFor(() => {
        expect(live.readTopics()).toContain("session");
      });
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return {
      nav,
      live,
      bunPin: within(nav).getByRole("link", { name: "Bump the Bun pin, idle" }),
      flaky: within(nav).getByRole("link", { name: "Fix flaky webhook tests, working" }),
    };
  };

  /** Returns the card's `top` style, such as "140px". */
  const readCardTop = (): string =>
    document.querySelector<HTMLElement>(".thread-hover")?.style.top ?? "";

  /** Moves the pointer onto `row`, and rests it there until the card shows. */
  const restOn = (row: HTMLElement): void => {
    fireEvent.pointerOver(row);
    act(() => {
      vi.advanceTimersByTime(400);
    });
  };

  it("shows a thread's details once the pointer rests on its row for 400ms, and switches at once to another row", async () => {
    const { bunPin, flaky } = await startHovering();

    fireEvent.pointerOver(bunPin);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(readCard()).toBe("");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(readCard()).toBe("Bump the Bun pin" + "webshop" + "moss" + "main" + "claude-sonnet-5");

    fireEvent.pointerOver(flaky);
    expect(readCard()).toContain("Fix flaky webhook tests");
  });

  it("shows no card when the pointer leaves the row before 400ms", async () => {
    const { bunPin } = await startHovering();

    fireEvent.pointerOver(bunPin);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerOut(bunPin, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(readCard()).toBe("");
  });

  it.each<[string, (rows: { nav: HTMLElement; bunPin: HTMLElement }) => void]>([
    [
      "the pointer leaves the list",
      ({ bunPin }) => fireEvent.pointerOut(bunPin, { relatedTarget: document.body }),
    ],
    [
      "the pointer moves to a project's header",
      ({ nav }) => fireEvent.pointerOver(within(nav).getByRole("heading", { name: "ops" })),
    ],
    ["the row is pressed", ({ bunPin }) => fireEvent.pointerDown(bunPin)],
    ["the list scrolls", ({ nav }) => fireEvent.scroll(nav)],
    ["the window is resized", () => fireEvent(window, new Event("resize"))],
  ])("hides the card at once when %s", async (_, hide) => {
    const rows = await startHovering();
    restOn(rows.bunPin);
    expect(readCard()).toContain("Bump the Bun pin");

    hide(rows);
    expect(readCard()).toBe("");
  });

  it("keeps a card that shows in the space between two rows, and cancels one that waits for the delay", async () => {
    const { nav, bunPin } = await startHovering();
    const gap = nav.querySelector(".side-list")!;

    restOn(bunPin);
    fireEvent.pointerOver(gap);
    expect(readCard()).toContain("Bump the Bun pin");

    fireEvent.pointerOut(bunPin, { relatedTarget: document.body });
    fireEvent.pointerOver(bunPin);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerOver(gap);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(readCard()).toBe("");
  });

  it("does not show the card again after a press while the pointer stays on the pressed row", async () => {
    const { bunPin, flaky } = await startHovering();
    restOn(bunPin);

    fireEvent.pointerDown(bunPin);
    // The pointer moves from the row's title to its second line, and rests.
    restOn(bunPin.querySelector(".side-name")!);
    restOn(bunPin.querySelector(".side-meta")!);
    expect(readCard()).toBe("");

    restOn(flaky);
    expect(readCard()).toContain("Fix flaky webhook tests");
  });

  it("hides the card when its thread leaves the list", async () => {
    let threads: readonly Session[] = SIDEBAR_FIXTURE.threads;
    const { bunPin, live } = await startHovering(() => threads);
    restOn(bunPin);
    expect(readCard()).toContain("Bump the Bun pin");
    vi.useRealTimers();

    threads = threads.filter((session) => session.id !== FIXTURE_THREAD_IDS.bunPin);
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.bunPin]);
    });

    await waitFor(() => {
      expect(readCard()).toBe("");
    });
  });

  it("keeps the card beside its row when a new thread arrives above the row", async () => {
    // jsdom lays nothing out, so each list item reports a top from its place
    // among the items, 51px apart, and the card reports a height that fits
    // the window, so its top is not moved to keep it inside.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const index = this.hasAttribute("data-key")
        ? [...this.parentElement!.children].indexOf(this)
        : 0;
      return DOMRect.fromRect({ x: 0, y: index * 59, width: 272, height: 59 });
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("thread-hover") ? 100 : 800;
    });
    const bunPinThread = SIDEBAR_FIXTURE.threads.find(
      (session) => session.id === FIXTURE_THREAD_IDS.bunPin,
    )!;
    let threads: readonly Session[] = SIDEBAR_FIXTURE.threads;
    const { nav, bunPin, live } = await startHovering(() => threads);
    restOn(bunPin);
    const topBefore = readCardTop();
    expect(topBefore).toBe(`${String(bunPin.getBoundingClientRect().top)}px`);
    vi.useRealTimers();

    const [newest] = buildThreads(1, {
      projectId: bunPinThread.projectId,
      createdAt: "2026-09-10T09:10:00.000Z",
    });
    threads = [newest!, ...threads];
    act(() => {
      live.pushInvalidation("session", [newest!.id]);
    });

    await waitFor(() => {
      expect(within(nav).getByRole("link", { name: "Thread 1, idle" })).toBeTruthy();
    });
    const row = within(nav).getByRole("link", { name: "Bump the Bun pin, idle" });
    expect(readCardTop()).toBe(`${String(row.getBoundingClientRect().top)}px`);
    expect(readCardTop()).not.toBe(topBefore);
    expect(readCard()).toContain("Bump the Bun pin");
  });
});
