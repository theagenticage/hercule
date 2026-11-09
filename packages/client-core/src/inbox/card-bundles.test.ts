/**
 * Tests what rides on a card of the Inbox and the lines under it: which card
 * rides on which lead, the quiet and locked parts, the hints, and what the visit
 * holds so that a read never moves a card the user has seen. The world is the
 * invented one of `cards.testing.ts`: a ticket is a lead, a review rides on it.
 */
import { SHOW_ALL } from "./requests-view";
import type { Inbox } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { toggleFilterValue } from "../desk/filter";
import { EMPTY_BUNDLE, listBundleCardIds, type CardBundle } from "./card-bundles";
import {
  buildInbox,
  buildInboxCard,
  buildInboxHint,
  buildInboxLink,
  buildInboxPeer,
  buildRequestCard,
  buildWorkflowOffer,
} from "./cards.testing";
import { HOME_GROUPING } from "./inbox-place";
import { layOutInbox, listRiders, type InboxLayout, type InboxView } from "./lay-out";
import {
  NO_PLACEMENT,
  startRidingMove,
  type RidingMove,
  type VisitPlacement,
} from "./visit-placement";

const VIEW: InboxView = {
  grouping: HOME_GROUPING,
  filter: {},
  requestsGrouping: "none",
  requestsShow: SHOW_ALL,
  requestsSort: "oldest",
};

const layOut = (
  inbox: Inbox,
  held: VisitPlacement = NO_PLACEMENT,
  previousBundles: InboxLayout["bundles"] = {},
): InboxLayout => layOutInbox(inbox, VIEW, held, previousBundles);

/**
 * Lays out each read of one visit, and returns the layout of the last. The
 * moves in `waiting` are the user's Links and Unlinks that the controller has
 * not answered, made before the last read.
 */
const layOutVisit = (reads: readonly Inbox[], waiting: readonly RidingMove[] = []): InboxLayout => {
  let held = NO_PLACEMENT;
  let layout: InboxLayout | undefined;
  for (const [index, inbox] of reads.entries()) {
    if (index === reads.length - 1) {
      held = waiting.reduce(
        (placement, move, gesture) => startRidingMove(placement, gesture, move),
        held,
      );
    }
    layout = layOut(inbox, held, layout?.bundles);
    held = layout.placement;
  }
  return layout!;
};

const bundleOf = (layout: InboxLayout, cardId: string): CardBundle => {
  const row = layout.ongoing.surfaces
    .flatMap((surface) => surface.rows)
    .find((each) => each.card.id === cardId && each.alsoIn === undefined);
  const column = layout.requests.groups
    .flatMap((group) => group.rows)
    .find((each) => each.card.id === cardId);
  return (row ?? column)!.bundle;
};

const requestIds = (layout: InboxLayout): readonly string[] =>
  layout.requests.groups.flatMap((group) => group.rows.map((row) => row.card.id));

const describeParts = (bundle: CardBundle): readonly string[] =>
  bundle.parts.map((part) =>
    part._tag === "asking"
      ? `asking ${part.card.identifier}`
      : part._tag === "quiet"
        ? `quiet ${part.title}${part.statusWords === undefined ? "" : ` (${part.statusWords})`}`
        : `locked ${part.noun}`,
  );

const describeLines = (bundle: CardBundle): readonly string[] =>
  bundle.lines.map((line) =>
    line._tag === "mention" ? `${line.word} ${line.reference}` : `Linked to ${line.reference}`,
  );

const TICKET = buildInboxCard("1", { title: "Pay in one step" });
const OTHER_TICKET = buildInboxCard("2", { title: "Refund flow" });
const REVIEW = buildRequestCard("3", { ridesOn: TICKET.ref });

