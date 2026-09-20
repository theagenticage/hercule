import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, Workspace } from "@hercule/contract";
import { ageOf } from "@hercule/client-core";
import { threadsWorld } from "@hercule/client-core/threads/testing";
import { renderApp, stubApi, type Handler } from "../app/testing";

const ZONE = "Europe/Amsterdam";

const settings = (user: Record<string, unknown>) => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: { controller: {}, user: { "onboarding.completedSteps": ["timezone"], ...user } },
  },
  // The Threads face reads the session list on every path it mounts on; a
  // test that cares about actual sessions overrides this with its own list.
  "GET /api/v1/sessions": { body: { items: [] } },
});

const inShell = (user: Record<string, unknown> = {}): Readonly<Record<string, Handler>> =>
  settings({ timezone: ZONE, ...user });

const BASE_SESSION: Session = {
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  agentId: null,
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

const session = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE_SESSION,
  ...overrides,
});

/** Three sessions, deliberately out of `lastActivityAt` order in the fixture. */
const THREE_SESSIONS: readonly Session[] = [
  session({
    id: "01a06d02-2000-7000-8000-000000000001",
    title: "Fix the login bug",
    status: "busy",
    modelSelection: { model: "claude-sonnet-5", options: {} },
    lastActivityAt: "2026-09-05T09:05:00.000Z",
  }),
  session({
    id: "01a06d02-2000-7000-8000-000000000002",
    title: "Write the changelog",
    status: "idle",
    modelSelection: { model: "claude-opus-5", options: {} },
    lastActivityAt: "2026-09-06T10:00:00.000Z",
  }),
  session({
    id: "01a06d02-2000-7000-8000-000000000003",
    title: "Investigate the flaky test",
    status: "exited",
    modelSelection: { model: "claude-haiku-5", options: {} },
    lastActivityAt: "2026-09-04T08:00:00.000Z",
    exitedAt: "2026-09-04T08:10:00.000Z",
  }),
];

/** The same handlers as `inShell`, with a real session list. */
const withThreads = (
  sessions: readonly Session[],
  user: Record<string, unknown> = {},
): Readonly<Record<string, Handler>> => ({
  ...inShell(user),
  "GET /api/v1/sessions": { body: { items: sessions } },
});

const herculeNav = () => within(screen.getByRole("navigation", { name: "Hercule" }));

const threadsNav = () => within(screen.getByRole("navigation", { name: "Threads" }));

const navLabels = (): string[] =>
  herculeNav()
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the two-face sidebar", () => {
  it("shows the Hercule face on an orchestration screen, in its pinned order", async () => {
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    expect(navLabels()).toEqual([
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

  it("carries a glyph on the entity items and on no other", async () => {
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    const withGlyph = herculeNav()
      .getAllByRole("link")
      .filter((link) => link.querySelector("[data-mark]") !== null)
      .map((link) => link.textContent);

    expect(withGlyph).toEqual(["Tasks", "Runs", "Workflows"]);
  });

  it("shows the Threads face on Sessions", async () => {
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    // Create new thread opens the project picker (#72 AC-16, which supersedes
    // #160's plain link to `/threads/new`; recorded as D-14).
    expect(await threadsNav().findByRole("button", { name: /create new thread/i })).toBeDefined();
    expect(await threadsNav().findByText("No threads yet")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Hercule" })).toBeNull();
  });

  it("switches face when the segmented switch is used", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hercule/ }));

    expect(navLabels()[0]).toBe("Intake");
  });

  it("puts the screen back in charge of the face on the next navigation", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hercule/ }));
    await user.click(herculeNav().getByRole("link", { name: "Intake" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/intake");
    });
    expect(navLabels()[0]).toBe("Intake");

    await user.click(screen.getByRole("radio", { name: "Threads" }));
    expect(await threadsNav().findByText("No threads yet")).toBeDefined();
  });

  it("reads the thread-row density from the settings store", async () => {
    await renderApp({
      path: "/",
      api: stubApi(inShell({ "ui.threadRows": "plain" })).fetch,
      token: "held",
    });

    const empty = await threadsNav().findByText("No threads yet");
    expect(empty.parentElement?.dataset.threadRows).toBe("plain");
  });

  it("defaults the thread-row density to meta", async () => {
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    const empty = await threadsNav().findByText("No threads yet");
    expect(empty.parentElement?.dataset.threadRows).toBe("meta");
  });

  it("opens the marks legend on ?", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    expect(screen.queryByLabelText("Marks legend")).toBeNull();
    await user.keyboard("?");

    expect(await screen.findByLabelText("Marks legend")).toBeDefined();
  });
});

