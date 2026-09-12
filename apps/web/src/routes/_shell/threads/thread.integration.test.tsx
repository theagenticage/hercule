/**
 * The thread surface over a stubbed controller: AC-11 to AC-14 and AC-23 of
 * `docs/plans/P009-thread-surface-and-composer/SPEC.md`.
 *
 * These tests drive the transcript's rendering, the live turn's divider, the
 * token tap and the top bar's crumb - all through `renderApp` and the
 * `LiveStub`, never by reaching into the screen's own modules. Fixtures follow
 * the shapes `packages/client-core/src/threads/turns.test.ts` fixed: a
 * `user_message` item carries `detail: { text }` on both `item.started` and
 * `item.completed`; assistant text arrives only on `content.delta`, never on
 * the `assistant_message` item events themselves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatDuration, formatStamp } from "@hydra/client-core";
import type {
  Input,
  ModelOption,
  Profile,
  ProviderInstance,
  Runner,
  Session,
  TranscriptRow,
} from "@hydra/contract";
import { sessionStreamTopic, sessionTapTopic } from "@hydra/contract";
import { envelope, pickRow, renderApp, stubApi, type Handler } from "../../../app/testing";

const SESSION_ID = "01a06d02-b100-7000-8000-000000000001";
const ZONE = "Europe/Amsterdam";

const BASE_SESSION: Session = {
  id: SESSION_ID,
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  permissionProfileId: "01a06d02-2000-7000-8000-000000000001",
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: "01a06d02-3000-7000-8000-000000000001",
  workspaceId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  createdAt: "2026-09-08T09:59:00.000Z",
  startedAt: "2026-09-08T09:59:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T10:01:03.000Z",
};

const session = (overrides: Partial<Session>): Session => ({ ...BASE_SESSION, ...overrides });

/**
 * The composer's own fixtures (AC-19 to AC-21): a provider instance, a runner
 * and a profile matching `BASE_SESSION`'s own ids, so the started thread's
 * read-only fields and its model menu resolve against them; a second instance,
 * runner and profile of each kind exist only to prove nothing about them ever
 * surfaces on a started thread's read-only fields or its other-instance groups.
 */
const DECLARED: ProviderInstance["declared"] = {
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
};

const instanceSnapshot = (
  runnerId: string,
  identity: string,
  planLabel: string,
  models: ProviderInstance["snapshots"][number]["models"],
): ProviderInstance["snapshots"][number] => ({
  runnerId,
  probedAt: "2026-09-08T09:50:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity, planLabel },
  models,
});

const INSTANCE_STARTED: ProviderInstance = {
  id: BASE_SESSION.instanceId,
  providerId: "claude-code",
  name: "personal",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  declared: DECLARED,
  snapshots: [
    instanceSnapshot(BASE_SESSION.runnerId, "rogier@example.com", "Claude Max", [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [] },
      { slug: "claude-opus-5", name: "Claude Opus 5", options: [] },
    ]),
  ],
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

/**
 * The same descriptor `new.integration.test.tsx` uses, for the option tests of
 * P001's AC-6 and AC-7. It rides a fixture of its own (`INSTANCE_OPTIONS`)
 * rather than `INSTANCE_STARTED`, so the tests that are not about options keep
 * reading a pill with no effort segment.
 */
const EFFORT: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  default: "medium",
};

/** The session's instance, with `effort` offered on both of its models. */
const INSTANCE_OPTIONS: ProviderInstance = {
  ...INSTANCE_STARTED,
  snapshots: [
    instanceSnapshot(BASE_SESSION.runnerId, "rogier@example.com", "Claude Max", [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [EFFORT] },
      { slug: "claude-opus-5", name: "Claude Opus 5", options: [EFFORT] },
    ]),
  ],
};

const INSTANCE_OTHER: ProviderInstance = {
  ...INSTANCE_STARTED,
  id: "01a06d02-1000-7000-8000-000000000099",
  name: "work",
  snapshots: [
    instanceSnapshot(BASE_SESSION.runnerId, "work@example.com", "Claude Pro", [
      { slug: "claude-haiku-5", name: "Claude Haiku 5", isDefault: true, options: [] },
    ]),
  ],
};

