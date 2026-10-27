/**
 * Tests Discussions: the list grouped by project, its three widths, an open
 * Discussion with its shared files and Posts, a Discussion that does not
 * exist, Esc, paging, and how the `discussion` topic keeps the screen current
 * while the window is visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscussionSummary, Post, Session, SharedFile } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  changeTextSize,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Call,
  type Handler,
} from "../../../../app/testing";

// Every element measures as wide as a window that shows every column, and
// the virtualized list draws the rows that fit its height.
beforeEach(() => {
  stubElementSize(1168, 800);
  // Sunday 11 October 2026, 10:00 in UTC, the time zone the settings name.
  vi.useFakeTimers({ now: new Date("2026-10-11T10:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
  localStorage.clear();
});

/** The resources of `SIDEBAR_FIXTURE`: webshop alone in its project, and the two repositories of ops. */
const WEBSHOP_ID = SIDEBAR_FIXTURE.resources[0]!.id;
const INFRA_ID = SIDEBAR_FIXTURE.resources[1]!.id;
const RUNBOOKS_ID = SIDEBAR_FIXTURE.resources[2]!.id;

/** The three agents that take part in the open Discussion, by the sessions of the fixture threads. */
const RUNBOOK_ID = FIXTURE_THREAD_IDS.runbook;
const FLAKY_ID = FIXTURE_THREAD_IDS.flaky;
const BUN_PIN_ID = FIXTURE_THREAD_IDS.bunPin;

/** The run that wrote one Post. */
const RUN_ACTOR = "run:01a06d02-7900-7000-8000-000000000001";

