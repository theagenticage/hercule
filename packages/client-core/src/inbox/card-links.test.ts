/** Tests Link and Unlink as edits to the Inbox the screen holds, and the edit that undoes each. */
import { describe, expect, it } from "vitest";
import { applyInboxEdit } from "./card-moves";
import { describeLinkRemoved, nameLinkEnd, planLink, planUnlink } from "./card-links";
import {
  buildInbox,
  buildInboxCard,
  buildInboxLink,
  buildInboxPeer,
  buildRequestCard,
} from "./cards.testing";

const TICKET = buildInboxCard("1", { identifier: "OPS-47" });
const REVIEW = buildRequestCard("2", { identifier: "#6263" });
const OTHER_REVIEW = buildRequestCard("3", { identifier: "#6264", ridesOn: "acme:ticket:9" });
const LEAD_9 = buildInboxCard("9");

describe("planLink", () => {
  it("puts a request on the card of lasting work it is linked to, and the undo takes it off", () => {
    const inbox = buildInbox([TICKET, REVIEW]);
    const { edit, undo } = planLink(inbox, REVIEW.ref, TICKET.ref);
    expect(edit).toEqual({
      kind: "set-link",
      fromRef: REVIEW.ref,
      toRef: TICKET.ref,
      claim: { type: "person", actor: "user" },
      hasPersonClaim: true,
      riding: { id: REVIEW.id, ridesOn: TICKET.ref },
    });
    expect(undo).toEqual({
      kind: "set-link",
      fromRef: REVIEW.ref,
      toRef: TICKET.ref,
      claim: undefined,
      hasPersonClaim: false,
      riding: { id: REVIEW.id, ridesOn: undefined },
    });
  });

  it("works whichever end the pair is named from", () => {
    const inbox = buildInbox([TICKET, REVIEW]);
    expect(planLink(inbox, TICKET.ref, REVIEW.ref).edit.riding).toEqual({
      id: REVIEW.id,
      ridesOn: TICKET.ref,
    });
  });

  it("turns a hint into the user's link, and the undo puts the hint back", () => {
    const hint = buildInboxLink(REVIEW.ref, TICKET.ref, "text");
    const inbox = buildInbox([TICKET, REVIEW], { links: [hint] });
    const { edit, undo } = planLink(inbox, REVIEW.ref, TICKET.ref);
    const linked = applyInboxEdit(inbox, edit);
    expect(linked.links).toEqual([
      { ...hint, claim: { type: "person", actor: "user" }, hasPersonClaim: true },
    ]);
    expect(linked.cards.find((card) => card.id === REVIEW.id)?.ridesOn).toBe(TICKET.ref);
    expect(applyInboxEdit(linked, undo)).toEqual(inbox);
  });

  it("keeps a source's claim, which is firmer than a person's, and adds the user's own claim", () => {
    const source = buildInboxLink(REVIEW.ref, TICKET.ref, "source");
    const inbox = buildInbox([TICKET, REVIEW], { links: [source] });
    const { edit, undo } = planLink(inbox, REVIEW.ref, TICKET.ref);
    expect(edit).toMatchObject({ claim: source.claim, hasPersonClaim: true });
    expect(undo).toMatchObject({ claim: source.claim, hasPersonClaim: false });
  });

  it("says what the move does to a card that rides already, without moving it on the page", () => {
    const inbox = buildInbox([TICKET, OTHER_REVIEW, LEAD_9]);
    const plan = planLink(inbox, OTHER_REVIEW.ref, TICKET.ref);
    expect(plan.edit).not.toHaveProperty("riding");
    expect(plan.riding).toEqual({
      kind: "link",
      cardId: OTHER_REVIEW.id,
      lead: TICKET.ref,
      before: { _tag: "rides", lead: LEAD_9.ref },
    });
  });

  it.each([
    ["two cards of lasting work", [TICKET, buildInboxCard("5")], "acme:ticket:5"],
    ["two requests", [REVIEW, buildRequestCard("6")], "acme:review:6"],
    ["a request that already rides on a lead", [TICKET, OTHER_REVIEW, LEAD_9], OTHER_REVIEW.ref],
    ["a thing with no card", [TICKET], "acme:review:404"],
  ])("changes nothing about what rides for %s", (_name, cards, toRef) => {
    const inbox = buildInbox(cards);
    expect(planLink(inbox, cards[0]!.ref, toRef).edit).not.toHaveProperty("riding");
  });

  it("does not put a request on a lead a Task holds", () => {
    const held = { ...TICKET, taskId: "task-1", side: "with-someone-else" as const };
    expect(planLink(buildInbox([held, REVIEW]), REVIEW.ref, TICKET.ref).edit).not.toHaveProperty(
      "riding",
    );
  });
});

