/**
 * All sessions (`/sessions`): the headline sentence, the pinned lanes and
 * their rows, over a stubbed controller.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Session } from "@hydra/contract";
import { headlineOf } from "@hydra/client-core";
import { renderApp, stubApi, type Handler } from "../../../app/testing";

/**
 * The screen's own Create new thread, as opposed to the sidebar's: the
 * Threads face (with its own Create new thread) is shown on `/sessions` too,
 * so a query for the link by name alone finds two.
 */
const screenCreateThread = (): HTMLElement =>
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

const claudeCode = () => ({
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
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
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
};

const session = (overrides: Partial<Session> & { id: string }): Session => ({
  ...BASE_SESSION,
  ...overrides,
});

const BUSY = session({
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "busy",
  lastActivityAt: "2026-09-08T11:50:00.000Z",
});

const IDLE = session({
  id: "01a06d02-2000-7000-8000-000000000002",
  title: "Write the changelog",
  status: "idle",
  lastActivityAt: "2026-09-08T10:00:00.000Z",
});

const SETTLED = session({
  id: "01a06d02-2000-7000-8000-000000000003",
  title: "Investigate the flaky test",
  status: "exited",
  lastActivityAt: "2026-09-07T09:00:00.000Z",
  exitedAt: "2026-09-07T09:10:00.000Z",
});

const THREE_STATUSES: readonly Session[] = [BUSY, IDLE, SETTLED];

const controller = (
  sessions: readonly Session[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: ZONE },
    },
  },
  "GET /api/v1/sessions": { body: { items: sessions } },
  "GET /api/v1/providers": { body: [claudeCode()] },
  ...extra,
});

const open = async (
  sessions: readonly Session[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(controller(sessions, extra));
  const app = await renderApp({ path: "/sessions", api: api.fetch, token: "held" });
  return { ...app, api };
};

describe("All sessions", () => {
  it("reads the headline sentence for three sessions in three statuses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await open(THREE_STATUSES);

      const headline = headlineOf(THREE_STATUSES, NOW);
      expect(headline).toBe("1 running · 1 idle · 1 settled this week");
      // `renderApp` has already awaited `router.load()`, so the screen is in
      // its final state; a `findBy*`/`waitFor` would poll on a real timer
      // that fake timers never advance, and would hang rather than fail.
      expect(screen.getByText(headline)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Create new thread once on the screen itself, linking to /threads/new", async () => {
    await open(THREE_STATUSES);

    await screen.findAllByRole("link", { name: /create new thread/i });
    // The sidebar's Threads face carries its own Create new thread too, shown
    // on /sessions as well, so this counts only the screen's own.
    const onScreen = screen
      .getAllByRole("link", { name: /create new thread/i })
      .filter((link) => link.closest("nav") === null);
    expect(onScreen).toHaveLength(1);
    expect(onScreen[0]!.getAttribute("href")).toBe("/threads/new");
  });

  it("renders exactly the non-empty lanes, Running, Idle and Settled, and not the always-empty ones", async () => {
    await open(THREE_STATUSES);

    expect(await screen.findByText("Running")).toBeDefined();
    expect(screen.getByText("Idle")).toBeDefined();
    expect(screen.getByText("Settled")).toBeDefined();
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText("Assistants")).toBeNull();
  });

  it("shows one row per session, with its title and provider display name", async () => {
    await open(THREE_STATUSES);

    // The sidebar's Threads face carries every session's title too, shown on
    // /sessions as well, so a title is looked for on the screen itself.
    for (const s of THREE_STATUSES) {
      await waitFor(() => {
        const onScreen = screen.getAllByText(s.title).filter((el) => el.closest("nav") === null);
        expect(onScreen.length).toBeGreaterThanOrEqual(1);
      });
    }
    // "Claude Code" is the provider display name for every session's instanceId.
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(THREE_STATUSES.length);
  });

  it("reads No sessions yet with Create new thread, and no lane headings, when there are none", async () => {
    await open([]);

    expect(await screen.findByText("No sessions yet")).toBeDefined();
    expect(screenCreateThread().getAttribute("href")).toBe("/threads/new");
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText("Idle")).toBeNull();
    expect(screen.queryByText("Settled")).toBeNull();
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText("Assistants")).toBeNull();
  });
});
