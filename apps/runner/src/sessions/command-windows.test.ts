import type { HarnessEvent } from "@hercule/protocol";
import { describe, expect, it } from "vitest";
import type { StartMark } from "../edit-marks";
import { makeCommandWindows } from "./command-windows";

const A = "session-a";
const B = "session-b";
const JOINED_AT = 1n;

/** Builds a harness event from the fields the windows read. */
const buildEvent = (fields: object) => fields as unknown as HarnessEvent;

const itemStarted = (sessionId: string, itemId: string) =>
  buildEvent({ _tag: "item.started", sessionId, itemId, kind: "command_execution" });

const itemCompleted = (sessionId: string, itemId: string, status = "completed") =>
  buildEvent({ _tag: "item.completed", sessionId, itemId, kind: "command_execution", status });

const requestOpened = (sessionId: string, itemId: string, requestId: string) =>
  buildEvent({
    _tag: "request.opened",
    sessionId,
    request: { requestId, itemId, kind: "command_approval" },
  });

const requestResolved = (sessionId: string, requestId: string, decision = "accept") =>
  buildEvent({ _tag: "request.resolved", sessionId, requestId, decision });

const turnCompleted = (sessionId: string) =>
  buildEvent({ _tag: "turn.completed", sessionId, state: "completed" });

/**
 * Makes windows on a fake file clock. `setNow` sets what the next mark reads,
 * and `markStart` leaves a gate mark that the next read of marks takes.
 */
const makeWindows = () => {
  let now = 0n;
  const pending = new Map<string, Array<StartMark>>();
  const windows = makeCommandWindows({
    takeMark: () => now,
    takeStartMarks: (sessionId) => pending.get(sessionId)?.splice(0) ?? [],
  });
  const markStart = (
    sessionId: string,
    toolUseId: string,
    startNs: bigint,
    shellCommand?: string,
  ) =>
    pending.set(sessionId, [
      ...(pending.get(sessionId) ?? []),
      { toolUseId, startNs, shellCommand },
    ]);
  /** Lists the windows as the attribution rule reads them, as `[session, start, end]`. */
  const list = () =>
    windows
      .buildCommandWindows(new Map([A, B].map((id) => [id, { joinedAtNs: JOINED_AT }])))
      .map((window) => [window.sessionId, window.startNs, window.endNs]);
  const setNow = (next: bigint) => {
    now = next;
  };
  return { windows, markStart, list, setNow };
};

describe("the start", () => {
  it("is the gate's mark, and the window holds until its item completes", () => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    windows.recordEvent(itemStarted(A, "c-1"));
    expect(list()).toEqual([[A, 10n, undefined]]);
    setNow(20n);
    expect(windows.recordEvent(itemCompleted(A, "c-1"))).toEqual({ startWasUnknown: false });
    expect(list()).toEqual([[A, 10n, 20n]]);
  });

  it("is the earliest mark, because a later one may come from a gate that ran again mid-item", () => {
    const { markStart, list } = makeWindows();
    markStart(A, "c-1", 10n);
    markStart(A, "c-1", 15n);
    expect(list()).toEqual([[A, 10n, undefined]]);
    markStart(A, "c-1", 5n);
    expect(list()).toEqual([[A, 5n, undefined]]);
  });

  it("is the time the session joined when no mark is known", () => {
    const { windows, list, setNow } = makeWindows();
    windows.recordEvent(itemStarted(A, "c-1"));
    setNow(20n);
    expect(windows.recordEvent(itemCompleted(A, "c-1"))).toEqual({ startWasUnknown: true });
    expect(list()).toEqual([[A, JOINED_AT, 20n]]);
  });

  it("stays when the mark of an item that already completed is read late", () => {
    const { windows, markStart, list, setNow } = makeWindows();
    setNow(20n);
    windows.recordEvent(itemCompleted(A, "c-1"));
    markStart(A, "c-1", 15n);
    expect(list()).toEqual([[A, JOINED_AT, 20n]]);
  });
});

