/**
 * Tests All sessions (`/sessions`) against a stubbed controller: the headline
 * sentence, the lanes and their rows, and the fold that holds the sessions
 * workflow runs started.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@hercule/contract";
import { buildHeadline, summarizeWorkflowSessions } from "@hercule/client-core";
import { readPageText, renderApp, stubApi, type Handler } from "../../../app/testing";

/**
 * Returns the screen's own Create new thread link, not the sidebar's. The
 * sidebar's threads face, which has its own Create new thread link, is also
 * shown on `/sessions`, so a query by name alone finds two links.
 */
const getScreenCreateThreadLink = (): HTMLElement =>
  screen
    .getAllByRole("link", { name: /create new thread/i })
    .filter((link) => link.closest("nav") === null)[0]!;

const ZONE = "Europe/Amsterdam";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const DECLARED = {
  steering: "native",
  fork: "native",
  modelSwitch: "in-session",
  accessModes: {
    "approval-required": "native",
    "auto-accept-edits": "native",
    auto: "native",
    "full-access": "native",
  },
  mcpPassthrough: "native",
  disallowedTools: "native",
  structuredOutput: "supported",
} as const;

const CLAUDE_ID = "01a06d02-1000-7000-8000-000000000001";

const buildClaudeCodeInstance = () => ({
  id: CLAUDE_ID,
  providerId: "claude-code",
  name: "Claude Code",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  secretFields: [],
  declared: DECLARED,
  snapshots: [],
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const BASE_SESSION: Session = {
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: CLAUDE_ID,
  runnerId: "01a06d02-beff-7037-9f5b-042822015952",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:00.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

const buildSession = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE_SESSION,
  ...overrides,
});

const BUSY = buildSession({
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "busy",
  lastActivityAt: "2026-09-08T11:50:00.000Z",
});

const IDLE = buildSession({
  id: "01a06d02-2000-7000-8000-000000000002",
  title: "Write the changelog",
  status: "idle",
  lastActivityAt: "2026-09-08T10:00:00.000Z",
});

const SETTLED = buildSession({
  id: "01a06d02-2000-7000-8000-000000000003",
  title: "Investigate the flaky test",
  status: "exited",
  lastActivityAt: "2026-09-07T09:00:00.000Z",
  exitedAt: "2026-09-07T09:10:00.000Z",
});

const THREE_STATUSES: readonly Session[] = [BUSY, IDLE, SETTLED];

/** Sessions that answer an assistant's conversation, one working and one waiting for input. */
const ANSWERING: readonly Session[] = [
  buildSession({
    id: "01a06d02-2000-7000-8000-00000000000a",
    title: "Answer Ada's conversation",
    status: "busy",
    agentId: "01a06d02-a000-7000-8000-000000000001",
    conversationId: "01a06d02-c000-7000-8000-000000000001",
    lastActivityAt: "2026-09-08T11:55:00.000Z",
  }),
  buildSession({
    id: "01a06d02-2000-7000-8000-00000000000b",
    title: "Answer Bob's conversation",
    status: "idle",
    agentId: "01a06d02-a000-7000-8000-000000000002",
    conversationId: "01a06d02-c000-7000-8000-000000000002",
    lastActivityAt: "2026-09-08T11:00:00.000Z",
  }),
];

/**
 * Sessions two workflow runs' agent steps started: one working, created on
 * the day of `NOW`, and one ended, created the day before.
 */
const FROM_WORKFLOWS: readonly Session[] = [
  buildSession({
    id: "01a06d02-2000-7000-8000-000000000021",
    title: "Implement the retry policy",
    status: "busy",
    agentId: "01a06d02-a000-7000-8000-000000000021",
    runId: "01a06d02-e000-7000-8000-00011f3a9c2e",
    stepId: "implement",
    createdAt: "2026-09-08T10:00:00.000Z",
    lastActivityAt: "2026-09-08T11:58:00.000Z",
  }),
  buildSession({
    id: "01a06d02-2000-7000-8000-000000000022",
    title: "Review the nightly report",
    status: "exited",
    agentId: "01a06d02-a000-7000-8000-000000000022",
    runId: "01a06d02-e000-7000-8000-00024e5f6a7b",
    stepId: "review",
    createdAt: "2026-09-07T08:00:00.000Z",
    lastActivityAt: "2026-09-07T08:30:00.000Z",
    exitedAt: "2026-09-07T08:30:00.000Z",
  }),
];

/** Returns the button that opens and closes the fold of sessions workflows started. */
const getFoldButton = (): HTMLElement =>
  screen.getByRole("button", { name: /sessions started by workflows/i });

/**
 * Returns the lane on the screen whose heading is `label`, or null when the
 * screen has no such lane. The sidebar is skipped, because it can show the
 * same word.
 */
const findLane = (label: string): HTMLElement | null =>
  screen
    .queryAllByText(label)
    .filter((el) => el.closest("nav") === null)[0]
    ?.closest("section") ?? null;

const buildController = (
  sessions: readonly Session[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: ZONE },
    },
  },
  "GET /api/v1/sessions": { body: { items: sessions } },
  "GET /api/v1/providers": { body: [buildClaudeCodeInstance()] },
  // The sidebar's Assistants group reads this; no test here has an assistant.
  "GET /api/v1/assistants": { body: { items: [] } },
  ...extra,
});

