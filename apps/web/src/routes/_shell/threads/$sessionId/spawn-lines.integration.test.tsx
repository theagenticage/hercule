/**
 * Tests the spawn lines on the thread screen against a stubbed controller:
 * one line per subagent a turn started, in the turn between the user's
 * message and the agent's prose, each linking to the subagent's page.
 *
 * The clock is fake and frozen, so the tests never use `findBy*` or
 * `waitFor`: those poll on a timer the fake clock never advances. They run
 * pending work with `settle` and move the clock with
 * `vi.advanceTimersByTimeAsync` instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type {
  Profile,
  ProviderInstance,
  Runner,
  Session,
  SessionRequest,
  Subagent,
  TranscriptRow,
} from "@hercule/contract";
import { readPageText, renderApp, stubApi, type Handler } from "../../../../app/testing";

const SESSION_ID = "01a06d02-b100-7000-8000-000000000001";
const ZONE = "Europe/Amsterdam";
/** The moment the tests run at: 16 minutes 57 seconds after the iDEAL check started. */
const NOW = new Date("2026-09-08T10:17:00.000Z");

const INSTANCE: ProviderInstance = {
  id: "01a06d02-1000-7000-8000-000000000001",
  providerId: "claude-code",
  secretFields: [],
  name: "personal",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  declared: {
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
  },
  snapshots: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

const RUNNER: Runner = {
  id: "01a06d02-3000-7000-8000-000000000001",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: null,
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * 1024 * 1024 * 1024,
  lastSeenAt: "2026-09-08T09:50:00.000Z",
};

const PROFILE: Profile = {
  id: "01a06d02-2000-7000-8000-000000000001",
  name: "unrestricted",
  grants: [],
  shipped: true,
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

/** Builds an open command approval of the subagent `subagentId`. */
const buildRequest = (requestId: string, subagentId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "curl -s https://docs.mollie.com" },
  subagentId,
});

/**
 * The main agent is idle; its iDEAL check still runs in the background, and
 * two subagents wait on the user: one below the iDEAL check, and one the
 * turn started itself.
 */
const SESSION: Session = {
  id: SESSION_ID,
  title: "Audit checkout before the EU launch",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: PROFILE.id,
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: INSTANCE.id,
  runnerId: RUNNER.id,
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [buildRequest("r-mollie", "mollie"), buildRequest("r-asker", "asker")],
  createdAt: "2026-09-08T09:59:00.000Z",
  startedAt: "2026-09-08T09:59:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T10:05:00.000Z",
  unenforced: [],
};

/** Builds a subagent of `SESSION` with `over` applied. */
const buildSubagent = (over: Partial<Subagent> & Pick<Subagent, "id" | "status">): Subagent => ({
  sessionId: SESSION_ID,
  toolCalls: 0,
  startedAt: "2026-09-08T10:00:00.000Z",
  ...over,
});

const SUBAGENTS: readonly Subagent[] = [
  buildSubagent({
    id: "three-d-secure",
    itemId: "i-3ds",
    description: "Check the 3-D Secure flow",
    status: "completed",
    startedAt: "2026-09-08T10:00:01.000Z",
    endedAt: "2026-09-08T10:02:21.000Z",
  }),
  buildSubagent({
    id: "sepa",
    itemId: "i-sepa",
    description: "Check SEPA Direct Debit mandates",
    status: "failed",
    startedAt: "2026-09-08T10:00:02.000Z",
    endedAt: "2026-09-08T10:01:14.000Z",
  }),
  buildSubagent({
    id: "ideal",
    itemId: "i-ideal",
    description: "Check the iDEAL redirect",
    status: "running",
    startedAt: "2026-09-08T10:00:03.000Z",
  }),
  buildSubagent({
    id: "mollie",
    parentSubagentId: "ideal",
    itemId: "i-mollie",
    description: "Read Mollie's iDEAL docs",
    status: "running",
    startedAt: "2026-09-08T10:03:00.000Z",
  }),
  buildSubagent({
    id: "return-urls",
    parentSubagentId: "ideal",
    itemId: "i-return-urls",
    description: "List every place that builds an iDEAL return URL",
    status: "completed",
    startedAt: "2026-09-08T10:03:01.000Z",
    endedAt: "2026-09-08T10:06:49.000Z",
  }),
  buildSubagent({
    id: "apple-pay",
    itemId: "i-apple",
    description: "Check the Apple Pay path",
    status: "stopped",
    startedAt: "2026-09-08T10:00:04.000Z",
    endedAt: "2026-09-08T10:02:58.000Z",
  }),
  buildSubagent({
    id: "asker",
    itemId: "i-asker",
    description: "Run the webhook tests",
    status: "running",
    startedAt: "2026-09-08T10:00:05.000Z",
  }),
];