describe("a command that may import content", () => {
  /** Returns, for each window, its item's session and whether it may import content. */
  const listImports = (windows: ReturnType<typeof makeWindows>["windows"]) =>
    windows
      .buildCommandWindows(new Map([A, B].map((id) => [id, { joinedAtNs: JOINED_AT }])))
      .map((window) => [window.sessionId, window.mayImportContent]);

  it("marks its window from its gate's mark, through a Request, and from a mark read late", () => {
    const { windows, markStart, setNow } = makeWindows();
    markStart(A, "merge", 10n, "git merge origin/main");
    markStart(B, "edit", 10n, "sed -i s/a/b/ f");
    windows.recordEvent(requestOpened(A, "merge", "req-1"));
    setNow(20n);
    windows.recordAllow(A, "req-1");
    expect(listImports(windows)).toEqual([
      [A, true],
      [B, false],
    ]);
    setNow(30n);
    windows.recordEvent(itemCompleted(B, "pull"));
    markStart(B, "pull", 25n, "git pull");
    expect(listImports(windows)).toEqual([
      [A, true],
      [B, false],
      [B, true],
    ]);
  });
});

describe("a Request", () => {
  it("parks the window until the allow, which is then the start", () => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(requestOpened(A, "c-1", "req-1"));
    expect(list()).toEqual([]);
    setNow(30n);
    windows.recordAllow(A, "req-1");
    markStart(A, "c-1", 40n);
    expect(list()).toEqual([[A, 30n, undefined]]);
  });

  it("parks only the first time, because an allowed item may already have written", () => {
    const { windows, list, setNow } = makeWindows();
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(requestOpened(A, "c-1", "req-1"));
    setNow(20n);
    windows.recordAllow(A, "req-1");
    windows.recordEvent(requestOpened(A, "c-1", "req-2"));
    setNow(40n);
    windows.recordAllow(A, "req-2");
    expect(list()).toEqual([[A, 20n, undefined]]);
  });

  it("on an item that already runs parks nothing and moves no start", () => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordRequestOnRunningItem(A, "req-stdin");
    windows.recordEvent(requestOpened(A, "c-1", "req-stdin"));
    setNow(30n);
    windows.recordAllow(A, "req-stdin");
    expect(list()).toEqual([[A, 10n, undefined]]);
  });

  it("on an item with a running process parks nothing", () => {
    const { windows, markStart, list } = makeWindows();
    markStart(A, "c-1", 10n);
    list();
    windows.recordProcessStarted(A, "c-1");
    windows.recordEvent(requestOpened(A, "c-1", "req-1"));
    expect(list()).toEqual([[A, 10n, undefined]]);
  });

  it("that the runner did not answer opens the window from its gate's mark", () => {
    const { windows, markStart, list } = makeWindows();
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(requestOpened(A, "c-1", "req-1"));
    markStart(A, "c-1", 10n);
    windows.recordEvent(requestResolved(A, "req-1"));
    expect(list()).toEqual([[A, 10n, undefined]]);
  });

  it.each([
    ["allowed", undefined],
    ["resolved", "accept"],
    ["denied", "deny"],
    ["cancelled", "cancel"],
  ])(
    "with no mark and no item is forgotten when %s, as a Codex network approval is",
    (_, decision) => {
      const { windows, list, setNow } = makeWindows();
      windows.recordEvent(requestOpened(A, "c-1#network", "req-1"));
      if (decision === undefined) windows.recordAllow(A, "req-1");
      else windows.recordEvent(requestResolved(A, "req-1", decision));
      expect(list()).toEqual([]);
      expect(windows.hasClosedWindows()).toBe(false);
      // Nothing waits for an item under that id: a process reported under it
      // opens a window that the process's end closes.
      windows.recordProcessStarted(A, "c-1#network");
      setNow(20n);
      windows.recordProcessEnded(A, "c-1#network");
      expect(list()).toEqual([[A, JOINED_AT, 20n]]);
    },
  );

  it("keeps its window open after a resolve that follows the allow", () => {
    const { windows, list, setNow } = makeWindows();
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(requestOpened(A, "c-1", "req-1"));
    setNow(20n);
    windows.recordAllow(A, "req-1");
    windows.recordEvent(requestResolved(A, "req-1"));
    expect(list()).toEqual([[A, 20n, undefined]]);
  });

  it("that is declined holds nothing, and the item's failed completion opens no window", () => {
    const { windows, markStart, list } = makeWindows();
    markStart(A, "c-1", 10n);
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(requestOpened(A, "c-1", "req-1"));
    windows.recordEvent(requestResolved(A, "req-1", "deny"));
    expect(list()).toEqual([]);
    expect(windows.recordEvent(itemCompleted(A, "c-1", "failed"))).toEqual({
      startWasUnknown: false,
    });
    expect(list()).toEqual([]);
    expect(windows.hasClosedWindows()).toBe(false);
  });
});

