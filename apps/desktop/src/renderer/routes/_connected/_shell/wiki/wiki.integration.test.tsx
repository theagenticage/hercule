/**
 * Tests the Wiki: its list of pages grouped by project, the three widths of
 * the list, an open page with its History and its older revisions, a page or
 * a revision that does not exist, Esc, paging, the actors the screen names,
 * and how the `wikiPage` topic keeps it current while the window is visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WikiPageSummary, WikiRevision } from "@hercule/contract";
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

/** The session of the agent that wrote the newest revision of the release page: "Write the retry runbook". */
const AGENT_ID = FIXTURE_THREAD_IDS.runbook;
const AGENT_ACTOR = `session:${AGENT_ID}`;

/** The run that wrote the first revision of the release page. */
const RUN_ACTOR = "run:01a06d02-7900-7000-8000-000000000001";

const buildPage = (
  over: Partial<WikiPageSummary> & Pick<WikiPageSummary, "id">,
): WikiPageSummary => ({
  resourceId: WEBSHOP_ID,
  repository: "github.com/acme/webshop",
  slug: "page",
  title: "A page",
  summary: "What the page is about.",
  revision: 1,
  updatedAt: "2026-10-01T09:00:00.000Z",
  updatedBy: "user",
  createdAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

const RELEASES = buildPage({
  id: "01a06d02-7e00-7000-8000-000000000001",
  slug: "release-process",
  title: "How releases work",
  summary: "Who cuts a release, and what it takes.",
  revision: 3,
  updatedAt: "2026-10-11T08:15:00.000Z",
  updatedBy: AGENT_ACTOR,
});
const DEPLOY = buildPage({
  id: "01a06d02-7e00-7000-8000-000000000002",
  resourceId: INFRA_ID,
  repository: "github.com/acme/ops-infra",
  slug: "deploy",
  title: "Deploy runbook",
  summary: "How the infrastructure is deployed.",
  updatedAt: "2026-10-10T12:00:00.000Z",
  updatedBy: "user",
});
const ALERTS = buildPage({
  id: "01a06d02-7e00-7000-8000-000000000003",
  resourceId: RUNBOOKS_ID,
  repository: "github.com/acme/ops-runbooks",
  slug: "alert-routing",
  title: "Alert routing",
  summary: "Which alert pages whom.",
  updatedAt: "2026-10-01T09:00:00.000Z",
  updatedBy: RUN_ACTOR,
});
const PAGES = [RELEASES, DEPLOY, ALERTS];

/** The revisions of a page, newest first, as `wikiPage.read` lists them. */
const buildRevision = (
  revision: number,
  title: string,
  actor: string,
  at: string,
): WikiRevision => ({ revision, title, summary: `Summary of revision ${revision}.`, at, actor });

/** The release page's three revisions: the run wrote it, the user renamed it back, an agent renamed it. */
const RELEASE_REVISIONS: readonly WikiRevision[] = [
  buildRevision(3, "How releases work", AGENT_ACTOR, "2026-10-11T08:15:00.000Z"),
  buildRevision(2, "Releases", "user", "2026-10-09T12:00:00.000Z"),
  buildRevision(1, "Releases", RUN_ACTOR, "2026-10-01T09:00:00.000Z"),
];

/**
 * The page 60 revisions long: revisions 60 down to 11 are listed, so the list
 * says ten older revisions are not.
 */
const LONG = buildPage({
  id: "01a06d02-7e00-7000-8000-000000000004",
  slug: "long-history",
  title: "Long history",
  revision: 60,
});
const LONG_REVISIONS: readonly WikiRevision[] = Array.from({ length: 50 }, (_, index) =>
  buildRevision(60 - index, "Long history", "user", "2026-10-01T09:00:00.000Z"),
);

/** A page with 51 revisions, one more than the 50 the list holds. */
const JUST_OVER = buildPage({
  id: "01a06d02-7e00-7000-8000-000000000005",
  slug: "just-over",
  title: "Just over",
  revision: 51,
});
const JUST_OVER_REVISIONS: readonly WikiRevision[] = Array.from({ length: 50 }, (_, index) =>
  buildRevision(51 - index, "Just over", "user", "2026-10-01T09:00:00.000Z"),
);

/** The id of a page the controller does not have. */
const UNKNOWN_ID = "01a06d02-7e00-7000-8000-0000000000ff";

/** Builds `count` pages of the webshop project, "Page 1" on, newest first. */
const buildLongList = (count: number): WikiPageSummary[] =>
  Array.from({ length: count }, (_, index) =>
    buildPage({
      id: `01a06d02-7e00-7000-8100-${String(index + 1).padStart(12, "0")}`,
      slug: `page-${index + 1}`,
      title: `Page ${index + 1}`,
    }),
  );

/** Every page the controller can read, listed or not. */
const READABLE_PAGES = [...PAGES, LONG, JUST_OVER];

/** What `wikiPage.read` answers for each page's id: its revisions, newest first. */
const REVISIONS_BY_PAGE: Readonly<Record<string, readonly WikiRevision[]>> = {
  [RELEASES.id]: RELEASE_REVISIONS,
  [LONG.id]: LONG_REVISIONS,
  [JUST_OVER.id]: JUST_OVER_REVISIONS,
};

const RELEASE_BODY = "Releases are cut from `main`.\n\n- Tag the commit\n- Run the build";

/**
 * Returns the handler that answers `wikiPage.read` for a page, as of
 * `revision` when the query names one. It reads the pages of `READABLE_PAGES`
 * and the pages in `listed`, which have one revision each.
 */
const buildAnswerPageRead = (listed: readonly WikiPageSummary[]) => (call: Call) => {
  const id = call.path.split("/").at(-1)!;
  const summary = [...READABLE_PAGES, ...listed].find((page) => page.id === id);
  const revisions =
    REVISIONS_BY_PAGE[id] ??
    (summary === undefined
      ? undefined
      : [buildRevision(1, summary.title, "user", summary.updatedAt)]);
  const requested = new URLSearchParams(call.search).get("revision");
  const shown =
    requested === null
      ? revisions?.[0]
      : revisions?.find((revision) => revision.revision === Number(requested));
  if (summary === undefined || revisions === undefined || shown === undefined) {
    return { status: 404, body: buildErrorBody("not_found", `no wiki page ${id}`) };
  }
  return {
    body: {
      page: {
        ...summary,
        title: shown.title,
        // The current page keeps its listed summary; an older revision has its own.
        summary: requested === null ? summary.summary : shown.summary,
        revision: shown.revision,
        updatedAt: shown.at,
        updatedBy: shown.actor,
        body: requested === null ? RELEASE_BODY : `The page as of revision ${shown.revision}.`,
      },
      revisions,
    },
  };
};

/**
 * Opens the app at `path`, the Wiki's list by default, with the wiki pages in
 * `listed`, one array for each page the list is read in, and waits for the
 * floating header to show. While `isNextPageFailing`, the reads of the second
 * page fail; `healNextPage` makes them succeed.
 *
 * With `isNextPageFailing`, every read of the first page after the loader's
 * also answers 20 ms late, as a real controller's answer comes after the
 * list has drawn. The list then reaches its end while a push reads the list
 * again, which is the order in which a failing next page could be read
 * without end.
 */
const openWiki = async (
  path = "/wiki",
  listed: readonly (readonly WikiPageSummary[])[] = [PAGES],
  isNextPageFailing = false,
) => {
  const answerPageRead = buildAnswerPageRead(listed.flat());
  let failing = isNextPageFailing;
  let firstPageReads = 0;
  const handlers: Readonly<Record<string, Handler>> = {
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    // A page of the list is named by the number of the page before it.
    "GET /api/v1/wiki-pages": async (call) => {
      const cursor = new URLSearchParams(call.search).get("cursor");
      const index = cursor === null ? 0 : Number(cursor);
      if (index === 0 && isNextPageFailing && firstPageReads++ > 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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
      [...[...READABLE_PAGES, ...listed.flat()].map((page) => page.id), UNKNOWN_ID].map(
        (id): [string, Handler] => [`GET /api/v1/wiki-pages/${id}`, answerPageRead],
      ),
    ),
    // The agent that wrote the release page's newest revision.
    [`GET /api/v1/sessions/${AGENT_ID}`]: { body: SIDEBAR_FIXTURE.threads[0] },
  };
  const calls = stubApi(handlers);
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path, retryFailedReads: !isNextPageFailing },
  );
  // The header's pill, which every width draws.
  await screen.findByRole("navigation", { name: "Wiki" });
  return {
    calls,
    healNextPage: () => {
      failing = false;
    },
    ...app,
  };
};

const getList = () => screen.getByRole("navigation", { name: "Wiki page list" });
const getHeader = () => screen.getByRole("navigation", { name: "Wiki" });

/** Returns the names of the list's headings and rows, in order. */
const readList = (): string[] =>
  [...getList().querySelectorAll("[data-key]")].map(
    (item) => item.getAttribute("aria-label") ?? item.textContent ?? "",
  );

/** Returns the open page's History list. */
const getHistory = () => screen.getByRole("complementary", { name: "History" });

describe("the wiki list", () => {
  it("groups the pages by project, with a sub-heading for each repository of a project with several", async () => {
    await openWiki();

    expect(readList()).toEqual([
      "webshop",
      "How releases work",
      "ops",
      "acme/ops-infra",
      "Deploy runbook",
      "acme/ops-runbooks",
      "Alert routing",
    ]);
  });

  it("shows each page's name and summary, who changed it, and when", async () => {
    await openWiki();

    const row = within(getList()).getByRole("link", {
      name: "How releases work",
      description: "Who cuts a release, and what it takes.",
    });
    expect([...row.children].map((cell) => cell.textContent)).toEqual([
      "How releases workWho cuts a release, and what it takes.",
      "Write the retry runbook",
      "08:15",
    ]);
    // The name of whoever changed the page is the last text in the "Changed by" cell, after its mark.
    const readChange = (title: string) => {
      const [, who, changed] = within(getList()).getByRole("link", { name: title }).children;
      return [who!.lastElementChild!.textContent, changed!.textContent];
    };
    // The user is "You", a run is named by its id, and the time is the day for an older page.
    expect(readChange("Deploy runbook")).toEqual(["You", "Sat"]);
    expect(readChange("Alert routing")).toEqual(["run 00000001", "1 Oct"]);
  });

  it("opens a page from its row, and marks the row selected", async () => {
    const { router } = await openWiki();
    const row = within(getList()).getByRole("link", { name: "Deploy runbook" });
    expect(row.getAttribute("href")).toBe(`/wiki/${DEPLOY.id}`);

    await userEvent.click(row);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/wiki/${DEPLOY.id}`));
    const selected = within(getList()).getByRole("link", { name: "Deploy runbook" });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(selected.classList.contains("is-on")).toBe(true);
  });

  it("says when there are no pages", async () => {
    await openWiki("/wiki", [[]]);

    expect(within(getList()).getByText("No wiki pages yet")).toBeTruthy();
  });

  it("reads the next page of pages when the list reaches its end", async () => {
    const { calls } = await openWiki("/wiki", [[RELEASES, DEPLOY], [ALERTS]]);

    await waitFor(() =>
      expect(within(getList()).getByRole("link", { name: "Alert routing" })).toBeTruthy(),
    );
    const reads = calls
      .filter((call) => call.method === "GET" && call.path === "/api/v1/wiki-pages")
      .map((call) => call.search);
    expect(reads[0]).toBe("");
    expect(reads).toContain("?cursor=1");
    // The page of the second page sits under its own repository, below the first page's.
    expect(readList()).toEqual([
      "webshop",
      "How releases work",
      "ops",
      "acme/ops-infra",
      "Deploy runbook",
      "acme/ops-runbooks",
      "Alert routing",
    ]);
  });

  it("does not read a failed next page again by itself, only from the Retry row", async () => {
    const { calls, healNextPage, live, context } = await openWiki(
      "/wiki",
      [[RELEASES, DEPLOY], [ALERTS]],
      true,
    );
    const readNextPages = () =>
      calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path === "/api/v1/wiki-pages" &&
          call.search === "?cursor=1",
      );

    // The live connection reads every list once it opens, which clears the
    // failure and reads the next page once more. Wait until no read runs
    // and the list ends on the failure.
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => {
      expect(context.queryClient.isFetching()).toBe(0);
      expect(within(getList()).getByRole("button", { name: "Retry" })).toBeTruthy();
    });
    expect(within(getList()).getByRole("alert").textContent).toContain(
      "Could not read the next page: The database is locked.",
    );
    const readsBefore = readNextPages().length;
    expect(readsBefore).toBeLessThanOrEqual(2);

    // The list is still at its end, and does not read the page again.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(readNextPages()).toHaveLength(readsBefore);

    healNextPage();
    await userEvent.click(within(getList()).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(within(getList()).getByRole("link", { name: "Alert routing" })).toBeTruthy(),
    );
    expect(readNextPages()).toHaveLength(readsBefore + 1);
    expect(within(getList()).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("a page far down a long list", () => {
  const LONG_LIST = buildLongList(80);
  const FAR = LONG_LIST[69]!;

  it("scrolls to its row and focuses it when it opens beside the list", async () => {
    const { router } = await openWiki("/wiki", [LONG_LIST]);
    // The row is far below the rows that fit the window, so it is not drawn.
    expect(within(getList()).queryByRole("link", { name: FAR.title })).toBeNull();

    await act(() => router.navigate({ to: "/wiki/$pageId", params: { pageId: FAR.id } }));

    await waitFor(() =>
      expect(document.activeElement).toBe(within(getList()).getByRole("link", { name: FAR.title })),
    );
    expect(getList().classList.contains("workflow-list--column")).toBe(true);
    expect(getList().scrollTop).toBeGreaterThan(0);
  });

  it("scrolls to its row and focuses it when Esc closes it back to the table", async () => {
    const { router } = await openWiki(`/wiki/${FAR.id}`, [LONG_LIST]);
    // Opened from its address, the row is in view beside the list, but nothing took focus.
    expect(within(getList()).getByRole("link", { name: FAR.title })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/wiki"));
    await waitFor(() => expect(getList().classList.contains("workflow-list--table")).toBe(true));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(getList()).getByRole("link", { name: FAR.title })),
    );
    expect(getList().scrollTop).toBeGreaterThan(0);
  });
});

describe("the wiki list's widths", () => {
  it("places its headings and its two-line rows again when the Text size changes their heights", async () => {
    await openWiki();
    const items = getList().querySelector<HTMLElement>(".virtual-list-items")!;
    const before = Number.parseFloat(items.style.height);

    // At the largest step a heading and a sub-heading are each 2px taller, and a two-line row 4px.
    await changeTextSize(4, {
      "--list-height-group-heading": "26px",
      "--list-height-repository-heading": "24px",
      "--list-height-two-line-row": "56px",
    });

    // Two projects, two repositories with a sub-heading, and three pages.
    expect(Number.parseFloat(items.style.height) - before).toBe(2 * 2 + 2 * 2 + 3 * 4);
  });

  it("draws the table while no page is open, with its column heads", async () => {
    await openWiki();

    expect(screen.getByRole("heading", { level: 1, name: "Wiki" })).toBeTruthy();
    expect(getList().classList.contains("workflow-list--table")).toBe(true);
    expect(getList().classList.contains("wiki-list")).toBe(true);
    expect(within(getList()).getByText("Changed by")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("draws the list as a column beside an open page, with its pages' names over their times", async () => {
    // The first page is open, so the list stays scrolled to the top and every
    // row is on screen, which keeps its time current.
    await openWiki(`/wiki/${RELEASES.id}`);

    expect(getList().classList.contains("workflow-list--column")).toBe(true);
    expect(within(getList()).queryByText("Changed by")).toBeNull();
    const row = within(getList()).getByRole("link", { name: "How releases work" });
    expect([...row.children].map((part) => part.textContent)).toEqual([
      "",
      "How releases workWho cuts a release, and what it takes.",
      "08:15",
    ]);
    expect(
      within(getList())
        .getByRole("link", { name: "How releases work" })
        .getAttribute("aria-current"),
    ).toBe("page");
    // The same groups and rows as the table.
    expect(readList()).toHaveLength(7);
  });

  it("hides the list while the open page fills the pane", async () => {
    await openWiki(`/wiki/${DEPLOY.id}?full=true`);

    expect(screen.queryByRole("navigation", { name: "Wiki page list" })).toBeNull();
    expect(within(getHeader()).getByRole("button", { name: "Show the list" })).toBeTruthy();
  });

  it("hides the list and shows it again from the header's button, keeping the revision", async () => {
    const { router } = await openWiki(`/wiki/${RELEASES.id}?revision=2`);

    await userEvent.click(within(getHeader()).getByRole("button", { name: "Hide the list" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ revision: 2, full: true }));
    expect(screen.queryByRole("navigation", { name: "Wiki page list" })).toBeNull();

    await userEvent.click(within(getHeader()).getByRole("button", { name: "Show the list" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ revision: 2 }));
    expect(
      within(getList())
        .getByRole("link", { name: "How releases work" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("leads back to the table from the header's tab", async () => {
    const { router } = await openWiki(`/wiki/${DEPLOY.id}`);
    const back = within(getHeader()).getByRole("link", { name: "Wiki" });
    expect(back.getAttribute("href")).toBe("/wiki");

    await userEvent.click(back);

    await waitFor(() => expect(router.state.location.pathname).toBe("/wiki"));
    expect(getList().classList.contains("workflow-list--table")).toBe(true);
  });

  it("keeps the focus on the open page's row while the list changes width", async () => {
    const { router } = await openWiki();
    act(() => within(getList()).getByRole("link", { name: "Deploy runbook" }).focus());

    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe(`/wiki/${DEPLOY.id}`));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(getList()).getByRole("link", { name: "Deploy runbook" }),
      ),
    );

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/wiki"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(getList()).getByRole("link", { name: "Deploy runbook" }),
      ),
    );
  });
});

describe("an open wiki page", () => {
  it("draws the page's title, summary, repository and body, named by its title", async () => {
    await openWiki(`/wiki/${RELEASES.id}`);

    const page = await screen.findByRole("region", { name: "How releases work" });
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("How releases work");
    expect(within(page).getByText("Who cuts a release, and what it takes.")).toBeTruthy();
    expect(within(page).getByRole("list", { name: "About this page" }).textContent).toBe(
      "acme/webshop",
    );
    // The body is Markdown.
    expect(within(page).getByText("main").tagName).toBe("CODE");
    expect(
      within(page)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(expect.arrayContaining(["Tag the commit", "Run the build"]));
    expect(screen.queryByText(/This is not the current page/)).toBeNull();
  });

  it("lists the history, newest first, with who wrote each revision, when, and which revision renamed the page", async () => {
    await openWiki(`/wiki/${RELEASES.id}`);

    const rows = within(getHistory()).getAllByRole("link");
    expect(
      rows.map((row) =>
        [...row.querySelectorAll(".rev-n, .rev-who, .rev-when")].map((part) => part.textContent),
      ),
    ).toEqual([
      ["3", "Write the retry runbook", "08:15", "Renamed to How releases work"],
      ["2", "You", "Fri"],
      ["1", "run 00000001", "1 Oct"],
    ]);
    // The newest revision opens the current page, the others their revision.
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      `/wiki/${RELEASES.id}`,
      `/wiki/${RELEASES.id}?revision=2`,
      `/wiki/${RELEASES.id}?revision=1`,
    ]);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(within(getHistory()).queryByText(/older revision/)).toBeNull();
  });

  it("says how many older revisions the history leaves out", async () => {
    await openWiki(`/wiki/${LONG.id}`);
    expect(within(getHistory()).getByText("And 10 older revisions")).toBeTruthy();
  });

  it("says it in the singular for one older revision", async () => {
    await openWiki(`/wiki/${JUST_OVER.id}`);
    expect(within(getHistory()).getByText("And 1 older revision")).toBeTruthy();
  });

  it("opens an older revision from the history, with a band that leads back to the current page", async () => {
    const { router } = await openWiki(`/wiki/${RELEASES.id}`);

    await userEvent.click(within(getHistory()).getByRole("link", { name: /^2/ }));

    await waitFor(() => expect(router.state.location.search).toEqual({ revision: 2 }));
    await screen.findByText("The page as of revision 2.");
    // Revision 2 is from Friday 9 October, and its title was "Releases".
    expect(
      screen.getByText("Revision 2 of 3, from Fri. This is not the current page."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Releases" })).toBeTruthy();
    const shown = within(getHistory()).getAllByRole("link");
    expect(shown.map((row) => row.getAttribute("aria-current"))).toEqual([null, "page", null]);

    await userEvent.click(screen.getByRole("link", { name: "Show the current page" }));

    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await screen.findByRole("heading", { level: 1, name: "How releases work" });
    expect(screen.queryByText(/This is not the current page/)).toBeNull();
  });

  it("keeps the page filling the pane through the history and the band", async () => {
    await openWiki(`/wiki/${RELEASES.id}?full=true&revision=1`);

    await screen.findByText(/Revision 1 of 3/);
    expect(screen.getByRole("link", { name: "Show the current page" }).getAttribute("href")).toBe(
      `/wiki/${RELEASES.id}?full=true`,
    );
    expect(
      within(getHistory())
        .getAllByRole("link")
        .map((row) => row.getAttribute("href")),
    ).toEqual([
      `/wiki/${RELEASES.id}?full=true`,
      `/wiki/${RELEASES.id}?full=true&revision=2`,
      `/wiki/${RELEASES.id}?full=true&revision=1`,
    ]);
  });

  it("drops a revision that is not a positive whole number, and shows the current page", async () => {
    const { router } = await openWiki(`/wiki/${RELEASES.id}?revision=0`);

    await screen.findByRole("heading", { level: 1, name: "How releases work" });
    expect(router.state.location.search).toEqual({});
  });

  it("says when no page has the id, and leads back to the list", async () => {
    const { router } = await openWiki(`/wiki/${UNKNOWN_ID}`);

    expect(await screen.findByText("This wiki page was not found.")).toBeTruthy();
    // The list stays beside it.
    expect(within(getList()).getByRole("link", { name: "Deploy runbook" })).toBeTruthy();

    const notFound = screen.getByText("This wiki page was not found.").parentElement!;
    await userEvent.click(within(notFound).getByRole("link", { name: "Wiki" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/wiki"));
  });

  it("says when the page has no such revision, and leads to its current revision", async () => {
    const { router } = await openWiki(`/wiki/${RELEASES.id}?revision=9`);

    expect(await screen.findByText("This wiki page has no revision 9.")).toBeTruthy();
    const notFound = screen.getByText("This wiki page has no revision 9.").parentElement!;
    await userEvent.click(within(notFound).getByRole("link", { name: "Current revision" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/wiki/${RELEASES.id}`));
    expect(router.state.location.search).toEqual({});
  });

  it("says the page was not found when a revision is asked of a page that does not exist", async () => {
    await openWiki(`/wiki/${UNKNOWN_ID}?revision=2`);

    expect(await screen.findByText("This wiki page was not found.")).toBeTruthy();
  });

  // A new pane starts scrolled to the top, so the user never lands halfway
  // down the next page. The same page keeps its pane, and its scroll position.
  it("draws another page or revision in a new pane, and keeps the pane through a push and the list's toggle", async () => {
    const { router, live, context } = await openWiki(`/wiki/${RELEASES.id}`);
    const pane = (await screen.findByRole("region", { name: "How releases work" })).closest(
      ".open-pane",
    );
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));

    act(() => live.pushInvalidation("wikiPage", [RELEASES.id]));
    await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));
    await act(() =>
      router.navigate({
        to: "/wiki/$pageId",
        params: { pageId: RELEASES.id },
        search: { full: true },
      }),
    );
    expect(screen.getByRole("region", { name: "How releases work" }).closest(".open-pane")).toBe(
      pane,
    );

    await act(() =>
      router.navigate({
        to: "/wiki/$pageId",
        params: { pageId: RELEASES.id },
        search: { revision: 2 },
      }),
    );
    const revisionPane = (await screen.findByRole("region", { name: "Releases" })).closest(
      ".open-pane",
    );
    expect(revisionPane).not.toBe(pane);

    await act(() => router.navigate({ to: "/wiki/$pageId", params: { pageId: DEPLOY.id } }));
    const otherPane = (await screen.findByRole("region", { name: "Deploy runbook" })).closest(
      ".open-pane",
    );
    expect(otherPane).not.toBe(revisionPane);
  });
});

