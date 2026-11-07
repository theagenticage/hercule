/**
 * Tests `decideRiding` as a table: who rides on whom, from the cards and the
 * links alone.
 */
import { describe, expect, it } from "vitest";
import { decideRiding, selectInboxPage, type RidingCard, type RidingLink } from "./riding";

const NOW = Date.parse("2026-03-10T00:00:00.000Z");
const HOUR = 3_600_000;
const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

/** A ticket-like lasting thing: rich, with a clock of 100 hours of patience. */
const lead = (ref: string, waitedHours = 0, overrides: Partial<RidingCard> = {}): RidingCard => ({
  ref,
  card: "rich",
  pace: "fast",
  patience: 100,
  waitingSince: hoursAgo(waitedHours),
  hasTask: false,
  ...overrides,
});

/** A pull-request-like small thing: compact, in Requests. */
const small = (ref: string, overrides: Partial<RidingCard> = {}): RidingCard => ({
  ref,
  card: "compact",
  pace: "fast",
  patience: 24,
  waitingSince: hoursAgo(1),
  hasTask: false,
  ...overrides,
});

const link = (
  fromRef: string,
  toRef: string,
  type: RidingLink["claim"]["type"] = "source",
): RidingLink => ({ fromRef, toRef, claim: { type } });

const ride = (cards: ReadonlyArray<RidingCard>, links: ReadonlyArray<RidingLink>) =>
  Object.fromEntries(decideRiding(cards, links, NOW));

describe("decideRiding", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly cards: ReadonlyArray<RidingCard>;
    readonly links: ReadonlyArray<RidingLink>;
    readonly rides: Record<string, string>;
  }> = [
    {
      name: "rides a small thing on the one lead it links, whichever way the link points",
      cards: [lead("T"), small("A"), small("B")],
      links: [link("T", "A"), link("B", "T", "person")],
      rides: { A: "T", B: "T" },
    },
    {
      name: "rides on the lead that has used the largest share of its patience, not the longest wait",
      // X waited 50h of 100h (half). Y waited 80h of 400h (a fifth).
      cards: [lead("X", 50), lead("Y", 80, { patience: 400 }), small("A")],
      links: [link("A", "Y"), link("A", "X")],
      rides: { A: "X" },
    },
    {
      name: "breaks a tie in the share by the lowest ref",
      cards: [lead("M", 10), lead("K", 10), small("A")],
      links: [link("A", "M"), link("A", "K")],
      rides: { A: "K" },
    },
    {
      name: "counts a lead with no clock as having used none: a slow kind, or a lead a Task holds",
      cards: [
        lead("Slow", 500, { pace: "slow" }),
        lead("Held", 500, { hasTask: true }),
        lead("Ticking", 1),
        small("A"),
      ],
      links: [link("A", "Slow"), link("A", "Held"), link("A", "Ticking")],
      rides: { A: "Ticking" },
    },
    {
      name: "keeps a small thing with no link on its own",
      cards: [lead("T"), small("A")],
      links: [],
      rides: {},
    },
    {
      name: "never rides two lasting things on each other",
      cards: [lead("T"), lead("U", 99)],
      links: [link("T", "U")],
      rides: {},
    },
    {
      name: "joins only what touches the lead in a chain",
      // A is linked to the lead T, B only to A, C only to B.
      cards: [lead("T"), small("A"), small("B"), small("C")],
      links: [link("T", "A"), link("A", "B"), link("B", "C")],
      rides: { A: "T" },
    },
    {
      name: "rides a small thing that links two lasting things on the most pressing one, and the other shows as a quiet row",
      cards: [lead("T", 5), lead("U", 60), small("A")],
      links: [link("A", "T"), link("A", "U"), link("T", "U")],
      rides: { A: "U" },
    },
    {
      name: "stands a small thing alone when its lead is not among the cards, as when it is dismissed",
      cards: [small("A"), small("B")],
      links: [link("T", "A"), link("T", "B")],
      rides: {},
    },
    {
      name: "joins nothing for a shared repository or project, which is no link",
      cards: [lead("T"), small("A"), small("B")],
      links: [],
      rides: {},
    },
    {
      name: "keeps a small thing a live Task holds out of the ride, on the with-someone-else side",
      cards: [lead("T"), small("A", { hasTask: true }), small("B")],
      links: [link("T", "A"), link("B", "T")],
      rides: { B: "T" },
    },
  ];

  it.each(cases)("$name", ({ cards, links, rides }) => {
    expect(ride(cards, links)).toEqual(rides);
  });

  it("does not depend on the order of the cards or the links", () => {
    const cards = [lead("T", 5), lead("U", 60), small("A")];
    const links = [link("A", "T"), link("A", "U")];
    expect(ride([...cards].reverse(), [...links].reverse())).toEqual(ride(cards, links));
  });
});

describe("selectInboxPage", () => {
  const pick = (refs: ReadonlyArray<string>, riding: Record<string, string>, limit: number) => {
    const page = selectInboxPage(refs, new Map(Object.entries(riding)), limit);
    return { refs: refs.filter((ref) => page.refs.has(ref)), truncated: page.truncated };
  };

  it("takes every card, in no particular bundle, when they all fit", () => {
    expect(pick(["a", "b", "c"], {}, 3)).toEqual({ refs: ["a", "b", "c"], truncated: false });
  });

  it("brings the riders of a lead that comes later than they do, and never picks a rider alone", () => {
    // p1 and p2 are older than their lead t. With room for 3, t brings both and x is left off.
    expect(pick(["p1", "p2", "t", "x"], { p1: "t", p2: "t" }, 3)).toEqual({
      refs: ["p1", "p2", "t"],
      truncated: true,
    });
  });

  it("stops at the first bundle that does not fit, rather than skipping to a smaller one", () => {
    expect(pick(["a", "p1", "p2", "t", "z"], { p1: "t", p2: "t" }, 3)).toEqual({
      refs: ["a"],
      truncated: true,
    });
  });

  it("brings every rider of a lead, in their order, when the whole bundle fits", () => {
    const riders = Array.from({ length: 30 }, (_, index) => `p${String(index)}`);
    const riding = Object.fromEntries(riders.map((rider) => [rider, "t"]));
    expect(pick(["x", ...riders, "t", "y"], riding, 32)).toEqual({
      refs: ["x", ...riders, "t"],
      truncated: true,
    });
  });

  it("never leaves the page empty: a first bundle larger than the page is cut to the lead and its oldest riders", () => {
    const riders = Array.from({ length: 10 }, (_, index) => `p${String(index)}`);
    const riding = Object.fromEntries(riders.map((rider) => [rider, "t"]));
    expect(pick([...riders, "t"], riding, 4)).toEqual({
      refs: ["p0", "p1", "p2", "t"],
      truncated: true,
    });
  });
});
