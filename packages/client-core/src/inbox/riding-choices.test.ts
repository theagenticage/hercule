/** Tests how the user's own Link and Unlink settle what rides on what, also when moves overlap or are refused. */
import { describe, expect, it } from "vitest";
import {
  chooseLead,
  decideRidingChoices,
  EMPTY_RIDING_LEDGER,
  NO_RIDING_CHOICES,
  settleRidingMove,
  startRidingMove,
  type RidingChoice,
  type RidingLedger,
  type RidingMove,
} from "./riding-choices";

const A = "acme:ticket:1";
const B = "acme:ticket:2";
const CARD = "review-1";

const link = (lead: string, before: RidingChoice): RidingMove => ({
  kind: "link",
  cardId: CARD,
  lead,
  before,
});
const unlink = (lead: string): RidingMove => ({
  kind: "unlink",
  cardId: CARD,
  lead,
  before: chooseLead(lead),
});

/** Starts each move as its own gesture, numbered from 1 in the order given. */
const startAll = (...moves: readonly RidingMove[]): RidingLedger =>
  moves.reduce(
    (ledger, move, index) => startRidingMove(ledger, index + 1, move),
    EMPTY_RIDING_LEDGER,
  );

const choiceOf = (ledger: RidingLedger): RidingChoice | undefined =>
  decideRidingChoices(ledger).get(CARD);

describe("decideRidingChoices", () => {
  it("holds no choice for an empty ledger", () => {
    expect(decideRidingChoices(EMPTY_RIDING_LEDGER)).toBe(NO_RIDING_CHOICES);
  });

  it("puts a card on the lead it was linked to while the controller has not answered", () => {
    expect(choiceOf(startAll(link(A, chooseLead(undefined))))).toEqual(chooseLead(A));
  });

  it("keeps the first lead when the card is linked to a second one", () => {
    const ledger = startAll(link(A, chooseLead(undefined)), link(B, chooseLead(A)));
    expect(choiceOf(ledger)).toEqual(chooseLead(A));
  });

  it("takes a card off its lead while the unlink waits, and leaves a card on another lead alone", () => {
    expect(choiceOf(startAll(unlink(A)))).toEqual(chooseLead(undefined));
    const onOther: RidingMove = { ...unlink(A), before: chooseLead(B) };
    expect(choiceOf(startAll(onOther))).toEqual(chooseLead(B));
  });
});

describe("settleRidingMove", () => {
  it("settles a linked card on its lead", () => {
    const settled = settleRidingMove(startAll(link(A, chooseLead(undefined))), 1, true);
    expect(settled.waiting).toEqual([]);
    expect(choiceOf(settled)).toEqual(chooseLead(A));
  });

  it("puts a card back where it stood when its link is refused", () => {
    const settled = settleRidingMove(startAll(link(A, chooseLead(undefined))), 1, false);
    expect(choiceOf(settled)).toEqual(chooseLead(undefined));
  });

  it("plays a later link again when the earlier one fails, so the card ends on the later lead", () => {
    const ledger = startAll(link(A, chooseLead(undefined)), link(B, chooseLead(A)));
    const afterFirst = settleRidingMove(ledger, 1, false);
    expect(choiceOf(afterFirst)).toEqual(chooseLead(B));
    expect(choiceOf(settleRidingMove(afterFirst, 2, true))).toEqual(chooseLead(B));
  });

  it("keeps the first lead when both links succeed", () => {
    const ledger = startAll(link(A, chooseLead(undefined)), link(B, chooseLead(A)));
    const settled = settleRidingMove(settleRidingMove(ledger, 1, true), 2, true);
    expect(choiceOf(settled)).toEqual(chooseLead(A));
  });

  it("does not overwrite a later move that waits when an earlier one is answered", () => {
    const ledger = startAll(unlink(A), link(B, chooseLead(undefined)));
    expect(choiceOf(settleRidingMove(ledger, 1, true))).toEqual(chooseLead(B));
  });

  it("keeps the card on its lead when the earlier unlink is refused, whatever a later link waits for", () => {
    const ledger = startAll(unlink(A), link(B, chooseLead(undefined)));
    expect(choiceOf(settleRidingMove(ledger, 1, false))).toEqual(chooseLead(A));
  });

  it("keeps a card riding when an unlink did not change what rides, as when a source still reports the link", () => {
    const settled = settleRidingMove(startAll(unlink(A)), 1, false);
    expect(choiceOf(settled)).toEqual(chooseLead(A));
  });

  it("lets a card stand alone when an unlink left only a reference in text", () => {
    const settled = settleRidingMove(startAll(unlink(A)), 1, true);
    expect(choiceOf(settled)).toEqual(chooseLead(undefined));
  });

  it("returns the ledger itself for a gesture with no move waiting", () => {
    const ledger = startAll(unlink(A));
    expect(settleRidingMove(ledger, 9, true)).toBe(ledger);
  });
});