const buildDiscussion = (
  over: Partial<DiscussionSummary> & Pick<DiscussionSummary, "id">,
): DiscussionSummary => ({
  resourceId: WEBSHOP_ID,
  repository: "github.com/acme/webshop",
  kind: "general",
  subject: "A subject",
  postCount: 2,
  sharedFileCount: 0,
  participantCount: 2,
  lastPostAt: "2026-10-01T09:00:00.000Z",
  createdAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

const TOTALS = buildDiscussion({
  id: "01a06d02-7f00-7000-8000-000000000001",
  kind: "overlap",
  subject: "Edits overlap in `src/cart/totals.ts`",
  postCount: 6,
  sharedFileCount: 2,
  participantCount: 3,
  lastPostAt: "2026-10-11T09:41:00.000Z",
});
const HELPERS = buildDiscussion({
  id: "01a06d02-7f00-7000-8000-000000000002",
  resourceId: INFRA_ID,
  repository: "github.com/acme/ops-infra",
  subject: "Who owns the price formatting helpers?",
  postCount: 1,
  participantCount: 1,
  lastPostAt: "2026-10-10T12:00:00.000Z",
});
const LEDGER = buildDiscussion({
  id: "01a06d02-7f00-7000-8000-000000000003",
  resourceId: RUNBOOKS_ID,
  repository: "github.com/acme/ops-runbooks",
  kind: "overlap",
  subject: "Edits overlap in `src/ledger/entries.ts`",
  postCount: 3,
  participantCount: 2,
});
const DISCUSSIONS = [TOTALS, HELPERS, LEDGER];

const buildFile = (path: string, sessionIds: string[], sharedAt: string): SharedFile => ({
  path,
  sessionIds,
  sharedAt,
});

const buildPost = (index: number, actor: string, text: string, createdAt: string): Post => ({
  id: `01a06d02-8000-7000-8000-00000000000${index}`,
  discussionId: TOTALS.id,
  actor,
  text,
  createdAt,
});

/** The open Discussion's Posts, oldest first. */
const TOTALS_POSTS: readonly Post[] = [
  buildPost(
    1,
    "system",
    "Shared files: `src/cart/totals.ts` (session 3f9a2c1d, session 8b1e0f47).",
    "2026-10-11T09:12:00.000Z",
  ),
  buildPost(
    2,
    `session:${RUNBOOK_ID}`,
    "I'm moving `computeTotals` out. Are you changing its signature?",
    "2026-10-11T09:14:00.000Z",
  ),
  buildPost(
    3,
    `session:${FLAKY_ID}`,
    "No signature change.\n\n- Round each line\n- Then sum",
    "2026-10-11T09:16:00.000Z",
  ),
  buildPost(4, "user", "Please keep the call where it is.", "2026-10-11T09:20:00.000Z"),
  buildPost(5, RUN_ACTOR, "The build failed on this file.", "2026-10-10T08:00:00.000Z"),
];

/** The first Discussion with the files and the sessions that make it an overlap. */
const TOTALS_FILES: readonly SharedFile[] = [
  buildFile("src/cart/totals.ts", [RUNBOOK_ID, FLAKY_ID], "2026-10-11T09:12:00.000Z"),
  buildFile("src/cart/totals.test.ts", [FLAKY_ID, BUN_PIN_ID], "2026-10-11T09:30:00.000Z"),
];

/** The id of a Discussion the controller does not have. */
const UNKNOWN_ID = "01a06d02-7f00-7000-8000-0000000000ff";

/** Returns the fixture thread `id`. */
const findThread = (id: string): Session => SIDEBAR_FIXTURE.threads.find((t) => t.id === id)!;

/** Returns the handler that answers `discussion.read` for the Discussions in `known`, by id. */
const buildAnswerRead = (known: readonly DiscussionSummary[]) => (call: Call) => {
  const id = call.path.split("/").at(-1)!;
  const summary = known.find((discussion) => discussion.id === id);
  if (summary === undefined) {
    return { status: 404, body: buildErrorBody("not_found", `no discussion ${id}`) };
  }
  const isTotals = id === TOTALS.id;
  return {
    body: {
      discussion: {
        ...summary,
        sharedFiles: isTotals ? TOTALS_FILES : [],
        participantSessionIds: isTotals ? [RUNBOOK_ID, FLAKY_ID, BUN_PIN_ID] : [],
      },
      posts: isTotals ? TOTALS_POSTS : [],
    },
  };
};

/** Builds `count` general Discussions of the webshop project, "Discussion 1" on, newest first. */
const buildLongList = (count: number): DiscussionSummary[] =>
  Array.from({ length: count }, (_, index) =>
    buildDiscussion({
      id: `01a06d02-7f00-7000-8100-${String(index + 1).padStart(12, "0")}`,
      subject: `Discussion ${index + 1}`,
    }),
  );

/**
 * Opens the app at `path`, the Discussions list by default, with the
 * Discussions in `listed`, one array for each page the list is read in, and
 * waits for the floating header to show. While `isNextPageFailing`, the
 * reads of the second page fail; `healNextPage` makes them succeed.
 */
const openDiscussions = async (
  path = "/discussions",
  listed: readonly (readonly DiscussionSummary[])[] = [DISCUSSIONS],
  isNextPageFailing = false,
) => {
  const answerRead = buildAnswerRead([...DISCUSSIONS, ...listed.flat()]);
  let failing = isNextPageFailing;
  const handlers: Readonly<Record<string, Handler>> = {
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    // A page of the list is named by the number of the page before it.
    "GET /api/v1/discussions": (call) => {
      const cursor = new URLSearchParams(call.search).get("cursor");
      const index = cursor === null ? 0 : Number(cursor);
      if (index === 1 && failing) {
        return { status: 500, body: buildErrorBody("internal", "The database is locked.") };
      }
      return {
        body: {
          items: listed[index] ?? [],
          ...(index + 1 < listed.length ? { nextCursor: String(index + 1) } : {}),
        },
      };
    },
    ...Object.fromEntries(
      [...[...DISCUSSIONS, ...listed.flat()].map((discussion) => discussion.id), UNKNOWN_ID].map(
        (id): [string, Handler] => [`GET /api/v1/discussions/${id}`, answerRead],
      ),
    ),
    ...Object.fromEntries(
      [RUNBOOK_ID, FLAKY_ID, BUN_PIN_ID].map((id): [string, Handler] => [
        `GET /api/v1/sessions/${id}`,
        { body: findThread(id) },
      ]),
    ),
  };
  const calls = stubApi(handlers);
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path, retryFailedReads: !isNextPageFailing },
  );
  // The header's pill, which every width draws.
  await screen.findByRole("navigation", { name: "Discussions" });
  return {
    calls,
    healNextPage: () => {
      failing = false;
    },
    ...app,
  };
};

