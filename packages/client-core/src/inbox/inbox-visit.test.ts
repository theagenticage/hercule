/**
 * Tests the visit of the Inbox page over sequences of reads: what is drawn
 * whole, what waits as an arrival, what stays where it lies, the Group by
 * menu, and what the user's own move emptied.
 */
import { SHOW_ALL } from "./requests-view";
import type { Inbox, InboxCard } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildInbox,
  buildInboxCard,
  buildInboxLink,
  buildInboxPlace,
  buildRequestCard,
  buildSignalLine,
  listCardIds,
} from "./cards.testing";
import { planLink, planUnlink } from "./card-links";
import {
  advanceInboxVisit,
  advanceLanding,
  advanceLinkGesture,
  START_OF_VISIT,
  type InboxVisit,
  type LandingStep,
  type LinkGestureStep,
  type VisitStep,
} from "./inbox-visit";
import { HOME_GROUPING, STATUS_GROUPING } from "./inbox-place";
import type { InboxView } from "./lay-out";
import { hasPlacedCards } from "./visit-placement";

const VIEW: InboxView = {
  grouping: HOME_GROUPING,
  filter: {},
  requestsGrouping: "none",
  requestsShow: SHOW_ALL,
  requestsSort: "oldest",
};

const PRICING = "acme:project:pricing";
const BETA = "acme:project:beta";
const places = [buildInboxPlace(PRICING, "Pricing"), buildInboxPlace(BETA, "Beta")];

const ticket = (
  id: string,
  ancestors: readonly string[] = [],
  overrides: Partial<InboxCard> = {},
) =>
  buildInboxCard(id, { ancestors, firstObservedAt: `2026-11-0${id}T09:00:00.000Z`, ...overrides });

const request = (id: string, overrides: Partial<InboxCard> = {}) =>
  buildRequestCard(id, { firstObservedAt: `2026-11-0${id}T09:00:00.000Z`, ...overrides });

const inboxOf = (cards: readonly InboxCard[]): Inbox => buildInbox(cards, { places });

/** Plays reads in turn through one visit, as the screen does: each read is a fresh reply unless said otherwise. */
const startVisit = () => {
  let history = START_OF_VISIT;
  let released: ReadonlySet<string> = new Set();
  return {
    /** Reads `received` and returns what the visit draws for it. */
    read: (received: Inbox | undefined, step: Partial<VisitStep> = {}): InboxVisit => {
      const next = advanceInboxVisit(history, {
        received,
        view: VIEW,
        released,
        isFresh: true,
        hasUserMove: false,
        isMotionReduced: () => false,
        ...step,
      });
      history = next.history;
      return next.visit;
    },
    /** Follows a Link or Unlink of the user, as the page does when the user makes one and the controller answers. */
    gesture: (step: LinkGestureStep) => {
      history = advanceLinkGesture(history, step);
    },
    /** Returns the placement the visit holds now. */
    readPlacement: () => history.placement,
    /** Lets the arrivals `ids` in, as the caller does once the hand is still. */
    release: (...ids: string[]) => {
      released = new Set([...released, ...ids]);
    },
  };
};

const surfaceRows = (visit: InboxVisit) =>
  visit.layout!.ongoing.surfaces.map((surface) => [surface.head.id, listCardIds(surface.rows)]);
const requestIds = (visit: InboxVisit) =>
  visit.layout!.requests.groups.flatMap((group) => listCardIds(group.rows));

