/**
 * Tests the roll of a hand-off on its row: which parts roll and when, that a
 * wait that stays is not rolled out, and that cancelling, finishing and Reduce
 * motion leave nothing behind. jsdom has no layout and no Web Animations, so
 * the tests read the animations that are asked for.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installFakeAnimations,
  removeFakeAnimations,
  type FakeAnimation,
} from "../../app/motion/testing-animations";
import { rollHandedRow } from "./inbox-hand-off-motion";

let played: FakeAnimation[];

const setReduced = (reduced: boolean): void => {
  document.documentElement.style.setProperty("--dur-2", reduced ? "0s" : "200ms");
};

/** Builds a span of class `className` holding `text`. */
const span = (className: string, text: string, ...inside: HTMLElement[]): HTMLElement => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  element.append(...inside);
  return element;
};

/** Draws a row whose first line ends in a wait and whose second line holds a sentence. */
const drawRow = (): HTMLElement => {
  const row = document.createElement("div");
  row.dataset["ref"] = "r1";
  row.append(
    span("ib-row-l1", "", span("ib-row-title", "T"), span("ib-row-time", "5d")),
    span("ib-row-l2", "", span("ib-row-why", "Mei asked")),
  );
  const rows = document.createElement("div");
  rows.className = "ib-rows";
  rows.append(row);
  document.body.replaceChildren(rows);
  return row;
};

/** Changes the row as the hand-off does: a face takes the slot and a new sentence the line. */
const handOff = (row: HTMLElement, { keepsWait }: { keepsWait: boolean }): (() => void) => {
  return () => {
    const slot = row.querySelector(".ib-row-time")!;
    if (!keepsWait) {
      slot.className = "ib-row-time ib-row-time--held";
      slot.textContent = "face";
    }
    row.querySelector(".ib-row-why")!.textContent = "Review PR has it";
  };
};

beforeEach(() => {
  played = installFakeAnimations();
  setReduced(false);
});

afterEach(() => {
  removeFakeAnimations();
  document.body.replaceChildren();
});

describe("rollHandedRow", () => {
  it("rolls the wait out as the face rolls in, then knocks the face and rolls the sentence 170ms later", () => {
    const row = drawRow();

    rollHandedRow("r1", handOff(row, { keepsWait: false }));

    const slot = row.querySelector(".ib-row-time")!;
    const sentence = row.querySelector(".ib-row-why")!;
    const delayOf = (element: Element): number[] =>
      played.filter((each) => each.element === element).map((each) => Number(each.options.delay));
    expect(delayOf(slot)).toEqual([0, 170]);
    expect(delayOf(sentence)).toEqual([170]);
    // The old wait and the old sentence are copies in clips, which roll away.
    expect(row.querySelectorAll(".ib-roll-clip")).toHaveLength(2);
    expect(row.querySelector(".ib-row-l1")!.hasAttribute("data-rolling")).toBe(true);
  });

  it("keeps the wait when asks are left, and rolls only the sentence", () => {
    const row = drawRow();

    rollHandedRow("r1", handOff(row, { keepsWait: true }));

    expect(played.some((each) => each.element === row.querySelector(".ib-row-time"))).toBe(false);
    expect(row.querySelectorAll(".ib-roll-clip")).toHaveLength(1);
  });

  it("takes the copies away when the roll ends", () => {
    const row = drawRow();
    rollHandedRow("r1", handOff(row, { keepsWait: false }));

    for (const animation of played) animation.finish();

    expect(row.querySelector(".ib-roll-clip")).toBeNull();
    expect(row.querySelector("[data-rolling]")).toBeNull();
  });

  it("stops and takes everything away when cancelled", () => {
    const row = drawRow();
    const roll = rollHandedRow("r1", handOff(row, { keepsWait: false }));

    roll.cancel();

    expect(played.every((animation) => animation.isCancelled)).toBe(true);
    expect(row.querySelector(".ib-roll-clip")).toBeNull();
    expect(row.querySelector("[data-rolling]")).toBeNull();
  });

  it("changes the row at once and draws nothing under Reduce motion", () => {
    setReduced(true);
    const row = drawRow();

    rollHandedRow("r1", handOff(row, { keepsWait: false }));

    expect(row.querySelector(".ib-row-why")!.textContent).toBe("Review PR has it");
    expect(played).toHaveLength(0);
    expect(row.querySelector(".ib-roll-clip")).toBeNull();
  });

  it("runs the change when the row is not drawn", () => {
    let changed = false;

    rollHandedRow("gone", () => {
      changed = true;
    });

    expect(changed).toBe(true);
    expect(played).toHaveLength(0);
  });
});
