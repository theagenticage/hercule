import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@hydra/contract";
import { ageOf } from "@hydra/client-core";
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
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: "01a06d02-beff-7037-9f5b-042822015952",
  workspaceId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  createdAt: "2026-09-04T09:00:00.000Z",
  startedAt: "2026-09-04T09:00:00.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-04T09:05:00.000Z",
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

const hydraNav = () => within(screen.getByRole("navigation", { name: "Hydra" }));

const threadsNav = () => within(screen.getByRole("navigation", { name: "Threads" }));

const navLabels = (): string[] =>
  hydraNav()
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the two-face sidebar", () => {
  it("shows the Hydra face on an orchestration screen, in its pinned order", async () => {
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

    const withGlyph = hydraNav()
      .getAllByRole("link")
      .filter((link) => link.querySelector("[data-mark]") !== null)
      .map((link) => link.textContent);

    expect(withGlyph).toEqual(["Tasks", "Runs", "Workflows"]);
  });

  it("shows the Threads face on Sessions", async () => {
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    // Create new thread is a real navigation now, not a disabled placeholder.
    const create = await threadsNav().findByRole("link", { name: /create new thread/i });
    expect(create.getAttribute("href")).toBe("/threads/new");
    expect(await threadsNav().findByText("No threads yet")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Hydra" })).toBeNull();
  });

  it("switches face when the segmented switch is used", async () => {
    const user = userEvent.setup();
    await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hydra/ }));

    expect(navLabels()[0]).toBe("Intake");
  });

  it("puts the screen back in charge of the face on the next navigation", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp({ path: "/", api: stubApi(inShell()).fetch, token: "held" });

    await user.click(screen.getByRole("radio", { name: /Hydra/ }));
    await user.click(hydraNav().getByRole("link", { name: "Intake" }));

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
    const create = threadsNav().getByRole("link", { name: /create new thread/i });
    const links = threadsNav().getAllByRole("link");
    expect(links.indexOf(create)).toBeLessThan(links.indexOf(rowLinks()[0]!));
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

  it("offers Create new thread as a link to /threads/new, not a disabled button", async () => {
    await renderApp({ path: "/", api: stubApi(withThreads(THREE_SESSIONS)).fetch, token: "held" });

    const create = await threadsNav().findByRole("link", { name: /create new thread/i });
    expect(create.getAttribute("href")).toBe("/threads/new");
    expect(threadsNav().queryByRole("button", { name: /create new thread/i })).toBeNull();
  });

  it.each(["/", "/threads/s1", "/sessions"])(
    "shows the Threads face, not Hydra, on %s",
    async (path) => {
      await renderApp({ path, api: stubApi(inShell()).fetch, token: "held" });

      expect(screen.getByRole("navigation", { name: "Threads" })).toBeDefined();
      expect(screen.queryByRole("navigation", { name: "Hydra" })).toBeNull();
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
      expect(screen.getByRole("navigation", { name: "Hydra" })).toBeDefined();
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
      expect(screen.getByRole("navigation", { name: "Hydra" })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
