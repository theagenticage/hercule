import { describe, expect, it } from "vitest";
import type {
  ProbeColour,
  ProbeTarget,
  TextFragment,
  TextRole,
} from "../src/renderer/specimens/ui-probe-types.ts";
import { METRICS } from "./ui-ratchet.ts";
import {
  summarizeContrast,
  summarizeDiscipline,
  summarizeGlyphs,
  summarizeProse,
  summarizeTargets,
  summarizeText,
  summarizeTokens,
  type MeasuredFragment,
} from "./ui-summary.ts";

const BLACK: ProbeColour = [0, 0, 0, 1];

/** Builds a measured line of text with the given role, size and contrast. */
function buildMeasured(
  role: TextRole,
  apcaLc: number,
  options: {
    fontSize?: number;
    wcagRatio?: number;
    supported?: boolean;
    sourceId?: number;
    dimmed?: boolean;
    partlyCovered?: boolean;
  } = {},
): MeasuredFragment {
  const fragment: TextFragment = {
    sourceId: options.sourceId ?? 0,
    length: 5,
    box: { left: 0, top: 0, right: 10, bottom: 10 },
    visibleBox: { left: 0, top: 0, right: 10, bottom: 10 },
    fontSize: options.fontSize ?? 13,
    fontWeight: 400,
    colour: BLACK,
    role,
    opacityGroups: options.dimmed === true ? [{ id: 1, opacity: 0.5 }] : [],
    isProse: false,
    partlyCovered: options.partlyCovered ?? false,
  };
  return {
    fragment,
    contrast: {
      apcaLc,
      wcagRatio: options.wcagRatio ?? 7,
      supported: options.supported ?? true,
    },
  };
}

describe("summarizeContrast", () => {
  it("takes the lowest absolute Lc of a role, whatever the sign, and counts the lines under its target", () => {
    const values = summarizeContrast(
      [buildMeasured("ink", -90), buildMeasured("ink", 80), buildMeasured("ink", -88)],
      true,
    );
    expect(values["contrast.ink.minLc"]).toBe(80);
    expect(values["contrast.ink.belowTarget"]).toBe(1);
  });

  it("returns no keys for a role without text", () => {
    const values = summarizeContrast([buildMeasured("ink", 90)], false);
    expect(Object.keys(values).filter((key) => key.includes("muted"))).toEqual([]);
  });

  it("measures each role against its own target, which METRICS holds", () => {
    // 50 passes the faint target and fails the muted one.
    const values = summarizeContrast(
      [buildMeasured("faint", 50), buildMeasured("muted", 50)],
      false,
    );
    expect(METRICS["contrast.faint.minLc"]!.target(50, { dark: false })).toBe(true);
    expect(values["contrast.faint.belowTarget"]).toBe(0);
    expect(values["contrast.muted.belowTarget"]).toBe(1);
  });

  it("counts ink above Lc 95 in a dark theme only", () => {
    const lines = [buildMeasured("ink", -97), buildMeasured("ink", -90)];
    expect(summarizeContrast(lines, true)["contrast.ink.aboveCeiling"]).toBe(1);
    expect(summarizeContrast(lines, false)["contrast.ink.aboveCeiling"]).toBe(0);
  });

  it("fails WCAG at 4.5 below 18px and at 3 from 18px, and exempts placeholders and disabled controls", () => {
    const values = summarizeContrast(
      [
        buildMeasured("ink", 80, { wcagRatio: 4 }),
        buildMeasured("ink", 80, { wcagRatio: 4, fontSize: 18 }),
        buildMeasured("ink", 80, { wcagRatio: 2.5, fontSize: 24 }),
        buildMeasured("placeholder", 40, { wcagRatio: 1.5 }),
        buildMeasured("disabled", 40, { wcagRatio: 1.5 }),
      ],
      false,
    );
    expect(values["contrast.wcag.failing"]).toBe(2);
  });

  it("counts a line that cannot be measured as failing, and leaves it out of the lowest Lc", () => {
    const values = summarizeContrast(
      [buildMeasured("muted", 70), buildMeasured("muted", 10, { supported: false })],
      false,
    );
    expect(values["contrast.unsupported"]).toBe(1);
    expect(values["contrast.muted.minLc"]).toBe(70);
    expect(values["contrast.muted.belowTarget"]).toBe(1);
    expect(values["contrast.wcag.failing"]).toBe(1);
  });

  it("treats a line under a translucent layer like a line that cannot be measured", () => {
    const values = summarizeContrast(
      [buildMeasured("muted", 70), buildMeasured("muted", 10, { partlyCovered: true })],
      false,
    );
    expect(values["contrast.unsupported"]).toBe(1);
    expect(values["contrast.muted.minLc"]).toBe(70);
    expect(values["contrast.muted.belowTarget"]).toBe(1);
    expect(values["contrast.wcag.failing"]).toBe(1);
  });
});

