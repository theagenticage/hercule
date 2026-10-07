/**
 * Tests the thread's side pane, its Subagents surface, the tally pill that
 * opens it and the header row beside it, against a stubbed controller. The
 * tests drive the app only through `renderApp`, and never import the
 * screen's own modules.
 *
 * The pane's layout is kept in `sessionStorage`, which `renderApp` does not
 * replace, so every test clears it afterwards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, Resource, Session, Subagent, Workspace } from "@hercule/contract";
import { renderApp, stubApi, type Call, type Handler } from "../../../../app/testing";
import { SESSION, SESSION_ID, buildController, buildSession, buildSubagent } from "./-fixtures";

const AT = "2026-09-08T09:59:00.000Z";

/** A thread whose harness has reported token usage. */
const REPORTED_SESSION = buildSession({ usage: { inputTokens: 40_000, outputTokens: 2_300 } });

/** A running subagent the session's own agent started, with one running child. */
const EXPLORER = buildSubagent({
  id: "toolu_explore_auth",
  description: "Explore the auth module",
  agentType: "Explore",
  toolCalls: 2,
  activity: "Reading src/auth/session.ts",
  startedAt: "2026-09-08T10:00:01.000Z",
});

const READER = buildSubagent({
  id: "toolu_read_tests",
  parentSubagentId: EXPLORER.id,
  description: "Read the auth tests",
  toolCalls: 1,
  startedAt: "2026-09-08T10:00:05.000Z",
});

const PLANNER = buildSubagent({
  id: "toolu_plan_fix",
  description: "Plan the fix",
  status: "completed",
  toolCalls: 4,
  result: "Change the cookie's SameSite flag.",
  startedAt: "2026-09-08T09:59:30.000Z",
  endedAt: "2026-09-08T10:00:00.000Z",
});

const SUBAGENTS: readonly Subagent[] = [PLANNER, EXPLORER, READER];

const openThread = async ({
  session = REPORTED_SESSION,
  subagents = SUBAGENTS,
  path = `/threads/${SESSION_ID}`,
  extra = {},
}: {
  readonly session?: Session;
  readonly subagents?: readonly Subagent[];
  readonly path?: string;
  readonly extra?: Readonly<Record<string, Handler>>;
} = {}) => {
  const api = stubApi(
    buildController(
      { session, subagents },
      { [`POST /api/v1/sessions/${SESSION_ID}/interrupt`]: { body: session }, ...extra },
    ),
  );
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Opens the pane with the header's toggle, and returns the pane. */
const openPane = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name: "Show the side pane" }));
  return screen.findByRole("complementary", { name: "Side pane" });
};

/** Returns the interrupt calls the app sent, by their payload. */
const readInterrupts = (calls: readonly Call[]): readonly unknown[] =>
  calls
    .filter(
      (call) => call.method === "POST" && call.path === `/api/v1/sessions/${SESSION_ID}/interrupt`,
    )
    .map((call) => call.body);

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("Side pane: opening and closing", () => {
  it("is closed until the header's toggle opens it on Subagents", async () => {
    const user = userEvent.setup();
    await openThread();
    await screen.findByRole("button", { name: "Show the side pane" });
    expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();

    const pane = await openPane(user);

    expect(within(pane).getByRole("tab", { name: "Subagents" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Hide the side pane" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("closes when its last tab closes, and with its own close button", async () => {
    const user = userEvent.setup();
    await openThread();

    let pane = await openPane(user);
    await user.click(within(pane).getByRole("button", { name: "Close Subagents" }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();
    });

    pane = await openPane(user);
    await user.click(within(pane).getByRole("button", { name: "Close the side pane" }));
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();
    });
  });

  it("stays open when the app loads again in the same browser tab", async () => {
    const user = userEvent.setup();
    await openThread();
    await openPane(user);

    cleanup();
    await openThread();

    expect(await screen.findByRole("complementary", { name: "Side pane" })).toBeDefined();
  });

  it("opens the Subagents surface again from the + menu", async () => {
    const user = userEvent.setup();
    await openThread();
    const pane = await openPane(user);
    await user.click(within(pane).getByRole("button", { name: "Close Subagents" }));
    // Closing the last tab closes the pane; the toggle opens it on Subagents again.
    const reopened = await openPane(user);

    await user.click(within(reopened).getByRole("button", { name: "Open a surface" }));
    await user.click(await screen.findByRole("menuitem", { name: /Subagents/ }));

    expect(within(reopened).getAllByRole("tab")).toHaveLength(1);
  });

  it("opens from the tally pill, which then hides it again", async () => {
    const user = userEvent.setup();
    await openThread();
    const tally = await screen.findByRole("button", { name: /^Subagents/ });
    expect(tally.getAttribute("aria-pressed")).toBe("false");

    await user.click(tally);

    const pane = await screen.findByRole("complementary", { name: "Side pane" });
    expect(within(pane).getByRole("tab", { name: "Subagents" })).toBeDefined();
    expect(tally.getAttribute("aria-pressed")).toBe("true");

    await user.click(tally);
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Side pane" })).toBeNull();
    });
  });

  it("shows no tally pill on a thread with no subagents", async () => {
    await openThread({ subagents: [] });
    await screen.findByRole("button", { name: "Show the side pane" });
    expect(screen.queryByRole("button", { name: /^Subagents/ })).toBeNull();
  });
});