const RUNNER_STARTED: Runner = {
  id: BASE_SESSION.runnerId,
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

const RUNNER_OTHER: Runner = {
  ...RUNNER_STARTED,
  id: "01a06d02-3000-7000-8000-000000000099",
  name: "cove",
};

const PROFILE_STARTED: Profile = {
  id: BASE_SESSION.permissionProfileId,
  name: "unrestricted",
  grants: [],
  shipped: true,
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

const PROFILE_OTHER: Profile = {
  ...PROFILE_STARTED,
  id: "01a06d02-2000-7000-8000-000000000099",
  name: "worker",
};

/** A controller answering for itself and for this one session's thread. */
const controller = (
  fixture: Session,
  rows: readonly TranscriptRow[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/setup": { body: { complete: true } },
  "GET /api/v1/settings": {
    body: {
      controller: {},
      user: { "onboarding.completedSteps": ["timezone"], timezone: ZONE },
    },
  },
  [`GET /api/v1/sessions/${fixture.id}`]: { body: fixture },
  [`GET /api/v1/sessions/${fixture.id}/transcript`]: { body: { items: rows } },
  // The composer's own reads (AC-19 to AC-21): a test that cares about
  // specific queued inputs overrides the last one with its own `extra`.
  "GET /api/v1/providers": { body: [INSTANCE_STARTED, INSTANCE_OTHER] },
  "GET /api/v1/runners": { body: { items: [RUNNER_STARTED, RUNNER_OTHER] } },
  "GET /api/v1/profiles": { body: { items: [PROFILE_STARTED, PROFILE_OTHER] } },
  [`GET /api/v1/sessions/${fixture.id}/inputs`]: { body: { items: [] } },
  ...extra,
});

const open = async (
  fixture: Session,
  rows: readonly TranscriptRow[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(controller(fixture, rows, extra));
  const app = await renderApp({ path: `/threads/${fixture.id}`, api: api.fetch, token: "held" });
  return { ...app, api };
};

/** The page's text with its whitespace collapsed, the way a reader sees it. */
const reading = (element: HTMLElement | null = document.body): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * `StubSocket.push` delivers over `queueMicrotask` (`socket-stub.ts`'s
 * `deliver`), and the RPC stream's own decode-and-dispatch is a few fiber
 * yields past that, so a push needs a few microtask turns before its effect -
 * a re-render, a `requestAnimationFrame` request - is observable. Testing
 * Library's own `findBy*`/`waitFor` poll on a real timer, which a frozen fake
 * clock never fires, so tests running under one flush this by hand instead.
 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

/** A `TranscriptRow`, position and `at` taken off the event itself. */
const row = (position: number, event: TranscriptRow["event"]): TranscriptRow => ({
  position,
  at: event.at,
  event,
});

const TOOL_DETAIL = { name: "Bash", input: { command: "ls -la" } };
/** `summarize`'s own summary of `TOOL_DETAIL`: the command, not the row's raw JSON. */
const TOOL_TARGET = "ls -la";

/**
 * Two completed turns: the first opens with a tool call (a divider to
 * collapse/expand), the second has no tool items at all (no divider).
 */
const twoCompletedTurns = (): TranscriptRow[] => [
  row(0, {
    _tag: "turn.started",
    eventId: "e0",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:00.000Z",
    turnId: "t1",
  }),
  row(1, {
    _tag: "item.started",
    eventId: "e1",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:00.100Z",
    turnId: "t1",
    itemId: "u1",
    kind: "user_message",
    detail: { text: "Fix the login bug" },
  }),
  row(2, {
    _tag: "item.completed",
    eventId: "e2",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:00.100Z",
    turnId: "t1",
    itemId: "u1",
    kind: "user_message",
    status: "completed",
    detail: { text: "Fix the login bug" },
  }),
  row(3, {
    _tag: "item.started",
    eventId: "e3",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:01.000Z",
    turnId: "t1",
    itemId: "tool1",
    kind: "command_execution",
    detail: TOOL_DETAIL,
  }),
  row(4, {
    _tag: "content.delta",
    eventId: "e4",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:02.000Z",
    turnId: "t1",
    itemId: "a1",
    streamKind: "assistant_text",
    delta: "I'll look at the file.",
  }),
  row(5, {
    _tag: "item.completed",
    eventId: "e5",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:03.000Z",
    turnId: "t1",
    itemId: "tool1",
    kind: "command_execution",
    status: "completed",
    detail: TOOL_DETAIL,
  }),
  row(6, {
    _tag: "item.started",
    eventId: "e6",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:03.500Z",
    turnId: "t1",
    itemId: "a1",
    kind: "assistant_message",
  }),
  row(7, {
    _tag: "item.completed",
    eventId: "e7",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:03.600Z",
    turnId: "t1",
    itemId: "a1",
    kind: "assistant_message",
    status: "completed",
  }),
  row(8, {
    _tag: "turn.completed",
    eventId: "e8",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:00:05.000Z",
    turnId: "t1",
    state: "completed",
  }),
  row(9, {
    _tag: "turn.started",
    eventId: "e9",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:00.000Z",
    turnId: "t2",
  }),
  row(10, {
    _tag: "item.started",
    eventId: "e10",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:00.100Z",
    turnId: "t2",
    itemId: "u2",
    kind: "user_message",
    detail: { text: "What about the tests?" },
  }),
  row(11, {
    _tag: "item.completed",
    eventId: "e11",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:00.100Z",
    turnId: "t2",
    itemId: "u2",
    kind: "user_message",
    status: "completed",
    detail: { text: "What about the tests?" },
  }),
  row(12, {
    _tag: "content.delta",
    eventId: "e12",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:01.000Z",
    turnId: "t2",
    itemId: "a2",
    streamKind: "assistant_text",
    delta: "Added a test too.",
  }),
  row(13, {
    _tag: "item.started",
    eventId: "e13",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:01.500Z",
    turnId: "t2",
    itemId: "a2",
    kind: "assistant_message",
  }),
  row(14, {
    _tag: "item.completed",
    eventId: "e14",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:01.600Z",
    turnId: "t2",
    itemId: "a2",
    kind: "assistant_message",
    status: "completed",
  }),
  row(15, {
    _tag: "turn.completed",
    eventId: "e15",
    sessionId: SESSION_ID,
    at: "2026-09-08T10:01:03.000Z",
    turnId: "t2",
    state: "completed",
  }),
];

describe("Thread: transcript (AC-11)", () => {
  it("renders each completed turn with its timestamp, the user bubble, the assistant text and a Worked-for divider for the turn with a tool item", async () => {
    const user = userEvent.setup();
    await open(session({ status: "idle", title: "Thread s1" }), twoCompletedTurns());

    // The user's message and the assistant's reply, both turns.
    const userBubble = await screen.findByText("Fix the login bug");
    // The column itself: 800px max width, holding both.
    const column = userBubble.closest('[class*="max-w-[800px]"]');
    expect(column, "no 800px column ancestor found").not.toBeNull();
    expect(column?.contains(await screen.findByText("What about the tests?"))).toBe(true);
    expect(reading()).toContain("I'll look at the file.");
    expect(reading()).toContain("What about the tests?");
    expect(reading()).toContain("Added a test too.");

    // Each turn's own mono timestamp line.
    const stamp1 = formatStamp(new Date("2026-09-08T10:00:00.000Z"), ZONE)!;
    const stamp2 = formatStamp(new Date("2026-09-08T10:01:00.000Z"), ZONE)!;
    expect(reading()).toContain(stamp1);
    expect(reading()).toContain(stamp2);

    // Turn 1 has a tool item, so it has a collapsed Worked-for divider.
    const divider = await screen.findByRole("button", { name: /worked for/i });
    expect(reading(divider)).toBe(`Worked for ${formatDuration(5000)}›`);
    // The tool item's line is not shown until the divider opens.
    expect(reading()).not.toContain(TOOL_TARGET);

    await user.click(divider);
    await waitFor(() => {
      expect(reading()).toContain(`command · ${TOOL_TARGET} · completed`);
    });

    // Turn 2 has no tool items at all, so it has no divider.
    expect(screen.queryAllByRole("button", { name: /worked for/i })).toHaveLength(1);
  });

  it("reads an earlier turn abandoned by an interrupt as settled with no number, never as 0s or as still running", async () => {
    // Turn 1 opens a tool call and is cut off - no item.completed, no
    // turn.completed - before turn 2 starts and finishes normally.
    const abandonedThenCompleted: TranscriptRow[] = [
      row(0, {
        _tag: "turn.started",
        eventId: "e0",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      row(1, {
        _tag: "item.started",
        eventId: "e1",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
      row(2, {
        _tag: "item.started",
        eventId: "e2",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.000Z",
        turnId: "t1",
        itemId: "tool1",
        kind: "command_execution",
        detail: TOOL_DETAIL,
      }),
      // No item.completed for tool1, no turn.completed for t1: abandoned.
      row(3, {
        _tag: "turn.started",
        eventId: "e3",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.000Z",
        turnId: "t2",
      }),
      row(4, {
        _tag: "item.started",
        eventId: "e4",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.100Z",
        turnId: "t2",
        itemId: "u2",
        kind: "user_message",
        detail: { text: "Try again" },
      }),
      row(5, {
        _tag: "turn.completed",
        eventId: "e5",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:05.000Z",
        turnId: "t2",
        state: "completed",
      }),
    ];
    await open(session({ status: "idle" }), abandonedThenCompleted);

    const divider = await screen.findByRole("button", { name: /worked for/i });
    expect(reading(divider)).toBe("Worked for —›");
    // Settled, not still running: no shimmer, no live hue, no ticking.
    expect(divider.className).not.toContain("hydra-thread-shimmer");
    expect(divider.className).not.toContain("text-live");
  });
});

describe("Thread: the live turn (AC-12)", () => {
  const liveTurnRows = (): TranscriptRow[] => [
    row(0, {
      _tag: "turn.started",
      eventId: "e0",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:00.000Z",
      turnId: "t3",
    }),
    row(1, {
      _tag: "item.started",
      eventId: "e1",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:00.100Z",
      turnId: "t3",
      itemId: "u3",
      kind: "user_message",
      detail: { text: "Run the tests" },
    }),
    row(2, {
      _tag: "item.completed",
      eventId: "e2",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:00.100Z",
      turnId: "t3",
      itemId: "u3",
      kind: "user_message",
      status: "completed",
      detail: { text: "Run the tests" },
    }),
    row(3, {
      _tag: "item.started",
      eventId: "e3",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:01.000Z",
      turnId: "t3",
      itemId: "tool3",
      kind: "command_execution",
      detail: { name: "Bash", input: { command: "pnpm test" } },
    }),
    // No item.completed for tool3, and no turn.completed: the turn is live.
  ];

  /**
   * Advances the frozen fake clock in small steps, settling after each one,
   * until `predicate` holds - for work (like the live socket coming up) that
   * needs both microtask turns and a macrotask tick or two to complete, which
   * a fully frozen clock never provides on its own.
   */
  const pumpUntil = async (predicate: () => boolean, stepMs = 20, maxSteps = 50): Promise<void> => {
    for (let i = 0; i < maxSteps; i++) {
      await settle();
      if (predicate()) return;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(stepMs);
      });
    }
    throw new Error("condition never became true");
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads Working for, ticking every second, with the shimmer class and the running item marked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z")); // 3s after turn.started

    const busy = session({ status: "busy", lastActivityAt: "2026-09-08T11:00:01.000Z" });
    await open(busy, liveTurnRows());
    await settle();

    const divider = screen.getByRole("button", { name: /^Working for 3s$/ });
    expect(divider.className).toContain("hydra-thread-shimmer");

    // The running tool item's line, once the divider (collapsed by default,
    // as AC-11's) is opened. `fireEvent`, not `userEvent`, since userEvent's
    // own internal delays do not get on with a fully frozen fake clock.
    fireEvent.click(divider);
    await settle();
    expect(reading()).toContain("command · pnpm test · running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle();
    screen.getByRole("button", { name: /^Working for 4s$/ });
  });

  it("leaves the shimmer class in place under prefers-reduced-motion, since the stylesheet owns that rule", async () => {
    // `.hydra-thread-shimmer` drops its own sweep and keeps the live hue
    // inside `@media (prefers-reduced-motion: reduce)` in `@hydra/ui`. There
    // is deliberately no JS copy of that rule, so the class the divider
    // carries is the same either way; whether the sweep actually stops is a
    // stylesheet question jsdom cannot answer and a manual check does.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    const busy = session({ status: "busy", lastActivityAt: "2026-09-08T11:00:01.000Z" });
    await open(busy, liveTurnRows());
    await settle();

    const divider = screen.getByRole("button", { name: /^Working for 3s$/ });
    expect(divider.className).toContain("hydra-thread-shimmer");
  });

  it("reads a dangling last turn on a session that is no longer busy as settled, with no shimmer and no ticking", async () => {
    // A runner that died mid-turn leaves no `turn.completed` row behind, so
    // the rows alone still look live; the session's own status is what says
    // otherwise.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));

    const exited = session({
      status: "exited",
      exitedAt: "2026-09-08T11:00:02.000Z",
      lastActivityAt: "2026-09-08T11:00:01.000Z",
    });
    await open(exited, liveTurnRows());
    await settle();

    const divider = screen.getByRole("button", { name: /^Worked for —$/ });
    expect(divider.className).not.toContain("hydra-thread-shimmer");

    // Nothing ticks: a minute later it still reads the same settled line.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();
    screen.getByRole("button", { name: /^Worked for —$/ });
    expect(screen.queryByRole("button", { name: /Working for/ })).toBeNull();
  });

  it("switches the divider to Worked for once turn.completed arrives on :stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));

    const busy = session({ status: "busy", lastActivityAt: "2026-09-08T11:00:01.000Z" });
    const { live } = await open(busy, liveTurnRows());
    await settle();

    // Live and ticking, however many seconds the wait for the subscription
    // below costs; the exact reading is not the point here (the ticking test
    // above already pins it), only that it reads "Working for" before the
    // turn completes.
    screen.getByRole("button", { name: /^Working for \d+s$/ });

    await pumpUntil(() => live.topics().includes(sessionStreamTopic(SESSION_ID)));
    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          row(4, {
            _tag: "item.completed",
            eventId: "e4",
            sessionId: SESSION_ID,
            at: "2026-09-08T11:00:04.000Z",
            turnId: "t3",
            itemId: "tool3",
            kind: "command_execution",
            status: "completed",
            detail: { name: "Bash", input: { command: "pnpm test" } },
          }),
          row(5, {
            _tag: "turn.completed",
            eventId: "e5",
            sessionId: SESSION_ID,
            at: "2026-09-08T11:00:05.000Z",
            turnId: "t3",
            state: "completed",
          }),
        ],
        cursor: "5",
      });
    });

    const workedFor = new RegExp(`^Worked for ${formatDuration(5000)}$`);
    await pumpUntil(() => screen.queryByRole("button", { name: workedFor }) !== null);
    screen.getByRole("button", { name: workedFor });
  });
});