describe("what rides on a lead", () => {
  it("draws a card that rides on its lead as an asking part and leaves Requests", () => {
    const inbox = buildInbox([TICKET, REVIEW], {
      links: [buildInboxLink(TICKET.ref, REVIEW.ref)],
    });
    const layout = layOut(inbox);
    const bundle = bundleOf(layout, TICKET.id);
    expect(describeParts(bundle)).toEqual(["asking #3"]);
    expect(bundle.parts[0]).toMatchObject({ claim: { type: "source", plugin: "acme" } });
    expect(bundle.riders).toEqual([REVIEW]);
    expect(requestIds(layout)).toEqual([]);
    expect(layout.requests.isEmpty).toBe(true);
  });

  it("gives an asking part the offers of its own set, shared with the card's row", () => {
    const review = buildRequestCard("3", { ridesOn: TICKET.ref, offerSetId: "reviews" });
    const offer = buildWorkflowOffer("Review PR");
    const inbox = buildInbox([TICKET, review], {
      links: [buildInboxLink(TICKET.ref, review.ref)],
      offerSets: { reviews: [offer] },
    });
    const [part] = bundleOf(layOut(inbox), TICKET.id).parts;
    expect(part).toMatchObject({ _tag: "asking", offers: { available: [offer], unavailable: [] } });
  });

  it("draws a card a Task holds as a quiet part that says so", () => {
    const taken = { ...REVIEW, taskId: "task-1" };
    const inbox = buildInbox([TICKET, taken], {
      links: [buildInboxLink(TICKET.ref, REVIEW.ref, "person")],
    });
    expect(describeParts(bundleOf(layOut(inbox), TICKET.id))).toEqual([
      "quiet Review 3 (You took it on)",
    ]);
  });

  it("keeps the riding cards of one lead in the order of the visit", () => {
    const first = buildRequestCard("4", {
      ridesOn: TICKET.ref,
      firstObservedAt: "2026-11-03T09:00:00.000Z",
    });
    const second = buildRequestCard("5", {
      ridesOn: TICKET.ref,
      firstObservedAt: "2026-11-02T09:00:00.000Z",
    });
    const inbox = buildInbox([TICKET, first, second]);
    expect(describeParts(bundleOf(layOut(inbox), TICKET.id))).toEqual(["asking #5", "asking #4"]);
  });

  it("shows a request that rides on another lead as a quiet part, and keeps it out of Requests only once", () => {
    const ridesElsewhere = buildRequestCard("6", { ridesOn: OTHER_TICKET.ref });
    const inbox = buildInbox([TICKET, OTHER_TICKET, ridesElsewhere], {
      links: [
        buildInboxLink(TICKET.ref, ridesElsewhere.ref),
        buildInboxLink(OTHER_TICKET.ref, ridesElsewhere.ref),
      ],
    });
    const layout = layOut(inbox);
    expect(describeParts(bundleOf(layout, TICKET.id))).toEqual(["quiet Review 6"]);
    expect(describeParts(bundleOf(layout, OTHER_TICKET.id))).toEqual(["asking #6"]);
    expect(requestIds(layout)).toEqual([]);
  });

  it("shows two lasting things as two rows, each with the other as a quiet part", () => {
    const inbox = buildInbox([TICKET, OTHER_TICKET], {
      links: [buildInboxLink(TICKET.ref, OTHER_TICKET.ref, "person")],
    });
    const layout = layOut(inbox);
    expect(describeParts(bundleOf(layout, TICKET.id))).toEqual(["quiet Refund flow"]);
    expect(describeParts(bundleOf(layout, OTHER_TICKET.id))).toEqual(["quiet Pay in one step"]);
    expect(layout.ongoing.surfaces.flatMap((surface) => surface.rows)).toHaveLength(2);
  });

  it("puts a peer with no card in a quiet part with its status word, and a restricted one in a locked part", () => {
    const peer = buildInboxPeer("acme:ticket:77", {
      title: "Clear the cache",
      status: { shape: "ring", tone: "active", label: "In Progress" },
    });
    const hidden = buildInboxPeer("sentry:issue:9", {
      kind: "sentry/issue",
      noun: "Issue",
      restricted: true,
    });
    const inbox = buildInbox([TICKET], {
      links: [
        buildInboxLink(TICKET.ref, hidden.ref),
        buildInboxLink(TICKET.ref, peer.ref, "person"),
      ],
      peers: [hidden, peer],
    });
    const bundle = bundleOf(layOut(inbox), TICKET.id);
    expect(describeParts(bundle)).toEqual(["quiet Clear the cache (In Progress)", "locked Issue"]);
    // A locked part carries its noun and its plugin, and never a title.
    expect(bundle.parts[1]).toEqual({
      _tag: "locked",
      ref: hidden.ref,
      kind: "sentry/issue",
      pluginId: "sentry",
      noun: "Issue",
      claim: { type: "source", plugin: "acme" },
    });
  });

  it("opens a quiet part by the id of its card, or of its record, and by nothing for a place", () => {
    const peer = buildInboxPeer("acme:ticket:77", { id: "record-77" });
    const bare = buildInboxPeer("acme:ticket:78");
    const inbox = buildInbox([TICKET, OTHER_TICKET], {
      links: [
        buildInboxLink(TICKET.ref, OTHER_TICKET.ref),
        buildInboxLink(TICKET.ref, peer.ref),
        buildInboxLink(TICKET.ref, bare.ref),
      ],
      peers: [peer, bare],
    });
    const quiet = bundleOf(layOut(inbox), TICKET.id).parts.flatMap((part) =>
      part._tag === "quiet" ? [[part.title, part.openId]] : [],
    );
    expect(quiet).toEqual(
      [
        ["Peer acme:ticket:78", undefined],
        ["Peer acme:ticket:77", "record-77"],
        ["Refund flow", OTHER_TICKET.id],
      ].toSorted(),
    );
  });

  it("lists the ids of the cards a row draws: its own and those of its asking and quiet parts, not a peer's", () => {
    const peer = buildInboxPeer("acme:ticket:77", { id: "record-77" });
    const inbox = buildInbox([TICKET, OTHER_TICKET, REVIEW], {
      links: [
        buildInboxLink(TICKET.ref, REVIEW.ref),
        buildInboxLink(TICKET.ref, OTHER_TICKET.ref),
        buildInboxLink(TICKET.ref, peer.ref),
      ],
      peers: [peer],
    });
    const bundle = bundleOf(layOut(inbox), TICKET.id);
    expect(listBundleCardIds(TICKET, bundle)).toEqual([TICKET.id, REVIEW.id, OTHER_TICKET.id]);
  });

  it("draws nothing for a link whose other end the read does not hold", () => {
    const inbox = buildInbox([TICKET], { links: [buildInboxLink(TICKET.ref, "acme:ticket:404")] });
    expect(bundleOf(layOut(inbox), TICKET.id).parts).toEqual([]);
  });

  it("lists the cards riding on a lead, for the words of its dismissal", () => {
    const inbox = buildInbox([TICKET, OTHER_TICKET, REVIEW], {
      links: [buildInboxLink(TICKET.ref, REVIEW.ref)],
    });
    const layout = layOut(inbox);
    expect(listRiders(layout, TICKET.id)).toEqual([REVIEW]);
    expect(listRiders(layout, OTHER_TICKET.id)).toEqual([]);
    expect(listRiders(layout, "missing")).toEqual([]);
  });

  it("carries nothing, as one shared value, when nothing is linked", () => {
    const layout = layOut(buildInbox([TICKET, OTHER_TICKET]));
    expect(bundleOf(layout, TICKET.id)).toBe(bundleOf(layout, OTHER_TICKET.id));
  });
});

