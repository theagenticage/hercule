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
  rankElements,
  summarizeProse,
  summarizeResilience,
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
    element?: string;
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
    element: options.element ?? "div.row > span.label",
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
    const { values } = summarizeContrast(
      [buildMeasured("ink", -90), buildMeasured("ink", 80), buildMeasured("ink", -88)],
      true,
    );
    expect(values["contrast.ink.minLc"]).toBe(80);
    expect(values["contrast.ink.belowTarget"]).toBe(1);
  });

  it("returns no keys for a role without text", () => {
    const { values } = summarizeContrast([buildMeasured("ink", 90)], false);
    expect(Object.keys(values).filter((key) => key.includes("muted"))).toEqual([]);
  });

  it("measures each role against its own target, which METRICS holds", () => {
    // 50 passes the faint target and fails the muted one.
    const { values } = summarizeContrast(
      [buildMeasured("faint", 50), buildMeasured("muted", 50)],
      false,
    );
    expect(METRICS["contrast.faint.minLc"]!.target(50, { dark: false })).toBe(true);
    expect(values["contrast.faint.belowTarget"]).toBe(0);
    expect(values["contrast.muted.belowTarget"]).toBe(1);
  });

  it("counts ink above Lc 95 in a dark theme only", () => {
    const lines = [buildMeasured("ink", -97), buildMeasured("ink", -90)];
    expect(summarizeContrast(lines, true).values["contrast.ink.aboveCeiling"]).toBe(1);
    expect(summarizeContrast(lines, false).values["contrast.ink.aboveCeiling"]).toBe(0);
  });

  it("fails WCAG at 4.5 below 18px and at 3 from 18px, and exempts placeholders and disabled controls", () => {
    const { values } = summarizeContrast(
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
    const { values } = summarizeContrast(
      [buildMeasured("muted", 70), buildMeasured("muted", 10, { supported: false })],
      false,
    );
    expect(values["contrast.unsupported"]).toBe(1);
    expect(values["contrast.muted.minLc"]).toBe(70);
    expect(values["contrast.muted.belowTarget"]).toBe(1);
    expect(values["contrast.wcag.failing"]).toBe(1);
  });

  it("treats a line under a translucent layer like a line that cannot be measured", () => {
    const { values } = summarizeContrast(
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
    const { values } = summarizeText([
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
    const { values } = summarizeDiscipline({
      fontSizes: [12, 13, 15],
      fontWeights: [400, 600],
      radii: ["6px"],
      offScaleFontSizes: ["a { font-size: 13px }"],
      offTokenRadii: [],
      spacingValues: [4, 8, 12.004, 6],
      fixedSizeSamples: 4,
      pieceTextFragments: 3,
      offGridSpacing: [],
      examples: { fontSizes: {}, fontWeights: {}, radii: {} },
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
      offGridSpacing: [],
      examples: { fontSizes: {}, fontWeights: {}, radii: {} },
    };
    expect(summarizeDiscipline(facts).values["spacing.onGrid"]).toBe(1);
  });
});

/** A target of the click-target tests; each test sets its element and box. */
const BUTTON: ProbeTarget = {
  id: 1,
  box: { left: 0, top: 0, right: 0, bottom: 0 },
  name: "x",
  inlineInProse: false,
  inWindow: true,
  element: "button",
};

describe("summarizeTargets", () => {
  /** Builds a target of the given size. */
  function buildTarget(width: number, height: number, inlineInProse = false): ProbeTarget {
    return {
      id: 1,
      box: { left: 10, top: 10, right: 10 + width, bottom: 10 + height },
      name: "x",
      inlineInProse,
      inWindow: true,
      element: `button.t${String(width)}x${String(height)}`,
    };
  }

  it("counts the targets under 24 and under 28 in either dimension, and skips links inside prose", () => {
    const { values } = summarizeTargets([
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
    expect(summarizeProse({ lines: 3, meanCharactersPerLine: 70, paragraphs: [] }).values).toEqual({
      "reading.proseMeasureOff": 0,
    });
    expect(
      summarizeProse({ lines: 3, meanCharactersPerLine: 87.5, paragraphs: [] }).values,
    ).toEqual({
      "reading.proseMeasureOff": 12.5,
    });
    expect(summarizeProse({ lines: 3, meanCharactersPerLine: 52, paragraphs: [] }).values).toEqual({
      "reading.proseMeasureOff": 8,
    });
  });

  it("returns nothing when the page has no full line of prose", () => {
    expect(
      summarizeProse({ lines: 0, meanCharactersPerLine: null, paragraphs: [] }).values,
    ).toEqual({});
  });
});

describe("summarizeTokens", () => {
  it("measures the line and the divider against each surface and the lightness steps between surfaces", () => {
    const { values } = summarizeTokens({
      bg: [244, 243, 240, 1],
      surface: [252, 252, 249, 1],
      raised: [255, 255, 255, 1],
      line: [216, 218, 213, 1],
      divider: [222, 223, 219, 1],
      ink: BLACK,
      muted: BLACK,
      faint: BLACK,
    });
    expect(values["line.minLc"]).toBeGreaterThan(5);
    expect(values["line.minLc"]).toBeLessThan(20);
    // The divider is the quieter of the two, over the same surfaces.
    expect(values["divider.minLc"]).toBeGreaterThan(0);
    expect(values["divider.minLc"]).toBeLessThan(values["line.minLc"] ?? 0);
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
      ]).values,
    ).toEqual({ "glyphs.confusablePairs": 2 });
  });
});

describe("the elements behind the numbers", () => {
  it("merges lines of one element: sums counts, keeps the worst of a minimum or a maximum", () => {
    expect(
      rankElements(
        [
          { element: "a", contribution: 3 },
          { element: "b", contribution: 4 },
          { element: "a", contribution: 2 },
        ],
        "sum",
      ),
    ).toEqual([
      { element: "a", contribution: 5 },
      { element: "b", contribution: 4 },
    ]);
    const lines = [
      { element: "a", contribution: 70 },
      { element: "a", contribution: 20 },
      { element: "b", contribution: 30 },
    ];
    expect(rankElements(lines, "smallest")).toEqual([
      { element: "a", contribution: 20 },
      { element: "b", contribution: 30 },
    ]);
    expect(rankElements(lines, "largest")).toEqual([
      { element: "a", contribution: 70 },
      { element: "b", contribution: 30 },
    ]);
  });

  it("lists one entry per element in a summary, with the characters of its lines added", () => {
    const { elements } = summarizeResilience("rest", {
      clippedCharacters: 9,
      overlappingPairs: 0,
      clippedTexts: [
        { element: "p.title", characters: 4 },
        { element: "p.title", characters: 5 },
      ],
      overlaps: [],
    });
    expect(elements["resilience.rest.clippedCharacters"]).toEqual([
      { element: "p.title", contribution: 9 },
    ]);
  });

  it("names the one line at the lowest Lc of a role, and the lines below target, lowest first", () => {
    const { elements } = summarizeContrast(
      [
        buildMeasured("muted", 70, { element: "fine" }),
        buildMeasured("muted", 40, { element: "second" }),
        buildMeasured("muted", 20, { element: "worst" }),
      ],
      false,
    );
    expect(elements["contrast.muted.minLc"]).toEqual([{ element: "worst", contribution: 20 }]);
    expect(elements["contrast.muted.belowTarget"]).toEqual([
      { element: "worst", contribution: 20 },
      { element: "second", contribution: 40 },
    ]);
  });

  it("names the line at the minimum even when the minimum still meets its target", () => {
    const { values, elements } = summarizeContrast(
      [buildMeasured("muted", 70, { element: "a" }), buildMeasured("muted", 65, { element: "b" })],
      false,
    );
    expect(values["contrast.muted.belowTarget"]).toBe(0);
    expect(elements["contrast.muted.minLc"]).toEqual([{ element: "b", contribution: 65 }]);
    expect(elements["contrast.muted.belowTarget"]).toBeUndefined();
  });

  it("lists the lines that fail WCAG by their ratio, and the dimmed and oversized faint lines", () => {
    const failing = summarizeContrast(
      [
        buildMeasured("ink", 80, { wcagRatio: 4, element: "close" }),
        buildMeasured("ink", 80, { wcagRatio: 2, element: "far" }),
      ],
      false,
    );
    expect(failing.elements["contrast.wcag.failing"]).toEqual([
      { element: "far", contribution: 2 },
      { element: "close", contribution: 4 },
    ]);
    const text = summarizeText([
      buildMeasured("faint", 50, { fontSize: 13, dimmed: true, element: "small" }),
      buildMeasured("faint", 50, { fontSize: 16, element: "big" }),
    ]);
    expect(text.elements["text.dimmedByOpacity"]).toEqual([
      { element: "small", contribution: 0.5 },
    ]);
    expect(text.elements["text.faintMisuse"]).toEqual([
      { element: "big", contribution: 16 },
      { element: "small", contribution: 13 },
    ]);
  });

  it("lists the targets under the limits by their smaller side, smallest first", () => {
    const { elements } = summarizeTargets([
      { ...BUTTON, element: "wide", box: { left: 0, top: 0, right: 100, bottom: 22 } },
      { ...BUTTON, element: "tiny", box: { left: 0, top: 0, right: 10, bottom: 10 } },
      { ...BUTTON, element: "big", box: { left: 0, top: 0, right: 40, bottom: 40 } },
    ]);
    expect(elements["target.under24"]).toEqual([
      { element: "tiny", contribution: 10 },
      { element: "wide", contribution: 22 },
    ]);
    expect(elements["target.under28"]).toEqual(elements["target.under24"]);
  });

  it("names one example per distinct size and radius, and the off-token declarations", () => {
    const { elements } = summarizeDiscipline({
      fontSizes: [12, 15],
      fontWeights: [400],
      radii: ["6px", "8px 4px"],
      offScaleFontSizes: ["a { font-size: 13px }"],
      offTokenRadii: ["b { border-radius: 5px }"],
      spacingValues: [],
      fixedSizeSamples: 0,
      pieceTextFragments: 0,
      offGridSpacing: [{ element: "div.card", values: ["padding-left 6px", "gap 5px"] }],
      examples: {
        fontSizes: { "12": "span.meta", "15": "p.body" },
        fontWeights: { "400": "p.body" },
        radii: { "6px": "div.card", "8px 4px": "div.tab" },
      },
    });
    expect(elements["type.sizes"]).toEqual([
      { element: "font-size 15px: p.body", contribution: 15 },
      { element: "font-size 12px: span.meta", contribution: 12 },
    ]);
    expect(elements["radius.distinct"]).toEqual([
      { element: "radius 8px 4px: div.tab", contribution: 8 },
      { element: "radius 6px: div.card", contribution: 6 },
    ]);
    expect(elements["type.offScale"]).toEqual([
      { element: "a { font-size: 13px }", contribution: 1 },
    ]);
    expect(elements["radius.offToken"]).toEqual([
      { element: "b { border-radius: 5px }", contribution: 1 },
    ]);
  });

  it("lists clipped texts by lost characters and overlaps by shared area, largest first", () => {
    const { elements } = summarizeResilience("rest", {
      clippedCharacters: 22,
      overlappingPairs: 2,
      clippedTexts: [
        { element: "div.row > span.hidden", characters: 2 },
        { element: 'span.sr-only "Skip to content"', characters: 20 },
      ],
      overlaps: [
        { first: "a", second: "b", area: 5 },
        { first: "c", second: "d", area: 50 },
      ],
    });
    expect(elements["resilience.rest.clippedCharacters"]![0]).toEqual({
      element: 'span.sr-only "Skip to content"',
      contribution: 20,
    });
    expect(elements["resilience.rest.overlaps"]![0]).toEqual({
      element: "c overlaps d",
      contribution: 50,
    });
  });

  it("names tokens and glyph pairs, never an element, and leaves out metrics without elements", () => {
    const tokens = summarizeTokens({
      bg: [244, 243, 240, 1],
      surface: [252, 252, 249, 1],
      raised: [255, 255, 255, 1],
      line: [216, 218, 213, 1],
      divider: [222, 223, 219, 1],
      ink: BLACK,
      muted: BLACK,
      faint: BLACK,
    });
    expect(tokens.elements["line.minLc"]![0]!.element).toMatch(/^--line over --/);
    expect(tokens.elements["surface.minStep"]![0]!.element).toBe("--surface to --raised");
    expect(
      summarizeGlyphs([
        { pair: "Il", differingPixels: 3 },
        { pair: "O0", differingPixels: 0 },
      ]).elements,
    ).toEqual({
      "glyphs.confusablePairs": [
        { element: "glyphs O0", contribution: 0 },
        { element: "glyphs Il", contribution: 3 },
      ],
    });
    expect(
      summarizeProse({ lines: 3, meanCharactersPerLine: 87.5, paragraphs: [] }).elements,
    ).toEqual({});
  });

  it("counts targets by the raw list, so two targets with one name are two", () => {
    const small = {
      ...BUTTON,
      element: "button.icon",
      box: { left: 0, top: 0, right: 20, bottom: 20 },
    };
    const { values, elements } = summarizeTargets([small, { ...small, id: 2 }]);
    expect(values["target.under24"]).toBe(2);
    expect(values["target.under28"]).toBe(2);
    expect(elements["target.under24"]).toEqual([{ element: "button.icon", contribution: 20 }]);
  });

  it("counts confusable glyph pairs by the raw list", () => {
    const { values } = summarizeGlyphs([
      { pair: "Il", differingPixels: 1 },
      { pair: "Il", differingPixels: 2 },
    ]);
    expect(values["glyphs.confusablePairs"]).toBe(2);
  });

  it("names the elements with off-grid spacing, and the prose paragraphs farthest from the band", () => {
    const discipline = summarizeDiscipline({
      fontSizes: [],
      fontWeights: [],
      radii: [],
      offScaleFontSizes: [],
      offTokenRadii: [],
      spacingValues: [4, 6, 5],
      fixedSizeSamples: 0,
      pieceTextFragments: 0,
      offGridSpacing: [
        { element: "div.a", values: ["padding-left 6px"] },
        { element: "div.b", values: ["gap 5px", "margin-top 7px"] },
      ],
      examples: { fontSizes: {}, fontWeights: {}, radii: {} },
    });
    expect(discipline.elements["spacing.onGrid"]).toEqual([
      { element: "div.b: gap 5px, margin-top 7px", contribution: 2 },
      { element: "div.a: padding-left 6px", contribution: 1 },
    ]);
    const prose = summarizeProse({
      lines: 6,
      meanCharactersPerLine: 80,
      paragraphs: [
        { element: "p.near", lines: 3, meanCharactersPerLine: 76 },
        { element: "p.far", lines: 3, meanCharactersPerLine: 84 },
      ],
    });
    expect(prose.elements["reading.proseMeasureOff"]).toEqual([
      { element: "p.far (3 full lines)", contribution: 84 },
      { element: "p.near (3 full lines)", contribution: 76 },
    ]);
    // A paragraph inside the band pulls the mean back, so it is not listed when the mean is too high.
    const mixed = summarizeProse({
      lines: 8,
      meanCharactersPerLine: 78,
      paragraphs: [
        { element: "p.fine", lines: 5, meanCharactersPerLine: 70 },
        { element: "p.long", lines: 3, meanCharactersPerLine: 90 },
      ],
    });
    expect(mixed.elements["reading.proseMeasureOff"]).toEqual([
      { element: "p.long (3 full lines)", contribution: 90 },
    ]);
    // Too short: the shortest, weighted by full lines, comes first.
    const short = summarizeProse({
      lines: 6,
      meanCharactersPerLine: 50,
      paragraphs: [
        { element: "p.few", lines: 1, meanCharactersPerLine: 30 },
        { element: "p.many", lines: 5, meanCharactersPerLine: 52 },
      ],
    });
    expect(short.elements["reading.proseMeasureOff"]!.map(({ element }) => element)).toEqual([
      "p.many (5 full lines)",
      "p.few (1 full lines)",
    ]);
    // Inside the band nothing is listed.
    const inside = summarizeProse({
      lines: 2,
      meanCharactersPerLine: 70,
      paragraphs: [{ element: "p.a", lines: 2, meanCharactersPerLine: 70 }],
    });
    expect(inside.elements).toEqual({});
  });
});