describe("Thread: token tap (AC-13)", () => {
  const openTurnRows = (): TranscriptRow[] => [
    row(0, {
      _tag: "turn.started",
      eventId: "e0",
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:00.000Z",
      turnId: "t4",
    }),
    row(1, {
      _tag: "item.started",
      eventId: "e1",
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:00.100Z",
      turnId: "t4",
      itemId: "u4",
      kind: "user_message",
      detail: { text: "Say hi" },
    }),
    row(2, {
      _tag: "item.completed",
      eventId: "e2",
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:00.100Z",
      turnId: "t4",
      itemId: "u4",
      kind: "user_message",
      status: "completed",
      detail: { text: "Say hi" },
    }),
    row(3, {
      _tag: "item.started",
      eventId: "e3",
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:00.200Z",
      turnId: "t4",
      itemId: "a4",
      kind: "assistant_message",
    }),
    // No item.completed for a4: it is the open item.
  ];

  /**
   * A `requestAnimationFrame` stub that records every request and never
   * fires on its own; `runFrame` fires everything queued so far, once, the
   * way a browser runs every callback registered since the last frame.
   */
  const stubFrames = () => {
    const queue: FrameRequestCallback[] = [];
    const raf = vi.fn((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const runFrame = () => {
      const callbacks = queue.splice(0, queue.length);
      act(() => {
        for (const cb of callbacks) cb(performance.now());
      });
    };
    return { raf, runFrame };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows concatenated tap deltas for the open item after one frame, batching N deltas into one requestAnimationFrame request", async () => {
    const { raf, runFrame } = stubFrames();
    const busy = session({ status: "busy" });
    const { live } = await open(busy, openTurnRows());

    await waitFor(() => {
      expect(live.topics()).toContain(sessionTapTopic(SESSION_ID));
    });

    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "Hel" }],
      });
    });
    await settle();
    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "lo" }],
      });
    });
    await settle();

    // Two deltas, requested for one frame - not two.
    expect(raf).toHaveBeenCalledTimes(1);
    // Nothing is written to the DOM before the frame runs.
    expect(screen.queryByText(/Hello/)).toBeNull();

    runFrame();

    await screen.findByText("Hello");
  });

  it("never paints a reasoning or command-output tap on the open item as the assistant's answer", async () => {
    // The open item (a4) is an `assistant_message`; a `reasoning_text` or
    // `command_output` delta naming it is never the answer, so it is dropped
    // rather than painted where the answer renders.
    const { runFrame } = stubFrames();
    const busy = session({ status: "busy" });
    const { live } = await open(busy, openTurnRows());

    await waitFor(() => {
      expect(live.topics()).toContain(sessionTapTopic(SESSION_ID));
    });
    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "reasoning_text", delta: "thinking…" }],
      });
    });
    await settle();
    runFrame();

    expect(screen.queryByText(/thinking/)).toBeNull();
  });

  it("lets the coalesced :stream row win over the buffer, and later taps for an item that has completed change nothing", async () => {
    const { runFrame } = stubFrames();
    const busy = session({ status: "busy" });
    const { live } = await open(busy, openTurnRows());

    await waitFor(() => {
      expect(live.topics()).toContain(sessionTapTopic(SESSION_ID));
    });

    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "Hello " }],
      });
    });
    await settle();
    runFrame();
    await screen.findByText("Hello");

    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });
    act(() => {
      // The coalescing rule flushes a row at an item's completion (spec 04
      // §Streaming deltas are coalesced), so the row and the item's own
      // completion arrive together - which is what actually retires the item
      // as "open" and is why a tap for it afterwards has nothing left to do.
      live.push(sessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          row(4, {
            _tag: "content.delta",
            eventId: "e4",
            sessionId: SESSION_ID,
            at: "2026-09-08T12:00:01.000Z",
            turnId: "t4",
            itemId: "a4",
            streamKind: "assistant_text",
            delta: "Hello world",
          }),
          row(5, {
            _tag: "item.completed",
            eventId: "e5",
            sessionId: SESSION_ID,
            at: "2026-09-08T12:00:01.100Z",
            turnId: "t4",
            itemId: "a4",
            kind: "assistant_message",
            status: "completed",
          }),
        ],
        cursor: "5",
      });
    });

    const paragraph = (await screen.findByText("Hello world")).closest("p");
    expect(paragraph).not.toBeNull();
    expect(screen.queryByText("Hello ")).toBeNull();

    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "!!!" }],
      });
    });
    await settle();
    runFrame();

    // A later tap delta for the item the row already answered for changes
    // nothing: the whole paragraph's text, tail node included, is unchanged.
    expect(paragraph?.textContent).toBe("Hello world");
  });

  it("lets a coalesced :stream row for an item that is still open win, and keeps painting the taps after it", async () => {
    // The 4KB flush (spec 04 §Streaming deltas are coalesced) writes a
    // `content.delta` row inside an open item: the row wins over what the
    // tail held, and the item goes on streaming into the same tail. Any
    // answer longer than 4KB takes this path.
    const { runFrame } = stubFrames();
    const busy = session({ status: "busy" });
    const { live } = await open(busy, openTurnRows());

    await waitFor(() => {
      expect(live.topics()).toContain(sessionTapTopic(SESSION_ID));
    });
    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "Hello " }],
      });
    });
    await settle();
    runFrame();
    await screen.findByText("Hello");

    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });
    act(() => {
      // The flush row alone: no `item.completed`, so a4 is still the open item.
      live.push(sessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          row(4, {
            _tag: "content.delta",
            eventId: "e4",
            sessionId: SESSION_ID,
            at: "2026-09-08T12:00:01.000Z",
            turnId: "t4",
            itemId: "a4",
            streamKind: "assistant_text",
            delta: "Hello world",
          }),
        ],
        cursor: "4",
      });
    });
    await settle();

    const paragraph = (await screen.findByText("Hello world")).closest("p");
    expect(paragraph).not.toBeNull();

    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: ", again" }],
      });
    });
    await settle();
    runFrame();

    // The row's text, then the taps that came after it - the buffer the row
    // replaced is not repeated.
    expect(paragraph?.textContent).toBe("Hello world, again");
  });

  it("leaves the open item's buffered tail alone when a :stream row for a different item arrives", async () => {
    // A tool item started earlier, still running when the assistant item
    // (a4, later, so still the open one per openItemOf) began streaming.
    const rowsWithEarlierTool: TranscriptRow[] = [
      ...openTurnRows().slice(0, 3),
      row(3, {
        _tag: "item.started",
        eventId: "e3",
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.150Z",
        turnId: "t4",
        itemId: "tool0",
        kind: "command_execution",
        detail: { name: "Bash", input: { command: "pnpm test" } },
      }),
      row(4, {
        _tag: "item.started",
        eventId: "e4",
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.200Z",
        turnId: "t4",
        itemId: "a4",
        kind: "assistant_message",
      }),
    ];
    const { runFrame } = stubFrames();
    const busy = session({ status: "busy" });
    const { live } = await open(busy, rowsWithEarlierTool);

    await waitFor(() => {
      expect(live.topics()).toContain(sessionTapTopic(SESSION_ID));
    });
    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "Hello" }],
      });
    });
    await settle();
    runFrame();
    const paragraph = (await screen.findByText("Hello")).closest("p");

    // tool0 finishing is a row about a different item; a4 stays open.
    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });
    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          row(5, {
            _tag: "item.completed",
            eventId: "e5",
            sessionId: SESSION_ID,
            at: "2026-09-08T12:00:01.000Z",
            turnId: "t4",
            itemId: "tool0",
            kind: "command_execution",
            status: "completed",
            detail: { name: "Bash", input: { command: "pnpm test" } },
          }),
        ],
        cursor: "5",
      });
    });
    await settle();

    // Untouched: the row was not about the open item's own text.
    expect(paragraph?.textContent).toBe("Hello");
  });

  it("refetches the transcript and shows the refetched rows when the live overlay reports reset", async () => {
    const { runFrame } = stubFrames();
    const busy = session({ status: "busy" });
    let transcriptCalls = 0;
    const REFETCHED: TranscriptRow[] = [
      ...openTurnRows(),
      row(4, {
        _tag: "content.delta",
        eventId: "e4",
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:02.000Z",
        turnId: "t4",
        itemId: "a4",
        streamKind: "assistant_text",
        delta: "Hi there, refetched.",
      }),
    ];
    const { live } = await open(busy, openTurnRows(), {
      [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: () => {
        transcriptCalls += 1;
        return { body: { items: transcriptCalls === 1 ? openTurnRows() : REFETCHED } };
      },
    });

    // A buffered tap delta is standing when the reset arrives, to prove it is
    // dropped rather than surviving into the refetched reading.
    await waitFor(() => {
      expect(live.topics()).toContain(sessionTapTopic(SESSION_ID));
    });
    act(() => {
      live.push(sessionTapTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          { turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "stale buffer" },
        ],
      });
    });
    await settle();
    runFrame();
    await screen.findByText("stale buffer");

    // A cursor is on record before the refusal: `reset` only fires for one
    // that is (`live.ts`'s own rule - a fresh subscription's `undefined`
    // cursor cannot be "past the end of the log").
    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });
    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), { _tag: "delta", items: [], cursor: "0" });
    });
    await settle();

    act(() => {
      live.fail(sessionStreamTopic(SESSION_ID), {
        error: {
          code: "validation",
          message: "cursor is past the end of the log",
          details: { issues: [] },
        },
      });
    });

    await waitFor(() => {
      expect(transcriptCalls).toBeGreaterThanOrEqual(2);
    });
    await screen.findByText("Hi there, refetched.");
    expect(screen.queryByText(/stale buffer/)).toBeNull();
  });
});

