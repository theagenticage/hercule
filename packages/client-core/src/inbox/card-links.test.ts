/** Tests Link and Unlink as edits to the Inbox the screen holds, planned over the place the visit holds. */
import { SHOW_ALL } from "./requests-view";
import { describe, expect, it } from "vitest";
import type { Inbox } from "@hercule/contract";
import { applyInboxEdit } from "./card-moves";
import {
  describeLinkRemaining,
  describeLinkRemoved,
  nameLinkEnd,
  planLink,
  planUnlink,
} from "./card-links";
import { HOME_GROUPING } from "./inbox-place";
import { layOutInbox } from "./lay-out";
import { NO_PLACEMENT, startRidingMove, type VisitPlacement } from "./visit-placement";
import {
  buildInbox,
  buildInboxCard,
  buildInboxHint,
  buildInboxLink,
  buildInboxPeer,
  buildRequestCard,
} from "./cards.testing";

const TICKET = buildInboxCard("1", { identifier: "OPS-47" });
const REVIEW = buildRequestCard("2", { identifier: "#6263" });
const OTHER_REVIEW = buildRequestCard("3", { identifier: "#6264", ridesOn: "acme:ticket:9" });
const LEAD_9 = buildInboxCard("9");

/** The place a visit holds after it has read `inbox`. */
const placeOf = (inbox: Inbox): VisitPlacement =>
  layOutInbox(
    inbox,
    {
      grouping: HOME_GROUPING,
      filter: {},
      requestsGrouping: "none",
      requestsShow: SHOW_ALL,
      requestsSort: "oldest",
    },
    NO_PLACEMENT,
  ).placement;

describe("planLink", () => {
  it("links the pair as the user's claim, and moves the request onto the card of lasting work it is linked to", () => {
    const inbox = buildInbox([TICKET, REVIEW]);
    expect(planLink(inbox, REVIEW.ref, TICKET.ref)).toEqual({
      edit: {
        kind: "set-link",
        fromRef: REVIEW.ref,
        toRef: TICKET.ref,
        claim: { type: "person", actor: "user" },
        hasPersonClaim: true,
      },
      ridingMove: { direction: "link", cardId: REVIEW.id, leadRef: TICKET.ref },
    });
  });

  it("works whichever end the pair is named from", () => {
    const inbox = buildInbox([TICKET, REVIEW]);
    expect(planLink(inbox, TICKET.ref, REVIEW.ref).ridingMove).toEqual({
      direction: "link",
      cardId: REVIEW.id,
      leadRef: TICKET.ref,
    });
  });

  it("turns a hint into the user's link", () => {
    const hint = buildInboxHint(REVIEW.ref, TICKET.ref);
    const inbox = buildInbox([TICKET, REVIEW], { hints: [hint] });
    const { edit } = planLink(inbox, REVIEW.ref, TICKET.ref);
    const linked = applyInboxEdit(inbox, edit);
    expect(linked.links).toEqual([
      {
        fromRef: REVIEW.ref,
        toRef: TICKET.ref,
        claim: { type: "person", actor: "user" },
        hasPersonClaim: true,
      },
    ]);
    expect(linked.hints).toEqual([]);
    expect(linked.cards).toBe(inbox.cards);
  });

  it("keeps a source's claim, which is firmer than a person's, and adds the user's own claim", () => {
    const source = buildInboxLink(REVIEW.ref, TICKET.ref, "source");
    const inbox = buildInbox([TICKET, REVIEW], { links: [source] });
    const { edit } = planLink(inbox, REVIEW.ref, TICKET.ref);
    expect(edit).toMatchObject({ claim: source.claim, hasPersonClaim: true });
  });

  it("plans the move also for a card that rides already, because the visit plays it only when it counts", () => {
    const inbox = buildInbox([TICKET, OTHER_REVIEW, LEAD_9]);
    expect(planLink(inbox, OTHER_REVIEW.ref, TICKET.ref).ridingMove).toEqual({
      direction: "link",
      cardId: OTHER_REVIEW.id,
      leadRef: TICKET.ref,
    });
  });

  it.each([
    ["two cards of lasting work", [TICKET, buildInboxCard("5")], "acme:ticket:5"],
    ["two requests", [REVIEW, buildRequestCard("6")], "acme:review:6"],
    ["a thing with no card", [TICKET], "acme:review:404"],
  ])("changes nothing about what rides for %s", (_name, cards, toRef) => {
    const inbox = buildInbox(cards);
    expect(planLink(inbox, cards[0]!.ref, toRef).ridingMove).toBeUndefined();
  });

  it("does not put a request on a lead a Task holds", () => {
    const held = { ...TICKET, taskId: "task-1", side: "with-someone-else" as const };
    expect(planLink(buildInbox([held, REVIEW]), REVIEW.ref, TICKET.ref).ridingMove).toBeUndefined();
  });
});

