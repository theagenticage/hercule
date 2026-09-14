import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hydra/contract";
import { mergeTranscript } from "./transcript";

const row = (position: number): TranscriptRow => ({
  position,
  at: "2026-09-08T10:00:00.000Z",
  event: {
    _tag: "turn.started",
    eventId: `e${position}`,
    sessionId: "01a06d02-b100-7000-8000-000000000001",
    at: "2026-09-08T10:00:00.000Z",
    turnId: `t${position}`,
  },
});

const positions = (rows: readonly TranscriptRow[]): number[] => rows.map((each) => each.position);

describe("mergeTranscript", () => {
  it("appends rows that carry on from what is held", () => {
    expect(positions(mergeTranscript([row(1), row(2)], [row(3), row(4)]))).toEqual([1, 2, 3, 4]);
  });

  it("places a replay that arrives after the rows it comes before", () => {
    expect(positions(mergeTranscript([row(4), row(5)], [row(1), row(2), row(3)]))).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("keeps the row it already holds for a position delivered twice", () => {
    const held = [row(1), row(2)];
    const merged = mergeTranscript(held, [row(2), row(3)]);
    expect(positions(merged)).toEqual([1, 2, 3]);
    expect(merged[1]).toBe(held[1]);
  });

  it("returns what it was given when every row is one it holds", () => {
    const held = [row(1), row(2)];
    // The same reference, so a cache that took this delivery does not notify
    // its observers over rows it already had.
    expect(mergeTranscript(held, [row(1), row(2)])).toBe(held);
  });
});