describe("Thread: the transcript cache only ever grows forwards", () => {
  it("appends the same :stream delta once, however many times it is delivered", async () => {
    // The transcript log is append-only and strictly ordered, so a row at or
    // below the last one held is one the cache already has: a replay the
    // subscription resumed from, or one delta delivered twice. The probe is
    // an `assistant_text` delta, because `turnsOf` concatenates those - a
    // second copy in the cache reads as the sentence said twice.
    const { live } = await open(session({ status: "idle" }), twoCompletedTurns());

    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });

    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          row(16, {
            _tag: "turn.started",
            eventId: "e16",
            sessionId: SESSION_ID,
            at: "2026-09-08T10:02:00.000Z",
            turnId: "t3",
          }),
        ],
        cursor: "16",
      });
    });
    await settle();

    const again = {
      _tag: "delta" as const,
      items: [
        row(17, {
          _tag: "content.delta" as const,
          eventId: "e17",
          sessionId: SESSION_ID,
          at: "2026-09-08T10:02:01.000Z",
          turnId: "t3",
          itemId: "a3",
          streamKind: "assistant_text" as const,
          delta: "One more thing.",
        }),
      ],
      cursor: "17",
    };

    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), again);
    });
    await settle();
    const paragraph = (await screen.findByText("One more thing.")).closest("p");

    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), again);
    });
    // React Query notifies its observers on a macrotask, which `settle`'s
    // microtask turns never reach - so a re-render this delta did cause would
    // still be pending, and the assertion below would pass by being early.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(paragraph?.textContent).toBe("One more thing.");
    expect(reading()).not.toContain("One more thing.One more thing.");
  });
});

