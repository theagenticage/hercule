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
  buildErrorBody,
  buildFixtureAssistant,
  FIXTURE_GITHUB_CONNECTION,
  buildFixtureAssistantSession,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  holdAnswer,
  NO_SIDEBAR_RECORDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  neverAnswer,
  type Handler,
  type SidebarRecords,
} from "../app/testing";
import { buildDraftKey } from "../app/pending-submissions";
import {
  buildDiscussionsWikiHandlers,
  DISCUSSION_ID,
  WIKI_PAGE_ID,
} from "../app/testing-discussions-wiki";
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
 * the thread list's `nav` with the app and its fake bridge. `handlers` replace the controller's
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
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  return { calls, nav, fake, ...app };
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

/**
 * Returns the first element in the list item `item` that carries a
 * `data-key`: the item itself, or for a thread row, the link inside it.
 */
const findKeyed = (item: Element): Element | null =>
  item.matches("[data-key]") ? item : item.querySelector("[data-key]");

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
    ).toEqual(["Waiting on you 1", "webshop 1 needs you", "ops", "No project"]);
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
      items
        .slice(items.indexOf(heading) + 1)
        .map((item) => findKeyed(item)?.getAttribute("aria-label")),
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
    // In its project the row ends with what it waits for. A worktree's name
    // is its branch, so the branch is not named again.
    expect(
      within(nav).getByRole("link", {
        name: "Write the retry runbook, waiting on you",
        description: "claude-sonnet-5 in webshop, workspace hercule/thread-3f1, on moss Approval",
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

  it("opens a thread that can't be reached in the Office's drawer while the Office is open", async () => {
    const { nav } = await startSidebar({ path: "/office" });

    // Every thread not marked Done has a colleague, asleep and away ones too.
    expect(
      within(nav)
        .getByRole("link", { name: "Rotate the backups key, can't be reached" })
        .getAttribute("href"),
    ).toBe(`/office?session=${FIXTURE_THREAD_IDS.backupsKey}`);
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
      const keys = [...nav.querySelectorAll(".side-item")].map(
        (item) => findKeyed(item)?.getAttribute("data-key") ?? null,
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
    // The worktree's branch was generated, so the row names only its machine.
    expect(draft.textContent).toBe("New thread" + "draft" + "moss");
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
        workspace: { kind: "primary", resourceId: SIDEBAR_FIXTURE.resources[0]!.id },
      });
    });
    // The repo's main workspace is on a branch the user chose, so the row names it.
    expect(nav.querySelector('[data-key="draft"]')?.textContent).toBe(
      "New thread" + "draft" + "main",
    );
    expect(readDraftProject()[1]).toBe("draft");
  });

  it(`draws a Draft Thread in no project as the first row under "No project", which stays last`, async () => {
    const { nav } = await startSidebar();

    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Waiting on you 1", "webshop 1 needs you", "ops", "No project"]);
    const heading = within(nav).getByRole("heading", { name: "No project" });
    const items = [...nav.querySelectorAll(".side-item")];
    expect(items.slice(items.indexOf(heading) + 1).map((item) => item.textContent)).toEqual([
      "New thread" + "draft" + "moss",
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

  it("draws Search as a button that does nothing yet", async () => {
    const { calls, router, live } = await startSidebar({
      path: `/threads/${FIXTURE_THREAD_IDS.flaky}`,
    });
    await live.waitForFirstPushes();
    const button = screen.getByRole("button", { name: "Search ⌘K" });
    const href = router.state.location.href;
    const sent = calls.length;

    expect(button.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(button);
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

    expect(nav.querySelectorAll("a[data-key^='thread:']")).toHaveLength(5);
    const more = within(nav).getByRole("button", { name: "3 more threads" });

    more.focus();
    await userEvent.keyboard("{Enter}");

    expect(nav.querySelectorAll("a[data-key^='thread:']")).toHaveLength(8);
    expect(readFocusedKey()).toBe(`thread:${threads[5]!.id}`);
  });

  it("mounts only the rows near the visible part of a long list, and keeps the focused row mounted", async () => {
    const webshop = SIDEBAR_FIXTURE.projects[0]!;
    const threads = buildThreads(500, { projectId: webshop.id });
    const { nav } = await startSidebar({ records: { ...SIDEBAR_FIXTURE, threads } });

    await userEvent.click(within(nav).getByRole("button", { name: "495 more threads" }));
    const focused = `thread:${threads[5]!.id}`;
    expect(readFocusedKey()).toBe(focused);
    expect(nav.querySelectorAll(".side-item").length).toBeLessThanOrEqual(45);

    // Scroll far down the list, to about the 235th row: the rows there
    // mount, and the focused row, far above them, stays.
    act(() => {
      Object.defineProperty(nav, "scrollTop", {
        configurable: true,
        value: 235 * ITEM_HEIGHTS["group-row"],
      });
      fireEvent.scroll(nav);
    });
    await waitFor(() => {
      expect(within(nav).queryByRole("link", { name: "Thread 260, idle" })).not.toBeNull();
    });
    expect(nav.querySelectorAll(".side-item").length).toBeLessThanOrEqual(45);
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
    expect(items).toEqual(["No project", "New thread" + "draft" + "No workspace"]);
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

describe("the sidebar's Done moves", () => {
  /** The path of the operation that marks threads done; here it marks "Bump the Bun pin". */
  const MARK_DONE_PATH = "/api/v1/sessions/mark-done";
  /** The path of the operation that reopens threads; here it reopens "Bump the Bun pin". */
  const REOPEN_PATH = "/api/v1/sessions/reopen";
  const MARK_DONE = `POST ${MARK_DONE_PATH}`;
  const REOPEN = `POST ${REOPEN_PATH}`;

  /**
   * Returns the controller's threads, as `readThreads` answers them, and the
   * handlers of the two Done moves on "Bump the Bun pin", which change those
   * threads as the controller would. `done` says whether the thread starts
   * marked Done.
   */
  const buildDoneController = (done: boolean) => {
    let threads: readonly Session[] = SIDEBAR_FIXTURE.threads.map((session) =>
      done && session.id === FIXTURE_THREAD_IDS.bunPin
        ? { ...session, done: { at: "2026-09-10T09:00:00.000Z", by: "user" as const } }
        : session,
    );
    const update = (change: (session: Session) => Session) => () => {
      threads = threads.map((session) =>
        session.id === FIXTURE_THREAD_IDS.bunPin ? change(session) : session,
      );
      return { body: threads.filter((session) => session.id === FIXTURE_THREAD_IDS.bunPin) };
    };
    return {
      readThreads: () => threads,
      markDone: update((session) => ({
        ...session,
        done: { at: "2026-09-10T09:30:00.000Z", by: "user" },
      })),
      reopen: update((session) => {
        const { done, ...open } = session;
        void done;
        return { ...open, reopenedAt: "2026-09-10T09:31:00.000Z" };
      }),
    };
  };

  /** Returns the button named `name` in the list item that holds the link `link`. */
  const findRowButton = (link: HTMLElement, name: string): HTMLElement =>
    within(link.closest<HTMLElement>(".side-item")!).getByRole("button", { name });

  it("takes the row off its project before the controller answers, says so with Undo, and puts it back from Undo", async () => {
    const controller = buildDoneController(false);
    const held = holdAnswer();
    const { nav, calls } = await startSidebar({
      readThreads: controller.readThreads,
      handlers: { [MARK_DONE]: held.handler, [REOPEN]: controller.reopen },
    });
    const bunPin = within(nav).getByRole("link", { name: "Bump the Bun pin, idle" });

    await userEvent.click(findRowButton(bunPin, "Mark done"));

    expect(within(nav).queryByRole("link", { name: "Bump the Bun pin, idle" })).toBeNull();
    const toast = screen.getByText("Marked done").parentElement!;
    expect(toast.getAttribute("role")).toBe("status");
    expect(within(nav).getByRole("button", { name: "Done 1" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    held.answer(controller.markDone());

    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

    expect(await within(nav).findByRole("link", { name: "Bump the Bun pin, idle" })).toBeTruthy();
    expect(screen.queryByText("Marked done")).toBeNull();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(
      expect.arrayContaining([MARK_DONE_PATH, REOPEN_PATH]),
    );
    expect(within(nav).queryByRole("button", { name: /^Done/ })).toBeNull();
  });

  it("sends an Undo pressed before the Done is answered only after that answer, and keeps the row in its project throughout", async () => {
    const controller = buildDoneController(false);
    const heldDone = holdAnswer();
    const heldReopen = holdAnswer();
    const { nav, calls } = await startSidebar({
      readThreads: controller.readThreads,
      handlers: { [MARK_DONE]: heldDone.handler, [REOPEN]: heldReopen.handler },
    });
    const sentMoves = () =>
      calls
        .filter((call) => call.path === MARK_DONE_PATH || call.path === REOPEN_PATH)
        .map((call) => call.path);
    const bunPin = within(nav).getByRole("link", { name: "Bump the Bun pin, idle" });

    await userEvent.click(findRowButton(bunPin, "Mark done"));
    const toast = screen.getByText("Marked done").parentElement!;
    await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

    expect(within(nav).getByRole("link", { name: "Bump the Bun pin, idle" })).toBeTruthy();
    expect(sentMoves()).toEqual([MARK_DONE_PATH]);

    heldDone.answer(controller.markDone());

    await waitFor(() => {
      expect(sentMoves()).toEqual([MARK_DONE_PATH, REOPEN_PATH]);
    });
    // The Done's answer is not written while the Undo is pending, so the row
    // never goes to the shelf.
    expect(within(nav).getByRole("link", { name: "Bump the Bun pin, idle" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: /^Done/ })).toBeNull();

    const countThreadReads = () =>
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/sessions").length;
    const readsBeforeAnswer = countThreadReads();
    heldReopen.answer(controller.reopen());

    // The Undo is the last move, so its answer reads the list again.
    await waitFor(() => {
      expect(countThreadReads()).toBeGreaterThan(readsBeforeAnswer);
    });
    expect(within(nav).getByRole("link", { name: "Bump the Bun pin, idle" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: /^Done/ })).toBeNull();
  });

  it("puts the row back and shows the error as an alert when the controller refuses", async () => {
    const controller = buildDoneController(false);
    const { nav } = await startSidebar({
      readThreads: controller.readThreads,
      handlers: {
        [MARK_DONE]: { status: 409, body: buildErrorBody("invalid_state", "The thread is busy.") },
      },
    });
    const bunPin = within(nav).getByRole("link", { name: "Bump the Bun pin, idle" });

    await userEvent.click(findRowButton(bunPin, "Mark done"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't mark the thread done: The thread is busy.");
    expect(within(alert).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(await within(nav).findByRole("link", { name: "Bump the Bun pin, idle" })).toBeTruthy();
  });

  it("keeps the Done shelf closed until its heading is pressed, and reopens a thread from it", async () => {
    const controller = buildDoneController(true);
    const { nav } = await startSidebar({
      readThreads: controller.readThreads,
      handlers: { [REOPEN]: controller.reopen },
    });
    const heading = within(nav).getByRole("button", { name: "Done 1" });
    expect(within(nav).queryByRole("link", { name: /^Bump the Bun pin/ })).toBeNull();

    await userEvent.click(heading);

    expect(heading.getAttribute("aria-expanded")).toBe("true");
    const doneRow = within(nav).getByRole("link", { name: "Bump the Bun pin, done" });
    expect(doneRow.querySelector(".side-detail")?.textContent).toMatch(/^Done /);

    await userEvent.click(findRowButton(doneRow, "Reopen"));

    expect(await within(nav).findByRole("link", { name: "Bump the Bun pin, idle" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: /^Done/ })).toBeNull();
  });
});

describe("the sidebar's faces", () => {
  /** Returns the face switch's segment named `name`. */
  const getSegment = (name: "Threads" | "Hercule"): HTMLElement =>
    within(screen.getByRole("tablist", { name: "Sidebar" })).getByRole("tab", { name });

  /** Returns the names of the segments that are selected. */
  const readSelectedSegments = (): (string | null)[] =>
    screen.getAllByRole("tab", { selected: true }).map((segment) => segment.textContent);

  it("draws the switch above New thread, on the Threads face for a thread", async () => {
    await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });

    const tablist = screen.getByRole("tablist", { name: "Sidebar" });
    const newThread = screen.getByRole("button", { name: "New thread ⌘N" });
    expect(
      tablist.compareDocumentPosition(newThread) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((segment) => segment.textContent),
    ).toEqual(["Threads", "Hercule"]);
    expect(readSelectedSegments()).toEqual(["Threads"]);
  });

  it("shows Waiting on you, Work and the System section on the Hercule face, without leaving the screen", async () => {
    const { router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });

    await userEvent.click(getSegment("Hercule"));

    expect(readSelectedSegments()).toEqual(["Hercule"]);
    expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    expect(screen.queryByRole("navigation", { name: "Threads" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Hercule" });
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Waiting on you 1", "Work", "System"]);
    expect(
      within(nav).getByRole("link", { name: "Write the retry runbook, waiting on you" }),
    ).toBeTruthy();
    // New thread, Search, the Office and the foot stay on both faces.
    expect(screen.getByRole("button", { name: "New thread ⌘N" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Office ⌘⇧O" })).toBeTruthy();
    expect(document.querySelector(".side-foot")).not.toBeNull();
  });

  it("lists The office, Intake, Workflows, Discussions and Wiki, all but Intake with no count, in Work, and marks Workflows while it is open", async () => {
    const { router } = await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
    await userEvent.click(getSegment("Hercule"));
    const nav = screen.getByRole("navigation", { name: "Hercule" });
    const work = within(nav).getByRole("heading", { name: "Work" }).closest("section")!;

    expect(
      within(work)
        .getAllByRole("link")
        .map((row) => row.textContent),
    ).toEqual(["The office", expect.stringMatching(/^Intake/), "Workflows", "Discussions", "Wiki"]);
    expect(within(work).getByRole("link", { name: "The office" }).getAttribute("href")).toBe(
      "/office",
    );
    expect(within(work).getByRole("link", { name: "Discussions" }).getAttribute("href")).toBe(
      "/discussions",
    );
    expect(within(work).getByRole("link", { name: "Wiki" }).getAttribute("href")).toBe("/wiki");
    const workflows = within(work).getByRole("link", { name: "Workflows" });
    expect(workflows.getAttribute("href")).toBe("/workflows");
    expect(workflows.getAttribute("aria-current")).toBeNull();

    await userEvent.click(workflows);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/workflows");
    });
    expect(workflows.getAttribute("aria-current")).toBe("page");
    expect(workflows.classList.contains("is-on")).toBe(true);
  });

  it.each([
    ["Discussions", "/discussions", `/discussions/${DISCUSSION_ID}`],
    ["Wiki", "/wiki", `/wiki/${WIKI_PAGE_ID}`],
  ])("marks %s while its list or one of its items is open", async (name, list, item) => {
    const { router } = await startSidebar({
      path: `/threads/${FIXTURE_THREAD_IDS.flaky}`,
      handlers: buildDiscussionsWikiHandlers(),
    });
    await userEvent.click(getSegment("Hercule"));
    const nav = screen.getByRole("navigation", { name: "Hercule" });
    const row = within(nav).getByRole("link", { name });
    expect(row.getAttribute("aria-current")).toBeNull();

    await act(() => router.navigate({ to: list }));
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.classList.contains("is-on")).toBe(true);

    await act(() => router.navigate({ to: item }));
    expect(router.state.location.pathname).toBe(item);
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.classList.contains("is-on")).toBe(true);
  });

  it("draws Fleet as a row that does nothing yet", async () => {
    const { calls, router, live } = await startSidebar({
      path: `/threads/${FIXTURE_THREAD_IDS.flaky}`,
    });
    await live.waitForFirstPushes();
    await userEvent.click(getSegment("Hercule"));
    const nav = screen.getByRole("navigation", { name: "Hercule" });
    const sent = calls.length;

    const row = within(nav).getByRole("button", { name: "Fleet" });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("title")).toBe("Not built yet");
    await userEvent.click(row);
    expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    expect(calls).toHaveLength(sent);
  });

  it("marks the Connections row while a Connection needs attention", async () => {
    await startSidebar({
      handlers: {
        "GET /api/v1/connections": {
          body: { items: [{ ...FIXTURE_GITHUB_CONNECTION, status: "error" }] },
        },
      },
    });
    await userEvent.click(getSegment("Hercule"));
    const nav = screen.getByRole("navigation", { name: "Hercule" });

    const row = within(nav).getByRole("link", { name: /Connections/ });
    expect(within(row).getByRole("img", { name: "A Connection needs attention" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Fleet" })).toBeTruthy();
  });

  it("keeps the app on screen when the Hercule face opens long after the Connections were last drawn", async () => {
    // `setImmediate` stays real: fake-indexeddb, which holds the thread
    // copies, runs its transactions on it, and a faked one runs several
    // transaction steps in one go, so opening the copies fails.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    let connectionReads = 0;
    // The loader's read answers; any later read hangs, so a screen that waits
    // for one stays hidden.
    const readConnections: Handler = () =>
      ++connectionReads === 1 ? { body: { items: [FIXTURE_GITHUB_CONNECTION] } } : neverAnswer();
    await startSidebar({
      path: `/threads/${FIXTURE_THREAD_IDS.flaky}`,
      handlers: { "GET /api/v1/connections": readConnections },
    });

    // Nothing on the Threads face draws the Connections. Query removes a read
    // no component draws after five minutes, unless its options keep it.
    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));
    fireEvent.click(getSegment("Hercule"));

    // A suspended screen is hidden, and a hidden element has no role.
    const nav = screen.getByRole("navigation", { name: "Hercule" });
    expect(within(nav).getByRole("link", { name: /Connections/ })).toBeTruthy();
  });

  it("moves between the segments with the arrow keys, keeping one of them in the tab order", async () => {
    await startSidebar();
    const threads = getSegment("Threads");
    const orchestration = getSegment("Hercule");
    expect([threads.tabIndex, orchestration.tabIndex]).toEqual([0, -1]);

    threads.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(readSelectedSegments()).toEqual(["Hercule"]);
    expect(document.activeElement).toBe(getSegment("Hercule"));
    expect([getSegment("Threads").tabIndex, getSegment("Hercule").tabIndex]).toEqual([-1, 0]);

    await userEvent.keyboard("{ArrowRight}");
    expect(readSelectedSegments()).toEqual(["Hercule"]);

    await userEvent.keyboard("{ArrowLeft}");
    expect(readSelectedSegments()).toEqual(["Threads"]);
    expect(document.activeElement).toBe(getSegment("Threads"));
  });

  it("switches the face from View › Threads and View › Hercule", async () => {
    const { fake } = await startSidebar();

    fake.sendMenuCommand("showOrchestrationFace");
    expect(readSelectedSegments()).toEqual(["Hercule"]);
    fake.sendMenuCommand("showThreadsFace");
    expect(readSelectedSegments()).toEqual(["Threads"]);
  });

  it("keeps the face when the Office or Settings opens, and shows Threads when a thread opens", async () => {
    const { router } = await startSidebar();
    await userEvent.click(getSegment("Hercule"));

    await userEvent.click(screen.getByRole("link", { name: "Office ⌘⇧O" }));
    await screen.findByText("The Office");
    expect(readSelectedSegments()).toEqual(["Hercule"]);

    await act(() => router.navigate({ to: "/settings" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(/^\/settings\//);
    });
    expect(readSelectedSegments()).toEqual(["Hercule"]);

    const nav = screen.getByRole("navigation", { name: "Hercule" });
    await userEvent.click(
      within(nav).getByRole("link", { name: "Write the retry runbook, waiting on you" }),
    );
    await waitFor(() => {
      expect(readSelectedSegments()).toEqual(["Threads"]);
    });
  });

  it("shows the Threads face at launch on a screen that keeps the face", async () => {
    await startSidebar({ path: "/office" });

    expect(readSelectedSegments()).toEqual(["Threads"]);
  });

  it("opens a new Draft Thread on the Threads face, also from the new-thread screen", async () => {
    const { router } = await startSidebar();
    await userEvent.click(getSegment("Hercule"));

    // A new Draft Thread opens at "/" again, with other search parameters.
    await act(() =>
      router.navigate({ to: "/", search: { project: SIDEBAR_FIXTURE.projects[0]!.id } }),
    );

    expect(readSelectedSegments()).toEqual(["Threads"]);
  });

  it("keeps the focus on a Waiting on you row opened from the Hercule face", async () => {
    await startSidebar({ path: `/threads/${FIXTURE_THREAD_IDS.flaky}` });
    await userEvent.click(getSegment("Hercule"));
    const name = "Write the retry runbook, waiting on you";
    within(screen.getByRole("navigation", { name: "Hercule" }))
      .getByRole("link", { name })
      .focus();

    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(readSelectedSegments()).toEqual(["Threads"]);
    });
    // The thread's Waiting on you row, not its row under its project.
    const row = screen
      .getByRole("navigation", { name: "Threads" })
      .querySelector(`[data-key="waiting:thread:${FIXTURE_THREAD_IDS.runbook}"]`);
    expect(document.activeElement).toBe(row);
  });

  it("names the list the segments control", async () => {
    await startSidebar();
    const nav = screen.getByRole("navigation", { name: "Threads" });

    expect(nav.id).not.toBe("");
    for (const name of ["Threads", "Hercule"] as const) {
      expect(getSegment(name).getAttribute("aria-controls")).toBe(nav.id);
    }
  });

  it("sends the Go menu the threads face's rows while the Hercule face shows, and not again on a switch", async () => {
    let threads: readonly Session[] = SIDEBAR_FIXTURE.threads;
    const { fake, live } = await startSidebar({ readThreads: () => threads });
    await waitFor(() => {
      expect(live.readTopics()).toContain("session");
    });
    const sent = fake.goMenus.length;

    await userEvent.click(getSegment("Hercule"));
    expect(fake.goMenus).toHaveLength(sent);

    // A thread that does not wait, so the Hercule face does not show it.
    const [newest] = buildThreads(1, { createdAt: "2026-09-10T09:10:00.000Z" });
    threads = [newest!, ...threads];
    act(() => {
      live.pushInvalidation("session", [newest!.id]);
    });

    await waitFor(() => {
      expect(fake.goMenus.at(-1)?.map((item) => item.title)).toContain("Thread 1");
    });
    expect(fake.goMenus.at(-1)).toHaveLength(SIDEBAR_FIXTURE.threads.length + 1);
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

describe(`the sidebar's "From runs"`, () => {
  /**
   * Returns `count` sessions of one run's steps, each waiting on the user's
   * approval of `git push`, titled "Deploy · step 1" to "Deploy · step
   * <count>", the last the most recently active.
   */
  const buildRunSessions = (count: number): Session[] =>
    buildThreads(count, {
      status: "busy",
      openRequests: [APPROVAL],
      kind: "run",
      runId: "01a06d02-7900-7000-8000-000000000001",
    }).map((session) => ({
      ...session,
      id: session.id.replace("-7400-", "-7a00-"),
      title: session.title.replace("Thread", "Deploy · step"),
    }));

  it("lists the runs' waiting sessions under Waiting on you's threads, capped at 3, the rest on the more row", async () => {
    const runSessions = buildRunSessions(5);
    const { nav, fake } = await startSidebar({
      records: { ...SIDEBAR_FIXTURE, agentSessions: runSessions },
    });

    expect(within(nav).getByRole("heading", { name: "Waiting on you 6" })).toBeTruthy();
    const label = within(nav).getByRole("heading", { name: "From runs" });
    expect(label.tagName).toBe("H4");
    expect(label.style.marginTop).toBe("7px");
    expect(
      [...nav.querySelectorAll("[data-key^='waiting'], [data-key='label:waiting-runs']")].map(
        (row) => row.getAttribute("aria-label") ?? row.textContent,
      ),
    ).toEqual([
      "Write the retry runbook, waiting on you",
      "From runs",
      "Deploy · step 5, waiting on you",
      "Deploy · step 4, waiting on you",
      "Deploy · step 3, waiting on you",
    ]);
    const row = within(nav).getByRole("link", {
      name: "Deploy · step 5, waiting on you",
      description: "Run git push?",
    });
    expect(row.getAttribute("href")).toBe(`/threads/${runSessions[0]!.id}`);
    // The Go menu lists the user's own threads, never a run's session.
    expect(fake.goMenus.at(-1)?.map((item) => item.title)).not.toContain("Deploy · step 5");

    await userEvent.click(within(nav).getByRole("button", { name: "2 more waiting on you" }));

    expect(nav.querySelectorAll("[data-key^='waiting-run:']")).toHaveLength(5);
  });

  it("opens a run's waiting session in the Office's drawer while the Office is open", async () => {
    const [runSession] = buildRunSessions(1);
    const { nav } = await startSidebar({
      path: "/office",
      records: { ...SIDEBAR_FIXTURE, agentSessions: [runSession!] },
    });

    expect(
      within(nav)
        .getByRole("link", { name: "Deploy · step 1, waiting on you" })
        .getAttribute("href"),
    ).toBe(`/office?session=${runSession!.id}`);
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
    const gap = nav.querySelector(".virtual-list-items")!;

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
    restOn(bunPin.querySelector(".side-detail")!);
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
    // jsdom lays nothing out, so each list item, and everything in it,
    // reports a top from the item's place among the items, a row's height
    // apart, and the card reports a height that fits the window, so its top
    // is not moved to keep it inside.
    const rowHeight = ITEM_HEIGHTS["group-row"];
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const item = this.closest(".side-item");
      const index = item === null ? 0 : [...item.parentElement!.children].indexOf(item);
      return DOMRect.fromRect({ x: 0, y: index * rowHeight, width: 272, height: rowHeight });
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