describe("Esc on an open wiki page", () => {
  it("closes the page, back to the table", async () => {
    const { router } = await openWiki(`/wiki/${DEPLOY.id}?full=true`);

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/wiki"));
    expect(router.state.location.search).toEqual({});
  });

  it("is left to a focused text field", async () => {
    const { router } = await openWiki(`/wiki/${DEPLOY.id}`);
    const field = document.createElement("input");
    document.body.append(field);
    act(() => field.focus());

    fireEvent.keyDown(field, { key: "Escape" });

    expect(router.state.location.pathname).toBe(`/wiki/${DEPLOY.id}`);
    field.remove();
  });

  it("does nothing on the table", async () => {
    const { router } = await openWiki();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(router.state.location.pathname).toBe("/wiki");
  });
});

describe("the Wiki's live updates", () => {
  /** Returns the paths of the GET requests in `calls`, from `from` on. */
  const readPaths = (calls: readonly Call[], from: number): string[] =>
    calls
      .slice(from)
      .filter((call) => call.method === "GET")
      .map((call) => call.path);

  it("reads the list and the open page again on a wikiPage push", async () => {
    const { calls, live, context } = await openWiki(`/wiki/${RELEASES.id}`);
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));

    const before = calls.length;
    act(() => live.pushInvalidation("wikiPage", [RELEASES.id]));

    await waitFor(() => {
      const paths = readPaths(calls, before);
      expect(paths).toContain("/api/v1/wiki-pages");
      expect(paths).toContain(`/api/v1/wiki-pages/${RELEASES.id}`);
    });
  });

  it("reads the list and the open page again when the window shows again", async () => {
    const { calls, live, context } = await openWiki(`/wiki/${RELEASES.id}`);
    const settle = async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));
    };
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));
    await settle();

    setVisibility("hidden");
    await waitFor(() => expect(live.readTopics()).not.toContain("wikiPage"));
    setVisibility("visible");
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));
    await settle();

    // The controller's first push on the new subscription says anything may have changed.
    const before = calls.length;
    act(() => live.pushInvalidation("wikiPage", []));

    await waitFor(() => {
      const paths = readPaths(calls, before);
      expect(paths).toContain("/api/v1/wiki-pages");
      expect(paths).toContain(`/api/v1/wiki-pages/${RELEASES.id}`);
    });
  });

  it("drops the topic while the window is hidden, and holds it again when it shows", async () => {
    const { live } = await openWiki();
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));

    setVisibility("hidden");

    await waitFor(() => expect(live.readTopics()).not.toContain("wikiPage"));

    setVisibility("visible");

    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));
  });

  it("drops the topic when the Wiki closes", async () => {
    const { live, router } = await openWiki();
    await waitFor(() => expect(live.readTopics()).toContain("wikiPage"));

    await act(() => router.navigate({ to: "/" }));

    await waitFor(() => expect(live.readTopics()).not.toContain("wikiPage"));
  });
});
