import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Assistant, Session, Workspace } from "@hercule/contract";
import { formatAge } from "@hercule/client-core";
import { buildThreadsWorld } from "@hercule/client-core/threads/testing";
import {
  buildErrorBody,
  expectInDocumentOrder,
  readCurrentNavItems,
  renderApp,
  stubApi,
  type Handler,
} from "../app/testing";

const ZONE = "Europe/Amsterdam";

const buildSettingsRoutes = (user: Record<string, unknown>) => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], ...user },
    },
  },
  // The Threads face reads the session list and the assistant list on every
  // path it mounts on; a test that cares about actual sessions or assistants
  // overrides these with its own list.
  "GET /api/v1/sessions": { body: { items: [] } },
  "GET /api/v1/assistants": { body: { items: [] } },
});

const buildShellRoutes = (user: Record<string, unknown> = {}): Readonly<Record<string, Handler>> =>
  buildSettingsRoutes({ timezone: ZONE, ...user });

const BASE_SESSION: Session = {
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  agentId: null,
  conversationId: null,
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: "01a06d02-beff-7037-9f5b-042822015952",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-04T09:00:00.000Z",
  startedAt: "2026-09-04T09:00:00.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-04T09:05:00.000Z",
  unenforced: [],
};

const buildSession = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE_SESSION,
  ...overrides,
});

/** Three sessions, deliberately out of `lastActivityAt` order in the fixture. */
const THREE_SESSIONS: readonly Session[] = [
  buildSession({
    id: "01a06d02-2000-7000-8000-000000000001",
    title: "Fix the login bug",
    status: "busy",
    modelSelection: { model: "claude-sonnet-5", options: {} },
    lastActivityAt: "2026-09-05T09:05:00.000Z",
  }),
  buildSession({
    id: "01a06d02-2000-7000-8000-000000000002",
    title: "Write the changelog",
    status: "idle",
    modelSelection: { model: "claude-opus-5", options: {} },
    lastActivityAt: "2026-09-06T10:00:00.000Z",
  }),
  buildSession({
    id: "01a06d02-2000-7000-8000-000000000003",
    title: "Investigate the flaky test",
    status: "exited",
    modelSelection: { model: "claude-haiku-5", options: {} },
    lastActivityAt: "2026-09-04T08:00:00.000Z",
    exitedAt: "2026-09-04T08:10:00.000Z",
  }),
];

/** The same handlers as `buildShellRoutes`, with a real session list. */
const withThreads = (
  sessions: readonly Session[],
  user: Record<string, unknown> = {},
): Readonly<Record<string, Handler>> => ({
  ...buildShellRoutes(user),
  "GET /api/v1/sessions": { body: { items: sessions } },
});

const getOrchestrationNav = () => within(screen.getByRole("navigation", { name: "Hercule" }));

const getThreadsNav = () => within(screen.getByRole("navigation", { name: "Threads" }));

