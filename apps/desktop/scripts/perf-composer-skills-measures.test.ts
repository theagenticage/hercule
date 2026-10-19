import { describe, expect, it } from "vitest";
import {
  LIBRARY_SKILLS,
  LONG_MESSAGE_CHIPS,
  LONG_MESSAGE_LENGTH,
  REPOSITORY_SKILLS,
  buildLongMessage,
  hasSettled,
  readMedian,
  readPercentile95,
  type ProbeReading,
} from "./perf-composer-skills-measures.ts";

describe("the seeded skills", () => {
  it("are 100 in the library and 20 in the checkout, each named once", () => {
    expect(LIBRARY_SKILLS).toHaveLength(100);
    expect(REPOSITORY_SKILLS).toHaveLength(20);
    const names = [...LIBRARY_SKILLS, ...REPOSITORY_SKILLS].map((skill) => skill.name);
    expect(new Set(names).size).toBe(120);
  });

  it("make `review` narrow the list to 10 and `team-w` keep all 120", () => {
    const skills = [...LIBRARY_SKILLS, ...REPOSITORY_SKILLS];
    const reviewing = skills.filter((skill) => skill.name.includes("review"));
    expect(reviewing).toHaveLength(10);
    expect(skills.every((skill) => skill.description.includes("team-w"))).toBe(true);
  });
});

describe("buildLongMessage", () => {
  it("writes the chips' names as references, in about 4,000 characters of one line", () => {
    const text = buildLongMessage(true);
    expect(text.length).toBeGreaterThanOrEqual(LONG_MESSAGE_LENGTH);
    expect(text.length).toBeLessThan(LONG_MESSAGE_LENGTH + 100);
    expect(text.split("$")).toHaveLength(LONG_MESSAGE_CHIPS + 1);
    expect(text).not.toContain("\n");
    expect(text.endsWith(" end")).toBe(true);
  });

  it("names the same skills without `$` for the baseline, in the same length less one character a chip", () => {
    const plain = buildLongMessage(false);
    expect(plain).not.toContain("$");
    expect(plain.length).toBeGreaterThanOrEqual(LONG_MESSAGE_LENGTH);
    const names = buildLongMessage(true)
      .match(/\$[a-z-]+/g)!
      .map((reference) => reference.slice(1));
    expect(names).toHaveLength(LONG_MESSAGE_CHIPS);
    for (const name of names) expect(plain).toContain(name);
  });
});

describe("hasSettled", () => {
  const reading: ProbeReading = {
    t0: 100,
    firstPaint: 110,
    lastPaint: 120,
    lastMutation: 115,
    sawReading: false,
    now: 300,
    reads: 0,
    rows: 120,
    chips: 0,
  };

  it("is true once the last change is drawn and the page has been quiet long enough", () => {
    expect(hasSettled(reading, 150)).toBe(true);
  });

  it("is false before the page has been quiet long enough", () => {
    expect(hasSettled({ ...reading, now: 200 }, 150)).toBe(false);
  });

  it("is false while the last change is not drawn yet", () => {
    expect(hasSettled({ ...reading, lastPaint: 112 }, 150)).toBe(false);
  });

  it("is false when no key changed the page", () => {
    expect(hasSettled({ ...reading, t0: null, lastMutation: null, lastPaint: null }, 150)).toBe(
      false,
    );
  });
});

describe("the statistics", () => {
  it("takes the middle value, or the mean of the two in the middle", () => {
    expect(readMedian([5, 1, 3])).toBe(3);
    expect(readMedian([4, 1, 3, 2])).toBe(2.5);
  });

  it("takes the 95th percentile at rank ceil(0.95 n)", () => {
    expect(readPercentile95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
    expect(readPercentile95([7])).toBe(7);
  });

  it("fails on no values", () => {
    expect(() => readMedian([])).toThrow();
    expect(() => readPercentile95([])).toThrow();
  });
});
