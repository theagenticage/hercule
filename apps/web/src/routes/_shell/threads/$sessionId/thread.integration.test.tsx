/**
 * Tests the thread screen against a stubbed controller.
 *
 * These tests cover the transcript's rendering, the live turn's divider, the
 * token tap and the header's breadcrumb. They drive the app only through
 * `renderApp` and the `LiveStub`, and never import the screen's own modules.
 *
 * The fixtures use the event shapes from
 * `packages/client-core/src/threads/turns.test.ts`:
 * - A `user_message` item has `detail: { text }` on both `item.started` and
 *   `item.completed`.
 * - Assistant text arrives only on `content.delta`, never on the
 *   `assistant_message` item events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultScheduler, focusManager, notifyManager } from "@tanstack/react-query";
import { buildApprovalCard, formatDuration, formatStamp, queryKeys } from "@hercule/client-core";
import type {
  Assistant,
  Input,
  ModelOption,
  Profile,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  SessionRequest,
  TranscriptRow,
  Workspace,
} from "@hercule/contract";
import {
  APPROVAL_ANSWER_LABELS,
  buildSessionStreamTopic,
  buildSessionTapTopic,
  buildSubagentStreamTopic,
  buildSubagentTapTopic,
} from "@hercule/contract";
import {
  buildErrorBody,
  fakeMainScrollGeometry,
  pickRow,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type FakeScrollGeometry,
  type Handler,
  type LiveStub,
} from "../../../../app/testing";
import {
  SESSION,
  SESSION_ID,
  ZONE,
  buildController,
  buildSession,
  buildSubagent,
} from "./-fixtures";

/**
 * Fixtures for the composer tests:
 * - A provider instance, a runner and a profile with `SESSION`'s ids,
 *   which the started thread's read-only fields and model menu read.
 * - A second instance, runner and profile, which exist only to prove that
 *   they never show up in a started thread's read-only fields or its
 *   other-instance groups.
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

const buildInstanceSnapshot = (
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
  id: SESSION.instanceId,
  providerId: "claude-code",
  secretFields: [],
  name: "personal",
  config: {},
  displayName: "Claude Code",
  binaryName: "claude",
  declared: DECLARED,
  snapshots: [
    buildInstanceSnapshot(SESSION.runnerId, "rogier@example.com", "Claude Max", [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [],
      },
      { slug: "claude-opus-5", name: "Claude Opus 5", imageInput: { maxBytes: null }, options: [] },
    ]),
  ],
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

/**
 * The same descriptor `new.integration.test.tsx` uses, for the model option
 * tests. Only `INSTANCE_OPTIONS` offers it, not
 * `INSTANCE_STARTED`, so the tests that are not about options see a pill with
 * no options selector.
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
    buildInstanceSnapshot(SESSION.runnerId, "rogier@example.com", "Claude Max", [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [EFFORT],
      },
      {
        slug: "claude-opus-5",
        name: "Claude Opus 5",
        imageInput: { maxBytes: null },
        options: [EFFORT],
      },
    ]),
  ],
};

const INSTANCE_OTHER: ProviderInstance = {
  ...INSTANCE_STARTED,
  id: "01a06d02-1000-7000-8000-000000000099",
  name: "work",
  snapshots: [
    buildInstanceSnapshot(SESSION.runnerId, "work@example.com", "Claude Pro", [
      {
        slug: "claude-haiku-5",
        name: "Claude Haiku 5",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [],
      },
    ]),
  ],
};

const RUNNER_STARTED: Runner = {
  id: SESSION.runnerId,
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
  id: SESSION.permissionProfileId,
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

/**
 * Builds the stubbed controller routes for the app and for the thread of
 * `fixture`, with no subagents, the transcript `rows`, and the composer's
 * instances, runners and profiles. `extra` is added over them.
 */