describe("advanceInboxVisit: arrivals", () => {
  it("draws nothing before the first read ends", () => {
    const visit = startVisit().read(undefined);
    expect(visit.inbox).toBeUndefined();
    expect(visit.layout).toBeUndefined();
    expect(visit.heldArrivals).toEqual([]);
    expect(visit.groupings.map((grouping) => grouping.id)).toEqual([HOME_GROUPING]);
  });

  it("draws the first fresh reply whole, even when it is empty", () => {
    const first = startVisit();
    expect(first.read(inboxOf([ticket("1", [PRICING]), ticket("2", [BETA])])).heldArrivals).toEqual(
      [],
    );
    // The first reply was empty, so everything after it is an arrival.
    const empty = startVisit();
    empty.read(inboxOf([]));
    expect(empty.read(inboxOf([ticket("1", [PRICING])])).heldArrivals).toEqual(["1"]);
  });

  it("never lets a copy kept from an earlier visit seed the visit", () => {
    const visit = startVisit();
    const placeholder = visit.read(inboxOf([ticket("1", [PRICING])]), { isFresh: false });
    expect(placeholder.heldArrivals).toEqual([]);
    // The visit's own reply names other cards; none of them is an arrival, and card 1 left it.
    const own = visit.read(inboxOf([ticket("2", [BETA]), ticket("3", [BETA])]));
    expect(own.heldArrivals).toEqual([]);
    expect(surfaceRows(own)).toEqual([[BETA, ["2", "3"]]]);
  });

  it("holds an arrival back mid-visit, and lets it in at the end of its list once it is released", () => {
    const visit = startVisit();
    visit.read(inboxOf([ticket("2", [PRICING]), ticket("3", [PRICING])]));
    // Card 1 is the oldest, but it arrives last.
    const arriving = inboxOf([
      ticket("1", [PRICING]),
      ticket("2", [PRICING]),
      ticket("3", [PRICING]),
    ]);
    const held = visit.read(arriving);
    expect(held.heldArrivals).toEqual(["1"]);
    expect(held.inbox!.cards.map((card) => card.id)).toEqual(["2", "3"]);
    expect(surfaceRows(held)).toEqual([[PRICING, ["2", "3"]]]);

    visit.release("1");
    const released = visit.read(arriving);
    expect(released.heldArrivals).toEqual([]);
    expect(surfaceRows(released)).toEqual([[PRICING, ["2", "3", "1"]]]);
  });

  it("shows the words of a held read at once, and holds only the new card", () => {
    const visit = startVisit();
    visit.read(inboxOf([request("1")]));
    const reread = visit.read(inboxOf([request("1", { title: "Review, reworded" }), request("2")]));
    expect(reread.heldArrivals).toEqual(["2"]);
    expect(reread.layout!.requests.groups[0]?.rows[0]?.card.title).toBe("Review, reworded");
  });

  it("brings a dismissed card back to its row, and it is no arrival", () => {
    const visit = startVisit();
    const all = [ticket("1", [PRICING]), ticket("2", [PRICING]), ticket("3", [PRICING])];
    visit.read(inboxOf(all));
    const dismissed = visit.read(inboxOf([all[0]!, all[2]!]), { hasUserMove: true });
    expect(surfaceRows(dismissed)).toEqual([[PRICING, ["1", "3"]]]);
    const restored = visit.read(inboxOf(all));
    expect(restored.heldArrivals).toEqual([]);
    expect(surfaceRows(restored)).toEqual([[PRICING, ["1", "2", "3"]]]);
  });

  it("keeps a card in its column once it gets a Task", () => {
    const visit = startVisit();
    visit.read(inboxOf([request("1")]));
    const taken = visit.read(
      inboxOf([request("1", { side: "with-someone-else", taskId: "task-1" })]),
    );
    expect(requestIds(taken)).toEqual(["1"]);
    expect(taken.heldArrivals).toEqual([]);
  });
});