describe("planUnlink", () => {
  const person = buildInboxLink(REVIEW.ref, TICKET.ref, "person");
  const riding = { ...REVIEW, ridesOn: TICKET.ref };

  it("takes the user's link back and sets the card that rode on it free, and the undo restores both", () => {
    const inbox = buildInbox([TICKET, riding], { links: [person] });
    const plan = planUnlink(inbox, TICKET.ref, REVIEW.ref)!;
    const unlinked = applyInboxEdit(inbox, plan.edit);
    expect(unlinked.links).toEqual([]);
    expect(unlinked.cards.find((card) => card.id === REVIEW.id)).not.toHaveProperty("ridesOn");
    expect(applyInboxEdit(unlinked, plan.undo)).toEqual(inbox);
  });

  it("takes back the user's claim on a link a source reports as well, and the card keeps riding", () => {
    const both = buildInboxLink(REVIEW.ref, TICKET.ref, "source", true);
    const inbox = buildInbox([TICKET, riding], { links: [both] });
    const plan = planUnlink(inbox, TICKET.ref, REVIEW.ref)!;
    expect(plan.edit).toEqual({
      kind: "set-link",
      fromRef: both.fromRef,
      toRef: both.toRef,
      claim: both.claim,
      hasPersonClaim: false,
    });
    expect(plan.riding).toBeUndefined();
    const unlinked = applyInboxEdit(inbox, plan.edit);
    expect(unlinked.links).toEqual([{ ...both, hasPersonClaim: false }]);
    expect(unlinked.cards).toEqual(inbox.cards);
    expect(applyInboxEdit(unlinked, plan.undo)).toEqual(inbox);
  });

  it("says that the card rode on the other end and is taken off it", () => {
    const inbox = buildInbox([TICKET, riding], { links: [person] });
    expect(planUnlink(inbox, TICKET.ref, REVIEW.ref)!.riding).toEqual({
      kind: "unlink",
      cardId: REVIEW.id,
      lead: TICKET.ref,
      before: { _tag: "rides", lead: TICKET.ref },
    });
  });

  it.each([
    ["a source's claim alone", buildInboxLink(REVIEW.ref, TICKET.ref, "source")],
    ["a hint", buildInboxLink(REVIEW.ref, TICKET.ref, "text")],
  ])("has nothing to take back when the pair is held by %s", (_name, link) => {
    expect(
      planUnlink(buildInbox([TICKET, REVIEW], { links: [link] }), REVIEW.ref, TICKET.ref),
    ).toBe(undefined);
  });

  it("has nothing to take back when nothing links the pair", () => {
    expect(planUnlink(buildInbox([TICKET, REVIEW]), REVIEW.ref, TICKET.ref)).toBeUndefined();
  });
});

describe("applyInboxEdit with a link", () => {
  it("adds a link where none was, and removes it again", () => {
    const inbox = buildInbox([TICKET, buildInboxCard("5")]);
    const { edit, undo } = planLink(inbox, TICKET.ref, "acme:ticket:5");
    const linked = applyInboxEdit(inbox, edit);
    expect(linked.links).toEqual([
      {
        fromRef: TICKET.ref,
        toRef: "acme:ticket:5",
        claim: { type: "person", actor: "user" },
        hasPersonClaim: true,
      },
    ]);
    expect(applyInboxEdit(linked, undo).links).toEqual([]);
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

describe("nameLinkEnd", () => {
  const peer = buildInboxPeer("acme:ticket:77", { title: "Clear the cache" }, true);
  const inbox = buildInbox([TICKET, REVIEW], { peers: [peer] });

  it("names a card by its identifier, a peer by its title when it has no identifier, and a stranger by its ref", () => {
    expect(nameLinkEnd(inbox, TICKET.ref)).toBe("OPS-47");
    expect(nameLinkEnd(inbox, peer.ref)).toBe("Clear the cache");
    expect(nameLinkEnd(inbox, "acme:ticket:404")).toBe("acme:ticket:404");
  });
});