const openApp = async (
  sessions: readonly Session[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildController(sessions, extra));
  const app = await renderApp({ path: "/sessions", api: api.fetch, token: "held" });
  return { ...app, api };
};

// The fold keeps its open state in session storage, which outlives a test.
beforeEach(() => {
  window.sessionStorage.clear();
});

describe("All sessions", () => {
  it("shows the headline sentence for three sessions in three statuses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await openApp(THREE_STATUSES);

      const headline = buildHeadline(THREE_STATUSES, NOW);
      expect(headline).toBe("1 running · 1 idle · 1 settled this week");
      // `renderApp` has already awaited `router.load()`, so the screen is in
      // its final state. A `findBy*` or `waitFor` would poll on a timer that
      // fake timers never advance, so it would hang rather than fail.
      expect(screen.getByText(headline)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Create new thread once on the screen itself, linking to /threads/new", async () => {
    await openApp(THREE_STATUSES);

    await screen.findAllByRole("link", { name: /create new thread/i });
    // The sidebar's threads face, also shown on /sessions, has its own Create
    // new thread link, so count only the screen's own.
    const onScreen = screen
      .getAllByRole("link", { name: /create new thread/i })
      .filter((link) => link.closest("nav") === null);
    expect(onScreen).toHaveLength(1);
    expect(onScreen[0]!.getAttribute("href")).toBe("/threads/new");
  });

  it("renders only the non-empty lanes (Running, Idle and Settled), not the empty ones", async () => {
    await openApp(THREE_STATUSES);

    expect(await screen.findByText("Running")).toBeDefined();
    expect(screen.getByText("Idle")).toBeDefined();
    expect(screen.getByText("Settled")).toBeDefined();
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText("Assistants")).toBeNull();
  });

  it("shows one row per session, with its title and provider display name", async () => {
    await openApp(THREE_STATUSES);

    // The sidebar's threads face, also shown on /sessions, lists every
    // session's title too, so look for each title outside the sidebar.
    for (const s of THREE_STATUSES) {
      await waitFor(() => {
        const onScreen = screen.getAllByText(s.title).filter((el) => el.closest("nav") === null);
        expect(onScreen.length).toBeGreaterThanOrEqual(1);
      });
    }
    // "Claude Code" is the provider display name for every session's instanceId.
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(THREE_STATUSES.length);
  });

  it("shows the sessions that answer a conversation in the Assistants lane and in no other", async () => {
    await openApp([...THREE_STATUSES, ...ANSWERING]);

    await waitFor(() => {
      expect(findLane("Assistants")).not.toBeNull();
    });
    const assistants = readPageText(findLane("Assistants"));
    const others = ["Running", "Idle", "Settled"].map((label) => readPageText(findLane(label)));
    for (const session of ANSWERING) {
      expect(assistants).toContain(session.title);
      for (const other of others) expect(other).not.toContain(session.title);
    }
    expect(assistants).not.toContain(BUSY.title);
    expect(assistants).not.toContain(IDLE.title);
  });

  it("shows No sessions yet, Create new thread and no lane headings when there are no sessions", async () => {
    await openApp([]);

    expect(await screen.findByText("No sessions yet")).toBeDefined();
    expect(getScreenCreateThreadLink().getAttribute("href")).toBe("/threads/new");
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText("Idle")).toBeNull();
    expect(screen.queryByText("Settled")).toBeNull();
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText("Assistants")).toBeNull();
  });
});

