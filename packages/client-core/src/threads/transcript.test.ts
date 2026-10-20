import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hercule/contract";
import {
  classifyTranscriptPage,
  findTranscriptAfterPosition,
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

describe("findTranscriptAfterPosition", () => {
  it("returns the position of the row before the last row held", () => {
    expect(findTranscriptAfterPosition([buildRow(2), buildRow(5), buildRow(9)])).toBe(5);
  });

  it("returns 0 when one row is held, so the page starts with that row", () => {
    expect(findTranscriptAfterPosition([buildRow(7)])).toBe(0);
  });

  it("returns undefined when no row is held", () => {
    expect(findTranscriptAfterPosition([])).toBeUndefined();
  });
});

describe("classifyTranscriptPage", () => {
  const held = [buildRow(1), buildRow(2), buildRow(3)];

  it("accepts a page that starts with the last row held", () => {
    expect(classifyTranscriptPage(held, [buildRow(3), buildRow(4)])).toBe("continuesHeldRows");
  });

  it("accepts a page that holds only the last row held", () => {
    expect(classifyTranscriptPage(held, [buildRow(3)])).toBe("continuesHeldRows");
  });

  it("accepts any page when no row is held", () => {
    expect(classifyTranscriptPage([], [buildRow(1), buildRow(2)])).toBe("continuesHeldRows");
    expect(classifyTranscriptPage([], [])).toBe("continuesHeldRows");
  });

  it("accepts a page that starts at the first row when one row is held, because it was read after 0", () => {
    expect(classifyTranscriptPage([buildRow(1)], [buildRow(1), buildRow(2)])).toBe(
      "continuesHeldRows",
    );
  });

  it("recognises the whole transcript from a controller that ignored `after`", () => {
    // `after` was 2, yet the page starts at position 1.
    expect(classifyTranscriptPage(held, [buildRow(1), buildRow(2), buildRow(3), buildRow(4)])).toBe(
      "wholeTranscript",
    );
  });

  it("recognises the whole transcript even when its rows differ from the held ones", () => {
    expect(classifyTranscriptPage(held, [buildRow(1, "other"), buildRow(2, "other")])).toBe(
      "wholeTranscript",
    );
  });

  it("refuses a page whose first row has the position of the last row held but another event", () => {
    expect(classifyTranscriptPage(held, [buildRow(3, "other"), buildRow(4)])).toBe("replacedLog");
  });

  it("refuses a page that starts after the last row held", () => {
    expect(classifyTranscriptPage(held, [buildRow(4), buildRow(5)])).toBe("replacedLog");
  });

  it("refuses an empty page, because the log no longer holds the last row", () => {
    expect(classifyTranscriptPage(held, [])).toBe("replacedLog");
  });
});
