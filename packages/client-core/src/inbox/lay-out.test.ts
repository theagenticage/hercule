/** Tests the page of the Inbox: its surfaces, its two columns, the order, Group by, Filter and the visit's held sides. */
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
import { holdInboxSides, layOutInbox, type InboxView } from "./lay-out";

const VIEW: InboxView = {
  grouping: HOME_GROUPING,
  filter: {},
  requestsOrder: "oldest",
  heldSides: new Map(),
};

const view = (overrides: Partial<InboxView> = {}): InboxView => ({ ...VIEW, ...overrides });

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
  layOutInbox(inbox, view(overrides)).ongoing.surfaces.map((surface) =>
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
    const heads = layOutInbox(inbox, view()).ongoing.surfaces.map((s) => s.head.id);
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
    const [surface] = layOutInbox(inbox, view()).ongoing.surfaces;
    expect(listCardIds(surface?.rows ?? [])).toEqual(["1", "2", "3"]);
  });

  it("breaks a tie in age by id", () => {
    const same = { firstObservedAt: "2026-11-01T09:00:00.000Z" };
    const inbox = buildInbox([ticket("b", [PRICING], same), ticket("a", [PRICING], same)], {
      places: [project(PRICING, "Pricing rules")],
    });
    const [surface] = layOutInbox(inbox, view()).ongoing.surfaces;
    expect(listCardIds(surface?.rows ?? [])).toEqual(["a", "b"]);
  });

  it("draws a card under two homes in full under the first and as a pointer under the second", () => {
    const inbox = buildInbox([ticket("1", [PRICING, CHECKOUT]), ticket("2", [CHECKOUT])], {
      places: [project(PRICING, "Pricing rules"), project(CHECKOUT, "Checkout")],
    });
    const layout = layOutInbox(inbox, view());
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
    const [surface] = layOutInbox(inbox, view()).ongoing.surfaces;
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
    const [surface] = layOutInbox(inbox, view()).ongoing.surfaces;
    expect(surface?.head).toMatchObject({ _tag: "place", above: [{ ref: site.ref, depth: 1 }] });
  });

  it("draws a card with no place of its home kind on a surface named for its plugin", () => {
    const inbox = buildInbox([ticket("1", [PRICING], { home: "acme/nothing" })], {
      places: [project(PRICING, "Pricing rules")],
    });
    const [surface] = layOutInbox(inbox, view()).ongoing.surfaces;
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
    const { groups } = layOutInbox(inbox, view()).requests;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBeUndefined();
    expect(listCardIds(groups[0]?.rows ?? [])).toEqual(["1", "2", "3", "4"]);
  });

  it("lists yours first, each half oldest first", () => {
    const { groups } = layOutInbox(inbox, view({ requestsOrder: "mine" })).requests;
    expect(listCardIds(groups[0]?.rows ?? [])).toEqual(["2", "4", "1", "3"]);
  });

  it("groups by place, each place labelled, by name, with no home last", () => {
    const { groups } = layOutInbox(inbox, view({ requestsOrder: "place" })).requests;
    expect(groups.map((group) => [group.label, listCardIds(group.rows)])).toEqual([
      ["shop-api", ["2"]],
      ["shop-web", ["1", "4"]],
      ["Elsewhere", ["3"]],
    ]);
  });

  it("carries the name of each request's home", () => {
    const { groups } = layOutInbox(inbox, view()).requests;
    expect(groups[0]?.rows.map((row) => row.homeName)).toEqual([
      "shop-web",
      "shop-api",
      undefined,
      "shop-web",
    ]);
  });
});

describe("layOutInbox: sides and the visit", () => {
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
    const layout = layOutInbox(inbox, view());
    expect(listCardIds(layout.requests.groups.flatMap((group) => group.rows))).toEqual(["1"]);
    expect(listCardIds(layout.ongoing.surfaces.flatMap((surface) => surface.rows))).toEqual(["2"]);
    expect(listCardIds(layout.withSomeoneElse.rows)).toEqual(["3", "4"]);
  });

  it("keeps a card in the column it was first seen in once it gets a Task", () => {
    const before = buildInbox([review("1", [], { side: "requests" })]);
    const held = holdInboxSides(new Map(), before);
    const after = buildInbox([review("1", [], { side: "with-someone-else", taskId: "task-1" })]);
    const layout = layOutInbox(after, view({ heldSides: holdInboxSides(held, after) }));
    expect(listCardIds(layout.requests.groups.flatMap((group) => group.rows))).toEqual(["1"]);
    expect(layout.withSomeoneElse.rows).toEqual([]);
  });

  it("counts the requests that wait on the user, not a card just taken", () => {
    const before = buildInbox([review("1", [], { side: "requests" }), review("2", [])]);
    const held = holdInboxSides(new Map(), before);
    const after = buildInbox([
      review("1", [], { side: "with-someone-else", taskId: "task-1" }),
      review("2", []),
    ]);
    const layout = layOutInbox(after, view({ heldSides: holdInboxSides(held, after) }));
    expect(listCardIds(layout.requests.groups.flatMap((group) => group.rows))).toEqual(["1", "2"]);
    expect(layout.requests.awaitingCount).toBe(1);
  });

  it("holds the side of a new card at its first read, and never changes one it holds", () => {
    const held = holdInboxSides(new Map([["3", "requests"]]), inbox);
    expect([...held]).toEqual([
      ["3", "requests"],
      ["1", "requests"],
      ["2", "ongoing"],
      ["4", "with-someone-else"],
    ]);
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
    const layout = layOutInbox(inbox, view({ grouping: STATUS_GROUPING }));
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      ["status:bad:Blocked", ["2"]],
      ["status:active:In progress", ["1"]],
      ["status:none", ["3"]],
    ]);
  });

  it("groups by a kind of place, with a surface for what has none", () => {
    const layout = layOutInbox(inbox, view({ grouping: "acme/project" }));
    expect(layout.grouping).toBe("acme/project");
    expect(layout.ongoing.surfaces.map((s) => [s.head.id, listCardIds(s.rows)])).toEqual([
      [CHECKOUT, ["2"]],
      [PRICING, ["1", "2"]],
      ["none:acme/project", ["3"]],
    ]);
    expect(layout.ongoing.surfaces.at(-1)?.head).toMatchObject({ title: "No Acme project" });
  });

  it("falls back to Place when the grouping asked for is no longer offered", () => {
    const layout = layOutInbox(inbox, view({ grouping: "acme/gone" }));
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
    expect(cardsShown(layOutInbox(inbox, view({ filter: { whose: ["mine"] } })))).toEqual([
      "1",
      "3",
    ]);
    expect(cardsShown(layOutInbox(inbox, view({ filter: { whose: ["others"] } })))).toEqual([
      "2",
      "4",
    ]);
  });

  it("shows what lies in a chosen place", () => {
    const filter = toggleFilterValue({}, "acme/project", CHECKOUT);
    expect(cardsShown(layOutInbox(inbox, view({ filter })))).toEqual(["2"]);
  });

  it("tells a column emptied by the filter from a column with nothing in it", () => {
    const layout = layOutInbox(inbox, view({ filter: { "acme/project": [CHECKOUT] } }));
    expect(layout.requests).toMatchObject({ isEmpty: true, isEmptiedByFilter: true });
    expect(layout.ongoing).toMatchObject({ isEmpty: false, isEmptiedByFilter: false });
    const bare = layOutInbox(buildInbox([ticket("1", [])]), view());
    expect(bare.requests).toMatchObject({ isEmpty: true, isEmptiedByFilter: false });
  });
});