describe("advanceInboxVisit: the history", () => {
  it("returns the history it was given when the read is the one it already holds", () => {
    const inbox = inboxOf([ticket("1", [PRICING])]);
    const step = {
      received: inbox,
      view: VIEW,
      released: new Set<string>(),
      isFresh: true,
      hasUserMove: false,
      isMotionReduced: () => false,
    };
    const first = advanceInboxVisit(START_OF_VISIT, step);
    expect(advanceInboxVisit(first.history, step).history).toBe(first.history);
  });

  it("keeps the placement and the bundles when a read only rewords a card", () => {
    const first = advanceInboxVisit(START_OF_VISIT, {
      received: inboxOf([ticket("1", [PRICING])]),
      view: VIEW,
      released: new Set(),
      isFresh: true,
      hasUserMove: false,
      isMotionReduced: () => false,
    });
    const again = advanceInboxVisit(first.history, {
      received: inboxOf([ticket("1", [PRICING], { title: "Reworded" })]),
      view: VIEW,
      released: new Set(),
      isFresh: true,
      hasUserMove: false,
      isMotionReduced: () => false,
    });
    expect(again.history.placement).toBe(first.history.placement);
    expect(again.history.bundles).toBe(first.history.bundles);
  });

  it("leaves no trace of a copy kept from an earlier visit", () => {
    const placeholder = advanceInboxVisit(START_OF_VISIT, {
      received: inboxOf([ticket("1", [PRICING])]),
      view: VIEW,
      released: new Set(),
      isFresh: false,
      hasUserMove: false,
      isMotionReduced: () => false,
    });
    expect(hasPlacedCards(placeholder.history.placement)).toBe(false);
    expect(placeholder.visit.layout?.ongoing.surfaces).toHaveLength(1);
  });
});

describe("advanceInboxVisit: Group by", () => {
  const cards = [ticket("2", [PRICING]), ticket("3", [BETA])];

  it("places the surfaces again when the user groups differently, and keeps the order of the rows", () => {
    const visit = startVisit();
    visit.read(inboxOf(cards));
    // Card 1 is the oldest, but it joined last and lies last.
    const arriving = inboxOf([ticket("1", [PRICING]), ...cards]);
    visit.read(arriving);
    visit.release("1");
    expect(surfaceRows(visit.read(arriving))).toEqual([
      [BETA, ["3"]],
      [PRICING, ["2", "1"]],
    ]);

    const byStatus = visit.read(arriving, { view: { ...VIEW, grouping: STATUS_GROUPING } });
    expect(byStatus.layout!.grouping).toBe(STATUS_GROUPING);
    expect(byStatus.layout!.ongoing.surfaces.map((surface) => listCardIds(surface.rows))).toEqual([
      ["2", "3", "1"],
    ]);
  });

  it("keeps a row in the menu for a grouping the replies stop offering, under its name", () => {
    const grouped = { ...VIEW, grouping: "acme/project" };
    const visit = startVisit();
    const before = visit.read(inboxOf(cards), { view: grouped });
    expect(before.groupings.map((grouping) => grouping.id)).toEqual([
      HOME_GROUPING,
      "acme/project",
      STATUS_GROUPING,
    ]);

    // A reparenting removed the last project from the replies.
    const after = visit.read(inboxOf([ticket("2"), ticket("3")]), { view: grouped });
    expect(after.layout!.grouping).toBe("acme/project");
    expect(after.groupings).toContainEqual({ id: "acme/project", name: "Acme project" });
    expect(surfaceRows(after)).toEqual([
      [BETA, ["3"]],
      [PRICING, ["2"]],
    ]);
  });

  it("drops that row at the next visit, which looks for the choice again", () => {
    const grouped = { ...VIEW, grouping: "acme/project" };
    const visit = startVisit();
    const after = visit.read(inboxOf([ticket("2"), ticket("3")]), { view: grouped });
    expect(after.layout!.grouping).toBe(HOME_GROUPING);
    expect(after.groupings.map((grouping) => grouping.id)).toEqual([
      HOME_GROUPING,
      STATUS_GROUPING,
    ]);
  });
});