const buildThreadRoutes = (
  fixture: Session,
  rows: readonly TranscriptRow[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> =>
  buildController(
    { session: fixture, subagents: [] },
    {
      [`GET /api/v1/sessions/${fixture.id}/transcript`]: { body: { items: rows } },
      "GET /api/v1/providers": { body: [INSTANCE_STARTED, INSTANCE_OTHER] },
      "GET /api/v1/runners": { body: { items: [RUNNER_STARTED, RUNNER_OTHER] } },
      "GET /api/v1/profiles": { body: { items: [PROFILE_STARTED, PROFILE_OTHER] } },
      ...extra,
    },
  );

const openApp = async (
  fixture: Session,
  rows: readonly TranscriptRow[],
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const api = stubApi(buildThreadRoutes(fixture, rows, extra));
  const app = await renderApp({ path: `/threads/${fixture.id}`, api: api.fetch, token: "held" });
  return { ...app, api };
};

/**
 * Runs pending microtasks inside `act`, so the effects of a socket push are
 * visible.
 *
 * `StubSocket.push` delivers with `queueMicrotask` (see `deliver` in
 * `socket-stub.ts`), and the RPC stream decodes and dispatches a few fiber
 * yields after that. A push therefore needs a few microtask turns before its
 * effect (a re-render, a `requestAnimationFrame` request) can be seen.
 * Testing Library's `findBy*` and `waitFor` poll on a real timer, which never
 * fires while the fake clock is frozen, so those tests call this instead.
 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

/** Builds a `TranscriptRow` at `position`, with `at` copied from the event. */
const buildTranscriptRow = (position: number, event: TranscriptRow["event"]): TranscriptRow => ({
  position,
  at: event.at,
  event,
});

/**
 * Returns the element that holds one turn's whole answer: the prose blocks
 * and, while the agent is typing, the live tail next to them. `inside` can be
 * a block or the tail, because they are siblings in that element. Fails the
 * test when `inside` is neither a paragraph nor the live tail.
 */
const findAnswerArea = (inside: HTMLElement): HTMLElement => {
  const paragraph = inside.tagName === "SPAN" ? inside : inside.closest("p");
  expect(paragraph, "the answer is neither a paragraph nor the live tail").not.toBeNull();
  return paragraph!.parentElement as HTMLElement;
};

/**
 * Returns the 800px reading column that contains `inside`, and fails the test
 * when there is none. The markdown tests use it to check only the thread's
 * prose, not the header or the composer.
 */
const findProseColumn = (inside: HTMLElement): HTMLElement => {
  const column = inside.closest('[class*="max-w-[800px]"]');
  expect(column, "no 800px column ancestor found").not.toBeNull();
  return column as HTMLElement;
};

/** One event of a turn, before `buildTranscript` gives it a position in the log. */
type TurnEvent = TranscriptRow["event"];

/**
 * Builds a transcript from the given events, numbered in order. Each event
 * gets an id that matches its position. The screens under test never read
 * the event id: `mergeTranscript` sorts and de-duplicates by position.
 */
const buildTranscript = (...parts: ReadonlyArray<readonly TurnEvent[]>): TranscriptRow[] =>
  parts.flat().map((event, index) => buildTranscriptRow(index, { ...event, eventId: `e${index}` }));

/** Builds the event that starts a turn. */
const buildTurnStart = (turnId: string, at: string): TurnEvent[] => [
  { _tag: "turn.started", eventId: "", sessionId: SESSION_ID, at, turnId },
];

/** Builds the event that completes a turn. The screen needs it to show the turn's duration. */
const buildTurnCompletion = (
  turnId: string,
  at: string,
  state: "completed" | "failed" | "interrupted" = "completed",
): TurnEvent[] => [
  { _tag: "turn.completed", eventId: "", sessionId: SESSION_ID, at, turnId, state },
];

/**
 * Builds the user's message the way a transcript records one: started and
 * completed at the same time, with the text on both events. `detail` adds
 * fields to both events' detail, such as `steered` or `senderSessionId`.
 */
const buildUserMessage = (
  turnId: string,
  at: string,
  itemId: string,
  text: string,
  detail: Readonly<Record<string, unknown>> = {},
): TurnEvent[] => [
  {
    _tag: "item.started",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    kind: "user_message",
    detail: { text, ...detail },
  },
  {
    _tag: "item.completed",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    kind: "user_message",
    status: "completed",
    detail: { text, ...detail },
  },
];

/** Builds the text of an assistant message. Assistant text arrives only in this event. */
const buildAssistantTextDelta = (
  turnId: string,
  at: string,
  itemId: string,
  text: string,
): TurnEvent[] => [
  {
    _tag: "content.delta",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    streamKind: "assistant_text",
    delta: text,
  },
];

/** Builds an assistant message's start event. While the item is open, it is the last row. */
const buildAssistantStart = (turnId: string, at: string, itemId: string): TurnEvent[] => [
  {
    _tag: "item.started",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    kind: "assistant_message",
  },
];

/** Builds an assistant message's completion event. */
const buildAssistantCompletion = (turnId: string, at: string, itemId: string): TurnEvent[] => [
  {
    _tag: "item.completed",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    kind: "assistant_message",
    status: "completed",
  },
];

/** Builds a whole assistant message: its text, then its start and completion events. */
const buildAssistantMessage = (
  turnId: string,
  at: string,
  itemId: string,
  text: string,
): TurnEvent[] => [
  ...buildAssistantTextDelta(turnId, at, itemId, text),
  ...buildAssistantStart(turnId, at, itemId),
  ...buildAssistantCompletion(turnId, at, itemId),
];

/**
 * Builds a command item's start event. Its completion is a separate event,
 * which is missing while the command runs.
 */
const buildCommandStart = (
  turnId: string,
  at: string,
  itemId: string,
  detail: { readonly name: string; readonly input: { readonly command: string } },
): TurnEvent[] => [
  {
    _tag: "item.started",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    kind: "command_execution",
    detail,
  },
];

/** Builds a command item's completion event. */
const buildCommandCompletion = (
  turnId: string,
  at: string,
  itemId: string,
  detail: { readonly name: string; readonly input: { readonly command: string } },
): TurnEvent[] => [
  {
    _tag: "item.completed",
    eventId: "",
    sessionId: SESSION_ID,
    at,
    turnId,
    itemId,
    kind: "command_execution",
    status: "completed",
    detail,
  },
];

const USER_TEXT = "Show me some markdown";

/** Builds one completed turn: `userText` as the user's message, then `text` as the whole answer. */
const buildAnsweredTurn = (text: string, userText: string = USER_TEXT): TranscriptRow[] =>
  buildTranscript(
    buildTurnStart("t5", "2026-09-08T13:00:00.000Z"),
    buildUserMessage("t5", "2026-09-08T13:00:00.100Z", "u5", userText),
    buildAssistantMessage("t5", "2026-09-08T13:00:01.000Z", "a5", text),
    buildTurnCompletion("t5", "2026-09-08T13:00:02.000Z"),
  );

/** Opens a thread whose only turn has `text` as its answer, and returns the prose column. */
const openAnsweredThread = async (text: string): Promise<HTMLElement> => {
  await openApp(buildSession({ status: "idle" }), buildAnsweredTurn(text));
  return findProseColumn(await screen.findByText(USER_TEXT));
};

const TOOL_DETAIL = { name: "Bash", input: { command: "ls -la" } };
/** How `summarize` shows `TOOL_DETAIL`: the command, not the row's raw JSON. */
const TOOL_TARGET = "ls -la";

/**
 * Builds two completed turns. The first starts with a tool call, so it has a
 * divider to collapse and expand. The second has no tool items, so it has no
 * divider.
 */
const buildTwoCompletedTurns = (): TranscriptRow[] =>
  buildTranscript(
    buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
    buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
    // The tool starts before the answer's text and finishes between that text
    // and the assistant item's events, the way a real turn mixes them.
    buildCommandStart("t1", "2026-09-08T10:00:01.000Z", "tool1", TOOL_DETAIL),
    buildAssistantTextDelta("t1", "2026-09-08T10:00:02.000Z", "a1", "I'll look at the file."),
    buildCommandCompletion("t1", "2026-09-08T10:00:03.000Z", "tool1", TOOL_DETAIL),
    buildAssistantStart("t1", "2026-09-08T10:00:03.500Z", "a1"),
    buildAssistantCompletion("t1", "2026-09-08T10:00:03.600Z", "a1"),
    buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z"),
    buildTurnStart("t2", "2026-09-08T10:01:00.000Z"),
    buildUserMessage("t2", "2026-09-08T10:01:00.100Z", "u2", "What about the tests?"),
    buildAssistantMessage("t2", "2026-09-08T10:01:01.000Z", "a2", "Added a test too."),
    buildTurnCompletion("t2", "2026-09-08T10:01:03.000Z"),
  );

describe("Thread: transcript", () => {
  it("renders each completed turn with its timestamp, the user bubble, the assistant text and a Worked-for divider for the turn with a tool item", async () => {
    const user = userEvent.setup();
    await openApp(buildSession({ status: "idle", title: "Thread s1" }), buildTwoCompletedTurns());

    // The user's message and the assistant's reply, both turns.
    const userBubble = await screen.findByText("Fix the login bug");
    // The 800px column holds both turns.
    const column = findProseColumn(userBubble);
    expect(column.contains(await screen.findByText("What about the tests?"))).toBe(true);
    expect(readPageText()).toContain("I'll look at the file.");
    expect(readPageText()).toContain("What about the tests?");
    expect(readPageText()).toContain("Added a test too.");

    // Each turn has its own timestamp line in mono.
    const stamp1 = formatStamp(new Date("2026-09-08T10:00:00.000Z"), ZONE)!;
    const stamp2 = formatStamp(new Date("2026-09-08T10:01:00.000Z"), ZONE)!;
    expect(readPageText()).toContain(stamp1);
    expect(readPageText()).toContain(stamp2);

    // Turn 1 has a tool item, so it has a collapsed Worked-for divider.
    const divider = await screen.findByRole("button", { name: /worked for/i });
    expect(readPageText(divider)).toBe(`Worked for ${formatDuration(5000)}›`);
    // The tool item's line is not shown until the divider opens.
    expect(readPageText()).not.toContain(TOOL_TARGET);

    await user.click(divider);
    await waitFor(() => {
      expect(readPageText()).toContain(`command · ${TOOL_TARGET} · completed`);
    });

    // Turn 2 has no tool items at all, so it has no divider.
    expect(screen.queryAllByRole("button", { name: /worked for/i })).toHaveLength(1);
  });

  it("shows an earlier turn with no turn.completed as cut short, never as 0s or as still running", async () => {
    // Turn 1 starts a tool call and is cut off (no item.completed, no
    // turn.completed). Then turn 2 starts and finishes normally.
    const abandonedThenCompleted: TranscriptRow[] = [
      buildTranscriptRow(0, {
        _tag: "turn.started",
        eventId: "e0",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      buildTranscriptRow(1, {
        _tag: "item.started",
        eventId: "e1",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
      buildTranscriptRow(2, {
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
      buildTranscriptRow(3, {
        _tag: "turn.started",
        eventId: "e3",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.000Z",
        turnId: "t2",
      }),
      buildTranscriptRow(4, {
        _tag: "item.started",
        eventId: "e4",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.100Z",
        turnId: "t2",
        itemId: "u2",
        kind: "user_message",
        detail: { text: "Try again" },
      }),
      buildTranscriptRow(5, {
        _tag: "turn.completed",
        eventId: "e5",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:05.000Z",
        turnId: "t2",
        state: "completed",
      }),
    ];
    await openApp(buildSession({ status: "idle" }), abandonedThenCompleted);

    const divider = await screen.findByRole("button", { name: /^Cut short$/ });
    expect(readPageText(divider)).toBe("Cut short›");
    // Finished, not still running: no shimmer and no live color.
    expect(divider.className).not.toContain("hercule-thread-shimmer");
    expect(divider.className).not.toContain("text-live");
  });

  it.each([
    ["interrupted", "Stopped after"],
    ["failed", "Failed after"],
  ] as const)("shows a turn that ended %s as %s its duration", async (state, words) => {
    await openApp(
      buildSession({ status: "idle" }),
      buildTranscript(
        buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
        buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
        buildCommandStart("t1", "2026-09-08T10:00:01.000Z", "tool1", TOOL_DETAIL),
        buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z", state),
      ),
    );

    const divider = await screen.findByRole("button", { name: new RegExp(`^${words}`) });
    expect(readPageText(divider)).toBe(`${words} ${formatDuration(5000)}›`);
  });

  // An ending that is not shown is a silent ending: a turn that was stopped
  // or failed before it used a tool still says so, as plain text, because it
  // has no items to open.
  it.each([
    ["interrupted", "Stopped after"],
    ["failed", "Failed after"],
  ] as const)(
    "shows a turn with no tool items that ended %s as %s its duration",
    async (state, words) => {
      await openApp(
        buildSession({ status: "idle" }),
        buildTranscript(
          buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
          buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
          buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z", state),
        ),
      );

      const divider = await screen.findByText(`${words} ${formatDuration(5000)}`);
      expect(divider.closest("button")).toBeNull();
    },
  );

  it("shows no divider under a completed turn with no tool items", async () => {
    await openApp(
      buildSession({ status: "idle" }),
      buildTranscript(
        buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
        buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
        buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z"),
      ),
    );

    await screen.findAllByText("Fix the login bug");
    expect(screen.queryByText(/^Worked for/)).toBeNull();
  });

  it("leaves out the target of a tool item that reported none, so no separator is doubled", async () => {
    const user = userEvent.setup();
    // An item that started with no detail has an empty target.
    const startWithoutDetail: TurnEvent[] = [
      {
        _tag: "item.started",
        eventId: "",
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.000Z",
        turnId: "t1",
        itemId: "tool1",
        kind: "command_execution",
      },
    ];
    await openApp(
      buildSession({ status: "idle" }),
      buildTranscript(
        buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
        buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
        startWithoutDetail,
        buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z"),
      ),
    );

    await user.click(await screen.findByRole("button", { name: /^Worked for/ }));
    expect(readPageText()).toContain("command · running");
    expect(readPageText()).not.toContain("· ·");
  });
});

describe("Thread: the live turn", () => {
  const buildLiveTurnRows = (): TranscriptRow[] =>
    buildTranscript(
      buildTurnStart("t3", "2026-09-08T11:00:00.000Z"),
      buildUserMessage("t3", "2026-09-08T11:00:00.100Z", "u3", "Run the tests"),
      // No completion for tool3, and no turn.completed: the turn is live.
      buildCommandStart("t3", "2026-09-08T11:00:01.000Z", "tool3", {
        name: "Bash",
        input: { command: "pnpm test" },
      }),
    );

  /**
   * Advances the frozen fake clock in small steps, running microtasks after
   * each step, until `predicate` returns true. Fails after `maxSteps` steps.
   *
   * Some work, such as the live socket connecting, needs both microtasks and
   * a timer tick or two. A frozen clock never provides the timer ticks by
   * itself.
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

  it("shows Working for, counting up every second, with the shimmer class and the running item marked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z")); // 3s after turn.started

    const busy = buildSession({ status: "busy", lastActivityAt: "2026-09-08T11:00:01.000Z" });
    await openApp(busy, buildLiveTurnRows());
    await settle();

    const divider = screen.getByRole("button", { name: /^Working for 3s$/ });
    expect(divider.className).toContain("hercule-thread-shimmer");

    // The running tool item's line shows once the divider is opened (it is
    // collapsed by default). The test uses `fireEvent`, not
    // `userEvent`, because userEvent's internal delays hang on a frozen fake
    // clock.
    fireEvent.click(divider);
    await settle();
    expect(readPageText()).toContain("command · pnpm test · running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle();
    screen.getByRole("button", { name: /^Working for 4s$/ });
  });

  it("keeps the shimmer class under prefers-reduced-motion, because the stylesheet handles that case", async () => {
    // In `@hercule/ui`, `.hercule-thread-shimmer` has a
    // `@media (prefers-reduced-motion: reduce)` rule that stops the sweep and
    // keeps the live color. There is deliberately no JavaScript copy of that
    // rule, so the divider has the same class either way. jsdom cannot check
    // whether the sweep actually stops; that needs a manual check.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    const busy = buildSession({ status: "busy", lastActivityAt: "2026-09-08T11:00:01.000Z" });
    await openApp(busy, buildLiveTurnRows());
    await settle();

    const divider = screen.getByRole("button", { name: /^Working for 3s$/ });
    expect(divider.className).toContain("hercule-thread-shimmer");
  });

  it("shows an unfinished last turn as running while the session still reads idle from before the turn started", async () => {
    // The turn's rows arrive over the stream at once; the session's move to
    // busy arrives in a read after them. The turn must not flash "Cut short".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));

    const idle = buildSession({ status: "idle", lastActivityAt: "2026-09-08T10:59:00.000Z" });
    await openApp(idle, buildLiveTurnRows());
    await settle();

    screen.getByRole("button", { name: /^Working for 3s$/ });
    expect(screen.queryByRole("button", { name: /^Cut short$/ })).toBeNull();
  });

  it("shows an unfinished last turn on a session that runs no harness as finished, with no shimmer and no counting", async () => {
    // A runner that died mid-turn leaves no `turn.completed` row behind, so
    // the rows alone still look live. The session's status shows that the
    // turn is over.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));

    const exited = buildSession({
      status: "exited",
      exitedAt: "2026-09-08T11:00:02.000Z",
      lastActivityAt: "2026-09-08T11:00:01.000Z",
    });
    await openApp(exited, buildLiveTurnRows());
    await settle();

    const divider = screen.getByRole("button", { name: /^Cut short$/ });
    expect(divider.className).not.toContain("hercule-thread-shimmer");

    // Nothing counts up: a minute later the divider shows the same text.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await settle();
    screen.getByRole("button", { name: /^Cut short$/ });
    expect(screen.queryByRole("button", { name: /Working for/ })).toBeNull();
  });

  it("switches the divider to Worked for once turn.completed arrives on :stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T11:00:03.000Z"));

    const busy = buildSession({ status: "busy", lastActivityAt: "2026-09-08T11:00:01.000Z" });
    const { live } = await openApp(busy, buildLiveTurnRows());
    await settle();

    // The divider is live and counting. The exact number of seconds depends
    // on how long the subscription below takes, and the counting test above
    // already checks it. Here it only matters that the divider shows
    // "Working for" before the turn completes.
    screen.getByRole("button", { name: /^Working for \d+s$/ });

    await pumpUntil(() => live.topics().includes(buildSessionStreamTopic(SESSION_ID)));
    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          buildTranscriptRow(4, {
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
          buildTranscriptRow(5, {
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

describe("Thread: token tap", () => {
  const TAP = buildSessionTapTopic(SESSION_ID);
  const STREAM = buildSessionStreamTopic(SESSION_ID);

  // The turn t4 has started and the user's message is in, but the assistant
  // message a4 has not started yet. Most tests start it on the stream after
  // the page subscribes to the tap (`startAssistantMessage`), so its tail
  // holds every tap sent for it.
  const buildOpenTurnRows = (): TranscriptRow[] =>
    buildTranscript(
      buildTurnStart("t4", "2026-09-08T12:00:00.000Z"),
      buildUserMessage("t4", "2026-09-08T12:00:00.100Z", "u4", "Say hi"),
    );

  /** Builds the row that starts the assistant message a4 at `position`. */
  const buildAssistantStartRow = (position: number): TranscriptRow =>
    buildTranscriptRow(position, {
      _tag: "item.started",
      eventId: `e${position}`,
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:00.200Z",
      turnId: "t4",
      itemId: "a4",
      kind: "assistant_message",
    });

  /** Builds a stored `assistant_text` row for a4 at `position`. */
  const buildAssistantTextRow = (position: number, text: string): TranscriptRow =>
    buildTranscriptRow(position, {
      _tag: "content.delta",
      eventId: `e${position}`,
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:01.000Z",
      turnId: "t4",
      itemId: "a4",
      streamKind: "assistant_text",
      delta: text,
    });

  /** Builds the row that completes a4 at `position`. */
  const buildAssistantCompletionRow = (position: number): TranscriptRow =>
    buildTranscriptRow(position, {
      _tag: "item.completed",
      eventId: `e${position}`,
      sessionId: SESSION_ID,
      at: "2026-09-08T12:00:01.100Z",
      turnId: "t4",
      itemId: "a4",
      kind: "assistant_message",
      status: "completed",
    });

  /** Sends one `assistant_text` tap delta for a4. */
  const pushAssistantTap = (live: LiveStub, delta: string) => {
    act(() => {
      live.push(TAP, {
        _tag: "delta",
        items: [{ turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta }],
      });
    });
  };

  /** Delivers `rows` on the stream, with the last row's position as the cursor. */
  const pushRows = (live: LiveStub, rows: readonly TranscriptRow[]) => {
    act(() => {
      live.push(STREAM, { _tag: "delta", items: rows, cursor: String(rows.at(-1)!.position) });
    });
  };

  /**
   * Waits until the page subscribes to the tap and the stream, then sends the
   * stream's replay with no rows in it. The controller answers every stream
   * subscription with the rows written after its cursor first, even when
   * there are none, so the rows pushed after the replay are live rows.
   */
  const replayNothingOnceSubscribed = async (live: LiveStub) => {
    await waitFor(() => {
      expect(live.topics()).toEqual(expect.arrayContaining([TAP, STREAM]));
    });
    act(() => {
      live.push(STREAM, { _tag: "delta", items: [], cursor: live.readCursor(STREAM) });
    });
    await settle();
  };

  /**
   * Waits until the page subscribes to the tap and the stream, then delivers
   * the row that starts a4 at `position`, after an empty replay. a4 starts
   * while the tap is subscribed, so its tail is shown.
   */
  const startAssistantMessage = async (live: LiveStub, position = 3) => {
    await replayNothingOnceSubscribed(live);
    pushRows(live, [buildAssistantStartRow(position)]);
    await settle();
  };

  /**
   * Replaces `requestAnimationFrame` with a stub that records every request
   * and never fires by itself. Returns the stub as `raf`, and `runFrame`,
   * which runs every callback queued so far once, the way a browser runs all
   * callbacks registered since the last frame.
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
    const busy = buildSession({ status: "busy" });
    const { live } = await openApp(busy, buildOpenTurnRows());
    await startAssistantMessage(live);

    pushAssistantTap(live, "Hel");
    await settle();
    pushAssistantTap(live, "lo");
    await settle();

    // Two deltas, but only one frame request.
    expect(raf).toHaveBeenCalledTimes(1);
    // Nothing is written to the DOM before the frame runs.
    expect(screen.queryByText(/Hello/)).toBeNull();

    runFrame();

    await screen.findByText("Hello");
  });

  it("shows the taps that arrive before their item's row starts the item", async () => {
    // A tap is sent straight to the socket, and a row only after it is
    // stored, so an item's first taps can arrive before its `item.started`
    // row. They are kept and shown once the row makes the item the open one.
    const { runFrame } = stubFrames();
    const { live } = await openApp(buildSession({ status: "busy" }), buildOpenTurnRows());
    await replayNothingOnceSubscribed(live);

    pushAssistantTap(live, "Early");
    await settle();
    runFrame();
    expect(screen.queryByText("Early")).toBeNull();

    pushRows(live, [buildAssistantStartRow(3)]);

    await screen.findByText("Early");
  });

  it("renders the live tail next to the finished prose, not inside it", async () => {
    // A turn can hold any number of assistant messages (spec 06 section 6.2).
    // The saved text ends with a3, and the open item a4 is a new message. The
    // finished text is its own block and the tail is the span after it, so
    // the layout makes the break between them. No separator is added to the
    // text.
    const { runFrame } = stubFrames();
    const withEarlier = [
      ...buildOpenTurnRows(),
      buildTranscriptRow(3, {
        _tag: "content.delta",
        eventId: "e3",
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.150Z",
        turnId: "t4",
        itemId: "a3",
        streamKind: "assistant_text",
        delta: "First answer.",
      }),
      buildTranscriptRow(4, {
        _tag: "item.completed",
        eventId: "e4",
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.160Z",
        turnId: "t4",
        itemId: "a3",
        kind: "assistant_message",
        status: "completed",
      }),
    ];
    const { live } = await openApp(buildSession({ status: "busy" }), withEarlier);
    await startAssistantMessage(live, 5);
    const answer = findAnswerArea(await screen.findByText(/First answer\./));

    pushAssistantTap(live, "Second");
    await settle();
    runFrame();

    // The finished prose is the paragraph. The tail is the span next to it,
    // and holds exactly what the agent has typed so far.
    expect(answer.querySelector("p")?.textContent).toBe("First answer.");
    expect(answer.querySelector("span")?.textContent).toBe("Second");

    // A later flush for the same item keeps filling the same span.
    pushAssistantTap(live, " answer.");
    await settle();
    runFrame();

    expect(answer.querySelector("p")?.textContent).toBe("First answer.");
    expect(answer.querySelector("span")?.textContent).toBe("Second answer.");
  });

  it("never shows a reasoning or command-output tap for the open item as the assistant's answer", async () => {
    // The open item (a4) is an `assistant_message`. A `reasoning_text` or
    // `command_output` delta for it is never part of the answer, so it is
    // dropped instead of shown where the answer renders.
    const { runFrame } = stubFrames();
    const busy = buildSession({ status: "busy" });
    const { live } = await openApp(busy, buildOpenTurnRows());
    await startAssistantMessage(live);

    act(() => {
      live.push(TAP, {
        _tag: "delta",
        items: [
          { turnId: "t4", itemId: "a4", streamKind: "reasoning_text", delta: "thinking…" },
          { turnId: "t4", itemId: "a4", streamKind: "command_output", delta: "$ ls" },
          { turnId: "t4", itemId: "a4", streamKind: "assistant_text", delta: "Hi" },
        ],
      });
    });
    await settle();
    runFrame();

    // The answer's own text in the same delivery shows, so the tail is live.
    expect(findAnswerArea(await screen.findByText("Hi")).textContent).toBe("Hi");
    expect(screen.queryByText(/thinking/)).toBeNull();
    expect(screen.queryByText(/\$ ls/)).toBeNull();
  });

  it("replaces the tail with the coalesced :stream row, and ignores later taps for the completed item", async () => {
    const { runFrame } = stubFrames();
    const busy = buildSession({ status: "busy" });
    const { live } = await openApp(busy, buildOpenTurnRows());
    await startAssistantMessage(live);

    pushAssistantTap(live, "Hello ");
    await settle();
    pushAssistantTap(live, "world");
    await settle();
    runFrame();
    await screen.findByText("Hello world");

    // Coalescing flushes a row when an item completes, so the row and the
    // item's completion arrive together. The row holds the text the tail
    // held, so the text shows once, as prose. The completion ends the item as
    // the open one, so a later tap for it has no effect. Spec 04 §Streaming
    // deltas are coalesced owns the rule.
    pushRows(live, [buildAssistantTextRow(4, "Hello world"), buildAssistantCompletionRow(5)]);

    const answer = findAnswerArea(await screen.findByText("Hello world", { selector: "p" }));
    expect(answer.textContent).toBe("Hello world");

    pushAssistantTap(live, "!!!");
    await settle();
    runFrame();

    // A later tap delta for the item that the row already covers changes
    // nothing: the answer's whole text, including the tail, is unchanged.
    expect(answer.textContent).toBe("Hello world");
  });

  it("removes a coalesced :stream row's text from a still-open item's tail, and keeps showing the taps after it", async () => {
    // The store also flushes a `content.delta` row once 4KB of deltas build
    // up, while the item is still open. Taps arrive before the row that holds
    // their text, so when the row lands the tail holds the row's text and
    // some text after it. The row's text leaves the tail and shows as prose;
    // the rest stays in the tail. Any answer longer than 4KB goes through
    // this path. Spec 04 §Streaming deltas are coalesced owns the rule.
    const { runFrame } = stubFrames();
    const busy = buildSession({ status: "busy" });
    const { live } = await openApp(busy, buildOpenTurnRows());
    await startAssistantMessage(live);

    pushAssistantTap(live, "Hello world, ag");
    await settle();
    runFrame();
    await screen.findByText("Hello world, ag");

    // The flush row alone: no `item.completed`, so a4 is still the open item.
    pushRows(live, [buildAssistantTextRow(4, "Hello world")]);

    const answer = findAnswerArea(await screen.findByText("Hello world", { selector: "p" }));
    expect(answer.querySelector("span")?.textContent).toBe(", ag");

    pushAssistantTap(live, "ain");
    await settle();
    runFrame();

    // The row's text, then the taps that came after it. The text that the
    // row took over from the tail is not repeated.
    expect(answer.textContent).toBe("Hello world, again");
  });

  it("leaves the open item's tail alone when a :stream row for a different item arrives", async () => {
    // A tool item started earlier and is still running when the assistant
    // item a4 starts streaming. a4 started later, so `findOpenItem` returns
    // a4 as the open item.
    const rowsWithEarlierTool: TranscriptRow[] = [
      ...buildOpenTurnRows(),
      buildTranscriptRow(3, {
        _tag: "item.started",
        eventId: "e3",
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.150Z",
        turnId: "t4",
        itemId: "tool0",
        kind: "command_execution",
        detail: { name: "Bash", input: { command: "pnpm test" } },
      }),
    ];
    const { runFrame } = stubFrames();
    const busy = buildSession({ status: "busy" });
    const { live } = await openApp(busy, rowsWithEarlierTool);
    await startAssistantMessage(live, 4);

    pushAssistantTap(live, "Hello");
    await settle();
    runFrame();
    const answer = findAnswerArea(await screen.findByText("Hello"));

    // tool0's completion is a row for a different item, so a4 stays open.
    pushRows(live, [
      buildTranscriptRow(5, {
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
    ]);
    await settle();

    // Unchanged, because the row was not about the open item's text.
    expect(answer.textContent).toBe("Hello");
  });

  it("paints no tail for an item already open at mount, and shows its text when its rows land", async () => {
    // a4 started before the page subscribed to the tap, so the taps sent
    // before then are lost and its tail could not be lined up with its rows.
    // Its taps are ignored until it completes, and its text shows from the
    // rows alone.
    const { runFrame } = stubFrames();
    const openAtMount = [...buildOpenTurnRows(), buildAssistantStartRow(3)];
    const { live } = await openApp(buildSession({ status: "busy" }), openAtMount);
    await replayNothingOnceSubscribed(live);
    const column = findProseColumn(await screen.findByText("Say hi"));

    pushAssistantTap(live, "lo world");
    await settle();
    runFrame();
    expect(readPageText(column)).not.toContain("lo world");

    pushRows(live, [buildAssistantTextRow(4, "Hello world")]);
    const answer = findAnswerArea(await screen.findByText("Hello world", { selector: "p" }));

    pushAssistantTap(live, ", again");
    await settle();
    runFrame();
    expect(answer.textContent).toBe("Hello world");

    pushRows(live, [buildAssistantTextRow(5, ", again"), buildAssistantCompletionRow(6)]);

    await waitFor(() => {
      expect(answer.textContent).toBe("Hello world, again");
    });
  });

  it("paints no tail for an item that started in the stream's replay, and shows its text when its rows land", async () => {
    // a4 started after the transcript was read and before the page
    // subscribed, so its start row arrives in the replay and the taps sent
    // before the tap was subscribed are lost. Its taps are ignored until it
    // completes, and its text shows from the rows alone.
    const { runFrame } = stubFrames();
    const { live } = await openApp(buildSession({ status: "busy" }), buildOpenTurnRows());
    await waitFor(() => {
      expect(live.topics()).toEqual(expect.arrayContaining([TAP, STREAM]));
    });
    const column = findProseColumn(await screen.findByText("Say hi"));

    pushRows(live, [buildAssistantStartRow(3)]);
    await settle();
    pushAssistantTap(live, "lo world");
    // The cache tells React about new rows in a zero-delay timer. Waiting for
    // it lets the render that makes a4 the open item happen before the frame.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    runFrame();
    expect(readPageText(column)).not.toContain("lo world");

    pushRows(live, [buildAssistantTextRow(4, "Hello world"), buildAssistantCompletionRow(5)]);

    const answer = findAnswerArea(await screen.findByText("Hello world", { selector: "p" }));
    expect(answer.textContent).toBe("Hello world");
  });

  it("keeps a landed row's text in the tail until the render that shows the row", async () => {
    const { runFrame } = stubFrames();
    const { live, queryClient } = await openApp(
      buildSession({ status: "busy" }),
      buildOpenTurnRows(),
    );
    await startAssistantMessage(live);
    const column = findProseColumn(await screen.findByText("Say hi"));
    pushAssistantTap(live, "Hello world");
    await settle();
    runFrame();
    expect(readPageText(column)).toContain("Hello world");

    // Hold back the cache's notifications to React, so the row below is in
    // the cache but not on the screen, as it is for the moment between the
    // two. A tap's frame in that moment must not paint the tail without the
    // row's text, which would make the text vanish for a frame.
    const held: Array<() => void> = [];
    notifyManager.setScheduler((callback) => {
      held.push(callback);
    });
    try {
      pushAssistantTap(live, ", again");
      pushRows(live, [buildAssistantTextRow(4, "Hello world")]);
      await settle();
      const cached = queryClient.getQueryData<TranscriptRow[]>(queryKeys.transcript(SESSION_ID));
      expect(cached?.at(-1)?.position).toBe(4);
      runFrame();
      expect(readPageText(column)).toContain("Hello world");
    } finally {
      notifyManager.setScheduler(defaultScheduler);
    }

    act(() => {
      for (const callback of held.splice(0)) callback();
    });
    const answer = findAnswerArea(await screen.findByText("Hello world", { selector: "p" }));
    expect(answer.textContent).toBe("Hello world, again");
  });

  it("refetches the transcript and shows the refetched rows when the live overlay reports reset", async () => {
    const { runFrame } = stubFrames();
    const busy = buildSession({ status: "busy" });
    let transcriptCalls = 0;
    const REFETCHED: TranscriptRow[] = [
      ...buildOpenTurnRows(),
      buildAssistantStartRow(3),
      buildAssistantTextRow(4, "Hi there, refetched."),
    ];
    const { live } = await openApp(busy, buildOpenTurnRows(), {
      [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: () => {
        transcriptCalls += 1;
        return { body: { items: transcriptCalls === 1 ? buildOpenTurnRows() : REFETCHED } };
      },
    });
    await startAssistantMessage(live);

    // A tap delta is in the tail when the reset arrives, to prove that it is
    // dropped and does not survive into the refetched transcript.
    pushAssistantTap(live, "stale tail");
    await settle();
    runFrame();
    await screen.findByText("stale tail");

    act(() => {
      live.fail(STREAM, {
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
    expect(screen.queryByText(/stale tail/)).toBeNull();
  });

  // Markdown stays out of the streaming path. A tap delta is written into the
  // tail as plain text, with no parsing and one frame for the two deltas. The
  // prose becomes markdown only when the item's row arrives.
  it("shows a live tap as plain text in the tail, and the row as markdown when it arrives", async () => {
    const { raf, runFrame } = stubFrames();
    const { live } = await openApp(buildSession({ status: "busy" }), buildOpenTurnRows());
    await startAssistantMessage(live);
    const column = findProseColumn(await screen.findByText("Say hi"));

    pushAssistantTap(live, "**bo");
    await settle();
    pushAssistantTap(live, "ld**");
    await settle();

    expect(raf).toHaveBeenCalledTimes(1);
    runFrame();

    // The tail shows the exact characters the agent typed, unparsed.
    expect(readPageText(column)).toContain("**bold**");
    expect(column.querySelector("strong")).toBeNull();

    pushRows(live, [buildAssistantTextRow(4, "**bold**"), buildAssistantCompletionRow(5)]);

    await waitFor(() => {
      expect(within(column).getByText("bold").tagName).toBe("STRONG");
    });
    expect(readPageText(column)).not.toContain("**");
  });
});

/**
 * The assistant's prose renders as markdown. Each test opens one completed
 * turn whose whole answer is the fixture text, and checks the prose column
 * that the turn renders into.
 */
describe("Thread: the assistant's prose renders markdown", () => {
  it("renders assistant markdown", async () => {
    const answer = [
      "Here is **bold**, `inline`, a [link](https://example.com), a list:",
      "",
      "- one",
      "- two",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
    ].join("\n");
    const column = await openAnsweredThread(answer);

    expect(within(column).getByText("bold").tagName).toBe("STRONG");
    expect(within(column).getByText("inline").tagName).toBe("CODE");

    const link = within(column).getByRole("link", { name: "link" });
    expect(link.getAttribute("href")).toBe("https://example.com");

    const items = within(within(column).getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => readPageText(item))).toEqual(["one", "two"]);

    const table = within(column).getByRole("table");
    expect(within(table).getByRole("cell", { name: "2" })).toBeDefined();

    // The fenced block has the mono font and the hairline card. These classes
    // can be on the code element, its `<pre>`, or the wrapper around it.
    const code = within(column).getByText("const x = 1;");
    const pre = code.closest("pre");
    expect(pre, "the fenced block is not a <pre>").not.toBeNull();
    const shell = [code, pre, pre?.parentElement]
      .map((element) => element?.className ?? "")
      .join(" ");
    expect(shell).toMatch(/\bfont-mono\b/);
    expect(shell).toMatch(/\bborder\b/);
    expect(shell).toContain("border-line-soft");
    expect(shell).toContain("rounded-card");

    // No markdown syntax is left in the visible text.
    const prose = readPageText(column);
    expect(prose).not.toContain("**");
    expect(prose).not.toContain("`");
    expect(prose).not.toContain("|");
  });

  it("renders raw HTML in assistant text as literal text", async () => {
    const column = await openAnsweredThread(
      "before <script>alert(1)</script> and <img src=x onerror=alert(1)> after",
    );

    expect(readPageText(column)).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(column.querySelector("img")).toBeNull();
    expect(column.querySelector("[onerror]")).toBeNull();
  });

  it("keeps soft breaks in assistant prose", async () => {
    const column = await openAnsweredThread("line one\nline two");

    // A single typed newline is a CommonMark soft break, not a line break.
    // Only the user's bubble uses `remark-breaks`.
    expect(column.querySelectorAll("br")).toHaveLength(0);
    const paragraph = within(column).getByText(
      (_, element) =>
        element?.tagName === "P" && readPageText(element as HTMLElement) === "line one line two",
    );
    expect(paragraph).toBeDefined();
  });
});

/**
 * The user's bubble renders as markdown too, with `remark-breaks`. A newline
 * the user typed stays a line break, instead of collapsing into a space the
 * way a CommonMark soft break would.
 */
describe("Thread: the user's bubble renders markdown", () => {
  it("renders the user's bubble as markdown with typed line breaks", async () => {
    const typed = "Try **this** with `code`\nsecond line <b>not bold</b>\n\n- a\n- b";
    await openApp(buildSession({ status: "idle" }), buildAnsweredTurn("Sure.", typed));
    const column = findProseColumn(await screen.findByText("Sure."));

    // The bubble is still a right-aligned card: a flex row, with the card
    // styles on the element inside it.
    const rows = column.querySelectorAll('[class*="justify-end"]');
    expect(rows, "no right-aligned row for the user's bubble").toHaveLength(1);
    const flexRow = rows[0] as HTMLElement;
    expect(flexRow.className).toMatch(/\bflex\b/);
    const bubble = flexRow.firstElementChild as HTMLElement;
    expect(bubble.className).toContain("rounded-card");
    expect(bubble.className).toMatch(/\bborder\b/);
    // The full `--line` hairline, not the softer one: the bubble is a passive
    // container on the page ground, and design-language.md gives depth by that
    // hairline. The softer line left the bubble hard to see (D-84).
    expect(bubble.className).toMatch(/(^|\s)border-line(\s|$)/);
    expect(bubble.className).toContain("bg-surface");

    expect(within(bubble).getByText("this").tagName).toBe("STRONG");
    expect(within(bubble).getByText("code").tagName).toBe("CODE");

    // One line break, exactly where the user typed their newline: between the
    // inline code and the line that follows it.
    const breaks = bubble.querySelectorAll("br");
    expect(breaks).toHaveLength(1);
    const lineBreak = breaks[0]!;
    expect((lineBreak.previousSibling as HTMLElement | null)?.tagName).toBe("CODE");
    let afterTheBreak = "";
    for (let node = lineBreak.nextSibling; node !== null; node = node.nextSibling) {
      afterTheBreak += node.textContent ?? "";
    }
    expect(afterTheBreak.trim()).toContain("second line");

    // Raw HTML shows as text, not as markup.
    expect(readPageText(bubble)).toContain("<b>not bold</b>");
    expect(bubble.querySelector("b")).toBeNull();

    const list = within(bubble).getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => readPageText(item)),
    ).toEqual(["a", "b"]);
  });
});

describe("Thread: the transcript cache only grows forwards", () => {
  it("appends the same :stream delta once, however many times it is delivered", async () => {
    // The transcript log is append-only and strictly ordered. A row at or
    // below the last position in the cache is already in the cache: either
    // replayed when the subscription resumed, or a delta delivered twice. The
    // test uses an `assistant_text` delta because `buildTurns` concatenates
    // those, so a second copy in the cache would show the sentence twice.
    const { live } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());

    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [
          buildTranscriptRow(16, {
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
        buildTranscriptRow(17, {
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
      live.push(buildSessionStreamTopic(SESSION_ID), again);
    });
    await settle();
    const answer = findAnswerArea(await screen.findByText("One more thing."));

    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), again);
    });
    // React Query notifies its observers in a macrotask, which `settle` does
    // not wait for. Without this wait, a re-render caused by the delta would
    // still be pending, and the assertion below would pass only because it
    // ran too early.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(answer.textContent).toBe("One more thing.");
    expect(readPageText()).not.toContain("One more thing.One more thing.");
  });
});

describe("Thread: live subscriptions", () => {
  it("subscribes to exactly the session's stream and tap topics and the subagent topic while mounted, and ends them on unmount", async () => {
    const { live, router } = await openApp(
      buildSession({ status: "idle" }),
      buildTwoCompletedTurns(),
    );

    // The shell has its own subscriptions whatever screen is open (for
    // example the sidebar's `session` invalidation topic). The assertion
    // therefore checks only the per-session topics, which start with
    // `session:`, and the `subagent` topic, which only a thread opens.
    const listThreadTopics = () =>
      live.topics().filter((topic) => topic.startsWith("session:") || topic === "subagent");

    await waitFor(() => {
      expect([...listThreadTopics()].sort()).toEqual(
        [buildSessionStreamTopic(SESSION_ID), buildSessionTapTopic(SESSION_ID), "subagent"].sort(),
      );
    });

    await act(async () => {
      await router.navigate({ to: "/" });
    });

    await waitFor(() => {
      expect(listThreadTopics()).toEqual([]);
    });
  });

  it("replays a just-spawned thread's rows when the transcript read returned none", async () => {
    // The loader reads the transcript while the runner is still starting the
    // session, so the transcript is empty, and the cache is never refetched
    // (staleTime Infinity). Subscribing with no cursor would mean "start at
    // the head and replay nothing", so every row written between the read
    // and the subscription would be lost for good.
    const { live } = await openApp(buildSession({ status: "busy" }), []);

    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });
    expect(live.readCursor(buildSessionStreamTopic(SESSION_ID))).toBe("0");

    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: buildTwoCompletedTurns(),
        cursor: "15",
      });
    });

    await screen.findByText("Fix the login bug", { selector: "p" });
    await screen.findByText("Added a test too.");
  });

  it("renders replayed rows that arrive after the later rows", async () => {
    // A just-spawned thread gets two deliveries: the subscribe effect runs
    // again while the cache is still empty, so both subscriptions replay from
    // cursor 0, and the second one's rows can arrive first. The transcript is
    // merged by `position` instead of appended after its last row; otherwise
    // every row of the earlier replay would be dropped as already seen.
    const { live } = await openApp(buildSession({ status: "busy" }), []);

    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    const rows = buildTwoCompletedTurns();
    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: rows.slice(4),
        cursor: "15",
      });
    });
    await settle();
    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: rows.slice(0, 4),
        cursor: "15",
      });
    });

    // The first turn's user message is in the delta that arrived second, and
    // the second turn's text is in the one that arrived first. Both are on
    // screen, in position order, not in arrival order.
    const shown = await screen.findByText("Fix the login bug", { selector: "p" });
    await screen.findByText("Added a test too.");
    expect(readPageText().indexOf("Fix the login bug")).toBeLessThan(
      readPageText().indexOf("Added a test too."),
    );
    expect(shown).toBeDefined();
  });

  it("does not carry the previous thread's cursor into a newly opened thread's :stream subscription", async () => {
    // The router does not remount this screen when only the route param
    // changes, so per-thread state, including the stream cursor, must be
    // reset explicitly. Otherwise it stays behind as leftover component state.
    const OTHER_ID = "01a06d02-b100-7000-8000-000000000002";
    const other = buildSession({ id: OTHER_ID, status: "idle", title: "A second thread" });
    const { live, router } = await openApp(
      buildSession({ status: "idle" }),
      buildTwoCompletedTurns(),
      {
        [`GET /api/v1/sessions/${OTHER_ID}`]: { body: other },
        [`GET /api/v1/sessions/${OTHER_ID}/transcript`]: { body: { items: [] } },
        [`GET /api/v1/sessions/${OTHER_ID}/subagents`]: { body: { items: [] } },
      },
    );

    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });
    // This thread has rows, so its cursor is its last position.
    expect(live.readCursor(buildSessionStreamTopic(SESSION_ID))).toBe("15");

    await act(async () => {
      await router.navigate({ to: "/threads/$sessionId", params: { sessionId: OTHER_ID } });
    });

    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(OTHER_ID));
    });
    // The second thread's transcript is empty, so its cursor must start at
    // the beginning of its log. Any other value means the previous thread's
    // cursor leaked.
    expect(live.readCursor(buildSessionStreamTopic(OTHER_ID))).toBe("0");
  });
});

