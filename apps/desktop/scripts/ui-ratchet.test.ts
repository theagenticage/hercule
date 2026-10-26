import { describe, expect, it } from "vitest";
import {
  checkTargets,
  compareWithBaseline,
  formatBaseline,
  formatReport,
  METRICS,
  parseBaseline,
  readMetricName,
} from "./ui-ratchet.ts";

// One key per kind of metric, so each test names what it exercises.
const HIGHER = "whitehaven/thread/contrast.ink.minLc"; // tolerance 0.05
const LOWER_COUNT = "whitehaven/thread/text.dimmedByOpacity"; // tolerance 0
const LOWER_MEASURE = "whitehaven/thread/reading.proseMeasureOff"; // tolerance 0.01
const REPORTED = "whitehaven/thread/coverage.texts"; // not ratcheted

describe("readMetricName", () => {
  it("strips the theme, the screen and the glass suffix", () => {
    expect(readMetricName("nile/thread-long/contrast.muted.minLc")).toBe("contrast.muted.minLc");
    expect(readMetricName("nile/thread/contrast.muted.minLc@glass0")).toBe("contrast.muted.minLc");
    expect(readMetricName("nile/tokens/line.minLc")).toBe("line.minLc");
    expect(readMetricName("run/glyphs.confusablePairs")).toBe("glyphs.confusablePairs");
  });

  it("fails on a key that has neither three parts nor a run prefix", () => {
    expect(() => readMetricName("thread/contrast.ink.minLc")).toThrow(/not "<theme>/);
  });
});

describe("compareWithBaseline", () => {
  it("calls a higher metric worse when it falls by more than the tolerance, and better when it rises by more", () => {
    const baseline = { [HIGHER]: 85 };
    expect(compareWithBaseline({ [HIGHER]: 84.9 }, baseline).worse).toEqual([
      { key: HIGHER, baseline: 85, current: 84.9 },
    ]);
    expect(compareWithBaseline({ [HIGHER]: 85.1 }, baseline).better).toEqual([
      { key: HIGHER, baseline: 85, current: 85.1 },
    ]);
  });

  it("calls a lower metric worse when it rises, and better when it falls", () => {
    const baseline = { [LOWER_COUNT]: 2 };
    expect(compareWithBaseline({ [LOWER_COUNT]: 3 }, baseline).worse).toHaveLength(1);
    expect(compareWithBaseline({ [LOWER_COUNT]: 1 }, baseline).better).toHaveLength(1);
    expect(compareWithBaseline({ [LOWER_COUNT]: 3 }, baseline).passed).toBe(false);
    expect(compareWithBaseline({ [LOWER_COUNT]: 1 }, baseline).passed).toBe(true);
  });

  it("calls a change of exactly the tolerance neither worse nor better", () => {
    const higher = compareWithBaseline({ [HIGHER]: 60 }, { [HIGHER]: 60.05 });
    expect(higher.worse).toEqual([]);
    expect(higher.better).toEqual([]);
    const lower = compareWithBaseline({ [LOWER_MEASURE]: 3.01 }, { [LOWER_MEASURE]: 3 });
    expect(lower.worse).toEqual([]);
    expect(lower.better).toEqual([]);
  });

  it("calls a change just past the tolerance worse", () => {
    expect(compareWithBaseline({ [HIGHER]: 59.94 }, { [HIGHER]: 60 }).worse).toHaveLength(1);
    expect(
      compareWithBaseline({ [LOWER_MEASURE]: 3.02 }, { [LOWER_MEASURE]: 3 }).worse,
    ).toHaveLength(1);
  });

  it("never calls a metric worse that is only reported", () => {
    const result = compareWithBaseline({ [REPORTED]: 1 }, { [REPORTED]: 100 });
    expect(result.worse).toEqual([]);
    expect(result.better).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("treats target.under28 as reported: a rise from 0 to 1 is not worse", () => {
    const key = "whitehaven/thread/target.under28";
    expect(METRICS["target.under28"]?.ratchet).toBe(false);
    const result = compareWithBaseline({ [key]: 1 }, { [key]: 0 });
    expect(result.worse).toEqual([]);
    expect(result.passed).toBe(true);
  });

  describe("the ink floor in a dark theme", () => {
    const dark = "nile/thread/contrast.ink.minLc";

    it("does not call ink worse for falling from above the band into it", () => {
      const result = compareWithBaseline({ [dark]: 90 }, { [dark]: 100 });
      expect(result.worse).toEqual([]);
      expect(result.better).toEqual([]);
    });

    it("calls ink worse for falling below the floor of the band", () => {
      expect(compareWithBaseline({ [dark]: 84 }, { [dark]: 100 }).worse).toHaveLength(1);
      expect(compareWithBaseline({ [dark]: 84 }, { [dark]: 86 }).worse).toHaveLength(1);
    });

    it("does not call ink better for rising above the floor", () => {
      expect(compareWithBaseline({ [dark]: 100 }, { [dark]: 90 }).better).toEqual([]);
    });

    it("leaves a light theme as it is: every fall counts", () => {
      expect(
        compareWithBaseline(
          { "whitehaven/thread/contrast.ink.minLc": 90 },
          { "whitehaven/thread/contrast.ink.minLc": 100 },
        ).worse,
      ).toHaveLength(1);
    });
  });

  it("fails when a key is missing on either side, even for a reported metric", () => {
    const missingFromCurrent = compareWithBaseline({}, { [REPORTED]: 1 });
    expect(missingFromCurrent.missingFromCurrent).toEqual([REPORTED]);
    expect(missingFromCurrent.passed).toBe(false);
    const missingFromBaseline = compareWithBaseline({ [HIGHER]: 90 }, {});
    expect(missingFromBaseline.missingFromBaseline).toEqual([HIGHER]);
    expect(missingFromBaseline.passed).toBe(false);
  });

  it("sorts every list by key", () => {
    const keys = ["nile/thread/text.dimmedByOpacity", "end-house/draft/text.dimmedByOpacity"];
    const result = compareWithBaseline({}, { [keys[0] as string]: 1, [keys[1] as string]: 1 });
    expect(result.missingFromCurrent).toEqual([...keys].sort());
  });

  it("fails on a metric that is not in the registry", () => {
    expect(() =>
      compareWithBaseline({ "nile/thread/made.up": 1 }, { "nile/thread/made.up": 1 }),
    ).toThrow(/"made.up".*not in METRICS/);
  });
});

describe("METRICS", () => {
  it("gives every metric a label and a tolerance of zero or more", () => {
    for (const [name, definition] of Object.entries(METRICS)) {
      expect(definition.label, name).not.toBe("");
      expect(definition.tolerance, name).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("checkTargets", () => {
  it("applies the ink ceiling in a dark theme only", () => {
    const dark = checkTargets({ "nile/thread/contrast.ink.aboveCeiling": 3 });
    const light = checkTargets({ "whitehaven/thread/contrast.ink.aboveCeiling": 3 });
    expect(dark).toEqual([{ key: "nile/thread/contrast.ink.aboveCeiling", value: 3, met: false }]);
    expect(light).toEqual([
      { key: "whitehaven/thread/contrast.ink.aboveCeiling", value: 3, met: true },
    ]);
  });

  it("checks minimums and maximums at their boundary", () => {
    const results = checkTargets({
      "whitehaven/thread/contrast.ink.minLc": 85,
      "whitehaven/sidebar/contrast.ink.minLc": 84.99,
      "whitehaven/thread/type.sizes": 7,
      "whitehaven/sidebar/type.sizes": 8,
      "run/glyphs.confusablePairs": 0,
    });
    expect(Object.fromEntries(results.map(({ key, met }) => [key, met]))).toEqual({
      "run/glyphs.confusablePairs": true,
      "whitehaven/sidebar/contrast.ink.minLc": false,
      "whitehaven/sidebar/type.sizes": false,
      "whitehaven/thread/contrast.ink.minLc": true,
      "whitehaven/thread/type.sizes": true,
    });
  });

  it("always meets the target of a reported metric", () => {
    expect(checkTargets({ [REPORTED]: 0 })[0]?.met).toBe(true);
    expect(checkTargets({ "whitehaven/thread/target.under28": 40 })[0]?.met).toBe(true);
  });
});

describe("formatBaseline and parseBaseline", () => {
  it("writes sorted keys, 4 decimals, 2-space indent and a trailing newline", () => {
    const text = formatBaseline({
      "run/glyphs.confusablePairs": 0,
      [HIGHER]: 85.123456,
      "a/b/c.d": -0.00001,
    });
    expect(text).toBe(
      '{\n  "a/b/c.d": 0,\n  "run/glyphs.confusablePairs": 0,\n  "whitehaven/thread/contrast.ink.minLc": 85.1235\n}\n',
    );
  });

  it("writes the same bytes whatever the order of the keys", () => {
    expect(formatBaseline({ b: 1, a: 2 })).toBe(formatBaseline({ a: 2, b: 1 }));
  });

  it("round-trips through parseBaseline", () => {
    const baseline = { [HIGHER]: 85.1235, [LOWER_COUNT]: 2 };
    expect(parseBaseline(formatBaseline(baseline))).toEqual(baseline);
  });

  it("refuses to write a value that is not finite", () => {
    expect(() => formatBaseline({ [HIGHER]: Number.NaN })).toThrow(
      /"whitehaven\/thread\/contrast.ink.minLc"/,
    );
  });

  it("rejects a baseline with a string, NaN or non-object", () => {
    expect(() => parseBaseline('{"a/b/c": "3"}')).toThrow(/"a\/b\/c".*finite number/);
    expect(() => parseBaseline('{"a/b/c": null}')).toThrow(/"a\/b\/c"/);
    expect(() => parseBaseline("[1]")).toThrow(/JSON object/);
    expect(() => parseBaseline("3")).toThrow(/JSON object/);
  });
});

describe("formatReport", () => {
  it("prints the verdict, the targets and one table per theme, tokens and run", () => {
    const current = {
      "whitehaven/thread/contrast.ink.minLc": 84.94,
      "whitehaven/thread/contrast.ink.minLc@glass0": 90,
      "whitehaven/thread/spacing.onGrid": 0.9712,
      "whitehaven/sidebar/spacing.onGrid": 0.99,
      "nile/thread/contrast.ink.aboveCeiling": 2,
      "nile/tokens/line.minLc": 16.04,
      "nile/tokens/surface.minStep": 0.0312,
      "run/glyphs.confusablePairs": 0,
    };
    const baseline = {
      ...current,
      "whitehaven/thread/contrast.ink.minLc": 86,
      "nile/thread/contrast.ink.aboveCeiling": 5,
    };
    const ratchet = compareWithBaseline(current, baseline);
    expect(formatReport(current, ratchet, checkTargets(current))).toMatchInlineSnapshot(`
      "## Ratchet: FAILED

      **Worse than the baseline (1)**
      - \`whitehaven/thread/contrast.ink.minLc\`: 86.0 -> 84.9

      **Better than the baseline (write the baseline to keep it) (1)**
      - \`nile/thread/contrast.ink.aboveCeiling\`: 5 -> 2

      ## Targets: 6 of 8 met

      ## whitehaven

      | metric                    | sidebar | thread |
      | ------------------------- | ------- | ------ |
      | contrast.ink.minLc        | -       | 84.9 ✗ |
      | contrast.ink.minLc@glass0 | -       | 90.0   |
      | spacing.onGrid            | 99.0%   | 97.1%  |

      ## nile

      | metric                    | thread |
      | ------------------------- | ------ |
      | contrast.ink.aboveCeiling | 2 ✗    |

      ## Tokens

      | metric          | nile  |
      | --------------- | ----- |
      | line.minLc      | 16.0  |
      | surface.minStep | 0.031 |

      ## Run

      | metric                 | value |
      | ---------------------- | ----- |
      | glyphs.confusablePairs | 0     |
      "
    `);
  });
});