describe("hints", () => {
  const mentioner = buildRequestCard("3", { identifier: "#6263" });
  const mentioned = buildInboxCard("1", { identifier: "OPS-47" });
  const inbox = buildInbox([mentioned, mentioner], {
    hints: [buildInboxHint(mentioner.ref, mentioned.ref)],
  });

  it("says Mentions under the card whose text holds the reference, and Mentioned in under the other", () => {
    const layout = layOut(inbox);
    expect(describeLines(bundleOf(layout, mentioner.id))).toEqual(["Mentions OPS-47"]);
    expect(describeLines(bundleOf(layout, mentioned.id))).toEqual(["Mentioned in #6263"]);
  });

  it("names the pair in the order of the reference, so a click links the right two", () => {
    expect(bundleOf(layOut(inbox), mentioned.id).lines[0]).toMatchObject({
      fromRef: mentioner.ref,
      toRef: mentioned.ref,
      evidenceKey: "description",
    });
  });

  it("never makes a part, never takes a request out of Requests and never stacks", () => {
    const layout = layOut(inbox);
    expect(bundleOf(layout, mentioned.id).parts).toEqual([]);
    expect(bundleOf(layout, mentioned.id).riders).toEqual([]);
    expect(requestIds(layout)).toEqual([mentioner.id]);
  });

  it("names a peer by its identifier, else its title, and leaves a restricted peer out", () => {
    const plain = buildInboxPeer("acme:ticket:5", { identifier: "ACME-5" });
    const untitled = buildInboxPeer("acme:ticket:6", { title: "Fix it" }, true);
    const hidden = buildInboxPeer("sentry:issue:9", { restricted: true });
    const card = buildInboxCard("1");
    const layout = layOut(
      buildInbox([card], {
        hints: [
          buildInboxHint(card.ref, plain.ref),
          buildInboxHint(untitled.ref, card.ref),
          buildInboxHint(card.ref, hidden.ref),
        ],
        peers: [plain, untitled, hidden],
      }),
    );
    expect(describeLines(bundleOf(layout, card.id))).toEqual([
      "Mentioned in Fix it",
      "Mentions ACME-5",
    ]);
  });
});