describe("the theme selector", () => {
  /** The document attribute is the one thing one render may leave on the next. */
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("sits below Marks at the sidebar foot, and a pick paints and persists", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    // At rest the machine is in charge: no explicit theme on the document.
    expect(document.documentElement.dataset.theme).toBeUndefined();
    const marks = screen.getByRole("button", { name: /Marks/ });
    const theme = screen.getByRole("button", { name: "Theme System" });
    expect(marks.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(theme);
    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("hercule:theme")).toBe("dark");
  });
});

describe("the Threads face's session rows", () => {
  /** Every row link the face renders for a session, in DOM order. */
  const rowLinks = (): HTMLElement[] =>
    threadsNav()
      .getAllByRole("link")
      .filter((link) => {
        const href = link.getAttribute("href") ?? "";
        return href.startsWith("/threads/") && href !== "/threads/new";
      });

  it("lists the sessions as rows linking to their thread, under Create new thread", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    for (const s of THREE_SESSIONS) {
      const row = await threadsNav().findByRole("link", { name: new RegExp(s.title) });
      expect(row.getAttribute("href")).toBe(`/threads/${s.id}`);
    }
    // Create new thread still comes before the rows.
    const create = threadsNav().getByRole("button", { name: /create new thread/i });
    const first = rowLinks()[0]!;
    expect(create.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the age read with ageOf, and the model slug in meta mode", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    const first = THREE_SESSIONS[0]!;
    const row = await threadsNav().findByRole("link", { name: new RegExp(first.title) });
    // Read right beside the assertion, the same instant the row itself reads
    // from: `ageOf`'s coarsest unit is a minute, so the two reads agree unless
    // this line and the render it followed straddle a minute boundary.
    expect(row.textContent).toContain(ageOf(first.lastActivityAt, new Date()));
    expect(row.textContent).toContain(first.modelSelection.model);
  });

  it("selects the row of the thread currently open, and no other", async () => {
    const current = THREE_SESSIONS[1]!;
    await renderApp({
      path: `/threads/${current.id}`,
      api: stubApi(withThreads(THREE_SESSIONS)).fetch,
      token: "held",
    });

    const currentRow = await threadsNav().findByRole("link", { name: new RegExp(current.title) });
    expect(currentRow.getAttribute("aria-current")).toBe("page");

    for (const s of THREE_SESSIONS) {
      if (s.id === current.id) continue;
      const row = threadsNav().getByRole("link", { name: new RegExp(s.title) });
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
    const metaRow = await threadsNav().findByRole("link", { name: new RegExp(target.title) });
    expect(metaRow.textContent).toContain(target.modelSelection.model);
    metaRender.unmount();

    await renderApp({
      path: "/",
      api: stubApi(withThreads(THREE_SESSIONS, { "ui.threadRows": "plain" })).fetch,
      token: "held",
    });
    const plainRow = await threadsNav().findByRole("link", { name: new RegExp(target.title) });
    expect(plainRow.textContent).not.toContain(target.modelSelection.model);
  });

  it("carries an All sessions link to /sessions, after the rows", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });
    await threadsNav().findByRole("link", { name: new RegExp(THREE_SESSIONS[0]!.title) });

    const allSessions = threadsNav().getByRole("link", { name: /All sessions/i });
    expect(allSessions.getAttribute("href")).toBe("/sessions");
  });

  it("refetches the list on a session invalidation nudge", async () => {
    const api = stubApi(withThreads(THREE_SESSIONS));
    const { live } = await renderApp({ path: "/", api: api.fetch, token: "held" });
    await threadsNav().findByRole("link", { name: new RegExp(THREE_SESSIONS[0]!.title) });

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

  it("offers Create new thread as a live control, not a disabled placeholder", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    // Amended by #72 AC-16 (D-14): it opens the project picker rather than
    // navigating, so it is a button and no longer carries an href.
    const create = await threadsNav().findByRole<HTMLButtonElement>("button", {
      name: /create new thread/i,
    });
    expect(create.disabled).toBe(false);
    expect(threadsNav().queryByRole("link", { name: /create new thread/i })).toBeNull();
  });

  it.each(["/", "/threads/s1", "/sessions"])(
    "shows the Threads face, not Hercule, on %s",
    async (path) => {
      await renderApp({ path, api: stubApi(inShell()).fetch, token: "held" });

      expect(screen.getByRole("navigation", { name: "Threads" })).toBeDefined();
      expect(screen.queryByRole("navigation", { name: "Hercule" })).toBeNull();
    },
  );
});

