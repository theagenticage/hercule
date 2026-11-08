/** Tests the state a card has beyond its stage, and the words for a card that waits on others. */
import { describe, expect, it } from "vitest";
import type { WorkCard } from "@hercule/contract";
import { buildCard, FAILURE, QUESTION } from "./cards.testing";
import { decideCardState, describeCardBlockers } from "./card-state";

const blocker = (id: string, title: string) => ({ id, title, stage: "building" as const });

/** A card that waits on the blockers given, counting `extra` more that the card does not list. */
const waiting = (overrides: Partial<WorkCard> = {}, titles = ["Add a refund button"], extra = 0) =>
  buildCard("x", {
    blockedBy: titles.map((title, index) => blocker(`b${String(index)}`, title)),
    blockedByCount: titles.length + extra,
    ...overrides,
  });

describe("decideCardState", () => {
  it.each([
    ["a card with nothing to say", buildCard("x"), "open"],
    ["a card that waits on a Task", waiting(), "blocked"],
    ["a card at Landed", buildCard("x", { stage: "landed" }), "landed"],
    ["a card at Landed that waits on a Task", waiting({ stage: "landed" }), "landed"],
    ["a blocked card with a question", waiting({ openQuestion: QUESTION }), "question"],
    [
      "a failed card with a question",
      buildCard("x", { failure: FAILURE, openQuestion: QUESTION }),
      "failed",
    ],
    ["a failed card that is blocked", waiting({ failure: FAILURE }), "failed"],
    ["a failed card at Landed", buildCard("x", { stage: "landed", failure: FAILURE }), "failed"],
  ])("reads %s", (_, card, state) => {
    expect(decideCardState(card)).toBe(state);
  });
});

describe("describeCardBlockers", () => {
  it.each([
    ["one blocker", waiting(), "Waits on Add a refund button"],
    [
      "two blockers",
      waiting({}, ["Add a refund button", "Plan the rollout"]),
      "Waits on Add a refund button and 1 more",
    ],
    [
      "more blockers than the card lists",
      waiting({}, ["Add a refund button"], 11),
      "Waits on Add a refund button and 11 more",
    ],
    ["a long title", waiting({}, ["x".repeat(50)]), `Waits on ${"x".repeat(31)}…`],
  ])("words %s", (_, card, words) => {
    expect(describeCardBlockers(card)).toEqual({ words, firstBlockerId: "b0" });
  });

  it.each([
    ["a card that waits on nothing", buildCard("x")],
    ["a failed card, because a failure outranks", waiting({ failure: FAILURE })],
    ["a card with a question", waiting({ openQuestion: QUESTION })],
    ["a card at Landed", waiting({ stage: "landed" })],
  ])("says nothing for %s", (_, card) => {
    expect(describeCardBlockers(card)).toBeNull();
  });
});
