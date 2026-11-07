/** Tests the shape of an opening sheet along its travel, with an invented card and destination. */
import { describe, expect, it } from "vitest";
import { computeSheetFrame } from "./opening-sheet-geometry";

const CARD = { left: 1088, top: 102, width: 320, height: 72 };
const OPEN = { left: 904, top: 102, width: 520, height: 282 };

describe("computeSheetFrame", () => {
  it("lies exactly on the card at 0, with the card's own corner and all of its words", () => {
    const frame = computeSheetFrame(CARD, OPEN, 0);

    expect(frame.rect).toEqual(CARD);
    expect(frame.radius).toBe(12);
    expect(frame.wordsOpacity).toBe(1);
    expect(frame.contentOpacity).toBe(0);
  });

  it("stands exactly on the destination at 1, with a corner of 16 and none of the card's words", () => {
    const frame = computeSheetFrame(CARD, OPEN, 1);

    expect(frame.rect).toEqual(OPEN);
    expect(frame.radius).toBe(16);
    expect(frame.wordsOpacity).toBe(0);
    expect(frame.contentOpacity).toBe(1);
    expect(frame.contentRise).toBe(0);
  });

  it("keeps its content at the destination in the page while the window grows round it", () => {
    const frame = computeSheetFrame(CARD, OPEN, 0.5);

    expect(frame.rect.left + frame.contentOffset.x).toBe(OPEN.left);
    expect(frame.rect.top + frame.contentOffset.y).toBe(OPEN.top);
  });

  it("gives the card's words up before the content comes in, so no words cross", () => {
    const halfway = computeSheetFrame(CARD, OPEN, 0.55);
    const early = computeSheetFrame(CARD, OPEN, 0.3);

    expect(halfway.wordsOpacity).toBe(0);
    expect(early.contentOpacity).toBe(0);
    expect(early.wordsOpacity).toBeGreaterThan(0);
  });

  it("stays at the destination when there is no card to grow from, and the paper is whole", () => {
    const frame = computeSheetFrame(null, OPEN, 0.2);

    expect(frame.rect).toEqual(OPEN);
    expect(frame.paperOpacity).toBe(1);
  });
});