const readNavLabels = (): string[] =>
  getOrchestrationNav()
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the two-face sidebar", () => {
  it("shows the Hercule face on an orchestration screen, with its items in a fixed order", async () => {
    await renderApp({ path: "/tasks", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    expect(readNavLabels()).toEqual([
      "Intake",
      "Check-in",
      "Tasks",
      "Runs",
      "Workflows",
      "Fleet",
      "Connections",
      "Notifications",
      "Settings",
    ]);
  });

  it("highlights a screen's item on a page under that screen's path", async () => {
    await renderApp({
      path: "/workflows/new",
      api: stubApi({
        ...buildShellRoutes(),
        "GET /api/v1/workflow-actions": { body: [] },
        "GET /api/v1/event-kinds": { body: [] },
        "GET /api/v1/agents": { body: { items: [] } },
      }).fetch,
      token: "held",
    });

    expect(readCurrentNavItems()).toEqual(["Workflows"]);
  });

  it("shows a glyph on the entity items only", async () => {
    await renderApp({ path: "/tasks", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    const withGlyph = getOrchestrationNav()
      .getAllByRole("link")
      .filter((link) => link.querySelector("[data-mark]") !== null)
      .map((link) => link.textContent);

    expect(withGlyph).toEqual(["Tasks", "Runs", "Workflows"]);
  });

  it("shows the Threads face on Sessions", async () => {
    await renderApp({ path: "/", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    // Create new thread is a button that opens the project picker, not a link
    // to `/threads/new` (#72).
    expect(
      await getThreadsNav().findByRole("button", { name: /create new thread/i }),
    ).toBeDefined();
    expect(await getThreadsNav().findByText("No threads yet")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Hercule" })).toBeNull();
  });

  it("switches face when the segmented switch is used", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hercule/ }));

    expect(readNavLabels()[0]).toBe("Intake");
  });

  it("lets the screen choose the face again after the next navigation", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({
      path: "/",
      api: stubApi(buildShellRoutes()).fetch,
      token: "held",
    });

    await user.click(screen.getByRole("radio", { name: /Hercule/ }));
    await user.click(getOrchestrationNav().getByRole("link", { name: "Intake" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/intake");
    });
    expect(readNavLabels()[0]).toBe("Intake");

    await user.click(screen.getByRole("radio", { name: "Threads" }));
    expect(await getThreadsNav().findByText("No threads yet")).toBeDefined();
  });

  it("reads the thread-row density from the settings store", async () => {
    await renderApp({
      path: "/",
      api: stubApi(buildShellRoutes({ "ui.threadRows": "plain" })).fetch,
      token: "held",
    });

    const empty = await getThreadsNav().findByText("No threads yet");
    expect(empty.parentElement?.dataset.threadRows).toBe("plain");
  });

  it("defaults the thread-row density to meta", async () => {
    await renderApp({ path: "/", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    const empty = await getThreadsNav().findByText("No threads yet");
    expect(empty.parentElement?.dataset.threadRows).toBe("meta");
  });

  it("opens the marks legend on ?", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/tasks", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    expect(screen.queryByLabelText("Marks legend")).toBeNull();
    await user.keyboard("?");

    expect(await screen.findByLabelText("Marks legend")).toBeDefined();
  });
});

describe("the theme selector", () => {
  /** The theme attribute on the document outlives a render, so remove it after each test. */
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("sits below Marks at the sidebar foot, and applies and saves the chosen theme", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/tasks", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    // Before any choice, the system theme applies: the document has no theme attribute.
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const marks = screen.getByRole("button", { name: /Marks/ });
    const theme = screen.getByRole("button", { name: "Theme System" });
    expectInDocumentOrder([marks, theme]);

    await user.click(theme);
    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("hercule:theme")).toBe("dark");
  });
});

