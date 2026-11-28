import { describe, expect, it } from "vitest";
import {
  computeCardWordsOpacity,
  computeFallbackOrigin,
  computeSheetProgress,
  computeSheetWords,
  interpolateSheetFrame,
} from "./opening-sheet-geometry";

describe("computeFallbackOrigin", () => {
  it("is a smaller sheet inside the open one", () => {
    const open = { left: 687, top: 58, width: 468, height: 828 };
    expect(computeFallbackOrigin(open)).toEqual({ left: 727, top: 98, width: 388, height: 200 });
  });
});

describe("interpolateSheetFrame", () => {
  const from = { left: 100, top: 300, width: 220, height: 90 };
  const to = { left: 700, top: 58, width: 468, height: 800 };

  it("is the card at 0 and the open sheet at 1, with the corner growing from 12 to 16", () => {
    expect(interpolateSheetFrame(from, to, 0)).toEqual({ rect: from, corner: 12 });
    expect(interpolateSheetFrame(from, to, 1)).toEqual({ rect: to, corner: 16 });
  });

  it("keeps the size from going below nothing when the spring dips under 0", () => {
    const frame = interpolateSheetFrame(from, to, -0.05);
    expect(frame.rect.width).toBe(from.width);
    expect(frame.rect.height).toBe(from.height);
    expect(frame.corner).toBe(12);
  });
});

describe("the two sets of words", () => {
  it("fade the card's out by 0.55, and the sheet's in from 0.3 to 0.85, so they overlap", () => {
    expect(computeCardWordsOpacity(0)).toBe(1);
    expect(computeCardWordsOpacity(0.55)).toBe(0);
    expect(computeSheetWords(0.3)).toEqual({ opacity: 0, rise: 10 });
    expect(computeSheetWords(0.85)).toEqual({ opacity: 1, rise: 0 });
    // At 0.5 both are partly there: never a blank sheet.
    expect(computeCardWordsOpacity(0.5)).toBeGreaterThan(0);
    expect(computeSheetWords(0.5).opacity).toBeGreaterThan(0);
  });
});

describe("computeSheetProgress", () => {
  it("is held between 0 and 1 when the spring goes past them", () => {
    expect(computeSheetProgress(-0.04)).toBe(0);
    expect(computeSheetProgress(0.4)).toBe(0.4);
    expect(computeSheetProgress(1.02)).toBe(1);
  });
});