describe("summarizeText", () => {
  it("counts dimmed lines, oversized faint lines, distinct pieces of text and lines per role", () => {
    const values = summarizeText([
      buildMeasured("faint", 50, { fontSize: 13, sourceId: 1, dimmed: true }),
      buildMeasured("faint", 50, { fontSize: 12, sourceId: 1 }),
      buildMeasured("muted", 70, { sourceId: 2 }),
    ]);
    expect(values["text.dimmedByOpacity"]).toBe(1);
    expect(values["text.faintMisuse"]).toBe(1);
    expect(values["coverage.texts"]).toBe(2);
    expect(values["coverage.faint"]).toBe(2);
    expect(values["coverage.muted"]).toBe(1);
    expect(values["coverage.other"]).toBe(0);
  });
});

describe("summarizeDiscipline", () => {
  it("counts the sizes, weights and radii, and the share of spacing on the 4px grid", () => {
    const values = summarizeDiscipline({
      fontSizes: [12, 13, 15],
      fontWeights: [400, 600],
      radii: ["6px"],
      offScaleFontSizes: ["a { font-size: 13px }"],
      offTokenRadii: [],
      spacingValues: [4, 8, 12.004, 6],
      fixedSizeSamples: 4,
      pieceTextFragments: 3,
    });
    expect(values).toEqual({
      "type.sizes": 3,
      "type.weights": 2,
      "type.offScale": 1,
      "coverage.fixedSizeSamples": 4,
      "coverage.pieceTextFragments": 3,
      "radius.distinct": 1,
      "radius.offToken": 0,
      "spacing.onGrid": 0.75,
    });
  });

  it("calls a page with no spacing values fully on the grid", () => {
    const facts = {
      fontSizes: [],
      fontWeights: [],
      radii: [],
      offScaleFontSizes: [],
      offTokenRadii: [],
      spacingValues: [],
      fixedSizeSamples: 0,
      pieceTextFragments: 0,
    };
    expect(summarizeDiscipline(facts)["spacing.onGrid"]).toBe(1);
  });
});

describe("summarizeTargets", () => {
  /** Builds a target of the given size. */
  function buildTarget(width: number, height: number, inlineInProse = false): ProbeTarget {
    return {
      id: 1,
      box: { left: 10, top: 10, right: 10 + width, bottom: 10 + height },
      name: "x",
      inlineInProse,
      inWindow: true,
    };
  }

  it("counts the targets under 24 and under 28 in either dimension, and skips links inside prose", () => {
    const values = summarizeTargets([
      buildTarget(24, 24),
      buildTarget(23.5, 40),
      buildTarget(40, 26),
      buildTarget(10, 10, true),
      buildTarget(23.995, 24),
    ]);
    expect(values).toEqual({ "coverage.controls": 5, "target.under24": 1, "target.under28": 4 });
  });
});

describe("summarizeProse", () => {
  it("is 0 inside the band and the distance to it outside", () => {
    expect(summarizeProse({ lines: 3, meanCharactersPerLine: 70 })).toEqual({
      "reading.proseMeasureOff": 0,
    });
    expect(summarizeProse({ lines: 3, meanCharactersPerLine: 87.5 })).toEqual({
      "reading.proseMeasureOff": 12.5,
    });
    expect(summarizeProse({ lines: 3, meanCharactersPerLine: 52 })).toEqual({
      "reading.proseMeasureOff": 8,
    });
  });

  it("returns nothing when the page has no full line of prose", () => {
    expect(summarizeProse({ lines: 0, meanCharactersPerLine: null })).toEqual({});
  });
});

describe("summarizeTokens", () => {
  it("measures the line against each surface and the lightness steps between surfaces", () => {
    const values = summarizeTokens({
      bg: [244, 243, 240, 1],
      surface: [252, 252, 249, 1],
      raised: [255, 255, 255, 1],
      line: [216, 218, 213, 1],
      ink: BLACK,
      muted: BLACK,
      faint: BLACK,
    });
    expect(values["line.minLc"]).toBeGreaterThan(5);
    expect(values["line.minLc"]).toBeLessThan(20);
    // The step from surface to raised is the smaller one.
    expect(values["surface.minStep"]).toBeGreaterThan(0);
    expect(values["surface.minStep"]).toBeLessThan(0.02);
  });
});

describe("summarizeGlyphs", () => {
  it("counts the pairs that differ in fewer than 4 pixels", () => {
    expect(
      summarizeGlyphs([
        { pair: "Il", differingPixels: 3 },
        { pair: "I1", differingPixels: 4 },
        { pair: "O0", differingPixels: 0 },
      ]),
    ).toEqual({ "glyphs.confusablePairs": 2 });
  });
});
