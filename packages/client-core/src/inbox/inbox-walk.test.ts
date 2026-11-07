/** Tests how the keys walk the Inbox page and which card the page moves on to after a move. */
import { describe, expect, it } from "vitest";
import {
  decideNextWaitingCard,
  walkInbox,
  type InboxStop,
  type InboxWalk,
  type WalkedFrom,
} from "./inbox-walk";

const stop = (
  id: string,
  column: InboxStop["column"],
  middle: number,
  waits = true,
): InboxStop => ({ id, column, middle, waits });

// The page: three rows on the wide side, three requests in the column.
//   a(40)            r(60)
//   b(140)           s(120)
//   c(300)           t(380, has a Task)
const PAGE: readonly InboxStop[] = [
  stop("a", "wide", 40),
  stop("b", "wide", 140),
  stop("c", "wide", 300),
  stop("r", "narrow", 60),
  stop("s", "narrow", 120),
  stop("t", "narrow", 380, false),
];

describe("walkInbox", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined, InboxWalk, string | undefined]> =
    [
      ["lands on the first card when nothing is current", undefined, "down", "a"],
      ["lands on the first card when the current card has left the page", "gone", "left", "a"],
      ["goes down within the column", "a", "down", "b"],
      ["goes up within the column", "c", "up", "b"],
      ["stays at the top of the column", "a", "up", undefined],
      ["stays at the foot of the column", "t", "down", undefined],
      ["does not cross to the other column going down", "c", "down", undefined],
      ["crosses right to the card at the nearest height", "b", "right", "s"],
      ["crosses right from a low row to the lowest request", "c", "right", "t"],
      ["crosses left to the card at the nearest height", "t", "left", "c"],
      ["crosses left from a high request to the top row", "r", "left", "a"],
      ["has nowhere to go right in the narrow column", "r", "right", undefined],
      ["has nowhere to go left on the wide side", "a", "left", undefined],
      ["reads on through the page", "c", "next", "r"],
      ["reads back through the page", "r", "previous", "c"],
      ["stops reading at the last card", "t", "next", undefined],
      ["stops reading at the first card", "a", "previous", undefined],
    ];
  it.each(cases)("%s", (_name, current, walk, expected) => {
    expect(walkInbox(PAGE, current, walk)).toBe(expected);
  });

  it("comes straight back with the opposite key, even when the cards do not line up", () => {
    const cameFrom: WalkedFrom = { id: "a", walk: "right" };
    // Right from "a" reached "r". Left from "s" would reach "b" by height, but it returns to "a".
    expect(walkInbox(PAGE, "s", "left", cameFrom)).toBe("a");
    expect(walkInbox(PAGE, "s", "left")).toBe("b");
  });

  it("does not go back to a card that left, and ignores a walk that is not the opposite", () => {
    expect(walkInbox(PAGE, "s", "left", { id: "gone", walk: "right" })).toBe("b");
    expect(walkInbox(PAGE, "s", "down", { id: "a", walk: "right" })).toBe("t");
  });

  it("picks the earlier card when two are as near", () => {
    const page = [stop("x", "wide", 100), stop("y", "narrow", 50), stop("z", "narrow", 150)];
    expect(walkInbox(page, "x", "right")).toBe("y");
  });

  it("has nowhere to go on an empty page", () => {
    expect(walkInbox([], undefined, "down")).toBeUndefined();
  });
});

describe("decideNextWaitingCard", () => {
  it("moves on to the card after it in its column", () => {
    expect(decideNextWaitingCard(PAGE, "a")).toBe("b");
    expect(decideNextWaitingCard(PAGE, "r")).toBe("s");
  });

  it("skips a card that already has a Task", () => {
    const page = [stop("a", "wide", 0), stop("b", "wide", 1, false), stop("c", "wide", 2)];
    expect(decideNextWaitingCard(page, "a")).toBe("c");
  });

  it("goes back to the nearest card before it when none waits after it", () => {
    expect(decideNextWaitingCard(PAGE, "c")).toBe("b");
    expect(decideNextWaitingCard(PAGE, "s")).toBe("r");
  });

  it("stays in its column, even when the other column still waits", () => {
    const page = [stop("a", "wide", 0), stop("r", "narrow", 0), stop("t", "narrow", 1, false)];
    expect(decideNextWaitingCard(page, "r")).toBeUndefined();
  });

  it("has no next card when it is the last that waits, or when it is not on the page", () => {
    expect(decideNextWaitingCard([stop("a", "wide", 0)], "a")).toBeUndefined();
    expect(decideNextWaitingCard(PAGE, "gone")).toBeUndefined();
  });
});