describe("the Threads face's session rows", () => {
  /** Every row link the face renders for a session, in DOM order. */
  const listRowLinks = (): HTMLElement[] =>
    getThreadsNav()
      .getAllByRole("link")
      .filter((link) => {
        const href = link.getAttribute("href") ?? "";
        return href.startsWith("/threads/") && href !== "/threads/new";
      });

  it("lists the sessions as rows linking to their thread, under Create new thread", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    for (const s of THREE_SESSIONS) {
      const row = await getThreadsNav().findByRole("link", { name: new RegExp(s.title) });
      expect(row.getAttribute("href")).toBe(`/threads/${s.id}`);
    }
    // Create new thread still comes before the rows.
    const create = getThreadsNav().getByRole("button", { name: /create new thread/i });
    expectInDocumentOrder([create, listRowLinks()[0]!]);
  });

  it("shows the age from formatAge, and the model slug in meta mode", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    const first = THREE_SESSIONS[0]!;
    const row = await getThreadsNav().findByRole("link", { name: new RegExp(first.title) });
    // Compute the expected age right at the assertion. `formatAge` counts in
    // whole minutes at the finest, so this value matches the rendered row unless
    // a minute boundary falls between the render and this line.
    expect(row.textContent).toContain(formatAge(first.lastActivityAt, new Date()));
    expect(row.textContent).toContain(first.modelSelection.model);
  });

  it("selects the row of the thread currently open, and no other", async () => {
    const current = THREE_SESSIONS[1]!;
    await renderApp({
      path: `/threads/${current.id}`,
      api: stubApi(withThreads(THREE_SESSIONS)).fetch,
      token: "held",
    });

    const currentRow = await getThreadsNav().findByRole("link", {
      name: new RegExp(current.title),
    });
    expect(currentRow.getAttribute("aria-current")).toBe("page");

    for (const s of THREE_SESSIONS) {
      if (s.id === current.id) continue;
      const row = getThreadsNav().getByRole("link", { name: new RegExp(s.title) });
      expect(row.getAttribute("aria-current")).not.toBe("page");
    }
  });

  it("shows the model slug in meta mode and hides it in plain mode", async () => {
    const target = THREE_SESSIONS[0]!;

    const metaRender = await renderApp({
      path: "/",
      api: stubApi(withThreads(THREE_SESSIONS, { "ui.threadRows": "meta" })).fetch,
      token: "held",
    });
    const metaRow = await getThreadsNav().findByRole("link", { name: new RegExp(target.title) });
    expect(metaRow.textContent).toContain(target.modelSelection.model);
    metaRender.unmount();

    await renderApp({
      path: "/",
      api: stubApi(withThreads(THREE_SESSIONS, { "ui.threadRows": "plain" })).fetch,
      token: "held",
    });
    const plainRow = await getThreadsNav().findByRole("link", { name: new RegExp(target.title) });
    expect(plainRow.textContent).not.toContain(target.modelSelection.model);
  });

  it("shows an All sessions link to /sessions after the rows", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });
    await getThreadsNav().findByRole("link", { name: new RegExp(THREE_SESSIONS[0]!.title) });

    const allSessions = getThreadsNav().getByRole("link", { name: /All sessions/i });
    expect(allSessions.getAttribute("href")).toBe("/sessions");
  });

  it("refetches the list when a session invalidation arrives", async () => {
    const api = stubApi(withThreads(THREE_SESSIONS));
    const { live } = await renderApp({ path: "/", api: api.fetch, token: "held" });
    await getThreadsNav().findByRole("link", { name: new RegExp(THREE_SESSIONS[0]!.title) });

    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    const before = api.calls.filter((call) => call.path === "/api/v1/sessions").length;

    act(() => {
      live.push("session", { _tag: "invalidate", ids: [], kind: "updated" });
    });

    await waitFor(() => {
      const after = api.calls.filter((call) => call.path === "/api/v1/sessions").length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("offers Create new thread as an enabled button, not a disabled placeholder", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    // Create new thread opens the project picker instead of navigating, so it
    // is a button, not a link (#72).
    const create = await getThreadsNav().findByRole<HTMLButtonElement>("button", {
      name: /create new thread/i,
    });
    expect(create.disabled).toBe(false);
    expect(getThreadsNav().queryByRole("link", { name: /create new thread/i })).toBeNull();
  });

  it.each(["/", "/threads/s1", "/sessions", "/assistants/a1"])(
    "shows the Threads face, not Hercule, on %s",
    async (path) => {
      await renderApp({ path, api: stubApi(buildShellRoutes()).fetch, token: "held" });

      expect(screen.getByRole("navigation", { name: "Threads" })).toBeDefined();
      expect(screen.queryByRole("navigation", { name: "Hercule" })).toBeNull();
    },
  );
});

describe("the pulse at the sidebar foot", () => {
  const getPulseButton = () => screen.getByRole("button", { name: /Nothing to report yet/ });

  it("starts collapsed", async () => {
    await renderApp({ path: "/tasks", api: stubApi(buildShellRoutes()).fetch, token: "held" });

    expect(getPulseButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click and remembers that for the browser session", async () => {
    const user = userEvent.setup();
    const first = await renderApp({
      path: "/tasks",
      api: stubApi(buildShellRoutes()).fetch,
      token: "held",
    });

    await user.click(getPulseButton());
    expect(getPulseButton().getAttribute("aria-expanded")).toBe("true");

    // Unmount the first render to stand in for a page reload, so only one
    // pulse is on screen.
    first.unmount();
    await renderApp({ path: "/runs", api: stubApi(buildShellRoutes()).fetch, token: "held" });
    expect(getPulseButton().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the top bar", () => {
  it("shows the screen title and the time in the user's zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      await renderApp({ path: "/runs", api: stubApi(buildShellRoutes()).fetch, token: "held" });

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runs");
      expect(screen.getByText("Monday 09:14")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the title of a screen with its own header when that screen fails to load", async () => {
    // A workflow's page draws its own header. When the workflow cannot be
    // read, the page shows the error instead of that header, so the shell's
    // top bar must show the title.
    const workflowId = "0199c0ff-1111-7000-8000-00000000dead";
    await renderApp({
      path: `/workflows/${workflowId}`,
      api: stubApi({
        ...buildShellRoutes(),
        [`GET /api/v1/workflows/${workflowId}`]: {
          status: 500,
          body: buildErrorBody("internal", "The database is locked."),
        },
        "GET /api/v1/workflow-actions": { body: [] },
        "GET /api/v1/event-kinds": { body: [] },
        "GET /api/v1/agents": { body: { items: [] } },
      }).fetch,
      token: "held",
    });

    expect(screen.getByText("This screen did not load")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workflow");
  });

  it("shows times in UTC, with a warning, when this browser does not know the user's zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      const api = stubApi(buildShellRoutes({ timezone: "Europe/Nowhere" }));
      await renderApp({ path: "/runs", api: api.fetch, token: "held" });

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runs");
      expect(screen.getByText("Monday 07:14")).toBeDefined();
      expect(
        screen.getByRole("link", { name: /does not know the zone Europe\/Nowhere/ }),
      ).toBeDefined();
      expect(screen.getByRole("navigation", { name: "Hercule" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows on Intake the time the user last checked it", async () => {
    const api = stubApi(buildShellRoutes({ "lastChecked.intake": "2026-09-06T20:10:00.000Z" }));
    await renderApp({ path: "/intake", api: api.fetch, token: "held" });

    expect(screen.getByText("since Sunday 22:10")).toBeDefined();
  });

  it("shows the current time on Intake until a last-checked time is stored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      await renderApp({ path: "/intake", api: stubApi(buildShellRoutes()).fetch, token: "held" });

      expect(screen.getByText("Monday 09:14")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still renders Intake, with the current time, when the stored last-checked time is not a date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      const api = stubApi(buildShellRoutes({ "lastChecked.intake": "0000-00-00T00:00:00.000Z" }));
      await renderApp({ path: "/intake", api: api.fetch, token: "held" });

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Intake");
      expect(screen.getByText("Monday 09:14")).toBeDefined();
      expect(screen.queryByText(/^since /)).toBeNull();
      expect(screen.getByRole("navigation", { name: "Hercule" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The Threads face groups threads by project, then by workspace, and
 * "Create new thread" opens the project picker (#72).
 *
 * The spec gives the copy but not how a test finds each element, so
 * these tests assume:
 * - a project's or workspace's group header shows its label as text,
 *   and the `+` beside it is a link whose accessible name says what it
 *   opens;
 * - a workspace that is not a main workspace is labelled with its first
 *   checkout's branch (`hercule/run-3f1`), because a `Workspace` record
 *   has no name of its own.
 * ------------------------------------------------------------------ */

/** The webshop/ops fixture world that every workspace test suite shares, with
 * ids in the format the contract accepts. Only the threads in each workspace
 * are specific to this suite. */
const IDS = {
  moss: "01a06d02-beff-7037-9f5b-042822015952",
  webshopProject: "01a06d02-7000-7000-8000-000000000001",
  opsProject: "01a06d02-7000-7000-8000-000000000002",
  webshop: "01a06d02-7100-7000-8000-000000000001",
  infra: "01a06d02-7100-7000-8000-000000000002",
  primary: "01a06d02-7200-7000-8000-000000000001",
  primaryCheckout: "01a06d02-7300-7000-8000-000000000001",
  run3f1: "01a06d02-7200-7000-8000-000000000002",
  run3f1Checkout: "01a06d02-7300-7000-8000-000000000002",
  flakyThread: "01a06d02-7400-7000-8000-000000000001",
  runbookThread: "01a06d02-7400-7000-8000-000000000002",
};

const WORLD = buildThreadsWorld(IDS);
const MOSS = WORLD.MOSS;
const WEBSHOP = WORLD.WEBSHOP_PROJECT;
const OPS = WORLD.OPS_PROJECT;
const R_WEBSHOP = WORLD.WEBSHOP;
const R_INFRA = WORLD.INFRA;
const BUMP_THE_BUN_PIN = "01a06d02-7400-7000-8000-000000000003";
const W_PRIMARY: Workspace = { ...WORLD.PRIMARY, sessionIds: [BUMP_THE_BUN_PIN] };
const W_RUN_3F1 = WORLD.RUN_3F1;

const grouped: readonly Session[] = [
  buildSession({
    id: IDS.flakyThread,
    title: "Fix flaky webhook tests",
    projectId: WEBSHOP.id,
    workspaceId: W_RUN_3F1.id,
    lastActivityAt: "2026-09-10T09:05:00.000Z",
  }),
  buildSession({
    id: IDS.runbookThread,
    title: "Write the retry runbook",
    projectId: WEBSHOP.id,
    workspaceId: W_RUN_3F1.id,
    lastActivityAt: "2026-09-10T09:04:00.000Z",
  }),
  buildSession({
    id: BUMP_THE_BUN_PIN,
    title: "Bump the Bun pin",
    projectId: WEBSHOP.id,
    workspaceId: W_PRIMARY.id,
    lastActivityAt: "2026-09-10T09:03:00.000Z",
  }),
  buildSession({
    id: "01a06d02-7400-7000-8000-000000000004",
    title: "Tidy the promotion runbook",
    projectId: WEBSHOP.id,
    workspaceId: null,
    lastActivityAt: "2026-09-10T09:02:00.000Z",
  }),
  buildSession({
    id: "01a06d02-7400-7000-8000-000000000005",
    title: "Rotate the Hetzner backups key",
    projectId: OPS.id,
    workspaceId: null,
    lastActivityAt: "2026-09-10T09:01:00.000Z",
  }),
  buildSession({
    id: "01a06d02-7400-7000-8000-000000000006",
    title: "Nothing to do with a project",
    projectId: null,
    workspaceId: null,
    lastActivityAt: "2026-09-10T09:00:00.000Z",
  }),
];

const withProjects = (user: Record<string, unknown> = {}): Readonly<Record<string, Handler>> => ({
  ...buildShellRoutes(user),
  "GET /api/v1/sessions": { body: { items: grouped } },
  "GET /api/v1/projects": { body: { items: [WEBSHOP, OPS] } },
  "GET /api/v1/resources": { body: { items: [R_WEBSHOP, R_INFRA] } },
  "GET /api/v1/workspaces": { body: { items: [W_PRIMARY, W_RUN_3F1] } },
  // What the draft route below loads; nothing here is what it asserts on.
  "GET /api/v1/runners": { body: { items: [MOSS] } },
  "GET /api/v1/providers": { body: [] },
  "GET /api/v1/profiles": { body: { items: [] } },
});

/** The Threads face's own text, whitespace collapsed, in DOM order. */
const readFaceText = (): string =>
  (screen.getByRole("navigation", { name: "Threads" }).textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

describe("the Threads face groups threads by project and workspace", () => {
  it("gives each project a header with its name, its thread count and a + that starts a draft in it", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    // Wait for the project's + link: its name appears once, while the bare
    // word "webshop" also appears in the main workspace's label.
    await getThreadsNav().findByRole("link", { name: "New thread in webshop" });
    expect(readFaceText()).toContain("webshop 4");
    expect(readFaceText()).toContain("ops 1");

    const plus = getThreadsNav().getByRole("link", { name: "New thread in webshop" });
    expect(plus.getAttribute("href")).toBe(`/threads/new?project=${WEBSHOP.id}`);
  });

  it("groups a project's threads by workspace, and labels a main workspace with its repo and machine", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    await getThreadsNav().findByText("hercule/run-3f1");
    // The tooltip shows the whole label. The label is split in two so that a
    // narrow sidebar truncates the repo, not the machine: the machine is what
    // tells two main workspaces of one repo apart. The label does not use the
    // word "checkout".
    const label = getThreadsNav().getByTitle("webshop · moss");
    expect(label.textContent).toBe("webshop · moss");
    expect(label.firstElementChild?.textContent).toBe("webshop");
    expect(label.lastElementChild?.textContent).toBe(" · moss");
  });

  it("puts the workspace-less threads of a project last, under 'no workspace'", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    await getThreadsNav().findByText("no workspace");
    const text = readFaceText();
    expect(text.indexOf("hercule/run-3f1")).toBeLessThan(text.indexOf("no workspace"));
    expect(text.indexOf("webshop · moss")).toBeLessThan(text.indexOf("no workspace"));
    expect(text.indexOf("no workspace")).toBeLessThan(text.indexOf("Tidy the promotion runbook"));
  });

  it("offers a + on a workspace group that opens a draft in that workspace", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    const plus = await getThreadsNav().findByRole("link", {
      name: "New thread in hercule/run-3f1",
    });
    expect(plus.getAttribute("href")).toBe(
      `/threads/new?project=${WEBSHOP.id}&workspace=${W_RUN_3F1.id}`,
    );
  });

  it("puts threads with no project last, without a header", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    await getThreadsNav().findByRole("link", { name: "New thread in webshop" });
    const text = readFaceText();
    expect(text.indexOf("ops")).toBeLessThan(text.indexOf("Nothing to do with a project"));
    expect(text.indexOf("Rotate the Hetzner backups key")).toBeLessThan(
      text.indexOf("Nothing to do with a project"),
    );
  });

  it("shows the draft being written under the group it will join", async () => {
    await renderApp({
      path: `/threads/new?project=${WEBSHOP.id}&workspace=${W_RUN_3F1.id}`,
      api: stubApi(withProjects()).fetch,
      token: "held",
    });

    await getThreadsNav().findByText("hercule/run-3f1");
    const text = readFaceText();
    expect(text).toContain("New thread draft");
    expect(text.indexOf("hercule/run-3f1")).toBeLessThan(text.indexOf("New thread draft"));
    // The draft is the group's last row, just as it is the last thread tab.
    expect(text.indexOf("Fix flaky webhook tests")).toBeLessThan(text.indexOf("New thread draft"));
    expect(text.indexOf("New thread draft")).toBeLessThan(text.indexOf("webshop · moss"));
  });

  it("does not repeat the workspace on a row's second line", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    const row = await getThreadsNav().findByRole("link", { name: /Fix flaky webhook tests/ });
    expect(row.textContent).not.toContain("hercule/run-3f1");
  });
});

describe("Create new thread opens the project picker", () => {
  it("opens the picker rather than navigating straight to a draft", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({
      path: "/",
      api: stubApi(withProjects()).fetch,
      token: "held",
    });

    await user.click(getThreadsNav().getByText("Create new thread"));

    const picker = await screen.findByRole("dialog");
    expect((picker.textContent ?? "").replace(/\s+/g, " ")).toContain("New thread in");
    expect(router.state.location.pathname).toBe("/");
  });
});

/* ------------------------------------------------------------------
 * The Threads face's Assistants group. It follows the thread groups
 * and holds one row per assistant, oldest first, each linking to the
 * assistant's conversation.
 *
 * The spec gives the dot's tones but not how to find them. These tests
 * assume that the live dot is painted with the live colour (a `bg-live`
 * class), the way the fleet's connectivity dot is, and that an idle dot
 * is not.
 * ------------------------------------------------------------------ */

const BASE_ASSISTANT: Assistant = {
  id: "01a06d02-a000-7000-8000-000000000001",
  name: "Ada",
  systemPrompt: "You are a helpful assistant.",
  instanceId: BASE_SESSION.instanceId,
  permissionProfileId: BASE_SESSION.permissionProfileId,
  accessMode: "full-access",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  createdAt: "2026-09-04T08:00:00.000Z",
  updatedAt: "2026-09-04T08:00:00.000Z",
};

const ADA = BASE_ASSISTANT;

const BOB: Assistant = {
  ...BASE_ASSISTANT,
  id: "01a06d02-a000-7000-8000-000000000002",
  name: "Bob",
  createdAt: "2026-09-04T09:00:00.000Z",
  updatedAt: "2026-09-04T09:00:00.000Z",
};

/** Ada's session, answering her web conversation. It is working, so Ada is live. */
const ADA_SESSION = buildSession({
  id: "01a06d02-2000-7000-8000-00000000000a",
  title: "Answer Ada's conversation",
  status: "busy",
  agentId: ADA.id,
  conversationId: "01a06d02-c000-7000-8000-000000000001",
  lastActivityAt: "2026-09-06T11:00:00.000Z",
});

/** Bob's only session, which has exited, so Bob is idle. */
const BOB_SESSION = buildSession({
  id: "01a06d02-2000-7000-8000-00000000000b",
  title: "Answer Bob's conversation",
  status: "exited",
  agentId: BOB.id,
  conversationId: "01a06d02-c000-7000-8000-000000000002",
  lastActivityAt: "2026-09-05T11:00:00.000Z",
  exitedAt: "2026-09-05T11:10:00.000Z",
});

const THREAD = THREE_SESSIONS[0]!;

/** The shell's routes with `assistants`, and `sessions` as the session list. */
const withAssistants = (
  assistants: readonly Assistant[],
  sessions: readonly Session[] = [THREAD, ADA_SESSION, BOB_SESSION],
): Readonly<Record<string, Handler>> => ({
  ...withThreads(sessions),
  // The server lists assistants oldest first.
  "GET /api/v1/assistants": { body: { items: assistants } },
});

/** Returns the face's assistant rows, the links to a conversation, in DOM order. */
const listAssistantRows = (): HTMLElement[] =>
  getThreadsNav()
    .getAllByRole("link")
    .filter((link) => (link.getAttribute("href") ?? "").startsWith("/assistants/"));

/** Returns the assistant row that links to `assistant`'s conversation, and fails when there is none. */
const getAssistantRow = (assistant: Assistant): HTMLElement => {
  const row = listAssistantRows().find(
    (link) => link.getAttribute("href") === `/assistants/${assistant.id}`,
  );
  if (row === undefined) throw new Error(`no row links to ${assistant.name}'s conversation`);
  return row;
};

/** Checks whether the row's dot is painted with the live colour. */
const hasLiveDot = (row: HTMLElement): boolean => row.querySelector('[class*="bg-live"]') !== null;

/**
 * Returns the class names of the row's presence dot, the element that
 * carries `data-presence`, and fails when the row has none.
 */
const readDotClasses = (row: HTMLElement): string => {
  const dot = row.querySelector("[data-presence]");
  if (dot === null) throw new Error("the row has no presence dot");
  return dot.className;
};

/** Matches a class that animates an element, such as `animate-pulse`. */
const MOTION = /\b(animate-\S+|hercule-\S*(pulse|live-dot)\S*)\b/;

describe("the Threads face's Assistants group", () => {
  it("follows the thread groups under the title Assistants", async () => {
    await renderApp({ path: "/", api: stubApi(withAssistants([ADA, BOB])).fetch, token: "held" });

    const title = await getThreadsNav().findByText("Assistants");
    const thread = getThreadsNav().getByRole("link", { name: new RegExp(THREAD.title) });
    expectInDocumentOrder([thread, title, listAssistantRows()[0]!]);
  });

  it("shows one row per assistant, oldest first, with its name and web", async () => {
    await renderApp({ path: "/", api: stubApi(withAssistants([ADA, BOB])).fetch, token: "held" });

    await getThreadsNav().findByText("Assistants");
    const rows = listAssistantRows();
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      `/assistants/${ADA.id}`,
      `/assistants/${BOB.id}`,
    ]);
    expect(rows[0]!.textContent).toContain("Ada");
    expect(rows[0]!.textContent).toContain("web");
    expect(rows[1]!.textContent).toContain("Bob");
    expect(rows[1]!.textContent).toContain("web");
  });

  // Review round 1 of #92 slice 3 (D-78): the idle dot is faint, and
  // neither dot moves, because a loaded session is a state, not work
  // happening. The title used to say "muted" and checked only the live dot.
  it("paints a live assistant's dot in the live colour and an idle assistant's dot faint, both still", async () => {
    await renderApp({ path: "/", api: stubApi(withAssistants([ADA, BOB])).fetch, token: "held" });

    await getThreadsNav().findByText("Assistants");
    const live = readDotClasses(getAssistantRow(ADA));
    const idle = readDotClasses(getAssistantRow(BOB));
    expect(live).toMatch(/\bbg-live\b/);
    expect(idle).toMatch(/\bbg-faint\b/);
    expect(idle).not.toMatch(/\bbg-live\b/);
    expect(live).not.toMatch(MOTION);
    expect(idle).not.toMatch(MOTION);
  });

  it("opens the assistant's conversation when its row is clicked", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({
      path: "/",
      api: stubApi(withAssistants([ADA, BOB])).fetch,
      token: "held",
    });

    await getThreadsNav().findByText("Assistants");
    await user.click(getAssistantRow(BOB));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/assistants/${BOB.id}`);
    });
  });

  it("turns the dot idle, without a reload, when a session nudge reports the assistant's session exited", async () => {
    let sessions: readonly Session[] = [THREAD, ADA_SESSION, BOB_SESSION];
    const api = stubApi({
      ...withAssistants([ADA, BOB]),
      "GET /api/v1/sessions": () => ({ body: { items: sessions } }),
    });
    const { live } = await renderApp({ path: "/", api: api.fetch, token: "held" });

    await getThreadsNav().findByText("Assistants");
    expect(hasLiveDot(getAssistantRow(ADA))).toBe(true);

    sessions = [
      THREAD,
      {
        ...ADA_SESSION,
        status: "exited",
        resumable: true,
        nativeSessionId: "native-ada",
        exitedAt: "2026-09-06T11:15:00.000Z",
      },
      BOB_SESSION,
    ];
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [ADA_SESSION.id], kind: "updated" });
    });

    await waitFor(() => {
      expect(hasLiveDot(getAssistantRow(ADA))).toBe(false);
    });
  });

  it("keeps an assistant's session out of the thread groups", async () => {
    await renderApp({ path: "/", api: stubApi(withAssistants([ADA, BOB])).fetch, token: "held" });

    await getThreadsNav().findByRole("link", { name: new RegExp(THREAD.title) });
    await getThreadsNav().findByText("Assistants");
    const threadLinks = getThreadsNav()
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(threadLinks).not.toContain(`/threads/${ADA_SESSION.id}`);
    expect(threadLinks).not.toContain(`/threads/${BOB_SESSION.id}`);
    expect(readFaceText()).not.toContain(ADA_SESSION.title);
    expect(readFaceText()).not.toContain(BOB_SESSION.title);
  });

  it("renders no Assistants group when there is no assistant", async () => {
    const api = stubApi(withAssistants([], [THREAD]));
    await renderApp({ path: "/", api: api.fetch, token: "held" });

    await getThreadsNav().findByRole("link", { name: new RegExp(THREAD.title) });
    await waitFor(() => {
      expect(api.calls.some((call) => call.path === "/api/v1/assistants")).toBe(true);
    });
    expect(getThreadsNav().queryByText("Assistants")).toBeNull();
    expect(listAssistantRows()).toEqual([]);
  });
});