describe("advanceInboxVisit: what the user's own move emptied", () => {
  it("marks the Requests column emptied by the user's dismissal, until a card comes back", () => {
    const visit = startVisit();
    visit.read(inboxOf([ticket("1", [PRICING]), request("2")]));
    const dismissed = visit.read(inboxOf([ticket("1", [PRICING])]), { hasUserMove: true });
    expect(dismissed.emptiedByMove).toEqual({ everything: false, requests: true });
    // The controller answers: no move is pending any more, and the column is still the user's doing.
    expect(visit.read(inboxOf([ticket("1", [PRICING])])).emptiedByMove.requests).toBe(true);
    // Undo puts the request back; later the column empties by itself.
    expect(visit.read(inboxOf([ticket("1", [PRICING]), request("2")])).emptiedByMove.requests).toBe(
      false,
    );
    expect(visit.read(inboxOf([ticket("1", [PRICING])])).emptiedByMove.requests).toBe(false);
  });

  it("marks the whole page emptied when the user dismisses the last card", () => {
    const visit = startVisit();
    visit.read(inboxOf([request("1")]));
    const dismissed = visit.read(inboxOf([]), { hasUserMove: true });
    expect(dismissed.emptiedByMove).toEqual({ everything: true, requests: true });
  });

  it("does not mark a column that something else emptied, or one that was empty already", () => {
    const visit = startVisit();
    visit.read(inboxOf([ticket("1", [PRICING]), ticket("2", [PRICING])]));
    // The user dismisses a card while Requests is empty already.
    const dismissed = visit.read(inboxOf([ticket("1", [PRICING])]), { hasUserMove: true });
    expect(dismissed.emptiedByMove).toEqual({ everything: false, requests: false });
    // A read, not the user, takes the last card.
    expect(visit.read(inboxOf([])).emptiedByMove).toEqual({ everything: false, requests: false });
  });

  it.each([
    ["the Show choice", { requestsShow: { kind: "mine" } }],
    ["a page filter", { filter: { whose: ["mine"] } }],
  ] as const)(
    "does not mark a column that %s hides, not even once the hidden request is gone",
    (_, hiding) => {
      const visit = startVisit();
      visit.read(inboxOf([ticket("1", [PRICING]), request("2")]));
      const hidden = visit.read(inboxOf([ticket("1", [PRICING]), request("2")]), {
        hasUserMove: true,
        view: { ...VIEW, ...hiding },
      });
      expect(hidden.layout!.requests.isEmpty).toBe(true);
      expect(hidden.emptiedByMove.requests).toBe(false);
      // The hidden request goes away by itself, with the same choice still on.
      const gone = visit.read(inboxOf([ticket("1", [PRICING])]), { view: { ...VIEW, ...hiding } });
      expect(gone.emptiedByMove.requests).toBe(false);
    },
  );

  it("does not mark a page that opens empty", () => {
    expect(startVisit().read(inboxOf([])).emptiedByMove).toEqual({
      everything: false,
      requests: false,
    });
  });
});

