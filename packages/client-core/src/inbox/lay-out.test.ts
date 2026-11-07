/**
 * Tests the page of the Inbox: its surfaces, its two columns, the order, Group by,
 * Filter, and what the visit holds in place while reads change the cards.
 */
import type { EntityEdge, EntityPlace, Inbox, InboxCard } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { toggleFilterValue } from "../desk/filter";
import {
  buildInbox,
  buildInboxCard,
  buildInboxPlace,
  buildRequestCard,
  listCardIds,
} from "./cards.testing";
import { HOME_GROUPING, STATUS_GROUPING } from "./inbox-place";
import { layOutInbox, type InboxLayout, type InboxView } from "./lay-out";
import { NO_PLACEMENT, type VisitPlacement } from "./visit-placement";

const VIEW: InboxView = { grouping: HOME_GROUPING, filter: {}, requestsOrder: "oldest" };

const view = (overrides: Partial<InboxView> = {}): InboxView => ({ ...VIEW, ...overrides });

/** Lays out one read at the start of a visit, or after the reads whose `held` placement is given. */
const layOut = (
  inbox: Inbox,
  inboxView: InboxView,
  held: VisitPlacement = NO_PLACEMENT,
): InboxLayout => layOutInbox(inbox, inboxView, held);

/** Lays out each read in turn within one visit, and returns the layout of the last. */
const layOutVisit = (reads: readonly Inbox[], inboxView: InboxView = view()): InboxLayout => {
  let held = NO_PLACEMENT;
  let layout: InboxLayout | undefined;
  for (const inbox of reads) {
    layout = layOut(inbox, inboxView, held);
    held = layout.placement;
  }
  return layout!;
};

const surfaceIds = (layout: InboxLayout) => layout.ongoing.surfaces.map((s) => s.head.id);
const requestIds = (layout: InboxLayout) =>
  layout.requests.groups.flatMap((group) => listCardIds(group.rows));

const edge = (fromRef: string, toRef: string): EntityEdge => ({ fromRef, toRef });

const PRICING = "acme:project:pricing";
const CHECKOUT = "acme:project:checkout";
const SHOP_WEB = "acme:repository:shop-web";
const SHOP_API = "acme:repository:shop-api";

const project = (ref: string, title: string, overrides: Partial<EntityPlace> = {}) =>
  buildInboxPlace(ref, title, overrides);
const repository = (ref: string, title: string) =>
  buildInboxPlace(ref, title, {
    kind: "acme/repository",
    noun: "Repository",
    caption: "Acme repository",
  });

const ticket = (id: string, ancestors: readonly string[], overrides: Partial<InboxCard> = {}) =>
  buildInboxCard(id, { ancestors, firstObservedAt: `2026-11-0${id}T09:00:00.000Z`, ...overrides });

const review = (id: string, ancestors: readonly string[], overrides: Partial<InboxCard> = {}) =>
  buildRequestCard(id, {
    ancestors,
    firstObservedAt: `2026-11-0${id}T09:00:00.000Z`,
    ...overrides,
  });

const titles = (inbox: Inbox, overrides: Partial<InboxView> = {}) =>
  layOut(inbox, view(overrides)).ongoing.surfaces.map((surface) =>
    surface.head._tag === "place" && !surface.head.row.isLocked
      ? surface.head.row.title
      : surface.head.id,
  );