describe("the end", () => {
  it("forgets the window of an item that was declined", () => {
    const { windows, markStart, list } = makeWindows();
    markStart(A, "c-1", 10n);
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(itemCompleted(A, "c-1", "declined"));
    expect(list()).toEqual([]);
  });

  // A harness can report a turn's end before the start of a command that
  // already runs, and an old turn's end after the gate of the next turn.
  it.each([
    ["a gate whose item has not shown up", false],
    ["an item that started", true],
  ])("does not come with a turn's end, for %s", (_, started) => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    list();
    windows.recordEvent(turnCompleted(A));
    if (started) windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordEvent(turnCompleted(A));
    expect(list()).toEqual([[A, 10n, undefined]]);
    setNow(40n);
    windows.recordEvent(itemCompleted(A, "c-1"));
    expect(list()).toEqual([[A, 10n, 40n]]);
  });

  it.each([
    ["the item completes first", ["item", "process"]],
    ["the process ends first", ["process", "item"]],
  ] as const)("waits for the item and its process when %s", (_, order) => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    windows.recordEvent(itemStarted(A, "c-1"));
    windows.recordProcessStarted(A, "c-1");
    const release = (hold: string) =>
      hold === "item"
        ? windows.recordEvent(itemCompleted(A, "c-1"))
        : windows.recordProcessEnded(A, "c-1");
    setNow(20n);
    release(order[0]);
    expect(list()).toEqual([[A, 10n, undefined]]);
    setNow(30n);
    release(order[1]);
    expect(list()).toEqual([[A, 10n, 30n]]);
  });

  it("opens again, with its start, when a process starts after its item completed", () => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    setNow(20n);
    windows.recordEvent(itemCompleted(A, "c-1"));
    windows.recordProcessStarted(A, "c-1");
    expect(list()).toEqual([[A, 10n, undefined]]);
    setNow(30n);
    windows.recordProcessEnded(A, "c-1");
    expect(list()).toEqual([[A, 10n, 30n]]);
  });

  it("closes the window of a process whose item's window was already forgotten", () => {
    const { windows, list, setNow } = makeWindows();
    windows.recordProcessStarted(A, "c-1");
    expect(list()).toEqual([[A, JOINED_AT, undefined]]);
    setNow(30n);
    windows.recordProcessEnded(A, "c-1");
    expect(list()).toEqual([[A, JOINED_AT, 30n]]);
  });

  it("at exit closes every open window of the session and forgets its waiting Requests", () => {
    const { windows, markStart, list, setNow } = makeWindows();
    markStart(A, "c-1", 10n);
    markStart(A, "c-2", 11n);
    markStart(B, "c-3", 12n);
    windows.recordEvent(requestOpened(A, "c-2", "req-2"));
    setNow(30n);
    windows.closeSessionWindows(A);
    expect(list()).toEqual([
      [A, 10n, 30n],
      [B, 12n, undefined],
    ]);
  });

  it("forgets every window and Request of a session the watch no longer keeps", () => {
    const { windows, markStart, list } = makeWindows();
    markStart(A, "c-1", 10n);
    markStart(B, "c-3", 12n);
    list();
    windows.recordRequestOnRunningItem(A, "req-stdin");
    windows.forgetSessionWindows(A);
    // The Request is forgotten too, so on a session that starts again under
    // the same id it parks its item.
    windows.recordEvent(requestOpened(A, "c-4", "req-stdin"));
    windows.recordEvent(itemStarted(A, "c-4"));
    expect(list()).toEqual([[B, 12n, undefined]]);
  });
});

describe("forgetting", () => {
  it("forgets a closed window once a listing that started after it closed succeeded", () => {
    const { windows, list, setNow } = makeWindows();
    setNow(10n);
    windows.recordEvent(itemCompleted(A, "c-1"));
    expect(windows.hasClosedWindows()).toBe(true);
    const first = windows.startListing();
    // This window closes while the first listing runs, which may have read
    // the files before its last write.
    setNow(20n);
    windows.recordEvent(itemCompleted(A, "c-2"));
    windows.forgetWindowsClosedBefore(first);
    expect(list()).toEqual([[A, JOINED_AT, 20n]]);
    windows.forgetWindowsClosedBefore(windows.startListing());
    expect(windows.hasClosedWindows()).toBe(false);
  });

  it("never forgets an open window", () => {
    const { windows, markStart, list } = makeWindows();
    markStart(A, "c-1", 10n);
    list();
    windows.forgetWindowsClosedBefore(Infinity);
    expect(list()).toEqual([[A, 10n, undefined]]);
  });
});