const SUBAGENT_ID = "toolu_explore_auth";

const SUBAGENT = buildSubagent({
  id: SUBAGENT_ID,
  description: "Explore the auth module",
  toolCalls: 2,
  startedAt: "2026-09-08T10:00:01.000Z",
});

/** The subagent's own transcript: one turn whose answer is a single message. */
const buildSubagentTranscript = (): TranscriptRow[] =>
  buildTranscript(
    buildTurnStart("s1", "2026-09-08T10:00:01.000Z"),
    buildAssistantMessage(
      "s1",
      "2026-09-08T10:00:02.000Z",
      "sa1",
      "The auth module has two entry points.",
    ),
  );

/**
 * Builds the routes for a thread with `SUBAGENT`. The transcript route
 * answers with the subagent's rows when the request names the subagent, and
 * with the session's own rows otherwise, as the controller does.
 */
const buildSubagentRoutes = (
  sessionRows: readonly TranscriptRow[],
): Readonly<Record<string, Handler>> => ({
  [`GET /api/v1/sessions/${SESSION_ID}/subagents`]: { body: { items: [SUBAGENT] } },
  [`GET /api/v1/sessions/${SESSION_ID}/transcript`]: (call: Call) => ({
    body: {
      items: call.search.includes(`subagentId=${SUBAGENT_ID}`)
        ? buildSubagentTranscript()
        : sessionRows,
    },
  }),
});

