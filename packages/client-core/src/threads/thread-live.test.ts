/**
 * Tests the decisions an open thread makes about its live deliveries: the
 * stream's cursor, what a stream delivery does to the held transcript, and
 * what a tap delivery hands to the tail buffer.
 */
import { describe, expect, it } from "vitest";
import type { TapItem, TranscriptRow } from "@hercule/contract";
import type { LiveDelta } from "../live/live";
import { buildStreamCursor, decideStreamDelivery, decideTapDelivery } from "./thread-live";

const buildRow = (position: number): TranscriptRow => ({
  position,
  at: "2026-09-30T09:00:00.000Z",
  event: {
    _tag: "turn.started",
    eventId: `e${position}`,
    sessionId: "01a06d02-b100-7000-8000-000000000001",
    at: "2026-09-30T09:00:00.000Z",
    turnId: `t${position}`,
  },
});

const TAP: TapItem = {
  turnId: "t1",
  itemId: "t1-answer",
  streamKind: "assistant_text",
  delta: "The fix ",
};

/** Returns a delivery of `items` with no flag set, with `flags` applied over it. */
const buildDelta = (
  items: LiveDelta["items"],
  flags: Partial<Pick<LiveDelta, "reset" | "replay" | "gone">> = {},
): LiveDelta => ({
  cursor: null,
  items,
  reset: false,
  replay: false,
  gone: false,
  ...flags,
});

describe("buildStreamCursor", () => {
  it("resumes after the last held row", () => {
    expect(buildStreamCursor([buildRow(1), buildRow(2), buildRow(7)])).toBe("7");
  });

  it("asks for the whole log when no row is held", () => {
    expect(buildStreamCursor([])).toBe("0");
  });
});

describe("decideStreamDelivery", () => {
  const held = [buildRow(1), buildRow(2)];

  it("hands over the new rows and the transcript with them merged in by position", () => {
    const delivery = decideStreamDelivery([buildRow(1), buildRow(3)], buildDelta([buildRow(2)]));
    expect(delivery.kind).toBe("rows");
    if (delivery.kind !== "rows") return;
    expect(delivery.fresh.map((row) => row.position)).toEqual([2]);
    expect(delivery.transcript.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(delivery.replay).toBe(false);
  });

  it("leaves out the rows already held, so the tail buffer never applies a row twice", () => {
    const delivery = decideStreamDelivery(held, buildDelta([buildRow(2), buildRow(3)]));
    expect(delivery.kind === "rows" && delivery.fresh.map((row) => row.position)).toEqual([3]);
  });

  it("marks the rows of a replay, so the caller skips the items open after it", () => {
    const delivery = decideStreamDelivery(held, buildDelta([buildRow(3)], { replay: true }));
    expect(delivery.kind === "rows" && delivery.replay).toBe(true);
  });

  it("does nothing when every delivered row is already held", () => {
    expect(decideStreamDelivery(held, buildDelta([buildRow(1), buildRow(2)]))).toEqual({
      kind: "held",
    });
    expect(decideStreamDelivery(held, buildDelta([], { replay: true }))).toEqual({ kind: "held" });
  });

  it("reads again after a reset, and stops when the session is gone", () => {
    expect(decideStreamDelivery(held, buildDelta([], { reset: true }))).toEqual({ kind: "reset" });
    expect(decideStreamDelivery(held, buildDelta([], { gone: true }))).toEqual({ kind: "gone" });
  });
});

describe("decideTapDelivery", () => {
  it("hands over the taps in the order they arrived", () => {
    const next = { ...TAP, delta: "is to await." };
    expect(decideTapDelivery(buildDelta([TAP, next]))).toEqual({ kind: "taps", taps: [TAP, next] });
  });

  it("skips after a reset, and stops when the session is gone", () => {
    expect(decideTapDelivery(buildDelta([], { reset: true }))).toEqual({ kind: "reset" });
    expect(decideTapDelivery(buildDelta([], { gone: true }))).toEqual({ kind: "gone" });
  });
});