describe("planUnlink", () => {
  const person = buildInboxLink(REVIEW.ref, TICKET.ref, "person");
  const riding = { ...REVIEW, ridesOn: TICKET.ref };

  it("takes the user's link back and sets the card that rode on it free", () => {
    const inbox = buildInbox([TICKET, riding], { links: [person] });
    const plan = planUnlink(inbox, TICKET.ref, REVIEW.ref, placeOf(inbox))!;
    const unlinked = applyInboxEdit(inbox, plan.edit);
    expect(unlinked.links).toEqual([]);
    expect(unlinked.cards).toBe(inbox.cards);
  });

  it("takes back the user's claim on a link a source reports as well, and the card keeps riding", () => {
    const both = buildInboxLink(REVIEW.ref, TICKET.ref, "source", true);
    const inbox = buildInbox([TICKET, riding], { links: [both] });
    const plan = planUnlink(inbox, TICKET.ref, REVIEW.ref, placeOf(inbox))!;
    expect(plan.edit).toEqual({
      kind: "set-link",
      fromRef: both.fromRef,
      toRef: both.toRef,
      claim: both.claim,
      hasPersonClaim: false,
    });
    expect(plan.ridingMove).toBeUndefined();
    const unlinked = applyInboxEdit(inbox, plan.edit);
    expect(unlinked.links).toEqual([{ ...both, hasPersonClaim: false }]);
    expect(unlinked.cards).toEqual(inbox.cards);
  });

  it("says that the card rode on the other end and is taken off it", () => {
    const inbox = buildInbox([TICKET, riding], { links: [person] });
    expect(planUnlink(inbox, TICKET.ref, REVIEW.ref, placeOf(inbox))!.ridingMove).toEqual({
      direction: "unlink",
      cardId: REVIEW.id,
      leadRef: TICKET.ref,
    });
  });

  it.each([
    ["a source's claim alone", { links: [buildInboxLink(REVIEW.ref, TICKET.ref, "source")] }],
    ["a hint", { hints: [buildInboxHint(REVIEW.ref, TICKET.ref)] }],
  ])("has nothing to take back when the pair is held by %s", (_name, held) => {
    expect(
      planUnlink(buildInbox([TICKET, REVIEW], held), REVIEW.ref, TICKET.ref, NO_PLACEMENT),
    ).toBe(undefined);
  });

  it("has nothing to take back when nothing links the pair", () => {
    expect(
      planUnlink(buildInbox([TICKET, REVIEW]), REVIEW.ref, TICKET.ref, NO_PLACEMENT),
    ).toBeUndefined();
  });
});

describe("an Unlink planned over the place the visit holds", () => {
  const person = buildInboxLink(REVIEW.ref, TICKET.ref, "person");

  it("frees a card the visit holds on the lead although the page does not say it rides there", () => {
    const first = buildInbox([TICKET, { ...REVIEW, ridesOn: TICKET.ref }], { links: [person] });
    const later = buildInbox([TICKET, REVIEW], { links: [person] });
    expect(planUnlink(later, REVIEW.ref, TICKET.ref, placeOf(first))!.ridingMove).toEqual({
      direction: "unlink",
      cardId: REVIEW.id,
      leadRef: TICKET.ref,
    });
  });

  it("frees nothing when the visit holds the card alone although the page says it rides", () => {
    const first = buildInbox([TICKET, REVIEW], { links: [person] });
    const later = buildInbox([TICKET, { ...REVIEW, ridesOn: TICKET.ref }], { links: [person] });
    expect(planUnlink(later, REVIEW.ref, TICKET.ref, placeOf(first))!.ridingMove).toBeUndefined();
  });

  it("frees the card of a Link that waits for the controller's answer, which no read says yet", () => {
    const inbox = buildInbox([TICKET, REVIEW], { links: [person] });
    const waiting = startRidingMove(placeOf(inbox), 1, {
      direction: "link",
      cardId: REVIEW.id,
      leadRef: TICKET.ref,
    });
    expect(planUnlink(inbox, REVIEW.ref, TICKET.ref, waiting)!.ridingMove).toMatchObject({
      direction: "unlink",
      cardId: REVIEW.id,
    });
  });
});

describe("applyInboxEdit with a link", () => {
  it("adds a link where none was, and removes it again", () => {
    const inbox = buildInbox([TICKET, buildInboxCard("5")]);
    const { edit } = planLink(inbox, TICKET.ref, "acme:ticket:5");
    const linked = applyInboxEdit(inbox, edit);
    expect(linked.links).toEqual([
      {
        fromRef: TICKET.ref,
        toRef: "acme:ticket:5",
        claim: { type: "person", actor: "user" },
        hasPersonClaim: true,
      },
    ]);
    const unlinked = applyInboxEdit(
      linked,
      planUnlink(linked, TICKET.ref, "acme:ticket:5", NO_PLACEMENT)!.edit,
    );
    expect(unlinked.links).toEqual([]);
  });
});

describe("describeLinkRemoved", () => {
  it.each([
    [undefined, "Link removed."],
    ["source", "Link removed. The source still reports the link."],
    ["text", "Link removed. A reference in text still mentions it."],
  ] as const)("words a removal that leaves %s", (remaining, words) => {
    expect(describeLinkRemoved(remaining)).toBe(words);
  });
});

describe("describeLinkRemaining", () => {
  it.each([
    [undefined, undefined],
    ["person", undefined],
    ["source", "The source still reports the link."],
    ["text", "A reference in text still mentions it."],
  ] as const)("words what %s leaves", (remaining, words) => {
    expect(describeLinkRemaining(remaining)).toBe(words);
  });
});

describe("nameLinkEnd", () => {
  const peer = buildInboxPeer("acme:ticket:77", { title: "Clear the cache" }, true);
  const inbox = buildInbox([TICKET, REVIEW], { peers: [peer] });

  it("names a card by its identifier, a peer by its title when it has no identifier, and a stranger by its ref", () => {
    expect(nameLinkEnd(inbox, TICKET.ref)).toBe("OPS-47");
    expect(nameLinkEnd(inbox, peer.ref)).toBe("Clear the cache");
    expect(nameLinkEnd(inbox, "acme:ticket:404")).toBe("acme:ticket:404");
  });
});