describe("the pulse at the sidebar foot", () => {
  const pulseButton = () => screen.getByRole("button", { name: /Nothing to report yet/ });

  it("is collapsed on arrival", async () => {
    await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    expect(pulseButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click and remembers that for the browser session", async () => {
    const user = userEvent.setup();
    const first = await renderApp({ path: "/tasks", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(pulseButton());
    expect(pulseButton().getAttribute("aria-expanded")).toBe("true");

    // The second load is a second page load, so the first one is gone by then
    // and the pulse is the only one on screen.
    first.unmount();
    await renderApp({ path: "/runs", api: stubApi(inShell()).fetch, token: "held" });
    expect(pulseButton().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the top bar", () => {
  it("names the screen and reads the clock in the user's zone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      await renderApp({ path: "/runs", api: stubApi(inShell()).fetch, token: "held" });

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runs");
      expect(screen.getByText("Monday 09:14")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a zone this browser does not know in UTC, and says so", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      const api = stubApi(inShell({ timezone: "Europe/Nowhere" }));
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

  it("frames Intake on when the user last checked", async () => {
    const api = stubApi(inShell({ "lastChecked.intake": "2026-09-06T20:10:00.000Z" }));
    await renderApp({ path: "/intake", api: api.fetch, token: "held" });

    expect(screen.getByText("since Sunday 22:10")).toBeDefined();
  });

  it("reads Intake as the plain clock until that marker exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      await renderApp({ path: "/intake", api: stubApi(inShell()).fetch, token: "held" });

      expect(screen.getByText("Monday 09:14")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Intake standing when the stored marker is not a date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T07:14:00.000Z"));
    try {
      const api = stubApi(inShell({ "lastChecked.intake": "0000-00-00T00:00:00.000Z" }));
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
 * Slice 3 of #72: the Threads face groups by project, then by
 * workspace (AC-20), and "Create new thread" opens the project picker
 * (AC-16).
 *
 * Readings picked here, where the SPEC names copy but not a handle:
 * - a project's group header and a workspace's group header carry their
 *   label as text, and the `+` beside each is a link whose accessible name
 *   names what it opens;
 * - a workspace's own label is its first checkout's branch (`hercule/run-3f1`),
 *   which is the only name a `Workspace` record carries.
 * ------------------------------------------------------------------ */

/** The webshop/ops world every workspace suite shares, with ids the contract
 * takes; only the threads standing in each workspace are this suite's own. */
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

const WORLD = threadsWorld(IDS);
const MOSS = WORLD.MOSS;
const WEBSHOP = WORLD.WEBSHOP_PROJECT;
const OPS = WORLD.OPS_PROJECT;
const R_WEBSHOP = WORLD.WEBSHOP;
const R_INFRA = WORLD.INFRA;
const BUMP_THE_BUN_PIN = "01a06d02-7400-7000-8000-000000000003";
const W_PRIMARY: Workspace = { ...WORLD.PRIMARY, sessionIds: [BUMP_THE_BUN_PIN] };
const W_RUN_3F1 = WORLD.RUN_3F1;

const grouped: readonly Session[] = [
  session({
    id: IDS.flakyThread,
    title: "Fix flaky webhook tests",
    projectId: WEBSHOP.id,
    workspaceId: W_RUN_3F1.id,
    lastActivityAt: "2026-09-10T09:05:00.000Z",
  }),
  session({
    id: IDS.runbookThread,
    title: "Write the retry runbook",
    projectId: WEBSHOP.id,
    workspaceId: W_RUN_3F1.id,
    lastActivityAt: "2026-09-10T09:04:00.000Z",
  }),
  session({
    id: BUMP_THE_BUN_PIN,
    title: "Bump the Bun pin",
    projectId: WEBSHOP.id,
    workspaceId: W_PRIMARY.id,
    lastActivityAt: "2026-09-10T09:03:00.000Z",
  }),
  session({
    id: "01a06d02-7400-7000-8000-000000000004",
    title: "Tidy the promotion runbook",
    projectId: WEBSHOP.id,
    workspaceId: null,
    lastActivityAt: "2026-09-10T09:02:00.000Z",
  }),
  session({
    id: "01a06d02-7400-7000-8000-000000000005",
    title: "Rotate the Hetzner backups key",
    projectId: OPS.id,
    workspaceId: null,
    lastActivityAt: "2026-09-10T09:01:00.000Z",
  }),
  session({
    id: "01a06d02-7400-7000-8000-000000000006",
    title: "Nothing to do with a project",
    projectId: null,
    workspaceId: null,
    lastActivityAt: "2026-09-10T09:00:00.000Z",
  }),
];

const withProjects = (user: Record<string, unknown> = {}): Readonly<Record<string, Handler>> => ({
  ...inShell(user),
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
const faceText = (): string =>
  (screen.getByRole("navigation", { name: "Threads" }).textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

describe("the Threads face groups by project and workspace (AC-20)", () => {
  it("heads each project with its name, its thread count and a + that starts a draft in it", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    // The project's own + names it, and unlike the bare word it stands in one
    // place only: a main workspace's label carries the repo's name too.
    await threadsNav().findByRole("link", { name: "New thread in webshop" });
    expect(faceText()).toContain("webshop 4");
    expect(faceText()).toContain("ops 1");

    const plus = threadsNav().getByRole("link", { name: "New thread in webshop" });
    expect(plus.getAttribute("href")).toBe(`/threads/new?project=${WEBSHOP.id}`);
  });

  it("groups a project's threads per workspace, naming a primary after its repo and machine", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    await threadsNav().findByText("hercule/run-3f1");
    // The whole label is the tooltip, and it is split so that a sidebar too
    // narrow for it cuts the repo rather than the machine that tells one
    // repo's two main workspaces apart. D-20c: the word "checkout" is gone.
    const label = threadsNav().getByTitle("webshop · moss");
    expect(label.textContent).toBe("webshop · moss");
    expect(label.firstElementChild?.textContent).toBe("webshop");
    expect(label.lastElementChild?.textContent).toBe(" · moss");
  });

  it("puts the workspace-less threads of a project last, under 'no workspace'", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    await threadsNav().findByText("no workspace");
    const text = faceText();
    expect(text.indexOf("hercule/run-3f1")).toBeLessThan(text.indexOf("no workspace"));
    expect(text.indexOf("webshop · moss")).toBeLessThan(text.indexOf("no workspace"));
    expect(text.indexOf("no workspace")).toBeLessThan(text.indexOf("Tidy the promotion runbook"));
  });

  it("offers a + on a workspace group that opens a draft joining it", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    const plus = await threadsNav().findByRole("link", {
      name: "New thread in hercule/run-3f1",
    });
    expect(plus.getAttribute("href")).toBe(
      `/threads/new?project=${WEBSHOP.id}&workspace=${W_RUN_3F1.id}`,
    );
  });

  it("puts the threads that belong to no project last, under no header of their own", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    await threadsNav().findByRole("link", { name: "New thread in webshop" });
    const text = faceText();
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

    await threadsNav().findByText("hercule/run-3f1");
    const text = faceText();
    expect(text).toContain("New thread draft");
    expect(text.indexOf("hercule/run-3f1")).toBeLessThan(text.indexOf("New thread draft"));
    // The draft is the group's last row, as it is the last of the thread tabs.
    expect(text.indexOf("Fix flaky webhook tests")).toBeLessThan(text.indexOf("New thread draft"));
    expect(text.indexOf("New thread draft")).toBeLessThan(text.indexOf("webshop · moss"));
  });

  it("no longer repeats the workspace on a row's second line", async () => {
    await renderApp({ path: "/", api: stubApi(withProjects()).fetch, token: "held" });

    const row = await threadsNav().findByRole("link", { name: /Fix flaky webhook tests/ });
    expect(row.textContent).not.toContain("hercule/run-3f1");
  });
});

describe("Create new thread opens the project picker (AC-16)", () => {
  it("opens the picker rather than navigating straight to a draft", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({
      path: "/",
      api: stubApi(withProjects()).fetch,
      token: "held",
    });

    await user.click(threadsNav().getByText("Create new thread"));

    const picker = await screen.findByRole("dialog");
    expect((picker.textContent ?? "").replace(/\s+/g, " ")).toContain("New thread in");
    expect(router.state.location.pathname).toBe("/");
  });
});