type TurnEvent = TranscriptRow["event"];

const base = (at: string, turnId: string) => ({ eventId: "", sessionId: SESSION_ID, at, turnId });

/** Builds a completed item of `kind`, started and completed at `at`. */
const buildItem = (
  turnId: string,
  at: string,
  itemId: string,
  kind: "user_message" | "subagent",
  text?: string,
): TurnEvent[] => {
  const detail = text === undefined ? {} : { detail: { text } };
  return [
    { _tag: "item.started", ...base(at, turnId), itemId, kind, ...detail },
    {
      _tag: "item.completed",
      ...base(at, turnId),
      itemId,
      kind,
      status: "completed",
      ...detail,
    },
  ];
};

/** Builds a whole assistant message: its text, then its start and completion events. */
const buildAssistantMessage = (
  turnId: string,
  at: string,
  itemId: string,
  text: string,
): TurnEvent[] => [
  {
    _tag: "content.delta",
    ...base(at, turnId),
    itemId,
    streamKind: "assistant_text",
    delta: text,
  },
  { _tag: "item.started", ...base(at, turnId), itemId, kind: "assistant_message" },
  {
    _tag: "item.completed",
    ...base(at, turnId),
    itemId,
    kind: "assistant_message",
    status: "completed",
  },
];

/** Builds a completed turn around `events`. */
const buildTurn = (turnId: string, at: string, endAt: string, events: TurnEvent[]): TurnEvent[] => [
  { _tag: "turn.started", ...base(at, turnId) },
  ...events,
  { _tag: "turn.completed", ...base(endAt, turnId), state: "completed" },
];

/**
 * The thread's transcript:
 *
 * - The first turn starts five subagents, in an order that is not the order
 *   their records are listed in, and one subagent whose record has not been
 *   read yet.
 * - The second turn starts none.
 */
const ROWS: TranscriptRow[] = [
  ...buildTurn("t1", "2026-09-08T10:00:00.000Z", "2026-09-08T10:05:00.000Z", [
    ...buildItem("t1", "2026-09-08T10:00:00.000Z", "u1", "user_message", "Audit checkout."),
    ...buildItem("t1", "2026-09-08T10:00:01.000Z", "i-3ds", "subagent"),
    ...buildItem("t1", "2026-09-08T10:00:02.000Z", "i-sepa", "subagent"),
    ...buildItem("t1", "2026-09-08T10:00:03.000Z", "i-ideal", "subagent"),
    ...buildItem("t1", "2026-09-08T10:00:04.000Z", "i-apple", "subagent"),
    ...buildItem("t1", "2026-09-08T10:00:05.000Z", "i-asker", "subagent"),
    ...buildItem("t1", "2026-09-08T10:00:06.000Z", "i-unread", "subagent"),
    ...buildAssistantMessage(
      "t1",
      "2026-09-08T10:04:59.000Z",
      "a1",
      "Here's where the audit stands.",
    ),
  ]),
  ...buildTurn("t2", "2026-09-08T10:06:00.000Z", "2026-09-08T10:06:10.000Z", [
    ...buildItem("t2", "2026-09-08T10:06:00.000Z", "u2", "user_message", "Thanks."),
    ...buildAssistantMessage("t2", "2026-09-08T10:06:09.000Z", "a2", "You're welcome."),
  ]),
].map((event, position) => ({
  position,
  at: event.at,
  event: { ...event, eventId: `e${position}` },
}));