describe("Thread: live subscriptions", () => {
  it("subscribes to exactly the session's stream and tap topics while mounted, and ends them on unmount", async () => {
    const { live, router } = await open(session({ status: "idle" }), twoCompletedTurns());

    // Judged among this thread's own per-session topics: the shell mounts
    // its own subscriptions (the sidebar's `session` invalidation topic
    // among them) regardless of which screen is open, so the assertion
    // narrows to what starts with `session:` rather than the whole set.
    const perSessionTopics = () => live.topics().filter((topic) => topic.startsWith("session:"));

    await waitFor(() => {
      expect([...perSessionTopics()].sort()).toEqual(
        [sessionStreamTopic(SESSION_ID), sessionTapTopic(SESSION_ID)].sort(),
      );
    });

    await act(async () => {
      await router.navigate({ to: "/" });
    });

    await waitFor(() => {
      expect(perSessionTopics()).toEqual([]);
    });
  });

  it("does not carry the previous thread's cursor into a newly opened thread's :stream subscription", async () => {
    // The router does not remount this screen for a route-param-only
    // navigation, so per-thread state - the seeded cursor included - has to
    // be reset by hand rather than surviving as leftover component state.
    const OTHER_ID = "01a06d02-b100-7000-8000-000000000002";
    const other = session({ id: OTHER_ID, status: "idle", title: "A second thread" });
    const { live, router } = await open(session({ status: "idle" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${OTHER_ID}`]: { body: other },
      [`GET /api/v1/sessions/${OTHER_ID}/transcript`]: { body: { items: [] } },
    });

    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });
    // This thread has rows on record, so its own cursor is not the head.
    expect(live.cursorOf(sessionStreamTopic(SESSION_ID))).toBeDefined();

    await act(async () => {
      await router.navigate({ to: "/threads/$sessionId", params: { sessionId: OTHER_ID } });
    });

    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(OTHER_ID));
    });
    // The second thread's transcript is empty, so a correctly-scoped seed has
    // nothing to start from; a leaked cursor from the thread just left is the
    // only way this could read as anything else.
    expect(live.cursorOf(sessionStreamTopic(OTHER_ID))).toBeUndefined();
  });
});

describe("Thread: auto-scroll follows new content", () => {
  /**
   * jsdom computes no layout, so the geometry `useStickToBottom` reads is set
   * by hand on the document's own scrolling element - the thread has no
   * scroll region of its own, the whole page does.
   */
  const scrollElement = (): Element => document.scrollingElement ?? document.documentElement;

  const setGeometry = (values: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }): void => {
    const el = scrollElement();
    Object.defineProperty(el, "scrollTop", {
      value: values.scrollTop,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(el, "scrollHeight", { value: values.scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: values.clientHeight, configurable: true });
  };

  afterEach(() => {
    const el = scrollElement();
    delete (el as { scrollTop?: number }).scrollTop;
    delete (el as { scrollHeight?: number }).scrollHeight;
    delete (el as { clientHeight?: number }).clientHeight;
  });

  const newRow = (): TranscriptRow =>
    row(16, {
      _tag: "turn.started",
      eventId: "e16",
      sessionId: SESSION_ID,
      at: "2026-09-08T10:02:00.000Z",
      turnId: "t3",
    });

  it("rejoins the tail on a :stream delta when the reader was at the bottom", async () => {
    const { live } = await open(session({ status: "idle" }), twoCompletedTurns());
    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });

    setGeometry({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
    fireEvent.scroll(window);
    await settle();

    // A real browser's scrollHeight would already reflect the new row by the
    // time the layout effect after this delta's commit runs.
    setGeometry({ scrollTop: 900, scrollHeight: 1200, clientHeight: 100 });
    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), { _tag: "delta", items: [newRow()], cursor: "16" });
    });

    await waitFor(() => {
      expect(scrollElement().scrollTop).toBe(1200 - 100);
    });
  });

  it("leaves the scroll position on a :stream delta when the reader had scrolled up", async () => {
    const { live } = await open(session({ status: "idle" }), twoCompletedTurns());
    await waitFor(() => {
      expect(live.topics()).toContain(sessionStreamTopic(SESSION_ID));
    });

    setGeometry({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    fireEvent.scroll(window);
    await settle();

    setGeometry({ scrollTop: 0, scrollHeight: 1200, clientHeight: 100 });
    act(() => {
      live.push(sessionStreamTopic(SESSION_ID), { _tag: "delta", items: [newRow()], cursor: "16" });
    });
    await settle();

    expect(scrollElement().scrollTop).toBe(0);
  });
});

/**
 * The thread's chrome is the screen's own first row, and the shell's top bar
 * steps aside on this route. These tests replace the "Thread: top bar" pair
 * that asserted the old shell title and its `thread · <short id>` crumb.
 *
 * How the row is read here:
 * - the crumb `Threads /` and the title are separate text-bearing elements in
 *   one row, so the row is the crumb's parent element;
 * - the overflow button's accessible name is the glyph `…`, spec 14's own
 *   wording. It carries no `aria-label`; add one only by changing this test.
 */
describe("Thread: the chrome is the screen's first row", () => {
  it("reads Threads / then the session title, with a disabled … button", async () => {
    await open(session({ status: "idle", title: "Fix the login bug" }), twoCompletedTurns());

    const crumb = await waitFor(() => screen.getByText("Threads /"));
    const chrome = crumb.parentElement;
    expect(reading(chrome)).toMatch(/^Threads \/ Fix the login bug/);

    const overflow = screen.getByRole<HTMLButtonElement>("button", { name: "…" });
    expect(chrome?.contains(overflow)).toBe(true);
    expect(overflow.disabled).toBe(true);
  });

  it("truncates a long title rather than pushing the crumb or the actions out of place", async () => {
    const longTitle =
      "Fix the login bug for real this time and also the logout bug and the signup bug";
    await open(session({ status: "idle", title: longTitle }), twoCompletedTurns());

    const crumb = await waitFor(() => screen.getByText("Threads /"));
    expect(screen.getByText(longTitle).className).toContain("truncate");
    // The crumb and the actions still render in full - only the title gave way.
    expect(crumb.className).toContain("shrink-0");
  });

  it("still warns about a zone this browser cannot read, the one thing the bar owes the screen", async () => {
    await open(session({ status: "idle" }), twoCompletedTurns(), {
      "GET /api/v1/settings": {
        body: {
          controller: {},
          user: { "onboarding.completedSteps": ["timezone"], timezone: "Mars/Olympus" },
        },
      },
    });

    // The chrome titles the screen, but nothing else renders the warning - a
    // thread reading its stamps in the wrong zone would say nothing at all.
    expect(await screen.findByText(/does not know the zone Mars\/Olympus/)).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("renders no shell title above it: no h1 and no thread · crumb anywhere", async () => {
    await open(session({ status: "idle", title: "Fix the login bug" }), twoCompletedTurns());

    await waitFor(() => {
      expect(screen.getByText("Threads /")).toBeDefined();
    });
    expect(reading()).not.toContain("thread · ");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

/**
 * AC-19 to AC-21 (the "Web: composer" table's in-thread half): the composer at
 * the foot of a started thread, driven only through `renderApp` and the
 * stubbed `fetch`/`LiveStub`.
 *
 * Decisions made where the SPEC does not pin an exact rendering detail, the
 * same as `new.integration.test.tsx`: a lone icon's disabled reason surfaces
 * via `title`, and the send/Steer/Cancel/Stop controls' accessible names
 * contain their literal AC wording ("send", "Steer", "Cancel", "Stop").
 */
describe("Thread: composer read-only fields and model switch (AC-19)", () => {
  it("renders workspace, machine and access mode as read-only values with no menu", async () => {
    const user = userEvent.setup();
    await open(session({ status: "idle" }), twoCompletedTurns());

    expect(reading()).toContain("No workspace");
    expect(reading()).toContain(RUNNER_STARTED.name);
    expect(reading()).toContain("approval-required");

    // None of these values ever reveals another option when interacted with -
    // the "no menu" half of the criterion. A read-only value need not be a
    // `<button>` to prove there is nothing behind it to open, so this checks
    // for the other option's absence after the click rather than for the
    // presence or absence of a particular element type.
    await user.click(screen.getByText(RUNNER_STARTED.name));
    expect(screen.queryByText(RUNNER_OTHER.name)).toBeNull();

    await user.click(screen.getByText("No workspace"));
    expect(screen.queryByText("Adopt a folder on this machine…")).toBeNull();

    await user.click(screen.getByText("approval-required"));
    expect(screen.queryByText("full-access")).toBeNull();
  });

  it("dims the model menu's other accounts with account fixed", async () => {
    const user = userEvent.setup();
    await open(session({ status: "idle" }), twoCompletedTurns());

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));

    expect(reading()).toContain("account fixed");
    // The current instance's own other model stays selectable, unlike the
    // other instance's group.
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
  });

  // Rewritten for P001 AD-4/AC-6: picking a model no longer patches the
  // session; the pick is draft state that rides the next submission.
  it("shows the picked model in the pill without sending anything when a model of the same instance is chosen", async () => {
    const user = userEvent.setup();
    const { api } = await open(session({ status: "idle" }), twoCompletedTurns());

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await user.click(screen.getByRole("button", { name: /claude opus 5/i }));

    expect(
      api.calls.some(
        (call) => call.method === "PATCH" && call.path === `/api/v1/sessions/${SESSION_ID}`,
      ),
    ).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    });
  });
});

const INPUT_ID = "01a06d02-5000-7000-8000-000000000001";

/** One queued input, ready for a busy thread's queued list. */
const queuedInput = (overrides: Partial<Input> = {}): Input => ({
  id: INPUT_ID,
  sessionId: SESSION_ID,
  source: "user",
  actor: "user",
  text: "Also check the logs",
  status: "queued",
  delivery: null,
  createdAt: "2026-09-08T10:02:00.000Z",
  deliveredAt: null,
  sentAt: null,
  reason: null,
  ...overrides,
});

describe("Thread: input queue (AC-20)", () => {
  it("sends POST /sessions/:id/input and clears the textarea once it answers opened, for an idle thread", async () => {
    const user = userEvent.setup();
    const { api } = await open(session({ status: "idle" }), twoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "opened" },
      },
    });

    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const call = await waitFor(() => {
      const found = api.calls.find(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (found === undefined) throw new Error("input not sent yet");
      return found;
    });
    // An input carries the picks made since the last submission and nothing
    // else, so an untouched composer sends the text alone and the session
    // keeps what it runs with.
    expect(call.body).toEqual({ text: "Also check the logs" });

    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    });
  });

  it("shows a queued answer in a list above the composer with Steer and Cancel, read from GET /sessions/:id/inputs", async () => {
    const user = userEvent.setup();
    const { api } = await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "queued" },
      },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [queuedInput()] } },
    });

    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await screen.findByText("Also check the logs");
    expect(screen.getByRole("button", { name: /steer/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    expect(
      api.calls.some(
        (call) => call.method === "GET" && call.path === `/api/v1/sessions/${SESSION_ID}/inputs`,
      ),
    ).toBe(true);
  });

  it("calls steer and the row leaves the list once it answers steered", async () => {
    const user = userEvent.setup();
    // Keyed on whether steer has actually landed, not on a raw call count: the
    // live connection's own first-connect sweep (`live.ts`'s `session` -
    // "every mutable reader ... swept ... on the first connection of a page
    // load") refetches this list once on its own, ahead of the steer click, so
    // a plain "second call empties it" counter would race that sweep instead
    // of the steer this test is actually about.
    let delivered = false;
    const { api } = await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => ({
        body: { items: delivered ? [] : [queuedInput()] },
      }),
      [`POST /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}/steer`]: () => {
        delivered = true;
        return { body: { inputId: INPUT_ID, result: "steered" } };
      },
    });

    await screen.findByText("Also check the logs");
    await user.click(screen.getByRole("button", { name: /steer/i }));

    await waitFor(() => {
      expect(
        api.calls.some(
          (call) =>
            call.method === "POST" &&
            call.path === `/api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}/steer`,
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("Also check the logs")).toBeNull();
    });
  });

  it("calls cancel (DELETE) and the row leaves the list", async () => {
    const user = userEvent.setup();
    // See the steer test above: keyed on the cancel actually landing, not a
    // raw call count, for the same reason.
    let delivered = false;
    const { api } = await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => ({
        body: { items: delivered ? [] : [queuedInput()] },
      }),
      [`DELETE /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}`]: () => {
        delivered = true;
        return { body: queuedInput({ status: "cancelled" }) };
      },
    });

    await screen.findByText("Also check the logs");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(
        api.calls.some(
          (call) =>
            call.method === "DELETE" &&
            call.path === `/api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}`,
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("Also check the logs")).toBeNull();
    });
  });

  it("shows a queued row's reason when the controller set one", async () => {
    await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: {
        body: { items: [queuedInput({ reason: "the runner has not answered yet" })] },
      },
    });

    await screen.findByText("the runner has not answered yet");
  });

  it("refetches the queued list on the session invalidation nudge", async () => {
    let inputsCalls = 0;
    const { live } = await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => {
        inputsCalls += 1;
        return { body: { items: [queuedInput()] } };
      },
    });

    await screen.findByText("Also check the logs");
    const before = inputsCalls;

    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(inputsCalls).toBeGreaterThan(before);
    });
  });

  it("shows the message and keeps the row when a steer attempt answers invalid_state", async () => {
    const user = userEvent.setup();
    await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [queuedInput()] } },
      [`POST /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}/steer`]: {
        status: 409,
        body: envelope("invalid_state", "the turn already finished"),
      },
    });

    await screen.findByText("Also check the logs");
    await user.click(screen.getByRole("button", { name: /steer/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("the turn already finished");
    expect(screen.getByText("Also check the logs")).toBeDefined();
  });
});

describe("Thread: stop control (AC-21)", () => {
  it("shows Stop on a busy thread and calls POST /sessions/:id/interrupt", async () => {
    const user = userEvent.setup();
    const { api } = await open(session({ status: "busy" }), twoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/interrupt`]: { body: session({ status: "idle" }) },
    });

    await user.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() => {
      expect(
        api.calls.some(
          (call) =>
            call.method === "POST" && call.path === `/api/v1/sessions/${SESSION_ID}/interrupt`,
        ),
      ).toBe(true);
    });
  });

  it("has no Stop control on an idle thread", async () => {
    await open(session({ status: "idle" }), twoCompletedTurns());
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });

  it("has no Stop control on an exited thread", async () => {
    await open(
      session({ status: "exited", exitedAt: "2026-09-08T10:05:00.000Z" }),
      twoCompletedTurns(),
    );

    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });
});