describe("layOutInbox: the order of the places", () => {
  it("puts places in trouble first (bad, then attention), then by target date, then by name", () => {
    const inbox = buildInbox(
      [1, 2, 3, 4, 5, 6].map((n) => ticket(String(n), [`acme:project:p${String(n)}`])),
      {
        places: [
          project("acme:project:p1", "Zulu"),
          project("acme:project:p2", "Alpha"),
          project("acme:project:p3", "Later", { targetDate: "2026-12-01T00:00:00.000Z" }),
          project("acme:project:p4", "Sooner", { targetDate: "2026-11-20T00:00:00.000Z" }),
          project("acme:project:p5", "Watched", {
            status: { shape: "alert", tone: "attention", label: "At risk" },
            targetDate: "2027-01-01T00:00:00.000Z",
          }),
          project("acme:project:p6", "Burning", {
            status: { shape: "alert", tone: "bad", label: "Off track" },
          }),
        ],
      },
    );
    expect(titles(inbox)).toEqual(["Burning", "Watched", "Sooner", "Later", "Alpha", "Zulu"]);
  });

  it("puts a surface named for a plugin, and a locked place, after the named places", () => {
    const inbox = buildInbox(
      [ticket("1", []), ticket("2", ["acme:project:hidden"]), ticket("3", [PRICING])],
      {
        places: [
          project(PRICING, "Pricing rules"),
          { ...project("acme:project:hidden", "Leaked"), restricted: true },
        ],
      },
    );
    const heads = layOut(inbox, view()).ongoing.surfaces.map((s) => s.head.id);
    expect(heads).toEqual([PRICING, "acme:project:hidden", "source:acme"]);
  });
});

describe("layOutInbox: the rows of a surface", () => {
  it("lists a place's cards oldest first, whatever order the read came in", () => {
    const inbox = buildInbox(
      [ticket("3", [PRICING]), ticket("1", [PRICING]), ticket("2", [PRICING])],
      {
        places: [project(PRICING, "Pricing rules")],
      },
    );
    const [surface] = layOut(inbox, view()).ongoing.surfaces;
    expect(listCardIds(surface?.rows ?? [])).toEqual(["1", "2", "3"]);
  });

  it("breaks a tie in age by id", () => {
    const same = { firstObservedAt: "2026-11-01T09:00:00.000Z" };
    const inbox = buildInbox([ticket("b", [PRICING], same), ticket("a", [PRICING], same)], {
      places: [project(PRICING, "Pricing rules")],
    });
    const [surface] = layOut(inbox, view()).ongoing.surfaces;
    expect(listCardIds(surface?.rows ?? [])).toEqual(["a", "b"]);
  });

  it("draws a card under two homes in full under the first and as a pointer under the second", () => {
    const inbox = buildInbox([ticket("1", [PRICING, CHECKOUT]), ticket("2", [CHECKOUT])], {
      places: [project(PRICING, "Pricing rules"), project(CHECKOUT, "Checkout")],
    });
    const layout = layOut(inbox, view());
    const [checkout, pricing] = layout.ongoing.surfaces;
    expect(checkout?.head.id).toBe(CHECKOUT);
    expect(checkout?.rows.map((row) => [row.card.id, row.alsoIn?.id])).toEqual([
      ["2", undefined],
      ["1", PRICING],
    ]);
    expect(pricing?.rows.map((row) => [row.card.id, row.alsoIn?.id])).toEqual([["1", undefined]]);
  });

  it("names the places between a row and its surface, such as its milestone", () => {
    const milestone = buildInboxPlace("acme:milestone:beta", "Beta", {
      kind: "acme/milestone",
      noun: "Milestone",
      targetDate: "2026-11-30T00:00:00.000Z",
    });
    const team = buildInboxPlace("acme:team:shop", "Shop team", {
      kind: "acme/team",
      noun: "Team",
    });
    const inbox = buildInbox([ticket("1", [PRICING, milestone.ref, team.ref])], {
      places: [project(PRICING, "Pricing rules"), milestone, team],
      edges: [
        edge("acme:ticket:1", PRICING),
        edge("acme:ticket:1", milestone.ref),
        edge("acme:ticket:1", team.ref),
      ],
    });
    const [surface] = layOut(inbox, view()).ongoing.surfaces;
    expect(surface?.rows[0]?.near.map((place) => place.title)).toEqual(["Beta"]);
  });

  it("gives the surface head everything its place is part of", () => {
    const site = buildInboxPlace("acme:site:rotterdam", "Rotterdam", {
      noun: "Site",
      kind: "acme/site",
    });
    const inbox = buildInbox([ticket("1", [PRICING, site.ref])], {
      places: [project(PRICING, "Pricing rules"), site],
      edges: [edge(PRICING, site.ref)],
    });
    const [surface] = layOut(inbox, view()).ongoing.surfaces;
    expect(surface?.head).toMatchObject({ _tag: "place", above: [{ ref: site.ref, depth: 1 }] });
  });

  it("draws a card in full on the first of its homes, in the order of its ancestors", () => {
    const inbox = buildInbox([ticket("1", [CHECKOUT, PRICING])], {
      places: [project(PRICING, "Pricing rules"), project(CHECKOUT, "Checkout")],
    });
    const layout = layOut(inbox, view());
    const full = layout.ongoing.surfaces.flatMap((surface) =>
      surface.rows.filter((row) => row.alsoIn === undefined).map(() => surface.head.id),
    );
    expect(full).toEqual([CHECKOUT]);
  });

  it("draws a card with no place of its home kind on a surface named for its plugin", () => {
    const inbox = buildInbox([ticket("1", [PRICING], { home: "acme/nothing" })], {
      places: [project(PRICING, "Pricing rules")],
    });
    const [surface] = layOut(inbox, view()).ongoing.surfaces;
    expect(surface?.head).toEqual({ _tag: "source", id: "source:acme", pluginId: "acme" });
  });
});