describe("lines under a request", () => {
  it("says Linked to for a confirmed link of a request that rides on nothing", () => {
    const request = buildRequestCard("3");
    const other = buildRequestCard("4", { identifier: "#4" });
    const peer = buildInboxPeer("acme:review:90", { identifier: "#90" });
    const hidden = buildInboxPeer("sentry:issue:9", { restricted: true });
    const inbox = buildInbox([request, other], {
      links: [
        buildInboxLink(request.ref, other.ref, "person"),
        buildInboxLink(request.ref, peer.ref),
        buildInboxLink(request.ref, hidden.ref),
      ],
      peers: [peer, hidden],
    });
    const layout = layOut(inbox);
    expect(describeLines(bundleOf(layout, request.id))).toEqual(["Linked to #4", "Linked to #90"]);
    expect(bundleOf(layout, request.id).parts).toEqual([]);
    expect(requestIds(layout)).toEqual([request.id, other.id]);
  });

  it("carries no line on a card a Task holds", () => {
    const held = buildRequestCard("3", { side: "with-someone-else", taskId: "task-1" });
    const peer = buildInboxPeer("acme:review:90");
    const inbox = buildInbox([held], {
      links: [buildInboxLink(held.ref, peer.ref)],
      peers: [peer],
    });
    const layout = layOut(inbox);
    expect(layout.withSomeoneElse.rows[0]?.bundle).toEqual({ parts: [], lines: [], riders: [] });
  });
});

describe("what the visit holds of riding", () => {
  const link = buildInboxLink(TICKET.ref, REVIEW.ref);
  const { ridesOn, ...alone } = REVIEW;
  void ridesOn;
  const unlinked = buildInbox([TICKET, alone]);
  const linked = buildInbox([TICKET, REVIEW], { links: [link] });

  it("leaves a request in Requests when a later read says it rides now, and shows it quietly on the lead", () => {
    const layout = layOutVisit([unlinked, linked]);
    expect(requestIds(layout)).toEqual([REVIEW.id]);
    expect(describeParts(bundleOf(layout, TICKET.id))).toEqual(["quiet Review 3"]);
    expect(bundleOf(layout, TICKET.id).riders).toEqual([]);
  });

  it("keeps a part under its lead when a later read says it no longer rides", () => {
    const layout = layOutVisit([linked, unlinked]);
    expect(requestIds(layout)).toEqual([]);
    expect(describeParts(bundleOf(layout, TICKET.id))).toEqual(["asking #3"]);
  });

  it("lets the user's own Link put a request on its lead, and Unlink take it off", () => {
    const put: RidingMove = { direction: "link", cardId: REVIEW.id, leadRef: TICKET.ref };
    const linkedLayout = layOutVisit([unlinked, linked], [put]);
    expect(describeParts(bundleOf(linkedLayout, TICKET.id))).toEqual(["asking #3"]);
    expect(requestIds(linkedLayout)).toEqual([]);

    const taken: RidingMove = { direction: "unlink", cardId: REVIEW.id, leadRef: TICKET.ref };
    const unlinkedLayout = layOutVisit([linked, unlinked], [taken]);
    expect(requestIds(unlinkedLayout)).toEqual([REVIEW.id]);
  });

  it("sets a part free when its lead is dismissed, and takes it back when the lead returns", () => {
    const first = layOut(linked);
    const without = buildInbox([REVIEW], { links: [link] });
    const dismissed = layOut(without, first.placement);
    expect(requestIds(dismissed)).toEqual([REVIEW.id]);
    const back = layOut(linked, dismissed.placement);
    expect(requestIds(back)).toEqual([]);
    expect(describeParts(bundleOf(back, TICKET.id))).toEqual(["asking #3"]);
  });

  it("draws a request in Requests when its lead is held under With someone else", () => {
    const taken = { ...TICKET, taskId: "task-1", side: "with-someone-else" as const };
    const layout = layOut(buildInbox([taken, REVIEW], { links: [link] }));
    expect(requestIds(layout)).toEqual([REVIEW.id]);
  });
});