describe("Side pane: the Subagents surface", () => {
  it("lists every subagent as a tree, with the footer's summary and total tokens", async () => {
    const user = userEvent.setup();
    await openThread();
    const pane = await openPane(user);

    const explorer = await within(pane).findByRole("link", { name: "Explore the auth module" });
    const row = explorer.closest("li");
    if (row === null) throw new Error("the subagent's link sits in no row");
    // The child sits in its parent's row, on the rail under it.
    expect(within(row).getByRole("link", { name: "Read the auth tests" })).toBeDefined();
    expect(within(row).getByText("Reading src/auth/session.ts")).toBeDefined();
    expect(within(pane).getByText("Change the cookie's SameSite flag.")).toBeDefined();
    expect(within(pane).getByText("2 running · 1 settled")).toBeDefined();
    expect(within(pane).getByText("Σ 42.3k tok")).toBeDefined();
  });

  it("leaves the total out when the session has reported no usage", async () => {
    const user = userEvent.setup();
    await openThread({ session: SESSION });
    const pane = await openPane(user);

    await within(pane).findByText("2 running · 1 settled");
    expect(within(pane).queryByText(/tok$/)).toBeNull();
  });

  it("says so when the thread has no subagents", async () => {
    const user = userEvent.setup();
    await openThread({ subagents: [] });
    const pane = await openPane(user);

    expect(await within(pane).findByText("No subagents yet")).toBeDefined();
    expect(within(pane).queryByRole("button", { name: "Stop all" })).toBeNull();
  });

  it("opens a subagent's page from its row, and marks that row current", async () => {
    const user = userEvent.setup();
    const { router } = await openThread();
    const pane = await openPane(user);

    await user.click(await within(pane).findByRole("link", { name: "Read the auth tests" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}/subagents/${READER.id}`);
    });
    // The pane stays open across the move to the subagent's page.
    const stayed = screen.getByRole("complementary", { name: "Side pane" });
    await waitFor(() => {
      expect(
        within(stayed)
          .getByRole("link", { name: "Read the auth tests" })
          .getAttribute("aria-current"),
      ).toBe("page");
    });
    expect(
      within(stayed)
        .getByRole("link", { name: "Explore the auth module" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("stops one running subagent from its row", async () => {
    const user = userEvent.setup();
    const { api } = await openThread();
    const pane = await openPane(user);

    const reader = await within(pane).findByRole("link", { name: "Read the auth tests" });
    const row = reader.closest("li");
    if (row === null) throw new Error("the subagent's link sits in no row");
    await user.click(within(row).getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(readInterrupts(api.calls)).toEqual([{ subagentId: READER.id }]);
    });
  });

  it("names the subagents below in a parent's Stop", async () => {
    const user = userEvent.setup();
    await openThread();
    const pane = await openPane(user);

    expect(await within(pane).findByRole("button", { name: "Stop with 1 below" })).toBeDefined();
    // A finished subagent has nothing to stop.
    const planner = within(pane).getByRole("link", { name: "Plan the fix" }).closest("li");
    if (planner === null) throw new Error("the subagent's link sits in no row");
    expect(within(planner).queryByRole("button", { name: /^Stop/ })).toBeNull();
  });

  it("stops everything with Stop all", async () => {
    const user = userEvent.setup();
    const { api } = await openThread();
    const pane = await openPane(user);

    await user.click(await within(pane).findByRole("button", { name: "Stop all" }));

    await waitFor(() => {
      expect(readInterrupts(api.calls)).toEqual([{}]);
    });
  });
});

const PROJECT: Project = {
  id: "01a06d02-7000-7000-8000-000000000001",
  name: "webshop",
  createdAt: AT,
  updatedAt: AT,
};

const RESOURCE: Resource = {
  id: "01a06d02-7100-7000-8000-000000000001",
  kind: "repo",
  remote: "git@github.com:acme/webshop.git",
  canonicalRemote: "github.com/acme/webshop",
  label: null,
  connectionId: null,
  setupCommand: null,
  workspaceInclude: true,
  projectIds: [PROJECT.id],
  createdAt: AT,
  updatedAt: AT,
};

const WORKSPACE: Workspace = {
  id: "01a06d02-7200-7000-8000-000000000002",
  runnerId: SESSION.runnerId,
  kind: "ephemeral",
  status: "ready",
  ownership: "managed",
  path: null,
  observedAt: null,
  warnings: [],
  checkouts: [
    {
      checkoutId: "01a06d02-7300-7000-8000-000000000002",
      resourceId: RESOURCE.id,
      form: "worktree",
      subdirectory: null,
      branch: "hercule/thread-3f1",
      branches: ["hercule/thread-3f1"],
      defaultBranch: "main",
      remoteBranches: [],
      headCommit: null,
      baseCommit: null,
      startingRevision: null,
      baseBranch: null,
    },
  ],
  designatedConnectionId: null,
  message: null,
  sessionIds: [SESSION_ID],
  keptUntil: null,
  createdAt: AT,
  provisionedAt: AT,
  lastUsedAt: AT,
  disposedAt: null,
};

/** Opens a thread in `WORKSPACE`, whose header offers a new thread there. */
const openThreadInWorkspace = () => {
  const session = { ...REPORTED_SESSION, projectId: PROJECT.id, workspaceId: WORKSPACE.id };
  return openThread({
    session,
    extra: {
      "GET /api/v1/projects": { body: { items: [PROJECT] } },
      "GET /api/v1/resources": { body: { items: [RESOURCE] } },
      "GET /api/v1/workspaces": { body: { items: [WORKSPACE] } },
      "GET /api/v1/sessions": { body: { items: [session] } },
    },
  });
};

describe("Header: giving way as the row narrows", () => {
  // jsdom lays nothing out, so every element is given the width the test
  // needs; the header reads its row's width from `clientWidth`.
  const stubWidth = (width: number): void => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
  };

  it("spells out New thread here in a wide row", async () => {
    stubWidth(900);
    await openThreadInWorkspace();

    const here = await screen.findByRole("link", { name: "+ New thread here" });
    expect(here.textContent).toBe("+ New thread here");
  });

  it("shrinks New thread here to + in a narrow row, keeping its words for screen readers", async () => {
    stubWidth(500);
    await openThreadInWorkspace();

    const here = await screen.findByRole("link", { name: "New thread here" });
    expect(here.textContent).toBe("+");
    expect(here.getAttribute("title")).toBe("New thread here");
  });

  it("names the thread and the subagent's ancestors in a subagent page's crumb", async () => {
    await openThread({ path: `/threads/${SESSION_ID}/subagents/${READER.id}` });

    const thread = await screen.findByRole("link", { name: "Fix the login bug" });
    expect(thread.getAttribute("href")).toBe(`/threads/${SESSION_ID}`);
    expect(screen.getByRole("link", { name: "Explore the auth module" }).getAttribute("href")).toBe(
      `/threads/${SESSION_ID}/subagents/${EXPLORER.id}`,
    );
    expect(screen.getByText("Subagent")).toBeDefined();
  });

  it("lets a narrow row cut the crumb's links short before the subagent's own name", async () => {
    await openThread({ path: `/threads/${SESSION_ID}/subagents/${READER.id}` });

    const thread = await screen.findByRole("link", { name: "Fix the login bug" });
    const ancestor = screen.getByRole("link", { name: "Explore the auth module" });
    const name = screen.getByTitle("Read the auth tests");
    // jsdom lays nothing out, so the flex sizing is what can be checked:
    // each link shares the name's box, starts at no width and grows into
    // the room the name leaves.
    for (const link of [thread, ancestor]) {
      expect(link.parentElement).toBe(name.parentElement);
      expect(link.className).toContain("basis-0");
    }
  });
});