describe("layOutInbox: Requests", () => {
  const places = [repository(SHOP_WEB, "shop-web"), repository(SHOP_API, "shop-api")];
  const inbox = buildInbox(
    [
      review("1", [SHOP_WEB], { yours: false }),
      review("2", [SHOP_API], { yours: true }),
      review("3", [], { yours: false }),
      review("4", [SHOP_WEB], { yours: true }),
    ],
    { places },
  );

  it("lists oldest first", () => {
    const { groups } = layOut(inbox, view()).requests;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBeUndefined();
    expect(listCardIds(groups[0]?.rows ?? [])).toEqual(["1", "2", "3", "4"]);
  });

  it("lists yours first, each half oldest first", () => {
    const { groups } = layOut(inbox, view({ requestsOrder: "mine" })).requests;
    expect(listCardIds(groups[0]?.rows ?? [])).toEqual(["2", "4", "1", "3"]);
  });

  it("groups by place, each place labelled, by name, with no home last", () => {
    const { groups } = layOut(inbox, view({ requestsOrder: "place" })).requests;
    expect(groups.map((group) => [group.label, listCardIds(group.rows)])).toEqual([
      ["shop-api", ["2"]],
      ["shop-web", ["1", "4"]],
      ["Elsewhere", ["3"]],
    ]);
  });

  it("names no home for a request with none, or whose home is locked", () => {
    const locked = { ref: SHOP_WEB, kind: "acme/repository", noun: "Repository", restricted: true };
    const hidden = buildInbox([review("1", [SHOP_WEB])], { places: [locked] });
    expect(layOut(hidden, view()).requests.groups[0]?.rows[0]?.homeName).toBeUndefined();
  });

  it("carries the name of each request's home", () => {
    const { groups } = layOut(inbox, view()).requests;
    expect(groups[0]?.rows.map((row) => row.homeName)).toEqual([
      "shop-web",
      "shop-api",
      undefined,
      "shop-web",
    ]);
  });
});

