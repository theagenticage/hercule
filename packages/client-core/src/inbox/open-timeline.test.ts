/** Tests the open card's timeline, with invented tickets and pull requests of the Acme world. */
import { describe, expect, it } from "vitest";
import type { EntityLink, EntitySignalLine } from "@hercule/contract";
import { buildInboxCard, buildRequestCard } from "./cards.testing";
import {
  buildOpenTimeline,
  describeTimelineAge,
  describeTimelineOverflow,
  findFirstOpenLine,
  type TimelineSource,
} from "./open-timeline";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const SELF = "acme:ticket:7";
const REVIEW = buildRequestCard("9", { identifier: "#9" });

/** Returns the time `hours` before `NOW` as an ISO timestamp. */
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const buildLine = (id: string, hours: number, overrides: Partial<EntitySignalLine> = {}) =>
  ({
    id,
    kind: "acme/comment",
    title: `Signal ${id}`,
    priority: "normal",
    status: "open",
    createdAt: hoursAgo(hours),
    say: { say: `Said ${id}`, tone: "plain" },
    snoozed: false,
    ...overrides,
  }) satisfies EntitySignalLine;

const buildSource = (overrides: Partial<TimelineSource> = {}): TimelineSource => ({
  ref: SELF,
  signals: [],
  timeline: [],
  places: [],
  peers: [],
  links: [],
  ...overrides,
});

const linkTo = (ref: string, type: EntityLink["claim"]["type"]): EntityLink => ({
  fromRef: SELF,
  toRef: ref,
  claim: { type },
});

describe("describeTimelineAge", () => {
  it.each([
    [0, "1 min ago"],
    [0.25, "15 min ago"],
    [1, "1h ago"],
    [5, "5h ago"],
    [23.9, "23h ago"],
    [24, "Yesterday"],
    [47, "2 days ago"],
    [24 * 6, "6 days ago"],
    [-3, "1 min ago"],
  ])("reads %s hours as %s", (hours, words) => {
    expect(describeTimelineAge(hoursAgo(hours), NOW)).toBe(words);
  });
});

describe("buildOpenTimeline", () => {
  it("weaves signals and changes by time, oldest first, whatever order they were read in", () => {
    const lines = buildOpenTimeline(
      buildSource({
        signals: [buildLine("s1", 10), buildLine("s2", 2)],
        timeline: [
          { reason: "reassigned", say: { say: "Now with Tessa", tone: "plain" }, at: hoursAgo(5) },
        ],
      }),
      [],
    );

    expect(lines.map((line) => line.say)).toEqual(["Said s1", "Now with Tessa", "Said s2"]);
  });

  it("marks only the newest live line as the latest, never a resolved or snoozed one", () => {
    const lines = buildOpenTimeline(
      buildSource({
        signals: [
          buildLine("s1", 10),
          buildLine("s2", 4, { status: "resolved", outcome: "Approved" }),
          buildLine("s3", 2, { snoozed: true }),
        ],
      }),
      [],
    );

    expect(lines.map((line) => line.isLatest)).toEqual([true, false, false]);
    expect(lines[1]?.signal).toMatchObject({ isOpen: false, outcome: "Approved" });
    expect(lines[2]?.signal).toMatchObject({ isOpen: true, isSnoozed: true });
  });

  it("keeps a lone resolved line with no latest", () => {
    const lines = buildOpenTimeline(
      buildSource({ signals: [buildLine("s1", 3, { status: "resolved" })] }),
      [],
    );

    expect(lines.map((line) => line.isLatest)).toEqual([false]);
  });

  it("names the asker only when the sentence does not", () => {
    const lines = buildOpenTimeline(
      buildSource({
        signals: [
          buildLine("s1", 3, {
            asker: "Ines",
            say: { say: "Ines asked for review", tone: "plain" },
          }),
          buildLine("s2", 2, { asker: "Ines", say: { say: "Checks failed", tone: "bad" } }),
        ],
      }),
      [],
    );

    expect(lines.map((line) => line.person)).toEqual([undefined, "Ines"]);
  });

  it("weaves in the newest signal of a confirmed linked card, with its mark and identifier", () => {
    const linked = {
      ...REVIEW,
      signals: {
        openCount: 1,
        latest: buildLine("p1", 1, { say: { say: "Checks failed", tone: "bad" } }),
      },
    };

    const lines = buildOpenTimeline(
      buildSource({
        signals: [buildLine("s1", 6)],
        links: [linkTo(REVIEW.ref, "source")],
      }),
      [linked],
    );

    expect(lines.at(-1)).toMatchObject({
      say: "Checks failed",
      isLinked: true,
      identifier: "#9",
      markPluginId: "acme",
      isLatest: true,
      tone: "bad",
    });
  });

  it("does not weave in the card of a hint in text, which proves nothing", () => {
    const linked = {
      ...REVIEW,
      signals: { openCount: 1, latest: buildLine("p1", 1) },
    };

    const lines = buildOpenTimeline(buildSource({ links: [linkTo(REVIEW.ref, "text")] }), [linked]);

    expect(lines).toEqual([]);
  });

  it("weaves in a linked card when the link points at this thing", () => {
    const linked = { ...REVIEW, signals: { openCount: 1, latest: buildLine("p1", 1) } };

    const lines = buildOpenTimeline(
      buildSource({ links: [{ fromRef: REVIEW.ref, toRef: SELF, claim: { type: "person" } }] }),
      [linked],
    );

    expect(lines).toHaveLength(1);
  });

  it("draws a change that says a thing was linked with that thing's mark and identifier", () => {
    const lines = buildOpenTimeline(
      buildSource({
        timeline: [
          {
            reason: "linked",
            say: { say: "Linked #9", tone: "plain" },
            at: hoursAgo(2),
            ref: REVIEW.ref,
          },
        ],
      }),
      [REVIEW],
    );

    expect(lines[0]).toMatchObject({ identifier: "#9", markPluginId: "acme", isLinked: false });
  });

  it("draws a change with a ref nobody knows as a plain line", () => {
    const lines = buildOpenTimeline(
      buildSource({
        timeline: [
          {
            reason: "linked",
            say: { say: "Linked #1", tone: "plain" },
            at: hoursAgo(2),
            ref: "x:y",
          },
        ],
      }),
      [],
    );

    expect(lines[0]).toMatchObject({ identifier: undefined, markPluginId: undefined });
  });
});