describe("Thread: a subagent's page", () => {
  it("shows the subagent's transcript and subscribes to its topics in place of the session's", async () => {
    const rows = buildTwoCompletedTurns();
    const { live, router } = await openApp(
      buildSession({ status: "busy" }),
      rows,
      buildSubagentRoutes(rows),
    );
    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    await act(async () => {
      await router.navigate({
        to: "/threads/$sessionId/subagents/$subagentId",
        params: { sessionId: SESSION_ID, subagentId: SUBAGENT_ID },
      });
    });

    await screen.findByText("The auth module has two entry points.");
    expect(screen.queryByText("Added a test too.")).toBeNull();
    await waitFor(() => {
      expect(live.topics()).toContain(buildSubagentStreamTopic(SESSION_ID, SUBAGENT_ID));
    });
    expect(live.topics()).toContain(buildSubagentTapTopic(SESSION_ID, SUBAGENT_ID));
    expect(live.topics()).not.toContain(buildSessionStreamTopic(SESSION_ID));
    expect(live.topics()).not.toContain(buildSessionTapTopic(SESSION_ID));
    // The thread's layout stays mounted, so the `subagent` topic stays open.
    expect(live.topics()).toContain("subagent");
    // A subagent takes no messages from the user, so its page has no composer.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the rows the thread wrote while its subagent's page was open after going back", async () => {
    // The thread's transcript stays cached while the subagent's page is open,
    // but nothing appends to it: the session's stream is not subscribed. Going
    // back subscribes again from the cached rows' cursor, and the controller
    // replays every row written after it, so the thread catches up.
    const rows = buildTwoCompletedTurns();
    const { live, router } = await openApp(
      buildSession({ status: "busy" }),
      rows,
      buildSubagentRoutes(rows),
    );
    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    await act(async () => {
      await router.navigate({
        to: "/threads/$sessionId/subagents/$subagentId",
        params: { sessionId: SESSION_ID, subagentId: SUBAGENT_ID },
      });
    });
    await waitFor(() => {
      expect(live.topics()).not.toContain(buildSessionStreamTopic(SESSION_ID));
    });

    await act(async () => {
      await router.navigate({ to: "/threads/$sessionId", params: { sessionId: SESSION_ID } });
    });
    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });
    // The new subscription resumes after the last cached row, not at the head
    // of the log, so the rows written meanwhile are replayed.
    expect(live.readCursor(buildSessionStreamTopic(SESSION_ID))).toBe("15");

    const written = [
      ...buildTurnStart("t3", "2026-09-08T10:02:00.000Z"),
      ...buildAssistantMessage("t3", "2026-09-08T10:02:01.000Z", "a3", "Merged the fix."),
    ].map((event, index) =>
      buildTranscriptRow(16 + index, { ...event, eventId: `e${16 + index}` }),
    );
    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: written,
        cursor: String(written.at(-1)!.position),
      });
    });

    await screen.findByText("Merged the fix.");
    expect(screen.getByText("Added a test too.")).toBeDefined();
    // The subagent's rows are cached under their own key and never show here.
    expect(screen.queryByText("The auth module has two entry points.")).toBeNull();
  });

  it("says the thread has no such subagent for an unknown subagent id", async () => {
    const rows = buildTwoCompletedTurns();
    const { router } = await openApp(
      buildSession({ status: "idle" }),
      rows,
      buildSubagentRoutes(rows),
    );

    await act(async () => {
      await router.navigate({
        to: "/threads/$sessionId/subagents/$subagentId",
        params: { sessionId: SESSION_ID, subagentId: "toolu_unknown" },
      });
    });

    await screen.findByText("This thread has no subagent with this id.");
    expect(screen.getByRole("link", { name: "Go to the thread" })).toBeDefined();
  });

  it("keeps the composer's unsent message after a visit to a subagent's page", async () => {
    const user = userEvent.setup();
    const rows = buildTwoCompletedTurns();
    const { router } = await openApp(
      buildSession({ status: "idle" }),
      rows,
      buildSubagentRoutes(rows),
    );
    await user.type(await screen.findByPlaceholderText("Reply…"), "Also check the logout path");

    await act(async () => {
      await router.navigate({
        to: "/threads/$sessionId/subagents/$subagentId",
        params: { sessionId: SESSION_ID, subagentId: SUBAGENT_ID },
      });
    });
    await screen.findByText("The auth module has two entry points.");
    await act(async () => {
      await router.navigate({ to: "/threads/$sessionId", params: { sessionId: SESSION_ID } });
    });

    expect(await screen.findByPlaceholderText("Reply…")).toHaveProperty(
      "value",
      "Also check the logout path",
    );
  });
});

/**
 * jsdom computes no layout, so these tests set by hand the scroll geometry
 * that `useStickToBottom` reads, on the shell's `main`: the thread has no
 * scroll region of its own and scrolls with `main`.
 */
describe("Thread: auto-scroll follows new content", () => {
  let geometry: FakeScrollGeometry;

  beforeEach(() => {
    geometry = fakeMainScrollGeometry();
  });

  afterEach(() => {
    geometry.restore();
  });

  const buildNewRow = (): TranscriptRow =>
    buildTranscriptRow(16, {
      _tag: "turn.started",
      eventId: "e16",
      sessionId: SESSION_ID,
      at: "2026-09-08T10:02:00.000Z",
      turnId: "t3",
    });

  // Guards against the thread opening at its top. A hook that stores the
  // scrolling element in a `useEffect` gets it only after the screen's mount
  // `useLayoutEffect`, so the first follow finds no element.
  it("opens on the latest turn", async () => {
    geometry.set({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });

    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());

    await waitFor(() => {
      expect(geometry.readScrollTop()).toBe(1000 - 100);
    });
  });

  it("scrolls to the bottom on a :stream delta when the reader was at the bottom", async () => {
    const { live } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());
    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    geometry.set({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
    geometry.scroll();
    await settle();

    // In a real browser, scrollHeight already includes the new row when the
    // layout effect after this delta's commit runs.
    geometry.set({ scrollTop: 900, scrollHeight: 1200, clientHeight: 100 });
    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [buildNewRow()],
        cursor: "16",
      });
    });

    await waitFor(() => {
      expect(geometry.readScrollTop()).toBe(1200 - 100);
    });
  });

  it("leaves the scroll position on a :stream delta when the reader had scrolled up", async () => {
    const { live } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());
    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    geometry.set({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
    geometry.scroll();
    await settle();

    geometry.set({ scrollTop: 0, scrollHeight: 1200, clientHeight: 100 });
    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: [buildNewRow()],
        cursor: "16",
      });
    });
    await settle();

    expect(geometry.readScrollTop()).toBe(0);
  });
});

/**
 * The thread's header is the screen's own first row, and the shell's top bar
 * is hidden on this route. These tests replace the two "Thread: top bar"
 * tests, which checked the old shell title and its `thread · <short id>`
 * breadcrumb.
 *
 * How these tests find the header:
 * - The breadcrumb `Threads`, the slash after it and the title are separate
 *   elements in one row, so the row is the slash's parent element.
 * - The overflow button's accessible name is the glyph `…`, as in spec 14.
 *   It has no `aria-label`; adding one means changing this test.
 */