const getList = () => screen.getByRole("navigation", { name: "Discussion list" });
const getHeader = () => screen.getByRole("navigation", { name: "Discussions" });

/** Returns the names of the list's headings and rows, in order. */
const readList = (): string[] =>
  [...getList().querySelectorAll("[data-key]")].map(
    (item) => item.getAttribute("aria-label") ?? item.textContent ?? "",
  );

describe("the Discussion list", () => {
  it("groups the Discussions by project, with a sub-heading for each repository of a project with several", async () => {
    await openDiscussions();

    expect(readList()).toEqual([
      "webshop",
      "Edits overlap in src/cart/totals.ts",
      "ops",
      "acme/ops-infra",
      "Who owns the price formatting helpers?",
      "acme/ops-runbooks",
      "Edits overlap in src/ledger/entries.ts",
    ]);
  });

  it("shows each Discussion's subject, its counts and its last Post, and marks an overlap", async () => {
    await openDiscussions();

    const readCells = (name: string) =>
      [...within(getList()).getByRole("link", { name }).children].map((cell) => ({
        text: cell.textContent,
        isMark: cell.classList.contains("overlap-mark"),
      }));
    // The mark, the subject with its code span, the sessions, the Posts, and the day or time.
    expect(readCells("Edits overlap in src/cart/totals.ts")).toEqual([
      { text: "", isMark: true },
      { text: "Edits overlap in src/cart/totals.ts", isMark: false },
      { text: "3", isMark: false },
      { text: "6", isMark: false },
      { text: "09:41", isMark: false },
    ]);
    expect(readCells("Who owns the price formatting helpers?")).toEqual([
      { text: "", isMark: false },
      { text: "Who owns the price formatting helpers?", isMark: false },
      { text: "1", isMark: false },
      { text: "1", isMark: false },
      { text: "Sat", isMark: false },
    ]);
    const code = within(getList()).getByRole("link", {
      name: "Edits overlap in src/cart/totals.ts",
    });
    expect(code.querySelector("code")?.textContent).toBe("src/cart/totals.ts");
  });

  it("opens a Discussion from its row, and marks the row selected", async () => {
    const { router } = await openDiscussions();
    const row = within(getList()).getByRole("link", {
      name: "Who owns the price formatting helpers?",
    });
    expect(row.getAttribute("href")).toBe(`/discussions/${HELPERS.id}`);

    await userEvent.click(row);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/discussions/${HELPERS.id}`));
    const selected = within(getList()).getByRole("link", {
      name: "Who owns the price formatting helpers?",
    });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(selected.classList.contains("is-on")).toBe(true);
  });

  it("says when there are no Discussions", async () => {
    await openDiscussions("/discussions", [[]]);

    expect(within(getList()).getByText("No discussions yet")).toBeTruthy();
  });

  it("reads the next page of Discussions when the list reaches its end", async () => {
    const { calls } = await openDiscussions("/discussions", [[TOTALS, HELPERS], [LEDGER]]);

    await waitFor(() =>
      expect(
        within(getList()).getByRole("link", { name: "Edits overlap in src/ledger/entries.ts" }),
      ).toBeTruthy(),
    );
    const reads = calls
      .filter((call) => call.method === "GET" && call.path === "/api/v1/discussions")
      .map((call) => call.search);
    expect(reads[0]).toBe("");
    expect(reads).toContain("?cursor=1");
    // The Discussion of the second page sits under its own repository, below the first page's.
    expect(readList()).toEqual([
      "webshop",
      "Edits overlap in src/cart/totals.ts",
      "ops",
      "acme/ops-infra",
      "Who owns the price formatting helpers?",
      "acme/ops-runbooks",
      "Edits overlap in src/ledger/entries.ts",
    ]);
  });

  it("does not read a failed next page again by itself, only from the Retry row", async () => {
    const { calls, healNextPage, live, context } = await openDiscussions(
      "/discussions",
      [[TOTALS, HELPERS], [LEDGER]],
      true,
    );
    const readNextPages = () =>
      calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path === "/api/v1/discussions" &&
          call.search === "?cursor=1",
      );

    await within(getList()).findByRole("button", { name: "Retry" });
    expect(within(getList()).getByRole("alert").textContent).toContain(
      "Could not read the next page: The database is locked.",
    );
    // The live connection reads every list once it opens; wait for that read to end.
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));
    const readsBefore = readNextPages().length;
    expect(readsBefore).toBeLessThanOrEqual(2);

    // The list is still at its end, and does not read the page again.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(readNextPages()).toHaveLength(readsBefore);

    healNextPage();
    await userEvent.click(within(getList()).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(
        within(getList()).getByRole("link", { name: "Edits overlap in src/ledger/entries.ts" }),
      ).toBeTruthy(),
    );
    expect(readNextPages()).toHaveLength(readsBefore + 1);
    expect(within(getList()).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("the Discussion list's widths", () => {
  it("places its headings and its one-line rows again when the Text size changes their heights", async () => {
    await openDiscussions();
    const items = getList().querySelector<HTMLElement>(".virtual-list-items")!;
    const before = Number.parseFloat(items.style.height);

    // At the largest step a heading and a sub-heading are each 2px taller, and a one-line row 2px.
    await changeTextSize(4, {
      "--list-height-group-heading": "26px",
      "--list-height-repository-heading": "24px",
      "--list-height-one-line-row": "42px",
    });

    // Two projects, two repositories with a sub-heading, and three Discussions.
    expect(Number.parseFloat(items.style.height) - before).toBe(2 * 2 + 2 * 2 + 3 * 2);
  });

  it("draws the table while no Discussion is open, with its column heads", async () => {
    await openDiscussions();

    expect(screen.getByRole("heading", { level: 1, name: "Discussions" })).toBeTruthy();
    expect(getList().classList.contains("workflow-list--table")).toBe(true);
    expect(getList().classList.contains("discussion-list")).toBe(true);
    expect(within(getList()).getByText("Last post")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("draws the list as a column beside an open Discussion, with each one's counts over its time", async () => {
    // The first Discussion is open, so the list stays scrolled to the top and
    // every row is on screen, which keeps its time current.
    await openDiscussions(`/discussions/${TOTALS.id}`);

    expect(getList().classList.contains("workflow-list--column")).toBe(true);
    expect(within(getList()).queryByText("Last post")).toBeNull();
    const readParts = (name: string) =>
      [...within(getList()).getByRole("link", { name }).children].map((part) => part.textContent);
    const readRow = (name: string) => within(getList()).getByRole("link", { name });
    expect(
      readRow("Edits overlap in src/cart/totals.ts").querySelector(".column-mark .overlap-mark"),
    ).toBeTruthy();
    expect(
      readRow("Who owns the price formatting helpers?").querySelector(".overlap-mark"),
    ).toBeNull();
    expect(readParts("Edits overlap in src/cart/totals.ts")).toEqual([
      "",
      "Edits overlap in src/cart/totals.ts6 posts · 3 sessions",
      "09:41",
    ]);
    // One Post and one session are said in the singular.
    expect(readParts("Who owns the price formatting helpers?")).toEqual([
      "",
      "Who owns the price formatting helpers?1 post · 1 session",
      "Sat",
    ]);
    expect(
      within(getList())
        .getByRole("link", { name: "Edits overlap in src/cart/totals.ts" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(readList()).toHaveLength(7);
  });

  it("hides the list while the open Discussion fills the pane", async () => {
    await openDiscussions(`/discussions/${HELPERS.id}?full=true`);

    expect(screen.queryByRole("navigation", { name: "Discussion list" })).toBeNull();
    expect(within(getHeader()).getByRole("button", { name: "Show the list" })).toBeTruthy();
  });

  it("hides the list and shows it again from the header's button", async () => {
    const { router } = await openDiscussions(`/discussions/${TOTALS.id}`);

    await userEvent.click(within(getHeader()).getByRole("button", { name: "Hide the list" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ full: true }));
    expect(screen.queryByRole("navigation", { name: "Discussion list" })).toBeNull();

    await userEvent.click(within(getHeader()).getByRole("button", { name: "Show the list" }));

    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(
      within(getList())
        .getByRole("link", { name: "Edits overlap in src/cart/totals.ts" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("leads back to the table from the header's tab", async () => {
    const { router } = await openDiscussions(`/discussions/${HELPERS.id}`);
    const back = within(getHeader()).getByRole("link", { name: "Discussions" });
    expect(back.getAttribute("href")).toBe("/discussions");

    await userEvent.click(back);

    await waitFor(() => expect(router.state.location.pathname).toBe("/discussions"));
    expect(getList().classList.contains("workflow-list--table")).toBe(true);
  });

  it("keeps the focus on the open Discussion's row while the list changes width", async () => {
    const { router } = await openDiscussions();
    const name = "Who owns the price formatting helpers?";
    act(() => within(getList()).getByRole("link", { name }).focus());

    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe(`/discussions/${HELPERS.id}`));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(getList()).getByRole("link", { name })),
    );

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/discussions"));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(getList()).getByRole("link", { name })),
    );
  });
});

describe("a Discussion far down a long list", () => {
  const LONG_LIST = buildLongList(80);
  const FAR = LONG_LIST[69]!;

  it("scrolls to its row and focuses it when it opens beside the list", async () => {
    const { router } = await openDiscussions("/discussions", [LONG_LIST]);
    // The row is far below the rows that fit the window, so it is not drawn.
    expect(within(getList()).queryByRole("link", { name: FAR.subject })).toBeNull();

    await act(() =>
      router.navigate({ to: "/discussions/$discussionId", params: { discussionId: FAR.id } }),
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(getList()).getByRole("link", { name: FAR.subject }),
      ),
    );
    expect(getList().classList.contains("workflow-list--column")).toBe(true);
    expect(getList().scrollTop).toBeGreaterThan(0);
  });

  it("scrolls to its row and focuses it when Esc closes it back to the table", async () => {
    const { router } = await openDiscussions(`/discussions/${FAR.id}`, [LONG_LIST]);
    // Opened from its address, the row is in view beside the list, but nothing took focus.
    expect(within(getList()).getByRole("link", { name: FAR.subject })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/discussions"));
    await waitFor(() => expect(getList().classList.contains("workflow-list--table")).toBe(true));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(getList()).getByRole("link", { name: FAR.subject }),
      ),
    );
    expect(getList().scrollTop).toBeGreaterThan(0);
  });
});

describe("an open Discussion", () => {
  it("draws the subject, the repository and the size, named by its subject", async () => {
    await openDiscussions(`/discussions/${TOTALS.id}`);

    const open = await screen.findByRole("region", { name: "Edits overlap in src/cart/totals.ts" });
    const heading = within(open).getByRole("heading", { level: 1 });
    expect(heading.querySelector("code")?.textContent).toBe("src/cart/totals.ts");
    expect(
      within(within(open).getByRole("list", { name: "About this discussion" }))
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual(["acme/webshop", "3 sessions · 6 posts"]);
    expect(open.querySelector(".open-lead .overlap-mark")).toBeTruthy();
  });

  it("lists the shared files with the faces and the names of the sessions that edited them", async () => {
    await openDiscussions(`/discussions/${TOTALS.id}`);

    const files = await screen.findByRole("list", { name: "Shared files" });
    const rows = within(files).getAllByRole("listitem");
    expect(rows.map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ["src/cart/totals.ts", "Write the retry runbook, Fix flaky webhook tests", "09:12"],
      ["src/cart/totals.test.ts", "Fix flaky webhook tests, Bump the Bun pin", "09:30"],
    ]);
    expect(rows[0]!.querySelectorAll(".faces > *")).toHaveLength(2);
    const heading = screen.getByRole("heading", { name: /^Shared files/ });
    expect(heading.querySelector(".count")?.textContent).toBe("2");
  });

  it("draws no shared files for a Discussion that has none", async () => {
    await openDiscussions(`/discussions/${HELPERS.id}`);

    const open = await screen.findByRole("region", {
      name: "Who owns the price formatting helpers?",
    });
    expect(screen.queryByRole("heading", { name: /Shared files/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Shared files" })).toBeNull();
    // A general Discussion has no overlap mark beside its subject.
    expect(open.querySelector(".overlap-mark")).toBeNull();
  });

  it("draws the Posts in order, each as its author's kind of Post", async () => {
    await openDiscussions(`/discussions/${TOTALS.id}`);

    const open = await screen.findByRole("region", { name: "Edits overlap in src/cart/totals.ts" });
    const posts = [...open.querySelectorAll(".posts > *")];
    expect(posts).toHaveLength(5);

    // A system Post is one line: its code span is code, and its time follows.
    expect(posts[0]!.className).toBe("post-system");
    expect(posts[0]!.querySelector("code")?.textContent).toBe("src/cart/totals.ts");
    expect(posts[0]!.querySelector("time")?.textContent).toBe("09:12");

    // A session's Post names its agent as a link to the thread, and its text is Markdown.
    const first = within(posts[1] as HTMLElement);
    expect(first.getByRole("link", { name: "Write the retry runbook" }).getAttribute("href")).toBe(
      `/threads/${RUNBOOK_ID}`,
    );
    expect(first.getByText("computeTotals").tagName).toBe("CODE");
    expect(posts[1]!.querySelector(".msg-name small")?.textContent).toBe("09:14");
    expect(
      within(posts[2] as HTMLElement)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Round each line", "Then sum"]);

    // The user is "You", and a run is named by its id. A Post from another day shows its
    // day and time, the transcript's message-time format, not only the day as the list does.
    expect(posts[3]!.querySelector(".msg-name span")?.textContent).toBe("You");
    expect(posts[4]!.querySelector(".msg-name span")?.textContent).toBe("run 00000001");
    expect(posts[4]!.querySelector(".msg-name small")?.textContent).toBe("10 Oct 08:00");
  });

  it("keeps the Discussion filling the pane through the full width", async () => {
    await openDiscussions(`/discussions/${TOTALS.id}?full=true`);

    await screen.findByRole("region", { name: "Edits overlap in src/cart/totals.ts" });
    expect(screen.queryByRole("navigation", { name: "Discussion list" })).toBeNull();
  });

  it("says when no Discussion has the id, and leads back to the list", async () => {
    const { router } = await openDiscussions(`/discussions/${UNKNOWN_ID}`);

    expect(await screen.findByText("This discussion was not found.")).toBeTruthy();
    // The list stays beside it.
    expect(
      within(getList()).getByRole("link", { name: "Who owns the price formatting helpers?" }),
    ).toBeTruthy();

    const notFound = screen.getByText("This discussion was not found.").parentElement!;
    await userEvent.click(within(notFound).getByRole("link", { name: "Discussions" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/discussions"));
  });
  // A new pane starts scrolled to the top, so the user never lands halfway
  // down the next Discussion. The same Discussion keeps its pane, and its
  // scroll position.
  it("draws another Discussion in a new pane, and keeps the pane through a push and the list's toggle", async () => {
    const { router, live, context } = await openDiscussions(`/discussions/${TOTALS.id}`);
    const pane = (
      await screen.findByRole("region", { name: "Edits overlap in src/cart/totals.ts" })
    ).closest(".open-pane");
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));

    act(() => live.pushInvalidation("discussion", [TOTALS.id]));
    await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));
    await act(() =>
      router.navigate({
        to: "/discussions/$discussionId",
        params: { discussionId: TOTALS.id },
        search: { full: true },
      }),
    );
    expect(
      screen
        .getByRole("region", { name: "Edits overlap in src/cart/totals.ts" })
        .closest(".open-pane"),
    ).toBe(pane);

    await act(() =>
      router.navigate({ to: "/discussions/$discussionId", params: { discussionId: HELPERS.id } }),
    );
    const otherPane = (
      await screen.findByRole("region", { name: "Who owns the price formatting helpers?" })
    ).closest(".open-pane");
    expect(otherPane).not.toBe(pane);
  });
});

describe("Esc on an open Discussion", () => {
  it("closes the Discussion, back to the table", async () => {
    const { router } = await openDiscussions(`/discussions/${HELPERS.id}?full=true`);

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/discussions"));
    expect(router.state.location.search).toEqual({});
  });

  it("is left to a focused text field", async () => {
    const { router } = await openDiscussions(`/discussions/${HELPERS.id}`);
    const field = document.createElement("input");
    document.body.append(field);
    act(() => field.focus());

    fireEvent.keyDown(field, { key: "Escape" });

    expect(router.state.location.pathname).toBe(`/discussions/${HELPERS.id}`);
    field.remove();
  });

  it("does nothing on the table", async () => {
    const { router } = await openDiscussions();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(router.state.location.pathname).toBe("/discussions");
  });
});

describe("the Discussions' live updates", () => {
  /** Returns the paths of the GET requests in `calls`, from `from` on. */
  const readPaths = (calls: readonly Call[], from: number): string[] =>
    calls
      .slice(from)
      .filter((call) => call.method === "GET")
      .map((call) => call.path);

  it("reads the list and the open Discussion again on a discussion push", async () => {
    const { calls, live, context } = await openDiscussions(`/discussions/${TOTALS.id}`);
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));

    const before = calls.length;
    act(() => live.pushInvalidation("discussion", [TOTALS.id]));

    await waitFor(() => {
      const paths = readPaths(calls, before);
      expect(paths).toContain("/api/v1/discussions");
      expect(paths).toContain(`/api/v1/discussions/${TOTALS.id}`);
    });
  });

  it("reads the list and the open Discussion again when the window shows again", async () => {
    const { calls, live, context } = await openDiscussions(`/discussions/${TOTALS.id}`);
    const settle = async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));
    };
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));
    await settle();

    setVisibility("hidden");
    await waitFor(() => expect(live.readTopics()).not.toContain("discussion"));
    setVisibility("visible");
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));
    await settle();

    // The controller's first push on the new subscription says anything may have changed.
    const before = calls.length;
    act(() => live.pushInvalidation("discussion", []));

    await waitFor(() => {
      const paths = readPaths(calls, before);
      expect(paths).toContain("/api/v1/discussions");
      expect(paths).toContain(`/api/v1/discussions/${TOTALS.id}`);
    });
  });

  it("drops the topic while the window is hidden, and holds it again when it shows", async () => {
    const { live } = await openDiscussions();
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));

    setVisibility("hidden");

    await waitFor(() => expect(live.readTopics()).not.toContain("discussion"));

    setVisibility("visible");

    await waitFor(() => expect(live.readTopics()).toContain("discussion"));
  });

  it("drops the topic when Discussions closes", async () => {
    const { live, router } = await openDiscussions();
    await waitFor(() => expect(live.readTopics()).toContain("discussion"));

    await act(() => router.navigate({ to: "/" }));

    await waitFor(() => expect(live.readTopics()).not.toContain("discussion"));
  });
});
