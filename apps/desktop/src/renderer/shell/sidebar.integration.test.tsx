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
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  NO_SIDEBAR_RECORDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Handler,
  type SidebarRecords,
} from "../app/testing";
import { buildDraftKey } from "../app/pending-submissions";

// Every thread row names its thread with `describePose`, so its calls count
// the rows that drew. The function itself is the real one.
vi.mock("@hercule/client-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hercule/client-core")>();
  return { ...actual, describePose: vi.fn(actual.describePose) };
});

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
const APPROVAL = SIDEBAR_FIXTURE.threads[0]!.openRequest;

/**
 * Returns `count` threads titled "Thread 1" to "Thread <count>", the last the
 * newest, each with `over` applied. Their ids are UUIDv7s the contract
 * accepts.
 */
const buildThreads = (count: number, over: Partial<Session> = {}): Session[] =>
  Array.from({ length: count }, (_, index) => ({
    ...PLAIN_THREAD,
    id: `01a06d02-7400-7000-8000-${String(1000 + index).padStart(12, "0")}`,
    title: `Thread ${String(index + 1)}`,
    lastActivityAt: new Date(Date.UTC(2026, 8, 10, 8, 0, index)).toISOString(),
    ...over,
  })).reverse();

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
    ).toEqual([
      "Waiting on you 1",
      "webshop",
      "hercule/thread-3f1",
      "webshop · moss",
      "ops",
      "No project",
    ]);
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label") ?? link.getAttribute("title")),
    ).toEqual([
      "Write the retry runbook, waiting on you",
      "New thread in webshop",
      "New thread in hercule/thread-3f1",
      "Write the retry runbook, waiting on you",
      "Fix flaky webhook tests, working",
      "New thread in webshop · moss",
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

  it("describes each row by its question, or by its model and its age", async () => {
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
    // already says, so only the model describes it.
    expect(
      within(nav).getByRole("link", {
        name: "Write the retry runbook, waiting on you",
        description: "claude-sonnet-5",
      }),
    ).toBe(projectRow);
    expect(
      within(nav).getByRole("link", {
        name: "Bump the Bun pin, idle",
        description: "claude-sonnet-5 22 minutes ago",
      }),
    ).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Bump the Bun pin, idle" }).textContent).toBe(
      "Bump the Bun pinclaude-sonnet-522m22 minutes ago",
    );
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

  it("opens a new thread in a project, or joining a workspace, from their +", async () => {
    const { nav, router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
    const [webshop, ops] = SIDEBAR_FIXTURE.projects;
    const [primary, thread3f1] = SIDEBAR_FIXTURE.workspaces;

    const readHref = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(readHref("New thread in webshop")).toBe(`/?project=${webshop!.id}`);
    expect(readHref("New thread in ops")).toBe(`/?project=${ops!.id}`);
    expect(readHref("New thread in hercule/thread-3f1")).toBe(
      `/?project=${webshop!.id}&workspace=${thread3f1!.id}`,
    );
    expect(readHref("New thread in webshop · moss")).toBe(
      `/?project=${webshop!.id}&workspace=${primary!.id}`,
    );

    await userEvent.click(within(nav).getByRole("link", { name: "New thread in webshop" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ project: webshop!.id });
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens the project picker from New thread", async () => {
    await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });

    await userEvent.click(screen.getByRole("button", { name: "New thread ⌘N" }));
    expect(await screen.findByRole("dialog", { name: "New thread in" })).toBeTruthy();
  });

  it("draws the Draft Thread as the current row of the group it will join, and moves it with the pick", async () => {
    const [webshop] = SIDEBAR_FIXTURE.projects;
    const [, thread3f1] = SIDEBAR_FIXTURE.workspaces;
    const { nav, router } = await startSidebar({
      path: `/?project=${webshop!.id}&workspace=${thread3f1!.id}`,
    });

    /** Returns the key of each item from the draft's project heading down to the draft's row. */
    const readDraftGroup = (): readonly (string | null)[] => {
      const keys = [...nav.querySelectorAll(".side-item")].map((item) =>
        item.getAttribute("data-key"),
      );
      return keys.slice(keys.indexOf(`header:project:${webshop!.id}`), keys.indexOf("draft") + 1);
    };
    const draft = await waitFor(() => {
      const row = nav.querySelector<HTMLElement>('[data-key="draft"]');
      expect(row).not.toBeNull();
      return row!;
    });
    expect(draft.getAttribute("aria-current")).toBe("page");
    expect(draft.textContent).toBe("New thread" + "hercule/thread-3f1 · moss" + "draft");
    // The draft's project comes first, and the draft is the last row of the
    // workspace it joins.
    expect(readDraftGroup()).toEqual([
      `header:project:${webshop!.id}`,
      `workspace:project:${webshop!.id}:${thread3f1!.id}`,
      `thread:${FIXTURE_THREAD_IDS.runbook}`,
      `thread:${FIXTURE_THREAD_IDS.flaky}`,
      "draft",
    ]);

    // A new workspace does not exist until the thread starts, so the draft
    // sits right under its project's heading.
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
    expect(readDraftGroup()).toEqual([`header:project:${webshop!.id}`, "draft"]);
    expect(nav.querySelector('[data-key="draft"]')?.textContent).toBe(
      "New thread" + "New workspace · moss" + "draft",
    );
  });

  it("draws a Draft Thread in no project as the last row, under No project", async () => {
    const { nav } = await startSidebar();

    // No project stays the last group even while its draft is open.
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual([
      "Waiting on you 1",
      "webshop",
      "hercule/thread-3f1",
      "webshop · moss",
      "ops",
      "No project",
    ]);
    const heading = within(nav).getByRole("heading", { name: "No project" });
    const items = [...nav.querySelectorAll(".side-item")];
    expect(items.slice(items.indexOf(heading) + 1).map((item) => item.textContent)).toEqual([
      expect.stringContaining("Sketch the pricing page"),
      "New thread" + "No workspace · moss" + "draft",
    ]);
  });

  it("draws Hide the sidebar, Search and Settings as buttons that do nothing yet", async () => {
    const { calls, router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
    const buttons = [
      screen.getByRole("button", { name: "Hide the sidebar" }),
      screen.getByRole("button", { name: "Search ⌘K" }),
      screen.getByRole("button", { name: "Settings" }),
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

    // A new approval in webshop's main workspace: a row at the top of
    // Waiting on you and a row above "Bump the Bun pin", with every row
    // below each of them moving down.
    const [primary] = SIDEBAR_FIXTURE.workspaces;
    const [arrived] = buildThreads(1, {
      title: "Pin the lockfile",
      status: "busy",
      openRequest: APPROVAL,
      projectId: SIDEBAR_FIXTURE.projects[0]!.id,
      workspaceId: primary!.id,
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
    const waiting = buildThreads(5, { status: "busy", openRequest: APPROVAL });
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
    expect(readFocusedKey()).toBe(`waiting:${waiting[3]!.id}`);
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

    // Scroll far down the list: the rows there mount, and the focused row,
    // far above them, stays.
    act(() => {
      Object.defineProperty(nav, "scrollTop", { configurable: true, value: 12_000 });
      fireEvent.scroll(nav);
    });
    await waitFor(() => {
      expect(within(nav).queryByRole("link", { name: "Thread 160, idle" })).not.toBeNull();
    });
    expect(nav.querySelectorAll("[data-key]").length).toBeLessThanOrEqual(45);
    expect(readFocusedKey()).toBe(focused);
    expect(within(nav).queryByRole("link", { name: "Thread 495, idle" })).not.toBeNull();
  });

  it("moves focus to Waiting on you when the focused waiting row is answered", async () => {
    let threads: readonly Session[] = [
      ...SIDEBAR_FIXTURE.threads,
      { ...buildThreads(1)[0]!, status: "busy", openRequest: APPROVAL },
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
    expect(readFocusedKey()).toBe(`waiting:${FIXTURE_THREAD_IDS.runbook}`);

    threads = threads.map((session) =>
      session.id === FIXTURE_THREAD_IDS.runbook ? { ...session, openRequest: null } : session,
    );
    act(() => {
      live.pushInvalidation("session", [FIXTURE_THREAD_IDS.runbook]);
    });

    await waitFor(() => {
      expect(nav.querySelector(`[data-key='waiting:${FIXTURE_THREAD_IDS.runbook}']`)).toBeNull();
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