/**
 * P001 AC-6 and AC-7: the model options block on a started thread. The picks
 * are draft state that never leaves the browser until a submission, and the
 * pill reads the stored row once the server has it.
 *
 * These tests answer `GET /api/v1/providers` with `INSTANCE_OPTIONS`, the one
 * fixture whose models carry an `effort` descriptor.
 */
describe("Thread: model options ride the submission (AC-6, AC-7)", () => {
  const providers = { body: [INSTANCE_OPTIONS, INSTANCE_OTHER] };

  it("sends nothing when an option is picked, and carries the pick on the next input", async () => {
    const user = userEvent.setup();
    const { api } = await open(session({ status: "idle" }), twoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "opened" },
      },
    });

    await user.click(screen.getByRole("button", { name: "medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));

    // The pick itself is not a write: neither the input route nor the update
    // route is called before the user sends.
    expect(
      api.calls.some(
        (call) => call.method !== "GET" && call.path.startsWith(`/api/v1/sessions/${SESSION_ID}`),
      ),
    ).toBe(false);

    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const call = await waitFor(() => {
      const found = api.calls.find(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (found === undefined) throw new Error("input not sent yet");
      return found;
    });
    expect(call.body).toEqual({
      text: "Also check the logs",
      options: { effort: "high" },
    });
  });

  it("resets the picks when a model is picked, and never patches the session", async () => {
    const user = userEvent.setup();
    const { api } = await open(session({ status: "idle" }), twoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "opened" },
      },
    });

    await user.click(screen.getByRole("button", { name: "medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);

    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const call = await waitFor(() => {
      const found = api.calls.find(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (found === undefined) throw new Error("input not sent yet");
      return found;
    });
    // The options went with the model that offered them.
    expect(call.body).toEqual({ text: "Also check the logs", model: "claude-opus-5" });
    expect(
      api.calls.some(
        (call) => call.method === "PATCH" && call.path === `/api/v1/sessions/${SESSION_ID}`,
      ),
    ).toBe(false);
  });

  it("shows the newly picked model's own defaults rather than the stored model's options", async () => {
    const user = userEvent.setup();
    await open(
      session({
        status: "idle",
        modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
      }),
      twoCompletedTurns(),
      { "GET /api/v1/providers": providers },
    );

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);
    await user.click(await screen.findByRole("button", { name: "medium" }));

    // The stored `high` was stored for the other model, and the server drops
    // it on a model change - so the block reads the descriptor's default.
    const medium = await screen.findByRole<HTMLButtonElement>("radio", { name: "Medium" });
    expect(medium.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
  });

  it("clears the picks once the input is accepted and reads the stored options back", async () => {
    const user = userEvent.setup();
    // The controller stores the pick, so the session read after the input
    // answers with it - which is where the pill's own label comes from once
    // the draft pick is gone.
    let stored: Record<string, string> = {};
    const { api } = await open(session({ status: "idle" }), twoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({
        body: session({
          status: "idle",
          modelSelection: { model: "claude-sonnet-5", options: stored },
        }),
      }),
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: (call) => {
        stored = { ...stored, ...(call.body as { options: Record<string, string> }).options };
        return { body: { inputId: INPUT_ID, result: "opened" } };
      },
    });

    await user.click(screen.getByRole("button", { name: "medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    // The selector still reads high after the picks are cleared, which it can
    // only do by having re-read the session the input just changed.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "high" })).toBeDefined();
    });

    // And the cleared picks show in the next submission, which carries none.
    await user.type(screen.getByRole("textbox"), "And the metrics");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const second = await waitFor(() => {
      const found = api.calls.filter(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (found.length < 2) throw new Error("second input not sent yet");
      return found[1];
    });
    expect(second?.body).toEqual({ text: "And the metrics" });
  });

  it("holds the picks until the re-read lands, so a send right after one reads the fresh row", async () => {
    const user = userEvent.setup();
    // The session read that follows the input is held open, which is the
    // window a second send would otherwise fall into.
    let stored: { model: string; options: Record<string, string> } = {
      model: "claude-sonnet-5",
      options: {},
    };
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;

    const { api } = await open(session({ status: "idle" }), twoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`GET /api/v1/sessions/${SESSION_ID}`]: async () => {
        if (holding) await held;
        return { body: session({ status: "idle", modelSelection: stored }) };
      },
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: (call) => {
        const body = call.body as { model: string; options: Record<string, string> };
        stored = { model: body.model, options: { ...stored.options, ...body.options } };
        holding = true;
        return { body: { inputId: INPUT_ID, result: "opened" } };
      },
    });

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);
    await user.click(await screen.findByRole("button", { name: "medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    // While the read is out the submission has not settled: the send button
    // stays disabled and the pill still reads what was picked, never the row
    // the cache still holds.
    await waitFor(() => {
      const call = api.calls.find(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (call === undefined) throw new Error("input not sent yet");
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "high" })).toBeDefined();

    await act(async () => {
      release();
      await held;
    });

    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    });
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "high" })).toBeDefined();

    // The picks are gone, and the next send reads the row the server stored
    // rather than the session the cache held while the read was out.
    holding = false;
    await user.type(screen.getByRole("textbox"), "And the metrics");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const second = await waitFor(() => {
      const found = api.calls.filter(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (found.length < 2) throw new Error("second input not sent yet");
      return found[1];
    });
    expect(second?.body).toEqual({ text: "And the metrics" });
  });

  it("shows the stored option on a fresh render: the pill's label, and the block enabled on that value (AC-7)", async () => {
    const user = userEvent.setup();
    await open(
      session({
        status: "idle",
        modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
      }),
      twoCompletedTurns(),
      { "GET /api/v1/providers": providers },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "high" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "high" }));

    const high = await screen.findByRole<HTMLButtonElement>("radio", { name: "High" });
    expect(high.getAttribute("aria-checked")).toBe("true");
    expect(high.disabled).toBe(false);

    // The stored value wins over the descriptor's own default.
    const medium = screen.getByRole<HTMLButtonElement>("radio", { name: "Medium" });
    expect(medium.getAttribute("aria-checked")).toBe("false");
    expect(medium.disabled).toBe(false);
  });
});

