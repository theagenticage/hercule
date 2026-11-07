/** Tests what a cell shows: the row limit, loud cards, failures leading, Landed as a line, filters, stacks. */
import { describe, expect, it } from "vitest";
import type { WorkCard, WorkStackCandidate } from "@hercule/contract";
import { arrangeCell, type CellView } from "./arrange-cell";
import { buildCard, FAILURE, listIds, QUESTION } from "./cards.testing";

/** Returns `count` plain cards named c1, c2, ... */
const buildPlain = (count: number): readonly WorkCard[] =>
  Array.from({ length: count }, (_, index) => buildCard(`c${String(index + 1)}`));

const CLOSED: CellView = { stage: "building", opened: false, filtered: false };

describe("arrangeCell", () => {
  it.each([0, 3, 4, 5])("shows all of a cell of %i cards, with no line", (count) => {
    const arranged = arrangeCell(buildPlain(count), CLOSED);
    expect(arranged.cards).toHaveLength(count);
    expect(arranged.foot).toBe("none");
    expect(arranged.hiddenCards).toEqual([]);
  });

  it("shows four cards and a '2 more' line for six", () => {
    const arranged = arrangeCell(buildPlain(6), CLOSED);
    expect(listIds(arranged.cards)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(listIds(arranged.hiddenCards)).toEqual(["c5", "c6"]);
    expect(arranged.foot).toBe("more");
  });

  it("counts '13 more' for seventeen cards", () => {
    const arranged = arrangeCell(buildPlain(17), CLOSED);
    expect(arranged.cards).toHaveLength(4);
    expect(arranged.hiddenCards).toHaveLength(13);
    expect(arranged.foot).toBe("more");
  });

  it("opens every card in place and offers Show fewer", () => {
    const arranged = arrangeCell(buildPlain(17), { ...CLOSED, opened: true });
    expect(arranged.cards).toHaveLength(17);
    expect(arranged.hiddenCards).toEqual([]);
    expect(arranged.foot).toBe("fewer");
  });

  it("offers no Show fewer for an opened cell that hides nothing", () => {
    const arranged = arrangeCell(buildPlain(5), { ...CLOSED, opened: true });
    expect(arranged.foot).toBe("none");
  });

  it("shows a card with a question past the fourth row, after the fourth", () => {
    const cards = [...buildPlain(8)];
    cards[6] = buildCard("asks", { openQuestion: QUESTION });
    const arranged = arrangeCell(cards, CLOSED);
    expect(listIds(arranged.cards)).toEqual(["c1", "c2", "c3", "c4", "asks"]);
    expect(arranged.hiddenCards).toHaveLength(3);
    expect(arranged.foot).toBe("more");
  });

  it("offers no line when everything past the fourth row is loud", () => {
    const cards = [
      ...buildPlain(3),
      buildCard("asks-1", { openQuestion: QUESTION }),
      buildCard("broke", { failure: FAILURE }),
      buildCard("asks-2", { openQuestion: QUESTION }),
    ];
    const arranged = arrangeCell(cards, CLOSED);
    expect(listIds(arranged.cards)).toEqual(["broke", "c1", "c2", "c3", "asks-1", "asks-2"]);
    expect(arranged.foot).toBe("none");
  });

  it("leads the cell with a failed card and keeps the stored order of the failed ones", () => {
    const cards = [
      buildCard("a"),
      buildCard("fail-2", { failure: FAILURE }),
      buildCard("b"),
      buildCard("fail-1", { failure: FAILURE }),
    ];
    expect(listIds(arrangeCell(cards, CLOSED).cards)).toEqual(["fail-2", "fail-1", "a", "b"]);
  });

  it("shows every failed card even when there are more than four", () => {
    const cards = Array.from({ length: 6 }, (_, index) =>
      buildCard(`f${String(index)}`, { failure: FAILURE }),
    );
    const arranged = arrangeCell([...cards, ...buildPlain(3)], CLOSED);
    expect(arranged.cards).toHaveLength(6);
    expect(arranged.hiddenCards).toHaveLength(3);
  });

  it("does not change the cards it is given", () => {
    const cards = [buildCard("a"), buildCard("f", { failure: FAILURE })];
    arrangeCell(cards, CLOSED);
    expect(listIds(cards)).toEqual(["a", "f"]);
  });

  it("lifts the limit when a filter is on", () => {
    const arranged = arrangeCell(buildPlain(17), { ...CLOSED, filtered: true });
    expect(arranged.cards).toHaveLength(17);
    expect(arranged.foot).toBe("none");
  });

  describe("Landed", () => {
    const LANDED: CellView = { stage: "landed", opened: false, filtered: false };

    it("shows three cards as one '3 landed' line", () => {
      const arranged = arrangeCell(buildPlain(3), LANDED);
      expect(arranged.cards).toEqual([]);
      expect(arranged.hiddenCards).toHaveLength(3);
      expect(arranged.foot).toBe("landed");
    });

    it("shows a failed card as a card above the line, which counts the others", () => {
      const cards = [buildCard("a"), buildCard("broke", { failure: FAILURE }), buildCard("b")];
      const arranged = arrangeCell(cards, LANDED);
      expect(listIds(arranged.cards)).toEqual(["broke"]);
      expect(listIds(arranged.hiddenCards)).toEqual(["a", "b"]);
      expect(arranged.foot).toBe("landed");
    });

    it("shows a card with a question as a card above the line", () => {
      const arranged = arrangeCell(
        [buildCard("a"), buildCard("asks", { openQuestion: QUESTION })],
        LANDED,
      );
      expect(listIds(arranged.cards)).toEqual(["asks"]);
    });

    it("has no line when every card is loud", () => {
      const arranged = arrangeCell([buildCard("broke", { failure: FAILURE })], LANDED);
      expect(arranged.foot).toBe("none");
    });

    it("opens like any cell, failed card first", () => {
      const cards = [buildCard("a"), buildCard("broke", { failure: FAILURE })];
      const arranged = arrangeCell(cards, { ...LANDED, opened: true });
      expect(listIds(arranged.cards)).toEqual(["broke", "a"]);
      expect(arranged.foot).toBe("fewer");
    });

    it("shows every card when a filter is on", () => {
      const arranged = arrangeCell(buildPlain(3), { ...LANDED, filtered: true });
      expect(arranged.cards).toHaveLength(3);
      expect(arranged.foot).toBe("none");
    });

    it("has no line for an empty cell", () => {
      expect(arrangeCell([], LANDED).foot).toBe("none");
    });
  });

  describe("stacks", () => {
    /** Returns the pair "`lead` links a rich thing, `member` is the thing it holds". */
    const pair = (lead: string, member: string, noun = "pull request"): WorkStackCandidate => ({
      leadTaskId: lead,
      memberTaskId: member,
      noun,
    });
    const ids = (cards: readonly WorkCard[]) => listIds(cards);

    it("makes no stack, and no map entry, when there are no candidates", () => {
      const arranged = arrangeCell(buildPlain(3), CLOSED);
      expect(arranged.stacks.size).toBe(0);
      expect(ids(arranged.cards)).toEqual(["c1", "c2", "c3"]);
    });

    it("stacks a ticket's Task with the Tasks of its pull requests, and says why", () => {
      const cards = [buildCard("pr-1"), buildCard("ticket"), buildCard("pr-2"), buildCard("other")];
      const arranged = arrangeCell(cards, CLOSED, [pair("ticket", "pr-1"), pair("ticket", "pr-2")]);
      // pr-1 sits above the ticket in stored order and still joins its stack.
      expect(ids(arranged.cards)).toEqual(["ticket", "other"]);
      expect(ids(arranged.stacks.get("ticket")!.members)).toEqual(["pr-1", "pr-2"]);
    });

    it("walks the cell in stored order, so the first Task with members leads", () => {
      const cards = [buildCard("ticket"), buildCard("pr-2"), buildCard("pr-1")];
      const arranged = arrangeCell(cards, CLOSED, [pair("ticket", "pr-1"), pair("ticket", "pr-2")]);
      expect(ids(arranged.cards)).toEqual(["ticket"]);
      expect(ids(arranged.stacks.get("ticket")!.members)).toEqual(["pr-2", "pr-1"]);
      expect(arranged.stacks.get("ticket")!.reason).toBe("2 pull requests");
    });

    it("keeps a member in another stage as a card of its own cell", () => {
      const arranged = arrangeCell([buildCard("ticket")], CLOSED, [pair("ticket", "pr-elsewhere")]);
      expect(ids(arranged.cards)).toEqual(["ticket"]);
      expect(arranged.stacks.size).toBe(0);
    });

    it("keeps the Task of a pull request alone when the ticket is in another stage", () => {
      const arranged = arrangeCell([buildCard("pr-1")], CLOSED, [pair("ticket-elsewhere", "pr-1")]);
      expect(ids(arranged.cards)).toEqual(["pr-1"]);
      expect(arranged.stacks.size).toBe(0);
    });

    it("says the reason in the singular for one member and counts each noun for a mixed stack", () => {
      const one = arrangeCell([buildCard("t"), buildCard("a")], CLOSED, [
        pair("t", "a", "Pull request"),
      ]);
      expect(one.stacks.get("t")!.reason).toBe("1 pull request");
      const mixed = arrangeCell(
        [buildCard("t"), buildCard("a"), buildCard("b"), buildCard("c")],
        CLOSED,
        [pair("t", "a"), pair("t", "b", "issue"), pair("t", "c")],
      );
      expect(mixed.stacks.get("t")!.reason).toBe("2 pull requests, 1 issue");
    });

    it("does not stack a Task with itself", () => {
      const arranged = arrangeCell([buildCard("t")], CLOSED, [pair("t", "t")]);
      expect(arranged.stacks.size).toBe(0);
    });

    describe("a member that is wanted by two leads", () => {
      it("joins the first lead in stored order, and the second lead stays a card", () => {
        const cards = [buildCard("rich-1"), buildCard("rich-2"), buildCard("compact")];
        const arranged = arrangeCell(cards, CLOSED, [
          pair("rich-2", "compact"),
          pair("rich-1", "compact"),
        ]);
        expect(ids(arranged.cards)).toEqual(["rich-1", "rich-2"]);
        expect(ids(arranged.stacks.get("rich-1")!.members)).toEqual(["compact"]);
        expect(arranged.stacks.has("rich-2")).toBe(false);
      });
    });

    it("makes one stack of two Tasks that each hold the other, led by the first", () => {
      const arranged = arrangeCell([buildCard("t1"), buildCard("t2")], CLOSED, [
        pair("t2", "t1"),
        pair("t1", "t2"),
      ]);
      expect(ids(arranged.cards)).toEqual(["t1"]);
      expect(ids(arranged.stacks.get("t1")!.members)).toEqual(["t2"]);
    });

    it("lets a lead take a Task that the walk passed before it, but never another lead", () => {
      const cards = [buildCard("c"), buildCard("b"), buildCard("a")];
      const arranged = arrangeCell(cards, CLOSED, [pair("a", "b"), pair("b", "c")]);
      // b leads first (it holds c), so a cannot take it, and a stays a card.
      expect(ids(arranged.cards)).toEqual(["b", "a"]);
      expect(ids(arranged.stacks.get("b")!.members)).toEqual(["c"]);
    });

    it("never nests: a member that holds others is a member, and those others stay free", () => {
      const cards = [buildCard("a"), buildCard("b"), buildCard("c")];
      const arranged = arrangeCell(cards, CLOSED, [pair("a", "b"), pair("b", "c")]);
      // b is placed as a's member, so it does not lead. c is then alone.
      expect(ids(arranged.cards)).toEqual(["a", "c"]);
      expect(ids(arranged.stacks.get("a")!.members)).toEqual(["b"]);
    });

    it("shows every Task exactly once, whatever the candidates", () => {
      const cards = buildPlain(7);
      const everyPair = cards.flatMap((lead) => cards.map((member) => pair(lead.id, member.id)));
      const arranged = arrangeCell(cards, { ...CLOSED, filtered: true }, everyPair);
      const shown = [...arranged.cards, ...[...arranged.stacks.values()].flatMap((s) => s.members)];
      expect(ids(shown).toSorted()).toEqual(ids(cards).toSorted());
    });

    describe("opening by itself", () => {
      it("does not open a calm stack", () => {
        const arranged = arrangeCell([buildCard("t"), buildCard("a")], CLOSED, [pair("t", "a")]);
        expect(arranged.stacks.get("t")!.opensItself).toBe(false);
      });

      it.each([
        ["a question", { openQuestion: QUESTION }],
        ["a failure", { failure: FAILURE }],
      ])("opens a stack whose member has %s", (_name, overrides) => {
        const arranged = arrangeCell([buildCard("t"), buildCard("a", overrides)], CLOSED, [
          pair("t", "a"),
        ]);
        expect(arranged.stacks.get("t")!.opensItself).toBe(true);
      });
    });

    describe("display order", () => {
      it("moves a stack with a failed member to the top as one unit", () => {
        const cards = [buildCard("calm"), buildCard("t"), buildCard("broke", { failure: FAILURE })];
        const arranged = arrangeCell(cards, CLOSED, [pair("t", "broke")]);
        expect(ids(arranged.cards)).toEqual(["t", "calm"]);
        expect(ids(arranged.stacks.get("t")!.members)).toEqual(["broke"]);
      });

      it("counts a stack as one row against the limit of four", () => {
        const cards = [...buildPlain(4), buildCard("t"), buildCard("m1"), buildCard("m2")];
        const arranged = arrangeCell(cards, CLOSED, [pair("t", "m1"), pair("t", "m2")]);
        // Five rows: c1-c4 and the stack. The fifth is shown rather than hidden.
        expect(ids(arranged.cards)).toEqual(["c1", "c2", "c3", "c4", "t"]);
        expect(arranged.foot).toBe("none");
      });

      it("shows a stack past the fourth row when a member has a question", () => {
        const cards = [
          ...buildPlain(5),
          buildCard("t"),
          buildCard("asks", { openQuestion: QUESTION }),
        ];
        const arranged = arrangeCell(cards, CLOSED, [pair("t", "asks")]);
        expect(ids(arranged.cards)).toEqual(["c1", "c2", "c3", "c4", "t"]);
        expect(ids(arranged.hiddenCards)).toEqual(["c5"]);
      });

      it("hides a calm stack with its members, and counts them all", () => {
        const cards = [...buildPlain(5), buildCard("t"), buildCard("m1"), buildCard("m2")];
        const arranged = arrangeCell(cards, CLOSED, [pair("t", "m1"), pair("t", "m2")]);
        expect(ids(arranged.cards)).toEqual(["c1", "c2", "c3", "c4"]);
        expect(ids(arranged.hiddenCards)).toEqual(["c5", "t", "m1", "m2"]);
        expect(arranged.foot).toBe("more");
      });

      it("shows a loud stack in Landed as a card above the line", () => {
        const cards = [
          buildCard("t"),
          buildCard("asks", { openQuestion: QUESTION }),
          buildCard("x"),
        ];
        const arranged = arrangeCell(cards, { ...CLOSED, stage: "landed" }, [pair("t", "asks")]);
        expect(ids(arranged.cards)).toEqual(["t"]);
        expect(ids(arranged.hiddenCards)).toEqual(["x"]);
        expect(arranged.foot).toBe("landed");
      });
    });
  });
});