describe("the filter and what rides", () => {
  const rider = buildRequestCard("3", { ridesOn: TICKET.ref, yours: true });
  const inbox = buildInbox([TICKET, { ...OTHER_TICKET, yours: true }, rider], {
    links: [buildInboxLink(TICKET.ref, rider.ref)],
  });
  const ongoingIds = (layout: InboxLayout): readonly string[] =>
    layout.ongoing.surfaces.flatMap((surface) => surface.rows.map((row) => row.card.id));

  it("shows a lead when a card that rides on it passes, and still draws every part", () => {
    const layout = layOutInbox(
      inbox,
      { ...VIEW, filter: toggleFilterValue({}, "whose", "mine") },
      NO_PLACEMENT,
    );
    expect(ongoingIds(layout)).toEqual([TICKET.id, OTHER_TICKET.id]);
    const lead = layout.ongoing.surfaces.flatMap((surface) => surface.rows)[0]!;
    expect(describeParts(lead.bundle)).toEqual(["asking #3"]);
  });

  it("hides a lead and what rides on it when neither passes", () => {
    const notMine = { ...rider, yours: false };
    const layout = layOutInbox(
      buildInbox([TICKET, { ...OTHER_TICKET, yours: true }, notMine]),
      { ...VIEW, filter: toggleFilterValue({}, "whose", "mine") },
      NO_PLACEMENT,
    );
    expect(ongoingIds(layout)).toEqual([OTHER_TICKET.id]);
    expect(requestIds(layout)).toEqual([]);
  });
});

describe("the identity of a bundle", () => {
  const link = buildInboxLink(TICKET.ref, REVIEW.ref);
  const inbox = buildInbox([TICKET, REVIEW], { links: [link] });
  const first = layOut(inbox);
  const next = (read: Inbox): InboxLayout => layOut(read, first.placement, first.bundles);

  it("is kept for a bundle built again from the same cards, and for an equal copy of them", () => {
    const base = bundleOf(first, TICKET.id);
    expect(bundleOf(next(inbox), TICKET.id)).toBe(base);
    const copy = buildInbox([{ ...TICKET }, { ...REVIEW }], { links: [{ ...link }] });
    expect(bundleOf(next(copy), TICKET.id)).toBe(base);
  });

  it("changes when a part's card or the claim changed, and keeps the parts that did not", () => {
    const base = bundleOf(first, TICKET.id);
    const changed = buildInbox([TICKET, { ...REVIEW, title: "New title" }], { links: [link] });
    expect(bundleOf(next(changed), TICKET.id)).not.toBe(base);
    const person = buildInbox([TICKET, REVIEW], {
      links: [buildInboxLink(TICKET.ref, REVIEW.ref, "person")],
    });
    expect(bundleOf(next(person), TICKET.id)).not.toBe(base);
  });

  it("is the empty bundle itself for a card that carries nothing", () => {
    expect(bundleOf(next(buildInbox([TICKET])), TICKET.id)).toBe(EMPTY_BUNDLE);
  });
});