describe("Thread: an exited thread that can be resumed", () => {
  const EXITED_RESUMABLE = session({
    status: "exited",
    resumable: true,
    nativeSessionId: "native-1",
    exitedAt: "2026-09-08T10:05:00.000Z",
  });

  it("reads like an idle thread: textarea and model pill enabled, no Stop and nothing saying exited", async () => {
    await open(EXITED_RESUMABLE, twoCompletedTurns());

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(textarea.disabled).toBe(false);
    expect(textarea.placeholder).toBe("Reply…");

    const pill = screen.getByRole<HTMLButtonElement>("button", { name: /claude sonnet 5/i });
    expect(pill.disabled).toBe(false);

    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
    expect(reading()).not.toMatch(/exited/i);
  });

  it("sends the typed text to POST /sessions/:id/input and shows the queued row above the composer", async () => {
    const user = userEvent.setup();
    const { api } = await open(EXITED_RESUMABLE, twoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "queued" },
      },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [queuedInput()] } },
    });

    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const call = await waitFor(() => {
      const found = api.calls.find(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (found === undefined) throw new Error("input not sent yet");
      return found;
    });
    expect(call.body).toEqual({ text: "Also check the logs" });

    const queued = await screen.findByText("Also check the logs");
    expect(screen.getByRole("button", { name: /steer/i })).toBeDefined();
    // The list sits above the composer, in reading order.
    expect(
      queued.compareDocumentPosition(screen.getByRole("textbox")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });
});