describe("describeTimelineOverflow", () => {
  const lines = (open: number, resolved: number): EntitySignalLine[] => [
    ...Array.from({ length: resolved }, (_, index) =>
      buildLine(`r${String(index)}`, 100 + index, { status: "resolved" }),
    ),
    ...Array.from({ length: open }, (_, index) => buildLine(`o${String(index)}`, index)),
  ];

  it.each([
    // [open shown, resolved shown, openCount, signalCount, expected]
    [3, 0, 3, 3, undefined],
    [50, 0, 62, 62, { kind: "open", count: 12, words: "and 12 more open" }],
    [50, 0, 1_262, 1_262, { kind: "open", count: 1_212, words: "and 1,212 more open" }],
    [2, 3, 2, 17, { kind: "older", count: 12, words: "and 12 older" }],
    [0, 50, 0, 51, { kind: "older", count: 1, words: "and 1 older" }],
    // Open work left out wins over resolved work left out.
    [49, 0, 60, 90, { kind: "open", count: 11, words: "and 11 more open" }],
  ] as const)(
    "with %s open and %s resolved shown, says %j",
    (open, resolved, openCount, signalCount, expected) => {
      expect(
        describeTimelineOverflow({ signals: lines(open, resolved), openCount, signalCount }),
      ).toEqual(expected);
    },
  );

  it("counts a snoozed line shown as an open line shown", () => {
    expect(
      describeTimelineOverflow({
        signals: [buildLine("a", 1, { snoozed: true })],
        openCount: 1,
        signalCount: 1,
      }),
    ).toBeUndefined();
  });
});

describe("findFirstOpenLine", () => {
  it.each([
    ["the newest open line", [buildLine("a", 9), buildLine("b", 3)], "b"],
    [
      "the newest open line that is not snoozed",
      [buildLine("a", 9), buildLine("b", 3, { snoozed: true })],
      "a",
    ],
    [
      "the newest open line when every one is snoozed",
      [buildLine("a", 9, { snoozed: true }), buildLine("b", 3, { snoozed: true })],
      "b",
    ],
    ["no line when all have ended", [buildLine("a", 9, { status: "resolved" })], undefined],
    ["no line when there are none", [], undefined],
  ] as const)("picks %s", (_name, signals, expected) => {
    expect(findFirstOpenLine(signals)).toBe(expected);
  });
});

describe("buildOpenTimeline with a thing nobody has a card for", () => {
  it("ignores the link when the far end has no card on the page", () => {
    const card = buildInboxCard("5");
    expect(
      buildOpenTimeline(buildSource({ links: [linkTo("acme:other:1", "source")] }), [card]),
    ).toEqual([]);
  });
});
