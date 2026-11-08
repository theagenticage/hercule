/** Tests which Initiative the pane names, what a pick in its menu does, and the words of the change. */
import { describe, expect, it } from "vitest";
import type { WorkInitiative } from "./lanes";
import {
  decideInitiativePick,
  describeInitiativeDone,
  describeInitiativeFailure,
  describeInitiativeGesture,
  findCardInitiative,
  NEW_INITIATIVE_CHOICE_ID,
  NO_INITIATIVE_CHOICE_ID,
} from "./task-initiative";

const CHECKOUT: WorkInitiative = { id: "i1", name: "Accessible checkout", hue: 245 };
const SEARCH: WorkInitiative = { id: "i2", name: "Faster search on phones", hue: 150 };

describe("the Initiative the pane names", () => {
  it.each([
    { name: "an open one", card: { initiativeId: "i1" }, found: CHECKOUT },
    { name: "none", card: {}, found: undefined },
    { name: "a closed one the list leaves out", card: { initiativeId: "gone" }, found: undefined },
    { name: "no card yet", card: undefined, found: undefined },
  ])("is $name", ({ card, found }) => {
    expect(findCardInitiative(card, [CHECKOUT, SEARCH])).toBe(found);
  });
});

describe("what a pick in the Initiative menu does", () => {
  it.each([
    {
      name: "another Initiative",
      choice: "i2",
      card: { initiativeId: "i1" },
      pick: { kind: "set", initiativeId: "i2" },
    },
    {
      name: "an Initiative for a loose card",
      choice: "i1",
      card: {},
      pick: { kind: "set", initiativeId: "i1" },
    },
    {
      name: "the Initiative the card is on",
      choice: "i1",
      card: { initiativeId: "i1" },
      pick: { kind: "keep" },
    },
    {
      name: "No initiative on an Initiative",
      choice: NO_INITIATIVE_CHOICE_ID,
      card: { initiativeId: "i1" },
      pick: { kind: "set", initiativeId: null },
    },
    // A card on a closed Initiative has an id the menu does not list: choosing none clears it.
    {
      name: "No initiative on a closed Initiative",
      choice: NO_INITIATIVE_CHOICE_ID,
      card: { initiativeId: "gone" },
      pick: { kind: "set", initiativeId: null },
    },
    {
      name: "No initiative on a loose card",
      choice: NO_INITIATIVE_CHOICE_ID,
      card: {},
      pick: { kind: "keep" },
    },
    {
      name: "New initiative",
      choice: NEW_INITIATIVE_CHOICE_ID,
      card: { initiativeId: "i1" },
      pick: { kind: "create" },
    },
  ] as const)("is $pick.kind for $name", ({ choice, card, pick }) => {
    expect(decideInitiativePick(choice, card)).toEqual(pick);
  });
});

describe("the words of an Initiative change", () => {
  it("names the Task and the Initiative, or says the Task came off its Initiative", () => {
    expect(describeInitiativeGesture("Restore a basket", "Accessible checkout")).toBe(
      "Put Restore a basket on Accessible checkout",
    );
    expect(describeInitiativeGesture("Restore a basket", null)).toBe(
      "Took Restore a basket off its initiative",
    );
    expect(describeInitiativeDone("Restore a basket", "Accessible checkout")).toBe(
      "Put Restore a basket on Accessible checkout.",
    );
  });

  it("gives the reason of a refusal and says what to do", () => {
    expect(
      describeInitiativeFailure("Restore a basket", "Accessible checkout", "It is closed"),
    ).toBe("Restore a basket was not put on Accessible checkout: It is closed. Try again.");
    expect(describeInitiativeFailure("Restore a basket", null, "Offline")).toBe(
      "Restore a basket was not taken off its initiative: Offline. Try again.",
    );
  });
});
