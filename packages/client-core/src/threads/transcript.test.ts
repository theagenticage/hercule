import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hercule/contract";
import { mergeTranscript } from "./transcript";

const buildRow = (position: number): TranscriptRow => ({
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

const listPositions = (rows: readonly TranscriptRow[]): number[] =>
  rows.map((each) => each.position);

describe("mergeTranscript", () => {
  it("appends rows that follow the cached rows", () => {
    expect(
      listPositions(mergeTranscript([buildRow(1), buildRow(2)], [buildRow(3), buildRow(4)])),
    ).toEqual([1, 2, 3, 4]);
  });

  it("puts replayed rows before later rows that arrived first", () => {
    expect(
      listPositions(
        mergeTranscript([buildRow(4), buildRow(5)], [buildRow(1), buildRow(2), buildRow(3)]),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the cached row when a position is delivered twice", () => {
    const held = [buildRow(1), buildRow(2)];
    const merged = mergeTranscript(held, [buildRow(2), buildRow(3)]);
    expect(listPositions(merged)).toEqual([1, 2, 3]);
    expect(merged[1]).toBe(held[1]);
  });

  it("returns the same array when every incoming row is already cached", () => {
    const held = [buildRow(1), buildRow(2)];
    // The same reference, so a cache that receives this delivery does not
    // notify its observers about rows it already had.
    expect(mergeTranscript(held, [buildRow(1), buildRow(2)])).toBe(held);
  });
});
