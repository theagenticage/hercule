/**
 * Tests All sessions (`/sessions`) against a stubbed controller: the headline
 * sentence, the lanes and their rows.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Session } from "@hercule/contract";
import { buildHeadline } from "@hercule/client-core";
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