describe("Thread: an exited thread that cannot be resumed", () => {
  it.each<[string, string | null]>([
    ["its transcript is gone", null],
    ["its runner was retired", "native-1"],
  ])("is read-only and says %s", async (reason, nativeSessionId) => {
    await open(
      session({
        status: "exited",
        resumable: false,
        nativeSessionId,
        exitedAt: "2026-09-08T10:05:00.000Z",
      }),
      twoCompletedTurns(),
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe(`This thread can't be resumed: ${reason}.`);

    const pill = screen.getByRole<HTMLButtonElement>("button", { name: /claude sonnet 5/i });
    expect(pill.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);
  });
});

/**
 * The composer on an active thread: the note a model pick stands under until
 * it is sent, and the fields that locked when the thread started.
 *
 * How the surface is read here: the model pill is the button whose accessible
 * name holds the model's *display* name ("Claude Sonnet 5"); a locked field is
 * whatever element carries the `title`, and "no button" is read as that
 * element not being one.
 */
describe("Composer: a model pick is pending until it is sent", () => {
  it("says the change applies on send, names it on the pill, and drops the note once the session carries it", async () => {
    const user = userEvent.setup();
    // The controller stores what the input carried, so the session read after
    // it answers with the new model - which is what retires the note.
    let stored = { model: "claude-sonnet-5", options: {} as Record<string, string> };
    await open(session({ status: "idle" }), twoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({
        body: session({ status: "idle", modelSelection: stored }),
      }),
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: (call) => {
        stored = { model: (call.body as { model: string }).model, options: {} };
        return { body: { inputId: INPUT_ID, result: "opened" } };
      },
    });

    expect(reading()).not.toContain("model change applies on send");

    await user.click(await screen.findByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);

    // Unsent, so the card says so, and the pill already names what will go.
    await waitFor(() => {
      expect(reading()).toContain("model change applies on send");
    });
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();

    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    // Once the session itself carries the model there is nothing pending to
    // warn about.
    await waitFor(() => {
      expect(reading()).not.toContain("model change applies on send");
    });
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
  });
});

describe("Composer: what locked at start says why", () => {
  it("renders the access mode, the workspace and the machine as plain text with the reason as their tooltip", async () => {
    await open(session({ status: "idle" }), twoCompletedTurns());

    for (const field of ["access mode", "workspace", "machine"]) {
      const locked = await screen.findByTitle(`Create a new thread to change the ${field}`);
      expect(locked.tagName).not.toBe("BUTTON");
      expect(locked.closest("button")).toBeNull();
    }

    // And none of the three is a trigger under another name.
    expect(screen.queryByRole("button", { name: /approval-required/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /no workspace/i })).toBeNull();
    expect(screen.queryByRole("button", { name: RUNNER_STARTED.name })).toBeNull();
  });
});
