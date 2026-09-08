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
import type { Session, TranscriptRow } from "@hydra/contract";
import { sessionStreamTopic, sessionTapTopic } from "@hydra/contract";
import { renderApp, stubApi, type Handler } from "../../../app/testing";

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
const TOOL_TARGET = JSON.stringify(TOOL_DETAIL);

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
    expect(reading()).toContain(
      `command · ${JSON.stringify({ name: "Bash", input: { command: "pnpm test" } })} · running`,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await settle();
    screen.getByRole("button", { name: /^Working for 4s$/ });
  });

  it("keeps the shimmer static under prefers-reduced-motion", async () => {
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
    expect(divider.className).not.toContain("hydra-thread-shimmer");
    expect(divider.className).toContain("text-live");
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

  it("lets the coalesced :stream row win over the buffer, and ignores later tap deltas for that item", async () => {
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

describe("Thread: top bar (AC-23)", () => {
  it("shows the thread's title and a mono thread · <short id> crumb instead of the screen title", async () => {
    await open(session({ status: "idle", title: "Fix the login bug" }), twoCompletedTurns());

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Fix the login bug");
    });
    const crumb = screen.getByText("thread · 01a06d02");
    expect(crumb.className).toContain("font-mono");
  });
});