describe("layOutInbox: sides", () => {
  const inbox = buildInbox(
    [
      review("1", [], { side: "requests" }),
      ticket("2", [PRICING], { side: "ongoing" }),
      review("3", [], { side: "with-someone-else", taskId: "task-3" }),
      review("4", [], { side: "with-someone-else", taskId: "task-4" }),
    ],
    { places: [project(PRICING, "Pricing rules")] },
  );

  it("puts each card in the column of its side, and With someone else at the foot, oldest first", () => {
    const layout = layOut(inbox, view());
    expect(listCardIds(layout.requests.groups.flatMap((group) => group.rows))).toEqual(["1"]);
    expect(listCardIds(layout.ongoing.surfaces.flatMap((surface) => surface.rows))).toEqual(["2"]);
    expect(listCardIds(layout.withSomeoneElse.rows)).toEqual(["3", "4"]);
  });

  it("shows the number of requests the controller counts, not the cards the page holds", () => {
    const counted = { ...buildInbox([review("1", [], { side: "requests" })]) };
    const layout = layOut(
      { ...counted, counts: { ...counted.counts, requests: 1200 } },
      view({ filter: { whose: ["mine"] } }),
    );
    expect(layout.requests.awaitingCount).toBe(1200);
  });
});

describe("layOutInbox: what the visit holds in place", () => {
  const BETA = "acme:project:beta";
  const places = [
    project(PRICING, "Alpha"),
    project(BETA, "Beta"),
    project(CHECKOUT, "Checkout", {
      status: { shape: "alert", tone: "bad", label: "Off track" },
    }),
  ];

  it("keeps a card in the column it was first seen in once it gets a Task", () => {
    const before = buildInbox([review("1", [], { side: "requests" })]);
    const after = buildInbox([review("1", [], { side: "with-someone-else", taskId: "task-1" })]);
    const layout = layOutVisit([before, after]);
    expect(requestIds(layout)).toEqual(["1"]);
    expect(layout.withSomeoneElse.rows).toEqual([]);
  });

  it("settles that card under With someone else at the start of the next visit", () => {
    const after = buildInbox([review("1", [], { side: "with-someone-else", taskId: "task-1" })]);
    const layout = layOutVisit([after]);
    expect(requestIds(layout)).toEqual([]);
    expect(listCardIds(layout.withSomeoneElse.rows)).toEqual(["1"]);
  });

  it("keeps the surfaces in order when a place turns bad, and shows the place's new status in place", () => {
    const first = buildInbox([ticket("1", [PRICING]), ticket("2", [BETA])], { places });
    const turnedBad = buildInbox([ticket("1", [PRICING]), ticket("2", [BETA])], {
      places: [
        places[0]!,
        project(BETA, "Beta", { status: { shape: "alert", tone: "bad", label: "Off track" } }),
      ],
    });
    const layout = layOutVisit([first, turnedBad]);
    expect(surfaceIds(layout)).toEqual([PRICING, BETA]);
    expect(layout.ongoing.surfaces[1]?.head).toMatchObject({
      row: { title: "Beta", status: { tone: "bad" } },
    });
    // The next visit applies the order of the page: places in trouble come first.
    expect(surfaceIds(layOutVisit([turnedBad]))).toEqual([BETA, PRICING]);
  });

  it("keeps a card on the surface it was first seen on when it is moved to another place", () => {
    const before = buildInbox([ticket("1", [PRICING]), ticket("2", [BETA])], { places });
    const moved = buildInbox([ticket("1", [BETA]), ticket("2", [BETA])], { places });
    const layout = layOutVisit([before, moved]);
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      [PRICING, ["1"]],
      [BETA, ["2"]],
    ]);
    expect(layOutVisit([moved]).ongoing.surfaces.map((s) => s.head.id)).toEqual([BETA]);
  });

  it("keeps a card under the status it was first seen with, and shows its new status in its row", () => {
    const open = { shape: "ring", tone: "quiet", label: "Open" } as const;
    const failing = { shape: "alert", tone: "bad", label: "Failing" } as const;
    const before = buildInbox([
      ticket("1", [], { status: open }),
      ticket("2", [], { status: failing }),
    ]);
    const after = buildInbox([
      ticket("1", [], { status: failing }),
      ticket("2", [], { status: failing }),
    ]);
    const layout = layOutVisit([before, after], view({ grouping: STATUS_GROUPING }));
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      ["status:bad:Failing", ["2"]],
      ["status:quiet:Open", ["1"]],
    ]);
    expect(layout.ongoing.surfaces[1]?.rows[0]?.card.status?.label).toBe("Failing");
  });

  it("keeps a card drawn in full on its first surface when its places change order", () => {
    const before = buildInbox([ticket("1", [PRICING, BETA])], { places });
    const after = buildInbox([ticket("1", [BETA, PRICING])], { places });
    const layout = layOutVisit([before, after]);
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, s.rows[0]?.alsoIn?.id])).toEqual([
      [PRICING, undefined],
      [BETA, PRICING],
    ]);
  });

  it("puts a new card at the end of its surface and a new surface behind the others", () => {
    const before = buildInbox([ticket("2", [BETA])], { places });
    const after = buildInbox(
      [
        ticket("2", [BETA]),
        // Observed earlier than card 2 and under a place that sorts first: it still joins at the end.
        ticket("1", [PRICING], { firstObservedAt: "2026-10-01T09:00:00.000Z" }),
        ticket("3", [BETA], { firstObservedAt: "2026-11-09T09:00:00.000Z" }),
      ],
      { places },
    );
    const layout = layOutVisit([before, after]);
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      [BETA, ["2", "3"]],
      [PRICING, ["1"]],
    ]);
  });

  it("puts a card that appears after the first read behind the rows already on its surface", () => {
    const first = buildInbox([ticket("2", [PRICING]), ticket("3", [PRICING])], { places });
    const arrived = buildInbox(
      [
        ticket("2", [PRICING]),
        ticket("3", [PRICING]),
        ticket("1", [PRICING], { firstObservedAt: "2026-10-01T09:00:00.000Z" }),
      ],
      { places },
    );
    const [surface] = layOutVisit([first, arrived]).ongoing.surfaces;
    expect(listCardIds(surface?.rows ?? [])).toEqual(["2", "3", "1"]);
  });

  it("puts a request that appears after the first read at the end of Requests", () => {
    const first = buildInbox([review("2", []), review("3", [])]);
    const arrived = buildInbox([
      review("2", []),
      review("3", []),
      review("1", [], { firstObservedAt: "2026-10-01T09:00:00.000Z" }),
    ]);
    expect(requestIds(layOutVisit([first, arrived]))).toEqual(["2", "3", "1"]);
  });

  it("brings a dismissed card back to the row it had, not to the end", () => {
    const all = buildInbox(
      [ticket("1", [PRICING]), ticket("2", [PRICING]), ticket("3", [PRICING])],
      {
        places,
      },
    );
    const dismissed = buildInbox([ticket("1", [PRICING]), ticket("3", [PRICING])], { places });
    const arrived = buildInbox(
      [ticket("1", [PRICING]), ticket("3", [PRICING]), ticket("4", [PRICING])],
      { places },
    );
    const restored = buildInbox(
      [
        ticket("1", [PRICING]),
        ticket("2", [PRICING]),
        ticket("3", [PRICING]),
        ticket("4", [PRICING]),
      ],
      { places },
    );
    const [surface] = layOutVisit([all, dismissed, arrived, restored]).ongoing.surfaces;
    expect(listCardIds(surface?.rows ?? [])).toEqual(["1", "2", "3", "4"]);
  });

  it("orders several surfaces that join together as the page does", () => {
    const before = buildInbox([ticket("1", [BETA])], { places });
    const after = buildInbox(
      [ticket("1", [BETA]), ticket("2", [PRICING]), ticket("3", [CHECKOUT])],
      {
        places,
      },
    );
    expect(surfaceIds(layOutVisit([before, after]))).toEqual([BETA, CHECKOUT, PRICING]);
  });

  it("brings a card back to its place when it returns after a dismissal", () => {
    const both = buildInbox([ticket("1", [PRICING]), ticket("2", [BETA])], { places });
    const dismissed = buildInbox([ticket("2", [BETA])], { places });
    const movedAway = buildInbox([ticket("1", [BETA]), ticket("2", [BETA])], { places });
    const layout = layOutVisit([both, dismissed, movedAway]);
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      [PRICING, ["1"]],
      [BETA, ["2"]],
    ]);
  });

  it("starts the surfaces over when the user groups differently, and keeps the sides", () => {
    const before = buildInbox(
      [ticket("1", [PRICING], { status: { shape: "ring", tone: "quiet", label: "Open" } })],
      { places },
    );
    let held = layOut(before, view()).placement;
    held = layOut(before, view({ grouping: STATUS_GROUPING }), held).placement;
    const layout = layOut(before, view(), held);
    expect(surfaceIds(layout)).toEqual([PRICING]);
    expect(held.cards.get("1")?.side).toBe("ongoing");
  });

  it("keeps the surfaces of a Group by choice when the replies stop offering that kind of place", () => {
    const grouped = view({ grouping: "acme/project" });
    const before = buildInbox([ticket("1", [PRICING]), ticket("2", [BETA])], { places });
    // A reparenting removed the last project from the replies.
    const after = buildInbox([ticket("1", []), ticket("2", [])], { places });
    const layout = layOutVisit([before, after], grouped);
    expect(layout.grouping).toBe("acme/project");
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      [PRICING, ["1"]],
      [BETA, ["2"]],
    ]);
  });

  it("looks for the Group by choice again at the next visit", () => {
    const grouped = view({ grouping: "acme/project" });
    const after = buildInbox([ticket("1", []), ticket("2", [])], { places });
    expect(layOutVisit([after], grouped).grouping).toBe(HOME_GROUPING);
  });

  it("looks for the Group by choice again when the user picks it", () => {
    const before = buildInbox([ticket("1", [PRICING])], { places });
    const after = buildInbox([ticket("1", [])], { places });
    let held = layOut(before, view()).placement;
    held = layOut(after, view({ grouping: STATUS_GROUPING }), held).placement;
    // The choice was Status, then Project, which the replies no longer offer.
    expect(layOut(after, view({ grouping: "acme/project" }), held).grouping).toBe(HOME_GROUPING);
  });

  describe("in Requests", () => {
    const reviews = [
      review("1", [SHOP_WEB], { yours: false }),
      review("2", [SHOP_API], { yours: false }),
    ];
    const withPlaces = (cards: readonly InboxCard[]) =>
      buildInbox(cards, {
        places: [repository(SHOP_WEB, "shop-web"), repository(SHOP_API, "shop-api")],
      });

    it("keeps a request in the half it was first seen in when it becomes yours, until the next visit", () => {
      const mine = view({ requestsOrder: "mine" });
      const before = withPlaces(reviews);
      const becameYours = withPlaces([reviews[0]!, review("2", [SHOP_API], { yours: true })]);
      expect(requestIds(layOutVisit([before, becameYours], mine))).toEqual(["1", "2"]);
      expect(requestIds(layOutVisit([becameYours], mine))).toEqual(["2", "1"]);
    });

    it("keeps the groups of Requests ordered by place in the order they joined, and a new group last", () => {
      const first = withPlaces([review("2", [SHOP_API]), review("3", [])]);
      const second = withPlaces([
        review("1", [SHOP_WEB]),
        review("2", [SHOP_API]),
        review("3", []),
        review("4", [SHOP_API]),
      ]);
      const layout = layOutVisit([first, second], view({ requestsOrder: "place" }));
      expect(layout.requests.groups.map((g) => [g.label, listCardIds(g.rows)])).toEqual([
        ["shop-api", ["2", "4"]],
        ["Elsewhere", ["3"]],
        ["shop-web", ["1"]],
      ]);
    });

    it("keeps a request in its group when its home is renamed, and shows the new name on the card", () => {
      const before = withPlaces([review("1", [SHOP_WEB])]);
      const renamed = buildInbox([review("1", [SHOP_WEB])], {
        places: [repository(SHOP_WEB, "storefront")],
      });
      const layout = layOutVisit([before, renamed], view({ requestsOrder: "place" }));
      expect(layout.requests.groups.map((g) => g.label)).toEqual(["shop-web"]);
      expect(layout.requests.groups[0]?.rows[0]?.homeName).toBe("storefront");
    });
  });
});