describe("advanceLinkGesture: where a card rides", () => {
  const A = buildInboxCard("a", { firstObservedAt: "2026-11-01T09:00:00.000Z" });
  const B = buildInboxCard("b", { firstObservedAt: "2026-11-02T09:00:00.000Z" });
  const X = request("3");
  const alone = inboxOf([A, B, X]);
  const ridingOn = (lead: InboxCard) => inboxOf([A, B, { ...X, ridesOn: lead.ref }]);
  const link = (
    visit: ReturnType<typeof startVisit>,
    inbox: Inbox,
    lead: InboxCard,
    gesture: number,
  ) => {
    const plan = planLink(inbox, X.ref, lead.ref);
    visit.gesture({ _tag: "start", gesture, move: plan.ridingMove! });
  };
  /** The ids of the cards drawn riding on each lead. */
  const riders = (visit: InboxVisit) =>
    Object.fromEntries(
      [A, B].map((lead) => [
        lead.id,
        visit
          .layout!.ongoing.surfaces.flatMap((surface) => surface.rows)
          .find((row) => row.card.id === lead.id && row.alsoIn === undefined)!
          .bundle.riders.map((card) => card.id),
      ]),
    );

  it("puts a request on the lead the user links it to, though a later read says it rides on another", () => {
    const visit = startVisit();
    visit.read(alone);
    // The read says X rides on B, but the visit keeps drawing it alone.
    const later = ridingOn(B);
    expect(riders(visit.read(later))).toEqual({ a: [], b: [] });
    link(visit, later, A, 1);
    expect(riders(visit.read(later, { hasUserMove: true }))).toEqual({ a: ["3"], b: [] });
    visit.gesture({ _tag: "settle", gesture: 1, remaining: undefined });
    expect(riders(visit.read(later))).toEqual({ a: ["3"], b: [] });
  });

  it("plays a later Link again when an earlier one is refused, so the card ends on the later lead", () => {
    const visit = startVisit();
    visit.read(alone);
    link(visit, alone, A, 1);
    link(visit, alone, B, 2);
    expect(riders(visit.read(alone))).toEqual({ a: ["3"], b: [] });
    visit.gesture({ _tag: "refuse", gesture: 1 });
    expect(riders(visit.read(alone))).toEqual({ a: [], b: ["3"] });
    visit.gesture({ _tag: "settle", gesture: 2, remaining: undefined });
    expect(riders(visit.read(alone))).toEqual({ a: [], b: ["3"] });
  });

  it("keeps the first lead when both Links are accepted", () => {
    const visit = startVisit();
    visit.read(alone);
    link(visit, alone, A, 1);
    link(visit, alone, B, 2);
    visit.gesture({ _tag: "settle", gesture: 1, remaining: undefined });
    visit.gesture({ _tag: "settle", gesture: 2, remaining: undefined });
    expect(riders(visit.read(alone))).toEqual({ a: ["3"], b: [] });
  });

  describe("an Unlink", () => {
    const person = buildInboxLink(X.ref, A.ref, "person");
    const linked = buildInbox([A, B, { ...X, ridesOn: A.ref }], { links: [person], places });
    const unlink = (visit: ReturnType<typeof startVisit>) => {
      const plan = planUnlink(linked, X.ref, A.ref, visit.readPlacement());
      visit.gesture({ _tag: "start", gesture: 1, move: plan!.ridingMove! });
    };

    it("takes the card off its lead while it waits, and lets it stand alone once nothing joins the pair", () => {
      const visit = startVisit();
      visit.read(linked);
      unlink(visit);
      expect(riders(visit.read(linked))).toEqual({ a: [], b: [] });
      visit.gesture({ _tag: "settle", gesture: 1, remaining: undefined });
      expect(riders(visit.read(linked))).toEqual({ a: [], b: [] });
    });

    it("keeps the card on its lead when the answer says a source still reports the link", () => {
      const visit = startVisit();
      visit.read(linked);
      unlink(visit);
      visit.gesture({ _tag: "settle", gesture: 1, remaining: "source" });
      expect(riders(visit.read(linked))).toEqual({ a: ["3"], b: [] });
    });

    it("puts the card back on its lead when the Unlink is refused", () => {
      const visit = startVisit();
      visit.read(linked);
      unlink(visit);
      visit.gesture({ _tag: "refuse", gesture: 1 });
      expect(riders(visit.read(linked))).toEqual({ a: ["3"], b: [] });
    });

    it("is undone by a Link, a gesture of its own, planned over the place the visit holds", () => {
      const visit = startVisit();
      visit.read(linked);
      unlink(visit);
      visit.gesture({ _tag: "settle", gesture: 1, remaining: undefined });
      link(visit, linked, A, 2);
      expect(riders(visit.read(linked))).toEqual({ a: ["3"], b: [] });
    });
  });

  it("returns the history it was given for a gesture that has no move waiting", () => {
    const visit = startVisit();
    visit.read(alone);
    const before = visit.readPlacement();
    visit.gesture({ _tag: "settle", gesture: 9, remaining: undefined });
    visit.gesture({ _tag: "refuse", gesture: 9 });
    expect(visit.readPlacement()).toBe(before);
  });

  it("still shows a move made while a copy from an earlier visit stands in, and keeps it for the visit's own reply", () => {
    const visit = startVisit();
    visit.read(alone, { isFresh: false });
    link(visit, alone, A, 1);
    expect(riders(visit.read(alone, { isFresh: false }))).toEqual({ a: ["3"], b: [] });
    expect(riders(visit.read(alone))).toEqual({ a: ["3"], b: [] });
  });
});