describe("All sessions' fold of the sessions workflows started", () => {
  it("leaves workflow sessions out of the headline and the lanes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await openApp([...THREE_STATUSES, ...FROM_WORKFLOWS]);

      // The working workflow session would make it "2 running", and the
      // ended one "2 settled".
      expect(screen.getByText("1 running · 1 idle · 1 settled this week")).toBeDefined();
      const lanes = ["Running", "Idle", "Settled"].map((label) => readPageText(findLane(label)));
      for (const session of FROM_WORKFLOWS) {
        for (const lane of lanes) expect(lane).not.toContain(session.title);
      }
      // Nor does the sidebar's list of threads show them.
      const sidebar = readPageText(screen.getByRole("navigation", { name: "Threads" }));
      for (const session of FROM_WORKFLOWS) expect(sidebar).not.toContain(session.title);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts closed, showing how many there are, how many run and how many started today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await openApp([...THREE_STATUSES, ...FROM_WORKFLOWS]);

      const button = getFoldButton();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(readPageText(button)).toContain("show 2 · 1 running · 1 today");
      for (const session of FROM_WORKFLOWS) expect(screen.queryByText(session.title)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens to list each session with the step and the run that started it, linked to its thread", async () => {
    const user = userEvent.setup();
    await openApp([...THREE_STATUSES, ...FROM_WORKFLOWS]);

    await user.click(getFoldButton());

    const button = getFoldButton();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // "Today" is the real today here, so the counts come from the same function.
    const summary = summarizeWorkflowSessions(FROM_WORKFLOWS, new Date(), ZONE);
    expect(readPageText(button)).toContain(`hide ${summary ?? ""}`);
    const fold = button.closest("section")!;
    const implement = within(fold).getByRole("link", { name: /Implement the retry policy/ });
    expect(implement.getAttribute("href")).toBe(`/threads/${FROM_WORKFLOWS[0]!.id}`);
    expect(readPageText(implement)).toContain("step implement · run 1f3a9c2e");
    const review = within(fold).getByRole("link", { name: /Review the nightly report/ });
    expect(readPageText(review)).toContain("step review · run 4e5f6a7b");
    // The threads in the lanes stay out of the fold.
    expect(readPageText(fold)).not.toContain(BUSY.title);
  });

  it("stays open across page loads in the same browser session once opened", async () => {
    const user = userEvent.setup();
    const first = await openApp(FROM_WORKFLOWS);

    await user.click(getFoldButton());
    // Unmount the first render to stand in for a page reload.
    first.unmount();
    await openApp(FROM_WORKFLOWS);

    expect(getFoldButton().getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getAllByText("Implement the retry policy").filter((el) => el.closest("nav") === null),
    ).toHaveLength(1);
  });

  it("is absent when no workflow run has started a session", async () => {
    await openApp(THREE_STATUSES);

    await screen.findByText("Running");
    expect(screen.queryByRole("button", { name: /sessions started by workflows/i })).toBeNull();
  });
});