describe("layOutInbox: Group by", () => {
  const inbox = buildInbox(
    [
      ticket("1", [PRICING], { status: { shape: "half", tone: "active", label: "In progress" } }),
      ticket("2", [PRICING, CHECKOUT], {
        status: { shape: "alert", tone: "bad", label: "Blocked" },
      }),
      ticket("3", []),
    ],
    { places: [project(PRICING, "Pricing rules"), project(CHECKOUT, "Checkout")] },
  );

  it("groups by status, bad tones first and no status last", () => {
    const layout = layOut(inbox, view({ grouping: STATUS_GROUPING }));
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      ["status:bad:Blocked", ["2"]],
      ["status:active:In progress", ["1"]],
      ["status:none", ["3"]],
    ]);
  });

  it("groups by a kind of place, with a surface for what has none", () => {
    const layout = layOut(inbox, view({ grouping: "acme/project" }));
    expect(layout.grouping).toBe("acme/project");
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      [CHECKOUT, ["2"]],
      [PRICING, ["1", "2"]],
      ["none:acme/project", ["3"]],
    ]);
    expect(layout.ongoing.surfaces.at(-1)?.head).toMatchObject({ title: "No Acme project" });
  });

  it("falls back to Place when the grouping asked for is no longer offered", () => {
    const layout = layOut(inbox, view({ grouping: "acme/gone" }));
    expect(layout.grouping).toBe(HOME_GROUPING);
  });
});