describe("Thread: the header is the screen's first row", () => {
  it("shows Threads / then the session title, with a disabled … button", async () => {
    await openApp(
      buildSession({ status: "idle", title: "Fix the login bug" }),
      buildTwoCompletedTurns(),
    );

    const chrome = await findThreadChrome();
    expect(readPageText(chrome)).toMatch(/^Threads \/ Fix the login bug/);

    const overflow = screen.getByRole<HTMLButtonElement>("button", { name: "…" });
    expect(chrome?.contains(overflow)).toBe(true);
    expect(overflow.disabled).toBe(true);
  });

  it("shows the run that started a step session as its crumb, linked to the run", async () => {
    const runId = "0199c0ff-2222-7000-8000-00003db7d6a1";
    await openApp(
      buildSession({
        status: "idle",
        title: "Fix and ship a pull request · implement",
        runId,
        stepId: "implement",
      }),
      buildTwoCompletedTurns(),
    );

    const link = await screen.findByRole("link", { name: "run 3db7d6a1" });
    expect(link.getAttribute("href")).toBe(`/runs/${runId}`);
    expect(readPageText(await findThreadChrome())).toMatch(
      /^run 3db7d6a1 \/ Fix and ship a pull request · implement/,
    );
  });

  it("truncates a long title instead of pushing the breadcrumb or the actions out of place", async () => {
    const longTitle =
      "Fix the login bug for real this time and also the logout bug and the signup bug";
    await openApp(buildSession({ status: "idle", title: longTitle }), buildTwoCompletedTurns());

    const crumb = (await findThreadChrome()).firstElementChild;
    expect(readPageText(crumb as HTMLElement)).toBe("Threads");
    expect(screen.getByText(longTitle).className).toContain("truncate");
    // The breadcrumb and the actions still render in full; only the title is truncated.
    expect(crumb?.className).toContain("shrink-0");
  });

  it("still warns about a time zone this browser does not know, even with the top bar hidden", async () => {
    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      "GET /api/v1/settings": {
        body: {
          controller: {},
          user: {
            "onboarding.completedSteps": ["timezone", "assistant"],
            timezone: "Mars/Olympus",
          },
        },
      },
    });

    // The thread's header shows the title, but nothing else on the screen
    // shows this warning. Without it, the thread would show its timestamps
    // in the wrong zone with no hint of the problem.
    expect(await screen.findByText(/does not know the zone Mars\/Olympus/)).toBeDefined();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("renders no shell title above it: no h1 and no thread · breadcrumb anywhere", async () => {
    await openApp(
      buildSession({ status: "idle", title: "Fix the login bug" }),
      buildTwoCompletedTurns(),
    );

    expect(readPageText(await findThreadChrome())).toMatch(/^Threads \/ /);
    expect(readPageText()).not.toContain("thread · ");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});

/**
 * Tests for the composer at the bottom of a started thread (the in-thread
 * half of the "Web: composer" table). They drive the app only through
 * `renderApp` and the stubbed `fetch` and `LiveStub`.
 *
 * Where the spec leaves a rendering detail open, these tests make the same
 * assumptions as `new.integration.test.tsx`:
 * - A lone icon button shows why it is disabled in its `title`.
 * - The accessible names of the send, Steer, Cancel and Stop controls contain
 *   the exact words from the spec ("send", "Steer", "Cancel", "Stop").
 */
describe("Thread: composer read-only fields and model switch", () => {
  it("renders workspace, machine and access mode as read-only values with no menu", async () => {
    const user = userEvent.setup();
    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());

    expect(readPageText()).toContain("No workspace");
    expect(readPageText()).toContain(RUNNER_STARTED.name);
    expect(readPageText()).toContain("Approval required");

    // Clicking any of these values never shows another option; that is the
    // "no menu" part of the criterion. A read-only value could still be a
    // `<button>`, so the test checks that the other option is absent after
    // the click, not which element type the value is.
    await user.click(screen.getByText(RUNNER_STARTED.name));
    expect(screen.queryByText(RUNNER_OTHER.name)).toBeNull();

    await user.click(screen.getByText("No workspace"));
    expect(screen.queryByText("Adopt a folder on this machine…")).toBeNull();

    await user.click(screen.getByText("Approval required"));
    expect(screen.queryByText("Full access")).toBeNull();
  });

  it("dims the model menu's other accounts with the note account fixed", async () => {
    const user = userEvent.setup();
    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));

    expect(readPageText()).toContain("account fixed");
    // The current instance's other model can still be picked, unlike the
    // other instance's group.
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
  });

  // Picking a model does not patch the session. The pick is draft state that
  // is sent with the next submission.
  it("shows the picked model in the pill without sending anything when a model of the same instance is chosen", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());

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

/** Builds one queued input for a busy thread's queue list. `overrides` replaces any field. */
const buildQueuedInput = (overrides: Partial<Input> = {}): Input => ({
  id: INPUT_ID,
  sessionId: SESSION_ID,
  source: "user",
  actor: "user",
  text: "Also check the logs",
  attachments: [],
  status: "queued",
  delivery: null,
  createdAt: "2026-09-08T10:02:00.000Z",
  deliveredAt: null,
  sentAt: null,
  reason: null,
  ...overrides,
});

describe("Thread: input queue", () => {
  it("sends POST /sessions/:id/input on an idle thread and clears the textarea once the result is opened", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
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
    // An input carries only the picks made since the last submission. An
    // untouched composer sends only the text, and the session keeps its
    // current model and options.
    expect(call.body).toEqual({ text: "Also check the logs" });

    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    });
  });

  // `isPending` reaches the composer a tick after `mutate`, so two Enters in
  // one tick could both send.
  it("sends once when Enter is pressed twice before the first input is answered", async () => {
    const user = userEvent.setup();
    let release = (): void => {};
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: () =>
        new Promise((resolve) => {
          release = () => resolve({ body: { inputId: INPUT_ID, result: "opened" } });
        }),
    });

    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    await user.type(box, "Also check the logs");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    await settle();

    expect(
      api.calls.filter(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      ),
    ).toHaveLength(1);
    release();
  });

  // Guards against clearing the box on success when the user typed more
  // while the input was in flight.
  it("keeps text typed while an input is in flight", async () => {
    const user = userEvent.setup();
    let release = (): void => {};
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: () =>
        new Promise((resolve) => {
          release = () => resolve({ body: { inputId: INPUT_ID, result: "opened" } });
        }),
    });

    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    await user.type(box, "Also check the logs{Enter}");
    await waitFor(() => {
      expect(
        api.calls.some(
          (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
        ),
      ).toBe(true);
    });
    await user.type(box, " and the metrics");
    release();
    await settle();

    expect(box.value).toBe("Also check the logs and the metrics");
  });

  it("shows a queued input in a list above the composer with Steer and Cancel, read from GET /sessions/:id/inputs", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "queued" },
      },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [buildQueuedInput()] } },
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

  it("calls steer and removes the row from the list once the result is steered", async () => {
    const user = userEvent.setup();
    // The stub empties the list once steer has actually been called, not
    // after a fixed number of calls. On its first connection, the live
    // connection makes every mutable query refetch once (see `runConnection`
    // in `packages/client-core/src/live/live.ts`), before the steer click. A
    // "second call returns an empty list" counter would be used up by that
    // refetch instead of the steer.
    let delivered = false;
    const { api } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => ({
        body: { items: delivered ? [] : [buildQueuedInput()] },
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

  it("calls cancel (DELETE) and removes the row from the list", async () => {
    const user = userEvent.setup();
    // As in the steer test above, the stub empties the list once cancel has
    // actually been called, not after a fixed number of calls.
    let delivered = false;
    const { api } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => ({
        body: { items: delivered ? [] : [buildQueuedInput()] },
      }),
      [`DELETE /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}`]: () => {
        delivered = true;
        return { body: buildQueuedInput({ status: "cancelled" }) };
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
    await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: {
        body: { items: [buildQueuedInput({ reason: "the runner has not answered yet" })] },
      },
    });

    await screen.findByText("the runner has not answered yet");
  });

  it("refetches the queued list when the session is invalidated", async () => {
    let inputsCalls = 0;
    const { live } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => {
        inputsCalls += 1;
        return { body: { items: [buildQueuedInput()] } };
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

  it("shows the message and keeps the row when a steer attempt fails with invalid_state", async () => {
    const user = userEvent.setup();
    await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [buildQueuedInput()] } },
      [`POST /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}/steer`]: {
        status: 409,
        body: buildErrorBody("invalid_state", "the turn already finished"),
      },
    });

    await screen.findByText("Also check the logs");
    await user.click(screen.getByRole("button", { name: /steer/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("the turn already finished");
    expect(screen.getByText("Also check the logs")).toBeDefined();
  });
});

/**
 * Opens `fixture`, a busy session, clicks Stop, and checks that Stop stays
 * gone when the interrupt's answer arrives after the live connection has
 * already reported the session idle.
 *
 * The controller answers `session.interrupt` with the session as it read it
 * before the interrupt, still busy. The app must not write that answer into
 * the cache, or the late answer would bring Stop back on an idle session.
 * `extra` adds the routes the screen needs besides the session's own.
 */
const checkLateInterruptAnswerKeepsStopGone = async (
  fixture: Session,
  extra: Readonly<Record<string, Handler>> = {},
) => {
  const user = userEvent.setup();
  let current = fixture;
  let answerInterrupt: (answer: { body: unknown }) => void = () => {};
  const { api, live } = await openApp(fixture, buildTwoCompletedTurns(), {
    ...extra,
    [`GET /api/v1/sessions/${fixture.id}`]: () => ({ body: current }),
    [`POST /api/v1/sessions/${fixture.id}/interrupt`]: () =>
      new Promise((resolve) => {
        answerInterrupt = resolve;
      }),
  });

  await user.click(await screen.findByRole("button", { name: /^stop$/i }));
  await waitFor(() => {
    expect(
      api.calls.some(
        (call) =>
          call.method === "POST" && call.path === `/api/v1/sessions/${fixture.id}/interrupt`,
      ),
    ).toBe(true);
  });

  current = { ...fixture, status: "idle" };
  await waitFor(() => {
    expect(live.topics()).toContain("session");
  });
  act(() => {
    live.push("session", { _tag: "invalidate", ids: [fixture.id], kind: "updated" });
  });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });

  await act(async () => {
    answerInterrupt({ body: fixture });
    // A real wait, not microtasks: the answer passes through `fetch`, the
    // client's decoding and React Query before it could reach the cache.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
};

describe("Thread: stop control", () => {
  it("shows Stop on a busy thread and calls POST /sessions/:id/interrupt", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/interrupt`]: { body: buildSession({ status: "idle" }) },
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

  it("keeps Stop gone when the interrupt answers after the session went idle", async () => {
    await checkLateInterruptAnswerKeepsStopGone(buildSession({ status: "busy" }));
  });

  it("has no Stop control on an idle thread", async () => {
    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });

  it("has no Stop control on an exited thread", async () => {
    await openApp(
      buildSession({ status: "exited", exitedAt: "2026-09-08T10:05:00.000Z" }),
      buildTwoCompletedTurns(),
    );

    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });
});

/**
 * Tests for the model options on a started thread. The
 * picks are draft state that stays in the browser until the next submission.
 * After the server stores them, the pill shows the stored session values.
 *
 * These tests return `INSTANCE_OPTIONS` from `GET /api/v1/providers`, the
 * only fixture whose models have an `effort` descriptor.
 */
describe("Thread: model options are sent with the submission", () => {
  const providers = { body: [INSTANCE_OPTIONS, INSTANCE_OTHER] };

  it("sends nothing when an option is picked, and carries the pick on the next input", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "opened" },
      },
    });

    await user.click(screen.getByRole("button", { name: "Medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));

    // The pick itself writes nothing: neither the input route nor the update
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
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "opened" },
      },
    });

    await user.click(screen.getByRole("button", { name: "Medium" }));
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
    // The option picks were cleared together with the model that offered them.
    expect(call.body).toEqual({ text: "Also check the logs", model: "claude-opus-5" });
    expect(
      api.calls.some(
        (call) => call.method === "PATCH" && call.path === `/api/v1/sessions/${SESSION_ID}`,
      ),
    ).toBe(false);
  });

  it("shows the newly picked model's defaults instead of the stored model's options", async () => {
    const user = userEvent.setup();
    await openApp(
      buildSession({
        status: "idle",
        modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
      }),
      buildTwoCompletedTurns(),
      { "GET /api/v1/providers": providers },
    );

    await user.click(screen.getByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);
    await user.click(await screen.findByRole("button", { name: "Medium" }));

    // The stored `high` belongs to the other model, and the server drops it
    // when the model changes, so the options show the descriptor's default.
    const medium = await screen.findByRole<HTMLButtonElement>("radio", { name: "Medium" });
    expect(medium.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
  });

  it("clears the picks once the input is accepted, and shows the stored options instead", async () => {
    const user = userEvent.setup();
    // The controller stores the pick, so the session read after the input
    // returns it. Once the draft pick is cleared, the selector's label comes
    // from that stored value.
    let stored: Record<string, string> = {};
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({
        body: buildSession({
          status: "idle",
          modelSelection: { model: "claude-sonnet-5", options: stored },
        }),
      }),
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: (call) => {
        stored = { ...stored, ...(call.body as { options: Record<string, string> }).options };
        return { body: { inputId: INPUT_ID, result: "opened" } };
      },
    });

    await user.click(screen.getByRole("button", { name: "Medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    // The selector still shows high after the picks are cleared. It can only
    // do that by reading the session again after the input changed it.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "High" })).toBeDefined();
    });

    // The next submission shows that the picks were cleared: it carries none.
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

  it("keeps the picks until the session is read again, so the next send uses the stored session", async () => {
    const user = userEvent.setup();
    // The stub holds back the session read that follows the input. A second
    // send in that window must not use the old session data.
    let stored: { model: string; options: Record<string, string> } = {
      model: "claude-sonnet-5",
      options: {},
    };
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;

    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      "GET /api/v1/providers": providers,
      [`GET /api/v1/sessions/${SESSION_ID}`]: async () => {
        if (holding) await held;
        return { body: buildSession({ status: "idle", modelSelection: stored }) };
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
    await user.click(await screen.findByRole("button", { name: "Medium" }));
    await user.click(await screen.findByRole("radio", { name: "High" }));
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    // While the read is pending, the submission is not finished: the send
    // button stays disabled, and the pill shows the picks, not the old
    // session in the cache.
    await waitFor(() => {
      const call = api.calls.find(
        (each) => each.method === "POST" && each.path === `/api/v1/sessions/${SESSION_ID}/input`,
      );
      if (call === undefined) throw new Error("input not sent yet");
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /send/i }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "High" })).toBeDefined();

    await act(async () => {
      release();
      await held;
    });

    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    });
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "High" })).toBeDefined();

    // The picks are cleared, and the next send uses the session the server
    // stored, not the one the cache held while the read was pending.
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

  it("shows the stored option on a fresh render, in the selector's label and as the enabled checked choice", async () => {
    const user = userEvent.setup();
    await openApp(
      buildSession({
        status: "idle",
        modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
      }),
      buildTwoCompletedTurns(),
      { "GET /api/v1/providers": providers },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claude sonnet 5/i })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "High" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "High" }));

    const high = await screen.findByRole<HTMLButtonElement>("radio", { name: "High" });
    expect(high.getAttribute("aria-checked")).toBe("true");
    expect(high.disabled).toBe(false);

    // The stored value takes precedence over the descriptor's default.
    const medium = screen.getByRole<HTMLButtonElement>("radio", { name: "Medium" });
    expect(medium.getAttribute("aria-checked")).toBe("false");
    expect(medium.disabled).toBe(false);
  });
});

describe("Thread: an exited thread that can be resumed", () => {
  const EXITED_RESUMABLE = buildSession({
    status: "exited",
    resumable: true,
    nativeSessionId: "native-1",
    exitedAt: "2026-09-08T10:05:00.000Z",
  });

  it("looks like an idle thread: textarea and model pill enabled, no Stop, and no mention of exited", async () => {
    await openApp(EXITED_RESUMABLE, buildTwoCompletedTurns());

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(textarea.disabled).toBe(false);
    expect(textarea.placeholder).toBe("Reply…");

    const pill = screen.getByRole<HTMLButtonElement>("button", { name: /claude sonnet 5/i });
    expect(pill.disabled).toBe(false);

    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
    expect(readPageText()).not.toMatch(/exited/i);
  });

  it("sends the typed text to POST /sessions/:id/input and shows the queued row above the composer", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(EXITED_RESUMABLE, buildTwoCompletedTurns(), {
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "queued" },
      },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [buildQueuedInput()] } },
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
    // The list comes before the composer in document order.
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
  ])("is read-only and explains that %s", async (reason, nativeSessionId) => {
    await openApp(
      buildSession({
        status: "exited",
        resumable: false,
        nativeSessionId,
        exitedAt: "2026-09-08T10:05:00.000Z",
      }),
      buildTwoCompletedTurns(),
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
 * Tests for the composer on an active thread: the note shown under a model
 * pick until it is sent, and the fields that locked when the thread started.
 *
 * How these tests find things:
 * - The model pill is the button whose accessible name contains the model's
 *   *display* name ("Claude Sonnet 5").
 * - A locked field is the element with the `title`, and "no button" means
 *   that element is not a button.
 */
describe("Composer: a model pick is pending until it is sent", () => {
  it("notes that the change applies on send, shows it on the pill, and removes the note once the session has it", async () => {
    const user = userEvent.setup();
    // The controller stores the model from the input, so the session read
    // after it returns the new model, and that removes the note.
    let stored = { model: "claude-sonnet-5", options: {} as Record<string, string> };
    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({
        body: buildSession({ status: "idle", modelSelection: stored }),
      }),
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: (call) => {
        stored = { model: (call.body as { model: string }).model, options: {} };
        return { body: { inputId: INPUT_ID, result: "opened" } };
      },
    });

    expect(readPageText()).not.toContain("model change applies on send");

    await user.click(await screen.findByRole("button", { name: /claude sonnet 5/i }));
    await pickRow(user, /claude opus 5/i);

    // The pick is not sent yet, so the card shows a note, and the pill
    // already shows the model that will be sent.
    await waitFor(() => {
      expect(readPageText()).toContain("model change applies on send");
    });
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();

    await user.type(screen.getByRole("textbox"), "Also check the logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    // Once the session has the new model, nothing is pending, so the note is
    // gone.
    await waitFor(() => {
      expect(readPageText()).not.toContain("model change applies on send");
    });
    expect(screen.getByRole("button", { name: /claude opus 5/i })).toBeDefined();
  });
});

describe("Composer: fields that locked when the thread started explain why", () => {
  it("renders the access mode, the workspace and the machine as plain text, with the reason as their tooltip", async () => {
    await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns());

    for (const field of ["access mode", "workspace", "machine"]) {
      const locked = await screen.findByTitle(`Create a new thread to change the ${field}`);
      expect(locked.tagName).not.toBe("BUTTON");
      expect(locked.closest("button")).toBeNull();
    }

    // None of the three is a menu trigger under another accessible name either.
    expect(screen.queryByRole("button", { name: /approval required/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /no workspace/i })).toBeNull();
    expect(screen.queryByRole("button", { name: RUNNER_STARTED.name })).toBeNull();
  });
});

/**
 * Tests for the permission card docked above the composer (spec 14 §The
 * thread surface). All the card's text comes from
 * `buildApprovalCard` in `client-core`, so these tests read the labels from
 * there instead of repeating text that `apps/web` does not own.
 */
describe("Thread: the permission card", () => {
  const REQUEST: SessionRequest = {
    requestId: "req-1",
    itemId: "tool3",
    kind: "command_approval",
    decisions: ["allow", "allow_always", "deny", "cancel"],
    detail: { command: "ls -la" },
  };

  const QUESTIONS: SessionRequest = {
    requestId: "req-2",
    itemId: "tool3",
    kind: "question",
    detail: {
      questions: [
        {
          question: "Which database should it use?",
          header: "Database",
          options: [
            { label: "SQLite", description: "the one Hercule ships" },
            { label: "Postgres", description: "somebody else's server" },
          ],
          multiSelect: false,
        },
      ],
    },
  };

  /** Builds a live turn whose only open item is the one `REQUEST` is about. */
  const buildParkedRows = (): TranscriptRow[] => [
    buildTranscriptRow(0, {
      _tag: "turn.started",
      eventId: "e0",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:00.000Z",
      turnId: "t3",
    }),
    buildTranscriptRow(1, {
      _tag: "item.started",
      eventId: "e1",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:00.100Z",
      turnId: "t3",
      itemId: "u3",
      kind: "user_message",
      detail: { text: "List the files" },
    }),
    buildTranscriptRow(2, {
      _tag: "item.completed",
      eventId: "e2",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:00.100Z",
      turnId: "t3",
      itemId: "u3",
      kind: "user_message",
      status: "completed",
      detail: { text: "List the files" },
    }),
    buildTranscriptRow(3, {
      _tag: "item.started",
      eventId: "e3",
      sessionId: SESSION_ID,
      at: "2026-09-08T11:00:01.000Z",
      turnId: "t3",
      itemId: "tool3",
      kind: "command_execution",
      detail: { name: "Bash", input: { command: "ls -la" } },
    }),
  ];

  /**
   * Returns a matcher for the accessible name of the card's row for
   * `decision`, using the text that `client-core` gives that row. Throws when
   * the card has no row for `decision`.
   */
  const buildAnswerMatcher = (
    request: SessionRequest,
    decision: string,
  ): ((name: string) => boolean) => {
    const found = buildApprovalCard(request).rows.find((each) => each.id === decision);
    if (found === undefined) throw new Error(`the card offers no ${decision} row`);
    const describeLine = found.describeLine.map((part) => part.text).join("");
    return (name: string) => name.includes(found.label) && name.includes(describeLine);
  };

  /** Returns the composer's card, the raised box that holds the message. Throws if it is missing. */
  const getComposerCard = (): HTMLElement => {
    const found = screen.getByRole("textbox").closest<HTMLElement>('[class*="bg-raised"]');
    if (found === null) throw new Error("the composer's card was not found");
    return found;
  };

  it("docks the card above the composer, with one row per offered decision and no copy in the transcript", async () => {
    await openApp(buildSession({ status: "busy", openRequests: [REQUEST] }), buildParkedRows());

    const allow = await screen.findByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") });
    // One row per offered decision, and exactly one card: the transcript does
    // not repeat it.
    for (const decision of REQUEST.decisions) {
      expect(
        screen.getAllByRole("button", { name: buildAnswerMatcher(REQUEST, decision) }),
        `${decision} does not render exactly once`,
      ).toHaveLength(1);
    }
    // The card shows the command the request is about.
    expect(readPageText()).toContain("ls -la");

    // The card is in the sticky footer, above the composer.
    const foot = allow.closest<HTMLElement>('[class*="sticky"]');
    expect(foot, "the card is not in the sticky foot").not.toBeNull();
    expect(foot?.contains(getComposerCard())).toBe(true);
    expect(
      allow.compareDocumentPosition(getComposerCard()) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the composer does not follow the card",
    ).toBeTruthy();

    // The dock is a mirror image of the lip, placed above the card. The card
    // keeps its 14px radius in every state and the dock tucks under it. jsdom
    // can only check the classes; whether the two look flush needs a manual
    // check. Spec 14 §Measurements owns the sizes.
    expect(getComposerCard().className).toContain("rounded-[14px]");
    const dock = allow.closest<HTMLElement>('[class*="rounded-t-[10px]"]');
    expect(dock, "the dock is not the lip mirrored").not.toBeNull();
    expect(dock?.className).toContain("bg-surface");
    expect(dock?.className).toContain("border-line-soft");
  });

  it("posts the clicked decision once, and removes the card when the session's open request is cleared", async () => {
    const user = userEvent.setup();
    let current = buildSession({ status: "busy", openRequests: [REQUEST] });
    let release: (() => void) | undefined;
    const api = stubApi({
      ...buildThreadRoutes(current, buildParkedRows()),
      [`GET /api/v1/sessions/${SESSION_ID}`]: () => ({ body: current }),
      // The response is held until the test releases it, and it still has
      // the open request. The response is a snapshot from when the request
      // was made; the card follows the live session instead.
      [`POST /api/v1/sessions/${SESSION_ID}/respond-to-approval-request`]: () =>
        new Promise<{ readonly body: unknown }>((resolve) => {
          release = () => {
            resolve({ body: buildSession({ status: "busy", openRequests: [REQUEST] }) });
          };
        }),
    });
    const { live } = await renderApp({
      path: `/threads/${SESSION_ID}`,
      api: api.fetch,
      token: "held",
    });

    await user.click(
      await screen.findByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") }),
    );

    await waitFor(() => {
      expect(
        api.calls.filter((call) => call.path.endsWith("/respond-to-approval-request")),
      ).toHaveLength(1);
    });
    expect(
      api.calls.find((call) => call.path.endsWith("/respond-to-approval-request")),
    ).toMatchObject({
      method: "POST",
      body: { requestId: REQUEST.requestId, decision: "allow" },
    });

    // The card disappears when the session's open request is cleared, not
    // when the user clicks.
    expect(
      screen.getByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") }),
    ).toBeDefined();
    current = buildSession({ status: "busy", openRequests: [] });
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [SESSION_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") }),
      ).toBeNull();
    });

    // Now the response arrives, with the open request the controller still
    // had when it was called. The card, which the session has cleared, does
    // not come back.
    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") })).toBeNull();
  });

  it("accepts only one answer: a second click while the request is still open sends nothing", async () => {
    const user = userEvent.setup();
    const current = buildSession({ status: "busy", openRequests: [REQUEST] });
    const api = stubApi({
      ...buildThreadRoutes(current, buildParkedRows()),
      [`POST /api/v1/sessions/${SESSION_ID}/respond-to-approval-request`]: { body: current },
    });
    await renderApp({ path: `/threads/${SESSION_ID}`, api: api.fetch, token: "held" });

    const allow = await screen.findByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") });
    await user.click(allow);
    await waitFor(() => {
      expect(
        api.calls.filter((call) => call.path.endsWith("/respond-to-approval-request")),
      ).toHaveLength(1);
    });

    // The card is still shown, because only the runner clears it. But it
    // already has its answer, and a contradicting second answer would be
    // sent and recorded in the audit log.
    await user.click(screen.getByRole("button", { name: buildAnswerMatcher(REQUEST, "deny") }));
    await user.click(allow);

    expect(
      api.calls.filter((call) => call.path.endsWith("/respond-to-approval-request")),
    ).toHaveLength(1);
  });

  it("shows the item the request is about as awaiting approval, in the attention color", async () => {
    const user = userEvent.setup();
    await openApp(buildSession({ status: "busy", openRequests: [REQUEST] }), buildParkedRows());

    await user.click(await screen.findByRole("button", { name: /^Working for/ }));

    const line = screen.getByText(/awaiting approval/);
    expect(readPageText(line)).toBe("command · ls -la · awaiting approval");
    expect(line.className).toContain("text-attn");
    expect(readPageText()).not.toContain("· running");
  });

  it("renders no card when the session has no open request", async () => {
    await openApp(buildSession({ status: "busy", openRequests: [] }), buildParkedRows());

    await screen.findByRole("textbox");
    expect(screen.queryByRole("button", { name: buildAnswerMatcher(REQUEST, "allow") })).toBeNull();
    // The composer's radius never depends on what is above it.
    expect(getComposerCard().className).toContain("rounded-[14px]");
  });

  it("shows a question request's questions with no decision", async () => {
    await openApp(buildSession({ status: "busy", openRequests: [QUESTIONS] }), buildParkedRows());

    await screen.findByText("Which database should it use?");
    // A question takes answers only; the user turns it down with Stop.
    for (const label of Object.values(APPROVAL_ANSWER_LABELS)) {
      expect(screen.queryByRole("button", { name: (name) => name.startsWith(label) })).toBeNull();
    }

    // A question is not an approval. The card shows three separate blocks,
    // not one paragraph:
    // - the header chip, styled as a lane label;
    // - the question text;
    // - each option, with its description.
    expect(screen.getByText("Database").className).toContain("uppercase");
    expect(screen.getByText("Which database should it use?")).toBeDefined();
    expect(screen.getByText("the one Hercule ships")).toBeDefined();
    // The dock answers the question itself, so it no longer tells the user to
    // cancel the turn and reply.
    expect(readPageText()).not.toContain("not built yet");
  });
});

/**
 * Tests for answering a `question` request in the permission card: one
 * question at a time, its options as choices, a field for an own answer, and
 * Next and Send. The answers go to `session.respondToQuestion` as
 * `{ requestId, answers }`.
 */
describe("Thread: answering the agent's questions", () => {
  /** One question of a `question` request, as the contract types it. */
  type Question = Extract<SessionRequest, { kind: "question" }>["detail"]["questions"][number];

  /** A single-select question. */
  const STORAGE: Question = {
    question: "Which storage should drafts use?",
    header: "Storage",
    options: [
      { label: "localStorage", description: "small and synchronous" },
      { label: "IndexedDB", description: "large and asynchronous" },
    ],
    multiSelect: false,
  };

  /** A multiSelect question. */
  const FEATURES: Question = {
    question: "Which features should ship?",
    header: "Features",
    options: [
      { label: "Sync", description: "" },
      { label: "Search", description: "" },
    ],
    multiSelect: true,
  };

  /** A question request with a single-select question, then a multiSelect one. */
  const QUESTIONS: SessionRequest = {
    requestId: "req-2",
    itemId: "tool3",
    kind: "question",
    detail: { questions: [STORAGE, FEATURES] },
  };

  /** A question request with only the single-select question. */
  const ONE_QUESTION: SessionRequest = {
    ...QUESTIONS,
    detail: { questions: [STORAGE] },
  };

  const RESPOND_TO_QUESTION = `POST /api/v1/sessions/${SESSION_ID}/respond-to-question`;

  /**
   * Opens the thread parked on `request`, with a controller that accepts
   * every answer, and returns the app and its stubbed API.
   */
  const openParked = (request: SessionRequest) => {
    const session = buildSession({ status: "busy", openRequests: [request] });
    return openApp(session, [], {
      [RESPOND_TO_QUESTION]: { body: session },
      [`POST /api/v1/sessions/${SESSION_ID}/interrupt`]: { body: session },
    });
  };

  /**
   * Returns the bodies the app sent with `session.respondToQuestion` and
   * `session.respondToApprovalRequest`, oldest first, so a decision sent by
   * mistake would show up too.
   */
  const readBodies = (calls: readonly Call[]): readonly unknown[] =>
    calls
      .filter(
        (call) =>
          call.path.endsWith("/respond-to-question") ||
          call.path.endsWith("/respond-to-approval-request"),
      )
      .map((call) => call.body);

  /**
   * Returns the choice for the option `label`: a radio on a single-select
   * question, a checkbox on a multiSelect one. Its accessible name starts with
   * the label and may go on with the option's description.
   */
  const findChoice = (role: "radio" | "checkbox", label: string): HTMLElement =>
    screen.getByRole(role, { name: (name) => name.startsWith(label) });

  /** Returns the field the user types their own answer in. */
  const readOwnAnswer = (): HTMLElement => screen.getByRole("textbox", { name: "Your own answer" });

  /** Returns the button that sends the answers, which the composer's Send is not. */
  const readSend = (): HTMLElement => screen.getByRole("button", { name: "Send answers" });

  /** Checks whether `element` takes no input, through `disabled` or `aria-disabled`. */
  const isLocked = (element: HTMLElement): boolean =>
    (element as HTMLInputElement | HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true";

  it("shows one question at a time with its place among them, its options as choices, and a field for an own answer", async () => {
    const user = userEvent.setup();
    await openParked(QUESTIONS);

    await screen.findByText("Which storage should drafts use?");
    expect(screen.queryByText("Which features should ship?")).toBeNull();
    expect(screen.getByText("Question 1 of 2")).toBeDefined();
    expect(findChoice("radio", "localStorage")).toBeDefined();
    expect(findChoice("radio", "IndexedDB")).toBeDefined();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(readOwnAnswer()).toBeDefined();

    await user.click(findChoice("radio", "localStorage"));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByText("Which storage should drafts use?")).toBeNull();
    expect(screen.getByText("Which features should ship?")).toBeDefined();
    expect(screen.getByText("Question 2 of 2")).toBeDefined();
    expect(findChoice("checkbox", "Sync")).toBeDefined();
    expect(findChoice("checkbox", "Search")).toBeDefined();
    // The shell's own segmented control is a radio group too, so only the
    // question form is checked for radios.
    const questionForm = screen.getByText("Which features should ship?").closest("form")!;
    expect(within(questionForm).queryAllByRole("radio")).toEqual([]);
    expect(readOwnAnswer()).toBeDefined();
    expect(readSend()).toBeDefined();
  });

  it("shows a lone question without its place, and with Send rather than Next", async () => {
    await openParked(ONE_QUESTION);

    await screen.findByText("Which storage should drafts use?");
    expect(screen.queryByText(/\b1 of 1\b/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(readSend()).toBeDefined();
  });

  it("warns that an answer the agent asked to keep secret is stored like any other", async () => {
    await openParked({ ...QUESTIONS, detail: { questions: [{ ...STORAGE, secret: true }] } });

    await screen.findByText("Which storage should drafts use?");
    expect(
      screen.getByText(
        "The agent asked to keep this answer secret. It is stored in the thread like any other answer.",
      ),
    ).toBeDefined();
  });

  it("enables Send only once the question is answered with a pick or non-blank text", async () => {
    const user = userEvent.setup();
    await openParked(ONE_QUESTION);

    await screen.findByText("Which storage should drafts use?");
    expect(isLocked(readSend())).toBe(true);
    await user.type(readOwnAnswer(), "   ");
    expect(isLocked(readSend())).toBe(true);
    await user.click(findChoice("radio", "IndexedDB"));
    expect(isLocked(readSend())).toBe(false);
  });

  it("keeps Send disabled on the last question until that question is answered", async () => {
    const user = userEvent.setup();
    await openParked(QUESTIONS);

    await user.click(
      await screen.findByRole("radio", { name: (name) => name.startsWith("localStorage") }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(isLocked(readSend())).toBe(true);
    await user.click(findChoice("checkbox", "Search"));
    expect(isLocked(readSend())).toBe(false);
  });

  it("sends the answers of every question with session.respondToQuestion", async () => {
    const user = userEvent.setup();
    const { api } = await openParked(QUESTIONS);

    await user.click(
      await screen.findByRole("radio", { name: (name) => name.startsWith("localStorage") }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(findChoice("checkbox", "Sync"));
    await user.click(findChoice("checkbox", "Search"));
    await user.type(readOwnAnswer(), " Offline mode ");
    await user.click(readSend());

    await waitFor(() => {
      expect(readBodies(api.calls)).toEqual([
        {
          requestId: "req-2",
          answers: { Storage: "localStorage", Features: ["Sync", "Search", "Offline mode"] },
        },
      ]);
    });
  });

  it("locks the choices, the field and Send once the answers are sent", async () => {
    const user = userEvent.setup();
    const { api } = await openParked(ONE_QUESTION);

    await user.click(
      await screen.findByRole("radio", { name: (name) => name.startsWith("IndexedDB") }),
    );
    await user.click(readSend());
    await waitFor(() => {
      expect(readBodies(api.calls)).toHaveLength(1);
    });

    await waitFor(() => {
      expect(isLocked(readSend())).toBe(true);
    });
    expect(isLocked(findChoice("radio", "localStorage"))).toBe(true);
    expect(isLocked(findChoice("radio", "IndexedDB"))).toBe(true);
    expect(isLocked(readOwnAnswer())).toBe(true);
    await user.click(readSend());
    expect(readBodies(api.calls)).toEqual([
      { requestId: "req-2", answers: { Storage: "IndexedDB" } },
    ]);
  });

  it("goes to the next question on ↩ in the own-answer field", async () => {
    const user = userEvent.setup();
    const { api } = await openParked(QUESTIONS);

    await screen.findByText("Which storage should drafts use?");
    await user.type(readOwnAnswer(), "a sqlite file{Enter}");

    expect(screen.getByText("Question 2 of 2")).toBeDefined();
    expect(readBodies(api.calls)).toEqual([]);
  });

  it("stays on the question on ↩ while it is unanswered", async () => {
    const user = userEvent.setup();
    const { api } = await openParked(QUESTIONS);

    await screen.findByText("Which storage should drafts use?");
    await user.type(readOwnAnswer(), "{Enter}");

    expect(screen.getByText("Question 1 of 2")).toBeDefined();
    expect(readBodies(api.calls)).toEqual([]);
  });

  it("answers a question with no options with the user's own text", async () => {
    const user = userEvent.setup();
    const { api } = await openParked({
      ...QUESTIONS,
      detail: { questions: [{ ...STORAGE, options: [] }] },
    });

    const questionForm = (await screen.findByText("Which storage should drafts use?")).closest(
      "form",
    )!;
    expect(within(questionForm).queryAllByRole("radio")).toEqual([]);
    await user.type(readOwnAnswer(), "a sqlite file");
    await user.click(readSend());

    await waitFor(() => {
      expect(readBodies(api.calls)).toEqual([
        { requestId: "req-2", answers: { Storage: "a sqlite file" } },
      ]);
    });
  });

  it("turns the question down with the composer's Stop, which sends no answer", async () => {
    const user = userEvent.setup();
    const { api } = await openParked(QUESTIONS);

    await screen.findByText("Which storage should drafts use?");
    await user.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() => {
      expect(
        api.calls.filter((call) => call.path === `/api/v1/sessions/${SESSION_ID}/interrupt`),
      ).toHaveLength(1);
    });
    expect(readBodies(api.calls)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Tests for the thread's header:
 * - The header shows the project the thread belongs to.
 * - The workspace's other threads are tabs next to the title.
 * - A thread in a workspace offers a link to start a new thread there.
 *
 * The spec defines the text but not how to find these elements. These
 * tests assume:
 * - The header is still the breadcrumb's parent element, as above.
 * - A sibling tab is a link to that thread, so the tab strip is found
 *   through the links in the header.
 * - "+ New thread here" is a link with that text.
 * ------------------------------------------------------------------ */

const AT = "2026-09-10T09:00:00.000Z";

const WEBSHOP: Project = {
  id: "01a06d02-7000-7000-8000-000000000001",
  name: "webshop",
  createdAt: AT,
  updatedAt: AT,
};

const R_WEBSHOP: Resource = {
  id: "01a06d02-7100-7000-8000-000000000001",
  kind: "repo",
  remote: "git@github.com:acme/webshop.git",
  canonicalRemote: "github.com/acme/webshop",
  label: null,
  connectionId: null,
  setupCommand: null,
  workspaceInclude: true,
  projectIds: [WEBSHOP.id],
  createdAt: AT,
  updatedAt: AT,
};

const SIBLING_ID = "01a06d02-b100-7000-8000-000000000002";

const buildEphemeralWorkspace = (sessionIds: readonly string[]): Workspace => ({
  id: "01a06d02-7200-7000-8000-000000000002",
  runnerId: RUNNER_STARTED.id,
  kind: "ephemeral",
  status: "ready",
  ownership: "managed",
  retentionPolicy: "manual",
  path: null,
  observedAt: null,
  warnings: [],
  checkouts: [
    {
      checkoutId: "01a06d02-7300-7000-8000-000000000002",
      resourceId: R_WEBSHOP.id,
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
  sessionIds,
  keptUntil: null,
  createdAt: AT,
  provisionedAt: AT,
  lastUsedAt: AT,
  disposedAt: null,
});

const buildPrimaryWorkspace = (sessionIds: readonly string[]): Workspace => ({
  ...buildEphemeralWorkspace(sessionIds),
  id: "01a06d02-7200-7000-8000-000000000001",
  kind: "primary",
  checkouts: [
    {
      checkoutId: "01a06d02-7300-7000-8000-000000000001",
      resourceId: R_WEBSHOP.id,
      form: "clone",
      subdirectory: null,
      branch: "main",
      branches: ["main"],
      defaultBranch: "main",
      remoteBranches: [],
      headCommit: null,
      baseCommit: null,
      startingRevision: null,
      baseBranch: null,
    },
  ],
});

const SIBLING: Session = buildSession({
  id: SIBLING_ID,
  title: "Write the retry runbook",
  status: "busy",
  projectId: WEBSHOP.id,
});

/** Builds the routes for one thread's project, workspaces and sessions. */
const buildThreadWorldRoutes = (
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/projects": { body: { items: [WEBSHOP] } },
  "GET /api/v1/resources": { body: { items: [R_WEBSHOP] } },
  "GET /api/v1/workspaces": { body: { items: workspaces } },
  "GET /api/v1/sessions": { body: { items: sessions } },
  [`GET /api/v1/sessions/${SIBLING_ID}`]: { body: SIBLING },
  [`GET /api/v1/sessions/${SIBLING_ID}/transcript`]: { body: { items: [] } },
  [`GET /api/v1/sessions/${SIBLING_ID}/subagents`]: { body: { items: [] } },
});

const findThreadChrome = async (): Promise<HTMLElement> => {
  const crumb = await waitFor(() => screen.getByText(/\/$/));
  const row = crumb.parentElement;
  if (row === null) throw new Error("the breadcrumb has no parent row");
  return row;
};

describe("Thread: the header shows the project and the workspace's threads", () => {
  const buildSessionInWorkspace = (workspaceId: string): Session =>
    buildSession({ status: "idle", projectId: WEBSHOP.id, workspaceId });

  it("shows the thread's project in the breadcrumb", async () => {
    const fixture = buildSessionInWorkspace(buildEphemeralWorkspace([SESSION_ID]).id);
    await openApp(
      fixture,
      buildTwoCompletedTurns(),
      buildThreadWorldRoutes([buildEphemeralWorkspace([SESSION_ID])], [fixture]),
    );

    expect(readPageText(await findThreadChrome())).toMatch(/^webshop \/ Fix the login bug/);
  });

  it("keeps Threads / on a thread that belongs to no project", async () => {
    const fixture = buildSession({ status: "idle", projectId: null, workspaceId: null });
    await openApp(fixture, buildTwoCompletedTurns(), buildThreadWorldRoutes([], [fixture]));

    expect(readPageText(await findThreadChrome())).toMatch(/^Threads \/ Fix the login bug/);
  });

  it("shows no tabs next to the title while the workspace has one thread", async () => {
    const workspace = buildEphemeralWorkspace([SESSION_ID]);
    const fixture = buildSessionInWorkspace(workspace.id);
    await openApp(
      fixture,
      buildTwoCompletedTurns(),
      buildThreadWorldRoutes([workspace], [fixture]),
    );

    const chrome = await findThreadChrome();
    expect(readPageText(chrome)).toContain("Fix the login bug");
    expect(within(chrome).queryByRole("link", { name: /Write the retry runbook/ })).toBeNull();
  });

  it("shows the workspace's other threads next to the title, in the workspace's order", async () => {
    const workspace = buildEphemeralWorkspace([SESSION_ID, SIBLING_ID]);
    const fixture = buildSessionInWorkspace(workspace.id);
    await openApp(
      fixture,
      buildTwoCompletedTurns(),
      buildThreadWorldRoutes([workspace], [fixture, { ...SIBLING, workspaceId: workspace.id }]),
    );

    const chrome = await findThreadChrome();
    const sibling = within(chrome).getByRole("link", { name: /Write the retry runbook/ });
    expect(sibling.getAttribute("href")).toBe(`/threads/${SIBLING_ID}`);
    const text = readPageText(chrome);
    expect(text.indexOf("Fix the login bug")).toBeLessThan(text.indexOf("Write the retry runbook"));
  });

  it("shows concurrent threads in a main workspace as the same tabs", async () => {
    const workspace = buildPrimaryWorkspace([SESSION_ID, SIBLING_ID]);
    const fixture = buildSessionInWorkspace(workspace.id);
    await openApp(
      fixture,
      buildTwoCompletedTurns(),
      buildThreadWorldRoutes([workspace], [fixture, { ...SIBLING, workspaceId: workspace.id }]),
    );

    const chrome = await findThreadChrome();
    expect(within(chrome).getByRole("link", { name: /Write the retry runbook/ })).toBeDefined();
  });

  it("offers a new thread in the same workspace", async () => {
    const workspace = buildEphemeralWorkspace([SESSION_ID]);
    const fixture = buildSessionInWorkspace(workspace.id);
    await openApp(
      fixture,
      buildTwoCompletedTurns(),
      buildThreadWorldRoutes([workspace], [fixture]),
    );

    const chrome = await findThreadChrome();
    const here = within(chrome).getByRole("link", { name: "+ New thread here" });
    expect(here.getAttribute("href")).toBe(
      `/threads/new?project=${WEBSHOP.id}&workspace=${workspace.id}`,
    );
  });

  it("offers no + New thread here on a thread with no workspace", async () => {
    const fixture = buildSession({ status: "idle", projectId: WEBSHOP.id, workspaceId: null });
    await openApp(fixture, buildTwoCompletedTurns(), buildThreadWorldRoutes([], [fixture]));

    const chrome = await findThreadChrome();
    expect(within(chrome).queryByRole("link", { name: "+ New thread here" })).toBeNull();
  });
});

describe("Draft: a draft joining a workspace", () => {
  it("shows its project in the breadcrumb, comes last in the tab strip, and offers no actions", async () => {
    const workspace = buildEphemeralWorkspace([SESSION_ID]);
    const fixture = buildSession({
      status: "idle",
      projectId: WEBSHOP.id,
      workspaceId: workspace.id,
    });
    const api = stubApi({
      ...buildThreadRoutes(
        fixture,
        buildTwoCompletedTurns(),
        buildThreadWorldRoutes([workspace], [fixture]),
      ),
      "GET /api/v1/connections": { body: { items: [] } },
    });
    await renderApp({
      path: `/threads/new?project=${WEBSHOP.id}&workspace=${workspace.id}`,
      api: api.fetch,
      token: "held",
    });

    const chrome = await findThreadChrome();
    const text = readPageText(chrome);
    expect(text).toContain("webshop /");
    expect(text).toContain("New thread");
    // The draft comes last in the tab strip, after the thread already in the workspace.
    expect(text.indexOf("Fix the login bug")).toBeLessThan(text.indexOf("New thread"));
    // A draft has nothing to act on yet.
    expect(within(chrome).queryByRole("button", { name: "…" })).toBeNull();
    expect(within(chrome).queryByRole("link", { name: "+ New thread here" })).toBeNull();
  });
});

/* ------------------------------------------------------------------
 * The session view of an assistant's session: the session that answers
 * an assistant's conversation, opened from the conversation's Show work
 * link. The user talks to the assistant in its conversation, not here, so
 * the view leads back to the conversation instead of offering a
 * composer. The permission card stays, because a request is answered on
 * the session.
 * ------------------------------------------------------------------ */

const ADA: Assistant = {
  id: "01a06d02-a000-7000-8000-000000000001",
  name: "Ada",
  systemPrompt: "You are a helpful assistant.",
  instanceId: SESSION.instanceId,
  permissionProfileId: SESSION.permissionProfileId,
  accessMode: "approval-required",
  model: null,
  disallowedTools: [],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  mainConversationId: "01a06d02-c000-7000-8000-000000000001",
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T09:00:00.000Z",
};

/** Builds a session that answers Ada's web conversation. */
const buildAssistantSession = (overrides: Partial<Session> = {}): Session =>
  buildSession({
    title: "Answer Ada's conversation",
    agentId: ADA.id,
    conversationId: "01a06d02-c000-7000-8000-000000000001",
    ...overrides,
  });

/** The routes an assistant's session view may read Ada through: the list or her record. */
const ASSISTANT_ROUTES: Readonly<Record<string, Handler>> = {
  "GET /api/v1/assistants": { body: { items: [ADA] } },
  [`GET /api/v1/assistants/${ADA.id}`]: { body: ADA },
};

/** Returns the header's crumb link, the one outside the sidebar that names Ada. */
const findAssistantCrumb = async (): Promise<HTMLElement> =>
  waitFor(() => {
    const found = screen
      .getAllByRole("link", { name: "Ada" })
      .filter((link) => link.closest("nav") === null)[0];
    if (found === undefined) throw new Error("no Ada crumb link outside the sidebar");
    return found;
  });

describe("Thread: the session view of an assistant's session", () => {
  const REQUEST: SessionRequest = {
    requestId: "req-ada",
    itemId: "tool-ada",
    kind: "command_approval",
    decisions: ["allow", "deny"],
    detail: { command: "ls -la" },
  };

  it("shows Assistants / Ada / as the crumb, the name linking to the assistant's conversation", async () => {
    await openApp(
      buildAssistantSession({ status: "idle" }),
      buildTwoCompletedTurns(),
      ASSISTANT_ROUTES,
    );

    const crumb = await findAssistantCrumb();
    expect(crumb.getAttribute("href")).toBe(`/assistants/${ADA.id}`);
    expect(readPageText(crumb.closest("div"))).toMatch(
      /^Assistants \/ Ada \/ Answer Ada's conversation/,
    );
    expect(readPageText(crumb.closest("div"))).not.toContain("Threads");
  });

  it("renders no composer, and a line that links to the assistant's conversation in its place", async () => {
    await openApp(
      buildAssistantSession({ status: "idle" }),
      buildTwoCompletedTurns(),
      ASSISTANT_ROUTES,
    );

    expect(
      await screen.findByText("This session replies in your conversation with Ada."),
    ).toBeDefined();
    const open = screen.getByRole("link", { name: "Open conversation" });
    expect(open.getAttribute("href")).toBe(`/assistants/${ADA.id}`);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });

  // The controller rejects input.update and input.cancel on a conversation's
  // session, because the conversation already shows a queued input as the
  // owner's message.
  it("shows a queued input with no Steer and no Cancel", async () => {
    const fixture = buildAssistantSession({ status: "busy" });
    await openApp(fixture, buildTwoCompletedTurns(), {
      ...ASSISTANT_ROUTES,
      [`GET /api/v1/sessions/${fixture.id}/inputs`]: {
        body: { items: [buildQueuedInput({ sessionId: fixture.id, text: "Book Friday" })] },
      },
    });

    await screen.findByText("Book Friday");
    expect(screen.queryByRole("button", { name: /steer/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("still shows the permission card for an open request, and sends its answer to session.respondToApprovalRequest", async () => {
    const user = userEvent.setup();
    const fixture = buildAssistantSession({ status: "busy", openRequests: [REQUEST] });
    const api = stubApi({
      ...buildThreadRoutes(fixture, buildTwoCompletedTurns(), ASSISTANT_ROUTES),
      [`POST /api/v1/sessions/${fixture.id}/respond-to-approval-request`]: { body: fixture },
    });
    await renderApp({ path: `/threads/${fixture.id}`, api: api.fetch, token: "held" });

    const allow = buildApprovalCard(REQUEST).rows.find((row) => row.id === "allow")!;
    const describeLine = allow.describeLine.map((part) => part.text).join("");
    await user.click(
      await screen.findByRole("button", {
        name: (name) => name.includes(allow.label) && name.includes(describeLine),
      }),
    );

    await waitFor(() => {
      expect(
        api.calls.find((call) => call.path.endsWith("/respond-to-approval-request")),
      ).toMatchObject({
        method: "POST",
        path: `/api/v1/sessions/${fixture.id}/respond-to-approval-request`,
        body: { requestId: REQUEST.requestId, decision: "allow" },
      });
    });
  });

  // A busy assistant's session can be stopped from its session view, as a
  // thread can from its composer. The interrupt call returns while the agent
  // is still stopping, so the session is still busy; Stop goes away only when
  // the live connection reports the session idle.
  it("offers Stop while the session is busy, calls session.interrupt, and removes Stop once the session is idle", async () => {
    const user = userEvent.setup();
    const fixture = buildAssistantSession({ status: "busy" });
    let current = fixture;
    const { api, live } = await openApp(fixture, buildTwoCompletedTurns(), {
      ...ASSISTANT_ROUTES,
      [`GET /api/v1/sessions/${fixture.id}`]: () => ({ body: current }),
      [`POST /api/v1/sessions/${fixture.id}/interrupt`]: { body: fixture },
    });

    await screen.findByText("This session replies in your conversation with Ada.");
    await user.click(screen.getByRole("button", { name: /^stop$/i }));

    await waitFor(() => {
      expect(
        api.calls.filter(
          (call) =>
            call.method === "POST" && call.path === `/api/v1/sessions/${fixture.id}/interrupt`,
        ),
      ).toHaveLength(1);
    });
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeDefined();

    current = { ...fixture, status: "idle" };
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [fixture.id], kind: "updated" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
    });
  });

  it("keeps Stop gone when the interrupt answers after the session went idle", async () => {
    await checkLateInterruptAnswerKeepsStopGone(
      buildAssistantSession({ status: "busy" }),
      ASSISTANT_ROUTES,
    );
  });

  it("has no Stop control while the session is idle", async () => {
    await openApp(
      buildAssistantSession({ status: "idle" }),
      buildTwoCompletedTurns(),
      ASSISTANT_ROUTES,
    );

    await screen.findByText("This session replies in your conversation with Ada.");
    expect(screen.queryByRole("button", { name: /^stop$/i })).toBeNull();
  });

  // A session outlives its assistant, so the view must still open after the
  // assistant is deleted.
  it("still opens after the assistant was deleted, with a plain crumb and no link to a conversation", async () => {
    const fixture = buildAssistantSession({ status: "idle" });
    await openApp(fixture, buildTwoCompletedTurns(), {
      "GET /api/v1/assistants": { body: { items: [] } },
      [`GET /api/v1/assistants/${ADA.id}`]: {
        status: 404,
        body: buildErrorBody("not_found", "No assistant has that id."),
      },
    });

    expect(
      await screen.findByText(
        "This session replied in a conversation with an assistant that was deleted.",
      ),
    ).toBeDefined();
    const chrome = await findThreadChrome();
    expect(readPageText(chrome)).toMatch(/^Assistants \/ Answer Ada's conversation/);
    expect(chrome.firstElementChild?.querySelector("a")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open conversation" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  // The sidebar marks the assistant whose session is open, as it marks the
  // open thread.
  it("marks the assistant's row in the sidebar as the open one", async () => {
    const fixture = buildAssistantSession({ status: "idle" });
    await openApp(fixture, buildTwoCompletedTurns(), {
      ...ASSISTANT_ROUTES,
      "GET /api/v1/sessions": { body: { items: [fixture] } },
    });

    const nav = await screen.findByRole("navigation", { name: "Threads" });
    const row = await within(nav).findByRole("link", { name: /Ada/ });
    await waitFor(() => {
      expect(row.getAttribute("aria-current")).toBe("page");
    });
  });
});

describe("Thread: images", () => {
  const SHOT = {
    id: "01a06d02-6000-7000-8000-000000000001",
    name: "before.png",
    mimeType: "image/png",
    sizeBytes: 2048,
  } as const;
  const SECOND_SHOT = { ...SHOT, id: "01a06d02-6000-7000-8000-000000000002", name: "after.png" };

  it("shows a message of images alone as a bubble of previews, and opens them large", async () => {
    const user = userEvent.setup();
    const at = "2026-09-08T13:00:00.100Z";
    const detail = { text: "", attachments: [SHOT, SECOND_SHOT] };
    const { api } = await openApp(
      buildSession({ status: "idle" }),
      buildTranscript(
        buildTurnStart("t5", "2026-09-08T13:00:00.000Z"),
        [
          {
            _tag: "item.started",
            eventId: "",
            sessionId: SESSION_ID,
            at,
            turnId: "t5",
            itemId: "u5",
            kind: "user_message",
            detail,
          },
        ],
        buildAssistantMessage("t5", "2026-09-08T13:00:01.000Z", "a5", "Both look fine."),
        buildTurnCompletion("t5", "2026-09-08T13:00:02.000Z"),
      ),
    );

    await user.click(await screen.findByRole("button", { name: "Preview before.png" }));
    const lightbox = screen.getByRole("dialog", { name: "before.png (1/2)" });
    fireEvent.keyDown(lightbox, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "after.png (2/2)" })).toBeDefined();

    // Each image's bytes are read from the controller for its preview.
    const reads = api.calls.filter((call) => call.path.startsWith("/api/v1/attachments/"));
    expect(new Set(reads.map((call) => call.path))).toEqual(
      new Set([
        `/api/v1/attachments/${SHOT.id}/content`,
        `/api/v1/attachments/${SECOND_SHOT.id}/content`,
      ]),
    );
  });

  it("sends an active thread's images with its input, and empties the shelf once the input is taken", async () => {
    const user = userEvent.setup();
    const { api } = await openApp(buildSession({ status: "idle" }), buildTwoCompletedTurns(), {
      "POST /api/v1/attachments": { status: 201, body: SHOT },
      [`POST /api/v1/sessions/${SESSION_ID}/input`]: {
        body: { inputId: INPUT_ID, result: "opened" },
      },
    });

    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(picker, [new File(["png"], "before.png", { type: "image/png" })]);
    await user.type(screen.getByRole("textbox"), "Compare these");
    const send = screen.getByRole<HTMLButtonElement>("button", { name: /send/i });
    await waitFor(() => {
      expect(send.disabled).toBe(false);
    });
    await user.click(send);

    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
    });
    const input = api.calls.find((call) => call.path === `/api/v1/sessions/${SESSION_ID}/input`);
    expect(input?.body).toEqual({ text: "Compare these", attachments: [SHOT.id] });
  });

  it("shows a queued input's images as thumbnails beside its text", async () => {
    await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: {
        body: { items: [buildQueuedInput({ text: "", attachments: [SHOT, SECOND_SHOT] })] },
      },
    });

    const thumbnails = await screen.findByLabelText("2 images");
    expect(within(thumbnails).getByAltText("before.png")).toBeDefined();
    expect(within(thumbnails).getByAltText("after.png")).toBeDefined();
  });
});

/** The session whose agent sends messages into the thread under test. */
const SENDER = buildSession({
  id: "01a06d02-b100-7000-8000-000000000077",
  title: "Fix EU checkout",
});

/**
 * Builds one turn the owner opened at 10:00 with "Fix the login bug", into
 * which `SENDER`'s agent then steered "The 3DS fix is merged".
 */
const buildTurnWithAgentMessage = (senderSessionId: string = SENDER.id): TranscriptRow[] =>
  buildTranscript(
    buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
    buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
    buildUserMessage("t1", "2026-09-08T10:00:02.000Z", "u2", "The 3DS fix is merged", {
      steered: true,
      senderSessionId,
    }),
    buildAssistantMessage("t1", "2026-09-08T10:00:03.000Z", "a1", "Rebasing on main."),
    buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z"),
  );

/** Counts the reads of one session the app has made so far. */
const countSessionReads = (calls: readonly Call[], id: string): number =>
  calls.filter((call) => call.method === "GET" && call.path === `/api/v1/sessions/${id}`).length;

describe("Thread: a message another agent sent", () => {
  it("draws the owner's message and a steered agent message as two bubbles, the agent's naming its sender with a link to its thread", async () => {
    await openApp(buildSession({ status: "idle" }), buildTurnWithAgentMessage(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: { body: SENDER },
    });

    const agentMessage = await screen.findByRole("group", {
      name: "Message from Fix EU checkout",
    });
    expect(readPageText(agentMessage)).toBe(
      "The 3DS fix is mergedSent by Fix EU checkout · steered",
    );
    const link = within(agentMessage).getByRole("link", { name: "Fix EU checkout" });
    expect(link.getAttribute("href")).toBe(`/threads/${SENDER.id}`);

    // The owner's message is its own bubble, outside the agent's message,
    // with no sender line and no steered mark.
    const ownerText = screen.getByText("Fix the login bug", { selector: "p" });
    expect(agentMessage.contains(ownerText)).toBe(false);
    expect(ownerText.closest('[role="group"]')).toBeNull();
    expect(screen.getAllByText(/^Sent by/)).toHaveLength(1);
    expect(screen.getAllByText(/steered$/)).toHaveLength(1);
  });

  it("marks the owner's own steered message as steered, with no sender line", async () => {
    await openApp(
      buildSession({ status: "idle" }),
      buildTranscript(
        buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
        buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "Fix the login bug"),
        buildUserMessage("t1", "2026-09-08T10:00:02.000Z", "u2", "Also the logout", {
          steered: true,
        }),
        buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z"),
      ),
    );

    const steered = await screen.findByText("Also the logout", { selector: "p" });
    expect(steered.closest('[role="group"]')).toBeNull();
    expect(screen.getAllByText("steered")).toHaveLength(1);
    expect(screen.queryByText(/^Sent by/)).toBeNull();
  });

  it("names a sender that cannot be read as another agent, with no link and no error", async () => {
    await openApp(buildSession({ status: "idle" }), buildTurnWithAgentMessage(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: {
        status: 404,
        body: buildErrorBody("not_found", "No session has that id."),
      },
    });

    const agentMessage = await screen.findByRole("group", {
      name: "Message from another agent",
    });
    expect(readPageText(agentMessage)).toBe("The 3DS fix is mergedSent by another agent · steered");
    expect(within(agentMessage).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(readPageText()).toContain("Rebasing on main.");
  });

  it("names a sender that answers an assistant's conversation by the assistant, linking to its page", async () => {
    const sender = buildAssistantSession({ id: SENDER.id });
    await openApp(buildSession({ status: "idle" }), buildTurnWithAgentMessage(), {
      ...ASSISTANT_ROUTES,
      [`GET /api/v1/sessions/${SENDER.id}`]: { body: sender },
    });

    const agentMessage = await screen.findByRole("group", { name: "Message from Ada" });
    const link = within(agentMessage).getByRole("link", { name: "Ada" });
    expect(link.getAttribute("href")).toBe(`/assistants/${ADA.id}`);
  });

  it("reads each sender once, however many messages it sent", async () => {
    const { api } = await openApp(
      buildSession({ status: "idle" }),
      buildTranscript(
        buildTurnStart("t1", "2026-09-08T10:00:00.000Z"),
        buildUserMessage("t1", "2026-09-08T10:00:00.100Z", "u1", "First note", {
          senderSessionId: SENDER.id,
        }),
        buildUserMessage("t1", "2026-09-08T10:00:02.000Z", "u2", "Second note", {
          steered: true,
          senderSessionId: SENDER.id,
        }),
        buildTurnCompletion("t1", "2026-09-08T10:00:05.000Z"),
      ),
      { [`GET /api/v1/sessions/${SENDER.id}`]: { body: SENDER } },
    );

    expect(
      await screen.findAllByRole("group", { name: "Message from Fix EU checkout" }),
    ).toHaveLength(2);
    expect(countSessionReads(api.calls, SENDER.id)).toBe(1);
  });
});

describe("Thread: an agent message that arrives while the thread is open", () => {
  it("draws the message at once and adds its sender when the sender's read answers, never holding up the transcript", async () => {
    let answer = (): void => {};
    const { live } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: () =>
        new Promise((resolve) => {
          answer = () => resolve({ body: SENDER });
        }),
    });
    await waitFor(() => {
      expect(live.topics()).toContain(buildSessionStreamTopic(SESSION_ID));
    });

    act(() => {
      live.push(buildSessionStreamTopic(SESSION_ID), {
        _tag: "delta",
        items: buildUserMessage("t2", "2026-09-08T10:01:02.000Z", "u3", "The 3DS fix is merged", {
          steered: true,
          senderSessionId: SENDER.id,
        }).map((event, index) =>
          buildTranscriptRow(16 + index, { ...event, eventId: `e${16 + index}` }),
        ),
        cursor: "17",
      });
    });

    // The message and the rest of the transcript show while the sender is
    // read; only the sender line waits.
    await screen.findByText("The 3DS fix is merged", { selector: "p" });
    expect(readPageText()).toContain("Added a test too.");
    expect(screen.queryByText(/^Sent by/)).toBeNull();
    // Until its sender is known, the message is no group, since a group with
    // no name tells a screen reader nothing.
    expect(screen.queryByRole("group")).toBeNull();

    answer();
    const agentMessage = await screen.findByRole("group", { name: "Message from Fix EU checkout" });
    expect(within(agentMessage).getByRole("link", { name: "Fix EU checkout" })).toBeDefined();
  });
});

describe("Thread: a sender whose read is slow or fails", () => {
  /** A message `SENDER`'s agent queued into the busy thread. */
  const AGENT_INPUT = buildQueuedInput({ actor: `session:${SENDER.id}`, text: "Tag the release" });

  it("opens the thread while the sender's read gets no answer, and names the sender once it answers", async () => {
    let answer = (): void => {};
    // `openApp` resolves once the loaders have, so this test times out if a
    // loader waits for the sender without a limit. The loader gives up on it
    // after a second.
    await openApp(buildSession({ status: "busy" }), buildTurnWithAgentMessage(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: () =>
        new Promise((resolve) => {
          answer = () => resolve({ body: SENDER });
        }),
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [AGENT_INPUT] } },
    });

    // The transcript shows. The queued row starts with "From" and a
    // placeholder, so it never reads as the owner's, and the message has no
    // sender line yet.
    expect(await screen.findByText("Rebasing on main.")).toBeDefined();
    const row = screen.getByText("Tag the release").parentElement;
    expect(readPageText(row)).toBe("From … · Tag the releaseSteerCancel");
    expect(screen.queryByText(/^Sent by/)).toBeNull();

    answer();
    await waitFor(() => {
      expect(readPageText(row)).toBe("From Fix EU checkout · Tag the releaseSteerCancel");
    });
    const agentMessage = await screen.findByRole("group", { name: "Message from Fix EU checkout" });
    expect(readPageText(agentMessage)).toBe(
      "The 3DS fix is mergedSent by Fix EU checkout · steered",
    );
  });

  it("opens the thread while the queued inputs' read gets no answer, and shows them once it answers", async () => {
    let answer = (): void => {};
    // `openApp` resolves once the loaders have, so this test times out if the
    // loader waits for the queued inputs without a limit.
    await openApp(buildSession({ status: "busy" }), buildTurnWithAgentMessage(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: { body: SENDER },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () =>
        new Promise((resolve) => {
          answer = () => resolve({ body: { items: [AGENT_INPUT] } });
        }),
    });

    expect(await screen.findByText("Rebasing on main.")).toBeDefined();
    expect(screen.queryByText("Tag the release")).toBeNull();

    answer();
    const row = (await screen.findByText("Tag the release")).parentElement;
    await waitFor(() => {
      expect(readPageText(row)).toBe("From Fix EU checkout · Tag the releaseSteerCancel");
    });
  });

  it("reads a sender whose read failed only once, however often its messages mount or the window is focused", async () => {
    const { api, router } = await openApp(
      buildSession({ status: "idle" }),
      buildTurnWithAgentMessage(),
      {
        [`GET /api/v1/sessions/${SENDER.id}`]: {
          status: 500,
          body: buildErrorBody("internal", "The session could not be read."),
        },
      },
    );
    await screen.findByRole("group", { name: "Message from another agent" });

    // Leaving the thread and opening it again runs its loader again and
    // mounts its message again.
    for (let visit = 0; visit < 3; visit += 1) {
      await act(async () => {
        await router.navigate({ to: "/" });
      });
      await act(async () => {
        await router.navigate({ to: "/threads/$sessionId", params: { sessionId: SESSION_ID } });
      });
      await screen.findByRole("group", { name: "Message from another agent" });
    }
    // Focusing the window again does not read it either. A read focus started
    // would be sent within the wait.
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    focusManager.setFocused(undefined);
    expect(countSessionReads(api.calls, SENDER.id)).toBe(1);
  });
});

describe("Thread: a queued message another agent sent", () => {
  /** A message `SENDER`'s agent queued into the busy thread. */
  const AGENT_INPUT = buildQueuedInput({
    actor: `session:${SENDER.id}`,
    text: "The 3DS fix is merged",
  });

  it("starts the agent's row with From and a link to the sender, and leaves the owner's row as it is", async () => {
    await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: { body: SENDER },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: {
        body: {
          items: [buildQueuedInput({ id: "01a06d02-5000-7000-8000-000000000002" }), AGENT_INPUT],
        },
      },
    });

    const link = await screen.findByRole("link", { name: "Fix EU checkout" });
    expect(link.getAttribute("href")).toBe(`/threads/${SENDER.id}`);
    expect(readPageText(link.parentElement)).toBe("From Fix EU checkout");
    // A name too long for the row is cut, so its whole text is the tooltip.
    expect(link.getAttribute("title")).toBe("Fix EU checkout");
    expect(readPageText()).toContain("From Fix EU checkout · The 3DS fix is merged");
    // The owner's row has no sender.
    expect(screen.getAllByText(/^From/)).toHaveLength(1);
    expect(screen.getByText("Also check the logs").previousElementSibling).toBeNull();
  });

  it("names the sender at the row's first paint, because the loader waited for its read", async () => {
    await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      // The sender answers after the thread's own reads, but well inside the
      // loader's wait.
      [`GET /api/v1/sessions/${SENDER.id}`]: () =>
        new Promise((resolve) => setTimeout(() => resolve({ body: SENDER }), 50)),
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [AGENT_INPUT] } },
    });

    // `openApp` resolves once the loaders have, so nothing is awaited here: a
    // row whose sender the loader did not wait for would show "From …".
    const row = screen.getByText("The 3DS fix is merged").parentElement;
    expect(readPageText(row)).toBe("From Fix EU checkout · The 3DS fix is mergedSteerCancel");
  });

  it("starts the row with From another agent when the sender cannot be read", async () => {
    await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: {
        status: 403,
        body: buildErrorBody("forbidden", "The caller may not read that session."),
      },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: { body: { items: [AGENT_INPUT] } },
    });

    const row = (await screen.findByText("The 3DS fix is merged")).parentElement;
    await waitFor(() => {
      expect(readPageText(row)).toBe("From another agent · The 3DS fix is mergedSteerCancel");
    });
    expect(within(row!).queryByRole("link")).toBeNull();
  });

  it.each([
    ["Steer", "POST", `/api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}/steer`],
    ["Cancel", "DELETE", `/api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}`],
  ] as const)("lets the owner %s the agent's queued row", async (label, method, path) => {
    const user = userEvent.setup();
    let acted = false;
    const { api } = await openApp(buildSession({ status: "busy" }), buildTwoCompletedTurns(), {
      [`GET /api/v1/sessions/${SENDER.id}`]: { body: SENDER },
      [`GET /api/v1/sessions/${SESSION_ID}/inputs`]: () => ({
        body: { items: acted ? [] : [AGENT_INPUT] },
      }),
      [`POST /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}/steer`]: () => {
        acted = true;
        return { body: { inputId: INPUT_ID, result: "steered" } };
      },
      [`DELETE /api/v1/sessions/${SESSION_ID}/inputs/${INPUT_ID}`]: () => {
        acted = true;
        return { body: { ...AGENT_INPUT, status: "cancelled" } };
      },
    });

    await screen.findByRole("link", { name: "Fix EU checkout" });
    await user.click(screen.getByRole("button", { name: label }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === method && call.path === path)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("The 3DS fix is merged")).toBeNull();
    });
  });
});
