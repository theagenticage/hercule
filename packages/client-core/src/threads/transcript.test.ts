import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hercule/contract";
import {
  continuesHeldRows,
  findCatchUpAfterPosition,
  findNewRows,
  mergeTranscript,
} from "./transcript";

const buildRow = (position: number, eventId = `e${position}`): TranscriptRow => ({
  position,
  at: "2026-09-08T10:00:00.000Z",
  event: {
    _tag: "turn.started",
    eventId,
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

describe("findNewRows", () => {
  it("returns the incoming rows the cache does not hold, in arrival order", () => {
    expect(
      listPositions(
        findNewRows([buildRow(1), buildRow(2)], [buildRow(4), buildRow(2), buildRow(3)]),
      ),
    ).toEqual([4, 3]);
  });
});

describe("findCatchUpAfterPosition", () => {
  it("returns the position of the row before the last row held", () => {
    expect(findCatchUpAfterPosition([buildRow(2), buildRow(5), buildRow(9)])).toBe(5);
  });

  it("returns 0 when one row is held, so the page starts with that row", () => {
    expect(findCatchUpAfterPosition([buildRow(7)])).toBe(0);
  });

  it("returns undefined when no row is held", () => {
    expect(findCatchUpAfterPosition([])).toBeUndefined();
  });
});

describe("continuesHeldRows", () => {
  const held = [buildRow(1), buildRow(2), buildRow(3)];

  it("accepts a page that starts with the last row held", () => {
    expect(continuesHeldRows(held, [buildRow(3), buildRow(4)])).toBe(true);
  });

  it("accepts a page that holds only the last row held", () => {
    expect(continuesHeldRows(held, [buildRow(3)])).toBe(true);
  });

  it("accepts any page when no row is held", () => {
    expect(continuesHeldRows([], [buildRow(1), buildRow(2)])).toBe(true);
    expect(continuesHeldRows([], [])).toBe(true);
  });

  it("refuses a page whose first row has the position of the last row held but another event", () => {
    expect(continuesHeldRows(held, [buildRow(3, "other"), buildRow(4)])).toBe(false);
  });

  it("refuses a page that starts at another position", () => {
    expect(continuesHeldRows(held, [buildRow(4), buildRow(5)])).toBe(false);
  });

  it("refuses an empty page, because the log no longer holds the last row", () => {
    expect(continuesHeldRows(held, [])).toBe(false);
  });
});
