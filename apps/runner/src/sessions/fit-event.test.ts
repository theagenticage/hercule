import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { MAX_FRAME_BYTES, RunnerToController, type ProviderEvent } from "@hercule/protocol";
import { fitEventToFrame } from "./fit-event";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const at = "2026-10-08T10:00:00.000Z";

const encodeFrame = Schema.encodeUnknownSync(RunnerToController);

/**
 * Measures an event the way the socket sends it: the frame encoded with the
 * protocol schema, then written as JSON. Encoding also fails on an event the
 * protocol would refuse, such as a warning whose message is too long.
 */
const measureSentBytes = (event: ProviderEvent): number =>
  Buffer.byteLength(
    JSON.stringify(encodeFrame({ _tag: "sessionEvent", seq: Number.MAX_SAFE_INTEGER, event })),
  );

/** Fits `event` and checks the guarantee: every returned event fits in one frame. */
const fitAndCheck = (event: ProviderEvent): ReadonlyArray<ProviderEvent> => {
  const fitted = fitEventToFrame(event);
  for (const one of fitted) expect(measureSentBytes(one)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  return fitted;
};

/** A string that takes `bytes` bytes of JSON. */
const buildText = (bytes: number): string => "x".repeat(bytes);

const RAW = { source: "claude.sdk.message", payload: { blob: buildText(MAX_FRAME_BYTES) } };

const buildDelta = (delta: string, extra: Partial<ProviderEvent> = {}): ProviderEvent =>
  ({
    _tag: "content.delta",
    eventId: "e-delta",
    sessionId: SESSION,
    at,
    subagentId: "agent-1",
    turnId: "t-1",
    itemId: "i-1",
    streamKind: "assistant_text",
    delta,
    ...extra,
  }) as ProviderEvent;

const buildItemCompleted = (extra: Partial<ProviderEvent>): ProviderEvent =>
  ({
    _tag: "item.completed",
    eventId: "e-item",
    sessionId: SESSION,
    at,
    turnId: "t-1",
    itemId: "toolu_01",
    kind: "tool_call",
    status: "completed",
    ...extra,
  }) as ProviderEvent;

type Warning = Extract<ProviderEvent, { readonly _tag: "runtime.warning" }>;
type Delta = Extract<ProviderEvent, { readonly _tag: "content.delta" }>;
type TurnCompleted = Extract<ProviderEvent, { readonly _tag: "turn.completed" }>;

/** Native ids too many to fit in one frame: their number has no bound. */
const MANY_REFS = Object.fromEntries(
  Array.from({ length: 5000 }, (_, index) => [`ref-${String(index)}`, buildText(500)]),
);

const expectWarning = (event: ProviderEvent | undefined): Warning => {
  expect(event?._tag).toBe("runtime.warning");
  return event as Warning;
};

describe("fitting an event into one frame", () => {
  it("returns an event that fits alone and unchanged", () => {
    const event = buildDelta("hello", { raw: { source: "x", payload: { small: true } } });
    expect(fitAndCheck(event)).toEqual([event]);
  });

  it("drops only the raw payload when that is enough, and says so on the event's agent and turn", () => {
    const event = buildItemCompleted({
      subagentId: "agent-1",
      detail: { content: "ok" },
      raw: RAW,
    });
    const [item, warning, ...rest] = fitAndCheck(event);

    expect(rest).toEqual([]);
    expect(item).not.toHaveProperty("raw");
    expect(item).toEqual({ ...event, raw: undefined });
    expect(expectWarning(warning)).toMatchObject({
      sessionId: SESSION,
      subagentId: "agent-1",
      turnId: "t-1",
      at,
    });
    expect(warning?.eventId).not.toBe(event.eventId);
    expect((warning as Warning).message).toBe(
      "A tool call result was 2.01 MiB, too large to send (the limit is 2 MiB), so its raw data was left out. Item toolu_01.",
    );
  });

  it("drops the detail of an item as well when the raw payload alone is not enough", () => {
    const event = buildItemCompleted({
      detail: { content: buildText(MAX_FRAME_BYTES) },
      raw: RAW,
    });
    const [item, warning, ...rest] = fitAndCheck(event);

    expect(rest).toEqual([]);
    expect(item).not.toHaveProperty("detail");
    expect(item).not.toHaveProperty("raw");
    expect(item).toMatchObject({ _tag: "item.completed", itemId: "toolu_01", status: "completed" });
    expect(expectWarning(warning).message).toMatch(
      /^A tool call result was 4\.\d\d MiB, too large to send \(the limit is 2 MiB\), so its output and raw data were left out\. Item toolu_01\.$/,
    );
  });

  it("names only the detail when the item had no raw payload", () => {
    const event = buildItemCompleted({ detail: { content: buildText(MAX_FRAME_BYTES) } });
    const [, warning] = fitAndCheck(event);
    expect(expectWarning(warning).message).toMatch(
      /, so its output was left out\. Item toolu_01\.$/,
    );
  });

  it("calls an item's detail its details when the item has only started", () => {
    const event = buildItemCompleted({
      _tag: "item.started",
      detail: { input: buildText(MAX_FRAME_BYTES) },
      raw: RAW,
    });
    const [item, warning] = fitAndCheck(event);
    expect(item).not.toHaveProperty("detail");
    expect(expectWarning(warning).message).toMatch(
      /^A tool call input was 4\.\d\d MiB, .*, so its details and raw data were left out\. Item toolu_01\.$/,
    );
  });

  it("splits a long delta into consecutive deltas with the same text and no warning", () => {
    // Each control character takes six bytes of JSON, the most one code unit
    // can take, so this is the worst case for the size of a piece.
    const text = "\u0001".repeat(MAX_FRAME_BYTES / 2);
    const event = buildDelta(text);
    const pieces = fitAndCheck(event) as ReadonlyArray<Delta>;

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece._tag === "content.delta")).toBe(true);
    expect(pieces.map((piece) => piece.delta).join("")).toBe(text);
    expect(pieces[0]?.eventId).toBe(event.eventId);
    expect(new Set(pieces.map((piece) => piece.eventId)).size).toBe(pieces.length);
    for (const piece of pieces) {
      expect(piece).toMatchObject({ subagentId: "agent-1", turnId: "t-1", itemId: "i-1" });
    }
  });

  it("never cuts a delta between the two halves of a character", () => {
    // Two strings with the pairs at opposite offsets, so whichever cut the
    // piece size gives, one of them puts it inside a pair.
    for (const text of ["😀".repeat(MAX_FRAME_BYTES), `a${"😀".repeat(MAX_FRAME_BYTES)}`]) {
      const pieces = fitAndCheck(buildDelta(text)) as ReadonlyArray<Delta>;
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.map((piece) => piece.delta).join("")).toBe(text);
      for (const piece of pieces) {
        expect(piece.delta, "a piece ends in half a character").not.toMatch(/[\ud800-\udbff]$/);
        expect(piece.delta, "a piece starts with half a character").not.toMatch(/^[\udc00-\udfff]/);
      }
    }
  });

  it("warns after the pieces of a split delta whose raw payload was dropped", () => {
    const fitted = fitAndCheck(buildDelta(buildText(MAX_FRAME_BYTES), { raw: RAW }));
    const warning = expectWarning(fitted.at(-1));
    expect(fitted.slice(0, -1).every((event) => event._tag === "content.delta")).toBe(true);
    expect(warning.message).toMatch(
      /^A piece of streamed text was 4\.\d\d MiB, .*, so its raw data was left out\. Item i-1\.$/,
    );
  });

  it("replaces an ok structured result with a schema failure, so the turn still ends", () => {
    const event: ProviderEvent = {
      _tag: "turn.completed",
      eventId: "e-turn",
      sessionId: SESSION,
      at,
      subagentId: "agent-1",
      turnId: "t-1",
      state: "completed",
      usage: { inputTokens: 1, outputTokens: 2 },
      structuredResult: { outcome: "ok", value: { text: buildText(MAX_FRAME_BYTES) } },
      raw: RAW,
    };
    const [turn, warning, ...rest] = fitAndCheck(event);

    expect(rest).toEqual([]);
    const { structuredResult, ...turnWithoutResult } = turn as TurnCompleted;
    expect(turnWithoutResult).toEqual({ ...event, raw: undefined, structuredResult: undefined });
    expect(structuredResult?.outcome).toBe("schema-failure");
    // The result's size is given without the raw data, which is not part of it.
    expect(structuredResult?.outcome === "schema-failure" && structuredResult.reason).toBe(
      "The turn's structured result was 2.01 MiB, too large to send (the limit is 2 MiB).",
    );
    expect(expectWarning(warning)).toMatchObject({ subagentId: "agent-1", turnId: "t-1" });
    expect((warning as Warning).message).toMatch(
      /^The end of a turn was 4\.\d\d MiB, too large to send \(the limit is 2 MiB\), so its structured result was replaced by a failure, and its raw data was left out\.$/,
    );
  });

  it("drops native ids last, so a turn's end and a session's end are never dropped", () => {
    const turnEnd: ProviderEvent = {
      _tag: "turn.completed",
      eventId: "e-turn",
      sessionId: SESSION,
      at,
      turnId: "t-1",
      state: "completed",
      structuredResult: { outcome: "ok", value: { text: buildText(MAX_FRAME_BYTES) } },
      providerRefs: MANY_REFS,
    };
    const sessionEnd: ProviderEvent = {
      _tag: "session.exited",
      eventId: "e-exit",
      sessionId: SESSION,
      at,
      reason: "crash",
      providerRefs: MANY_REFS,
    };

    const [turn, turnWarning] = fitAndCheck(turnEnd);
    expect(turn).toMatchObject({ _tag: "turn.completed", turnId: "t-1" });
    expect(turn).not.toHaveProperty("providerRefs");
    expect(expectWarning(turnWarning).message).toMatch(
      /, so its structured result was replaced by a failure, and its native ids were left out\.$/,
    );

    const [exit, exitWarning] = fitAndCheck(sessionEnd);
    expect(exit).toMatchObject({ _tag: "session.exited", reason: "crash" });
    expect(expectWarning(exitWarning).message).toMatch(
      /^The session's end was 2\.\d\d MiB, .*, so its native ids were left out\.$/,
    );
  });

  it("replaces an event that cannot be shrunk enough with the warning alone", () => {
    // A request's list of paths has no bound, and no step shortens it.
    const event: ProviderEvent = {
      _tag: "request.opened",
      eventId: "e-request",
      sessionId: SESSION,
      at,
      request: {
        requestId: "r-1",
        itemId: "i-1",
        kind: "file_change_approval",
        detail: { paths: Array.from({ length: 5000 }, () => buildText(500)) },
        decisions: ["allow", "deny"],
      },
    };
    const [warning, ...rest] = fitAndCheck(event);

    expect(rest).toEqual([]);
    expect(expectWarning(warning)).toMatchObject({ sessionId: SESSION });
    expect(warning).not.toHaveProperty("subagentId");
    expect((warning as Warning).message).toMatch(
      /^A request was 2\.\d+ MiB, too large to send \(the limit is 2 MiB\), so it was left out\.$/,
    );
  });

  it("writes An before a kind that starts with a vowel", () => {
    const event = buildItemCompleted({ kind: "assistant_message", raw: RAW });
    const [, warning] = fitAndCheck(event);
    expect(expectWarning(warning).message).toMatch(/^An assistant message result was /);
  });

  it("puts the warning about a subagent's introduction on the agent that started it", () => {
    const event: ProviderEvent = {
      _tag: "subagent.started",
      eventId: "e-sub",
      sessionId: SESSION,
      at,
      subagentId: "child",
      parentSubagentId: "parent",
      raw: RAW,
    };
    const [, warning] = fitAndCheck(event);
    expect(expectWarning(warning).subagentId).toBe("parent");
  });
});