describe("advanceInboxVisit: a signal landing on a card", () => {
  const saying = (n: number, say: string) => ({
    signals: { openCount: 1, kinds: [], latest: buildSignalLine(`s${String(n)}`, say) },
  });
  const read = (n: number, say: string, others: readonly InboxCard[] = []) =>
    inboxOf([ticket("1", [PRICING], saying(n, say)), ...others]);
  const wordsOf = (visit: InboxVisit, id: string) =>
    visit.inbox!.cards.find((card) => card.id === id)!.signals.latest?.say.say;

  /** Starts a visit that has read `first`, and keeps the history, so steps can be applied to it. */
  const startLanding = (isReduced = false) => {
    let history = START_OF_VISIT;
    let asked = 0;
    const draw = (received: Inbox | undefined, step: Partial<VisitStep> = {}): InboxVisit => {
      const next = advanceInboxVisit(history, {
        received,
        view: VIEW,
        released: new Set(),
        isFresh: true,
        hasUserMove: false,
        isMotionReduced: () => {
          asked += 1;
          return isReduced;
        },
        ...step,
      });
      history = next.history;
      return next.visit;
    };
    return {
      draw,
      step: (step: LandingStep) => {
        const next = advanceLanding(history, step);
        history = next.history;
        return next.released;
      },
      /** Draws the page again from what the visit remembers, as the screen does after a step. */
      redraw: (received: Inbox) => draw(received),
      countAsks: () => asked,
    };
  };

  it("lands nothing on the first read of the visit", () => {
    const visit = startLanding();
    const first = visit.draw(read(1, "Tessa commented"));
    expect(first.landing).toBeUndefined();
    expect(first.freshIds.size).toBe(0);
    expect(visit.countAsks()).toBe(0);
  });

  it("lands nothing on a copy kept from an earlier visit, and it is no read of this visit", () => {
    const visit = startLanding();
    visit.draw(read(1, "Tessa commented"), { isFresh: false });
    const own = visit.draw(read(2, "Omar commented"));
    expect(own.landing).toBeUndefined();
    expect(wordsOf(own, "1")).toBe("Omar commented");
  });

  it("holds the card as it was and asks the screen to play the landing, until the drop has landed", () => {
    const visit = startLanding();
    visit.draw(read(1, "Tessa commented"));
    const landed = visit.draw(read(2, "Omar commented"));
    expect(landed.landing).toEqual({
      number: 1,
      isReduced: false,
      cards: [{ id: "1", tone: "plain" }],
    });
    expect(wordsOf(landed, "1")).toBe("Tessa commented");
    // The card is not fresh while its drop falls, and the screen reader hears nothing yet.
    expect(landed.freshIds.size).toBe(0);
    expect(landed.announcement).toBe("");

    expect(visit.step({ _tag: "dropLanded", landing: 1 })).toEqual(["1"]);
    const after = visit.redraw(read(2, "Omar commented"));
    expect(wordsOf(after, "1")).toBe("Omar commented");
    expect([...after.freshIds]).toEqual(["1"]);
    expect(after.announcement).toBe("Ticket ACME-1: Omar commented");
    // The same landing, not a new one.
    expect(after.landing).toBe(landed.landing);
  });

  it("asks for no landing again for a read that brings the same signal", () => {
    const visit = startLanding();
    visit.draw(read(1, "Tessa commented"));
    const landed = visit.draw(read(2, "Omar commented"));
    visit.step({ _tag: "dropLanded", landing: 1 });
    const again = visit.draw(read(2, "Omar commented", [ticket("2", [PRICING])]));
    expect(again.landing).toBe(landed.landing);
    expect(visit.step({ _tag: "dropLanded", landing: 1 })).toEqual([]);
  });

  it("draws the new words at once under Reduce motion, and holds nothing", () => {
    const visit = startLanding(true);
    visit.draw(read(1, "Tessa commented"));
    const landed = visit.draw(read(2, "Omar commented"));
    expect(landed.landing).toMatchObject({ number: 1, isReduced: true });
    expect(wordsOf(landed, "1")).toBe("Omar commented");
    expect([...landed.freshIds]).toEqual(["1"]);
    expect(landed.announcement).toBe("Ticket ACME-1: Omar commented");
    expect(visit.step({ _tag: "dropLanded", landing: 1 })).toEqual([]);
  });

  it("asks about Reduce motion once for each landing, and not for a read that lands nothing", () => {
    const visit = startLanding();
    visit.draw(read(1, "Tessa commented"));
    visit.draw(read(1, "Tessa commented", [ticket("2", [PRICING])]));
    expect(visit.countAsks()).toBe(0);
    visit.draw(read(2, "Omar commented"));
    expect(visit.countAsks()).toBe(1);
  });

  it("keeps the first words a card was held with when a second signal lands, and passes the hold on", () => {
    const visit = startLanding();
    visit.draw(read(1, "Tessa commented"));
    visit.draw(read(2, "Omar commented"));
    const second = visit.draw(read(3, "Ines commented"));
    expect(second.landing?.number).toBe(2);
    expect(wordsOf(second, "1")).toBe("Tessa commented");
    // The first drop lands, but the second landing took the card over, so nothing is released.
    expect(visit.step({ _tag: "dropLanded", landing: 1 })).toEqual([]);
    expect(wordsOf(visit.redraw(read(3, "Ines commented")), "1")).toBe("Tessa commented");
    expect(visit.step({ _tag: "dropLanded", landing: 2 })).toEqual(["1"]);
    const after = visit.redraw(read(3, "Ines commented"));
    expect(wordsOf(after, "1")).toBe("Ines commented");
    expect(after.announcement).toBe("Ticket ACME-1: Ines commented");
  });

  it("holds only the cards a signal landed on, and keeps the order of the page", () => {
    const visit = startLanding();
    const quiet = ticket("2", [PRICING]);
    visit.draw(read(1, "Tessa commented", [quiet]));
    const landed = visit.draw(read(2, "Omar commented", [quiet]));
    expect(landed.inbox!.cards.map((card) => card.id)).toEqual(["1", "2"]);
    expect(landed.inbox!.cards[1]).toBe(quiet);
  });

  it("clears the new mark when the user reaches the card, and only then", () => {
    const visit = startLanding();
    visit.draw(read(1, "Tessa commented"));
    visit.draw(read(2, "Omar commented"));
    visit.step({ _tag: "dropLanded", landing: 1 });
    expect([...visit.redraw(read(2, "Omar commented")).freshIds]).toEqual(["1"]);
    expect(visit.step({ _tag: "cardReached", id: "9" })).toEqual([]);
    expect([...visit.redraw(read(2, "Omar commented")).freshIds]).toEqual(["1"]);
    visit.step({ _tag: "cardReached", id: "1" });
    expect(visit.redraw(read(2, "Omar commented")).freshIds.size).toBe(0);
  });

  it("returns the history it was given for a step that changes nothing", () => {
    const history = advanceInboxVisit(START_OF_VISIT, {
      received: read(1, "Tessa commented"),
      view: VIEW,
      released: new Set(),
      isFresh: true,
      hasUserMove: false,
      isMotionReduced: () => false,
    }).history;
    expect(advanceLanding(history, { _tag: "dropLanded", landing: 1 }).history).toBe(history);
    expect(advanceLanding(history, { _tag: "cardReached", id: "1" }).history).toBe(history);
  });
});