describe("layOutInbox: Filter", () => {
  const inbox = buildInbox(
    [
      ticket("1", [PRICING], { yours: true }),
      ticket("2", [CHECKOUT]),
      review("3", [SHOP_WEB], { yours: true }),
      review("4", [SHOP_WEB]),
    ],
    {
      places: [
        project(PRICING, "Pricing rules"),
        project(CHECKOUT, "Checkout"),
        repository(SHOP_WEB, "shop-web"),
      ],
    },
  );
  const cardsShown = (layout: ReturnType<typeof layOutInbox>) => [
    ...layout.ongoing.surfaces.flatMap((surface) => listCardIds(surface.rows)),
    ...layout.requests.groups.flatMap((group) => listCardIds(group.rows)),
  ];

  it("shows only yours, or only other people's, on both sides", () => {
    expect(cardsShown(layOut(inbox, view({ filter: { whose: ["mine"] } })))).toEqual(["1", "3"]);
    expect(cardsShown(layOut(inbox, view({ filter: { whose: ["others"] } })))).toEqual(["2", "4"]);
  });

  it("shows what lies in a chosen place", () => {
    const filter = toggleFilterValue({}, "acme/project", CHECKOUT);
    expect(cardsShown(layOut(inbox, view({ filter })))).toEqual(["2"]);
  });

  it("tells a column emptied by the filter from a column with nothing in it", () => {
    const layout = layOut(inbox, view({ filter: { "acme/project": [CHECKOUT] } }));
    expect(layout.requests).toMatchObject({ isEmpty: true, isEmptiedByFilter: true });
    expect(layout.ongoing).toMatchObject({ isEmpty: false, isEmptiedByFilter: false });
    const bare = layOut(buildInbox([ticket("1", [])]), view());
    expect(bare.requests).toMatchObject({ isEmpty: true, isEmptiedByFilter: false });
  });
});