const ROUTES: Readonly<Record<string, Handler>> = {
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone", "assistant"], timezone: ZONE },
    },
  },
  "GET /api/v1/sessions": { body: { items: [SESSION] } },
  [`GET /api/v1/sessions/${SESSION_ID}`]: { body: SESSION },
  [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: { body: { items: ROWS } },
  [`GET /api/v1/sessions/${SESSION_ID}/subagents`]: { body: { items: SUBAGENTS } },
  [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [] } },
  "GET /api/v1/providers": { body: [INSTANCE] },
  "GET /api/v1/runners": { body: { items: [RUNNER] } },
  "GET /api/v1/profiles": { body: { items: [PROFILE] } },
  "GET /api/v1/assistants": { body: { items: [] } },
};

/** Runs pending microtasks inside `act`, so a render that waits on them has happened. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

const openThread = async (): Promise<void> => {
  await renderApp({ path: `/threads/${SESSION_ID}`, api: stubApi(ROUTES).fetch, token: "held" });
  await settle();
};

/** Returns the spawn lines on the page, one link per line, in the order they are drawn. */
const getLines = (): HTMLElement[] =>
  within(screen.getByRole("list", { name: "Subagents started here" })).getAllByRole("link");

/** Returns the spawn line of the subagent named `name`. */
const getLine = (name: string): HTMLElement =>
  getLines().find((line) => readPageText(line).includes(name))!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Thread: spawn lines", () => {
  it("draws one line per subagent the turn started, in item order, and none for a record not read yet", async () => {
    await openThread();

    expect(getLines().map((line) => readPageText(line))).toEqual([
      "↳Check the 3-D Secure flowdone · 2m 20s",
      "↳Check SEPA Direct Debit mandatesfailed · 1m 12s",
      "↳Check the iDEAL redirectworking · 16m 57s · 2 below · one waits on you",
      "↳Check the Apple Pay pathstopped · 2m 54s",
      "↳Run the webhook testswaiting on you · 16m 55s · one waits on you",
    ]);
  });

  it("draws the lines after the user's message and before the agent's prose, in that turn only", async () => {
    await openThread();

    // Only the first turn started subagents, so there is one list.
    const list = screen.getByRole("list", { name: "Subagents started here" });
    const message = screen.getByText("Audit checkout.");
    const prose = screen.getByText("Here's where the audit stands.");
    expect(message.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws each state's mark and colours the state word by its hue", async () => {
    await openThread();

    const marks = getLines().map((line) =>
      line.querySelector("[data-mark]")?.getAttribute("data-mark"),
    );
    expect(marks).toEqual(["done", "failed", "working", "cancelled", "decision"]);
    expect(within(getLine("iDEAL")).getByText("working").className).toContain("text-live");
    expect(within(getLine("SEPA")).getByText("failed").className).toContain("text-fail");
    expect(within(getLine("webhook")).getByText("waiting on you").className).toContain("text-attn");
    expect(within(getLine("Apple Pay")).getByText("stopped").className).toContain("text-muted");
  });

  it("links each line to its subagent's page", async () => {
    await openThread();

    expect(getLine("iDEAL").getAttribute("href")).toBe(`/threads/${SESSION_ID}/subagents/ideal`);
    expect(getLine("3-D Secure").getAttribute("href")).toBe(
      `/threads/${SESSION_ID}/subagents/three-d-secure`,
    );
  });

  it("counts a running subagent's duration up every second, and leaves an ended one's alone", async () => {
    await openThread();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle();

    expect(readPageText(getLine("iDEAL"))).toContain("working · 16m 58s");
    expect(readPageText(getLine("3-D Secure"))).toContain("done · 2m 20s");
  });

  it("keeps each subagent item in the turn's Worked for list", async () => {
    await openThread();

    fireEvent.click(screen.getAllByRole("button", { name: /^Worked for/ })[0]!);
    await settle();

    // The six `subagent` items, the one with no record read yet included.
    const subagentItems = [...document.querySelectorAll("li")].filter((item) =>
      item.textContent.startsWith("subagent"),
    );
    expect(subagentItems).toHaveLength(6);
  });
});
