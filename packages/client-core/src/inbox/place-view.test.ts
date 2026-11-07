/** Tests the view of a place, with an invented project that holds two milestones. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildInboxPlace } from "./cards.testing";
import { readPlaceView } from "./place-view";

const PROJECT = "acme:project:pay";
const MILESTONE = "acme:milestone:timeouts";
const TEAM = "acme:team:shop";

const first = buildInboxCard("1", { ancestors: [MILESTONE, PROJECT, TEAM] });
const second = buildInboxCard("2", { ancestors: [PROJECT, TEAM] });
const elsewhere = buildInboxCard("3", { ancestors: [TEAM] });

const inbox = buildInbox([first, second, elsewhere], {
  places: [
    buildInboxPlace(PROJECT, "Payment retries"),
    buildInboxPlace(MILESTONE, "Gateway timeouts", { kind: "acme/milestone", noun: "Milestone" }),
    buildInboxPlace(TEAM, "Shop", { kind: "acme/team", noun: "Team" }),
  ],
  edges: [
    { fromRef: first.ref, toRef: MILESTONE },
    { fromRef: MILESTONE, toRef: PROJECT },
    { fromRef: second.ref, toRef: PROJECT },
    { fromRef: PROJECT, toRef: TEAM },
  ],
});

describe("readPlaceView", () => {
  it("shows what is above the place and the places directly inside it", () => {
    const view = readPlaceView(PROJECT, inbox)!;

    expect(view.row).toMatchObject({ ref: PROJECT, title: "Payment retries" });
    expect(view.above.map((row) => row.ref)).toEqual([TEAM]);
    expect(view.inner.map((each) => each.row.ref)).toEqual([MILESTONE]);
  });

  it("lists a card under the inner place it lies in, and the others under the place itself", () => {
    const view = readPlaceView(PROJECT, inbox)!;

    expect(view.inner[0]!.cards.map((card) => card.id)).toEqual(["1"]);
    expect(view.cards.map((card) => card.id)).toEqual(["2"]);
  });

  it("lists every card under a place of the top, none of them twice", () => {
    const view = readPlaceView(TEAM, inbox)!;

    expect(view.inner.map((each) => each.row.ref)).toEqual([PROJECT]);
    expect(view.inner[0]!.cards.map((card) => card.id)).toEqual(["1", "2"]);
    expect(view.cards.map((card) => card.id)).toEqual(["3"]);
  });

  it("finds nothing for a ref the Inbox read holds no record of", () => {
    expect(readPlaceView("acme:project:unknown", inbox)).toBeUndefined();
  });
});
