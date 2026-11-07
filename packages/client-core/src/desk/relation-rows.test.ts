/** Tests the rows of the outside graph, with an invented purchase order that sits in two delivery rounds. */
import type {
  EntityEdge,
  EntityHint,
  EntityLink,
  EntityPeer,
  EntityPlace,
} from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildLinkedRows,
  buildPeerRow,
  buildPlaceRow,
  describeLockedRow,
  indexRelationGraph,
  readAncestorRows,
} from "./relation-rows";

const place = (ref: string, title: string, overrides: Partial<EntityPlace> = {}): EntityPlace => ({
  ref,
  kind: "quayside/round",
  noun: "Delivery round",
  title,
  restricted: false,
  ...overrides,
});

const edge = (fromRef: string, toRef: string): EntityEdge => ({ fromRef, toRef });

const ORDER = "quayside:order:po-1";
const ROUND_A = "quayside:round:a";
const ROUND_B = "quayside:round:b";
const SITE = "quayside:site:rotterdam";

const SITE_PLACE = place(SITE, "Rotterdam depot", {
  kind: "quayside/site",
  noun: "Site",
  caption: "Quayside site",
  status: { shape: "half", tone: "active", label: "Receiving" },
  progress: { fraction: 4 / 9, done: 4, total: 9 },
  targetDate: "2026-11-14T00:00:00.000Z",
});

/** The order is in two rounds, and both rounds are in one site: a diamond. */
const DIAMOND = {
  places: [place(ROUND_A, "Round A"), place(ROUND_B, "Round B"), SITE_PLACE],
  edges: [edge(ORDER, ROUND_A), edge(ORDER, ROUND_B), edge(ROUND_A, SITE), edge(ROUND_B, SITE)],
};

describe("readAncestorRows", () => {
  it("lists both parents of a diamond, then the shared place once, nearest first", () => {
    const rows = readAncestorRows(ORDER, DIAMOND);
    expect(rows.map((row) => [row.ref, row.depth])).toEqual([
      [ROUND_A, 1],
      [ROUND_B, 1],
      [SITE, 2],
    ]);
  });

  it("shows what a place says about itself, and the progress words only with both numbers", () => {
    const [, , site] = readAncestorRows(ORDER, DIAMOND);
    expect(site).toMatchObject({
      isLocked: false,
      pluginId: "quayside",
      noun: "Site",
      caption: "Quayside site",
      title: "Rotterdam depot",
      status: { label: "Receiving" },
      progress: { fraction: 4 / 9, words: "4 of 9" },
      targetDate: "2026-11-14T00:00:00.000Z",
    });
    const bare = buildPlaceRow(place(SITE, "Bare", { progress: { fraction: 0.5 } }));
    expect(bare).toMatchObject({ progress: { fraction: 0.5 } });
    expect(bare).not.toHaveProperty("progress.words");
  });

  it("states no status or progress when the source reports none", () => {
    const [round] = readAncestorRows(ORDER, DIAMOND);
    expect(round).not.toHaveProperty("status");
    expect(round).not.toHaveProperty("progress");
  });

  it("draws a restricted place as a locked row with no title", () => {
    const hidden = place(SITE, "Leaked label", {
      kind: "sentry/issue",
      noun: "Error",
      restricted: true,
    });
    const rows = readAncestorRows(ORDER, { places: [hidden], edges: [edge(ORDER, SITE)] });
    expect(rows).toEqual([
      {
        isLocked: true,
        ref: SITE,
        kind: "sentry/issue",
        pluginId: "sentry",
        noun: "Error",
        depth: 1,
      },
    ]);
    expect(rows[0]).not.toHaveProperty("title");
  });

  it("leaves out a ref with no record, and still reads the places above it", () => {
    const rows = readAncestorRows(ORDER, {
      places: [SITE_PLACE],
      edges: [edge(ORDER, ROUND_A), edge(ROUND_A, SITE)],
    });
    expect(rows.map((row) => row.ref)).toEqual([SITE]);
  });

  it("uses the noun as the title of a place with no title", () => {
    const untitled: EntityPlace = {
      ref: ROUND_A,
      kind: "quayside/round",
      noun: "Delivery round",
      restricted: false,
    };
    const [row] = readAncestorRows(ORDER, { places: [untitled], edges: [edge(ORDER, ROUND_A)] });
    expect(row).toMatchObject({ title: "Delivery round" });
  });

  it("stops at a loop and never lists the thing itself", () => {
    const rows = readAncestorRows(ORDER, {
      places: [place(ROUND_A, "Round A"), place(ORDER, "The order")],
      edges: [edge(ORDER, ROUND_A), edge(ROUND_A, ORDER)],
    });
    expect(rows.map((row) => row.ref)).toEqual([ROUND_A]);
  });

  it("lists nothing for a thing with no parent", () => {
    expect(readAncestorRows(ORDER, { places: DIAMOND.places, edges: [] })).toEqual([]);
  });
});

describe("describeLockedRow", () => {
  it.each([
    ["Sentry", "Error", "A Sentry error you cannot open"],
    ["Asana", "Task", "An Asana task you cannot open"],
    ["GitHub", "PR", "A GitHub PR you cannot open"],
    [undefined, "Project", "A project you cannot open"],
    [undefined, "Issue", "An issue you cannot open"],
    [undefined, "PR", "A PR you cannot open"],
  ])("words a %s %s with the right article and no title", (pluginName, noun, words) => {
    const row = buildPlaceRow(place(SITE, "x", { noun, restricted: true }));
    expect(row.isLocked && describeLockedRow(row, pluginName)).toBe(words);
  });
});

describe("readAncestorRows with an index", () => {
  it("returns the rows it returns without one, so a caller can index a graph once for many walks", () => {
    const index = indexRelationGraph(DIAMOND);
    expect(readAncestorRows(ORDER, DIAMOND, index)).toEqual(readAncestorRows(ORDER, DIAMOND));
    expect(readAncestorRows(ROUND_A, DIAMOND, index)).toEqual(readAncestorRows(ROUND_A, DIAMOND));
  });
});

describe("buildLinkedRows", () => {
  const PLUGINS = [{ id: "quayside", displayName: "Quayside" }];
  const OTHER = "quayside:order:po-2";
  const PEER = "quayside:order:po-3";
  const claimOf = (type: EntityLink["claim"]["type"], extra: object = {}): EntityLink["claim"] => ({
    type,
    ...extra,
  });
  /** A link the test names without `hasPersonClaim`, which then holds exactly when the firmest claim is the user's. */
  type TestLink = Omit<EntityLink, "hasPersonClaim"> & { readonly hasPersonClaim?: boolean };
  const build = (
    links: readonly TestLink[],
    peers: readonly EntityPeer[] = [],
    hints: readonly EntityHint[] = [],
  ) =>
    buildLinkedRows({
      ref: ORDER,
      links: links.map((link) => ({
        ...link,
        hasPersonClaim: link.hasPersonClaim ?? link.claim.type === "person",
      })),
      hints,
      places: [place(OTHER, "Chilled crates", { identifier: "PO-2", noun: "Order" })],
      peers,
      plugins: PLUGINS,
    });

  it("words the claim of each link and lets only the user's own link be removed", () => {
    const rows = build([
      { fromRef: ORDER, toRef: OTHER, claim: claimOf("source", { plugin: "quayside" }) },
    ]);
    const byPerson = build([{ fromRef: OTHER, toRef: ORDER, claim: claimOf("person") }]);

    expect(rows.confirmed[0]?.link).toEqual({
      kind: "confirmed",
      claimWords: "Quayside reports this",
      canUnlink: false,
    });
    expect(byPerson.confirmed[0]?.link).toEqual({
      kind: "confirmed",
      claimWords: "You linked this",
      canUnlink: true,
    });
  });

  it("lets the user remove their own claim on a link a source reports as well", () => {
    const rows = build([
      {
        fromRef: ORDER,
        toRef: OTHER,
        claim: claimOf("source", { plugin: "quayside" }),
        hasPersonClaim: true,
      },
    ]);

    expect(rows.confirmed[0]?.link).toEqual({
      kind: "confirmed",
      claimWords: "Quayside reports this",
      canUnlink: true,
    });
  });

  it("keeps a reference found in text apart as a hint, and names the text it was found in", () => {
    const fromOther = build([], [], [{ fromRef: OTHER, toRef: ORDER, evidenceKey: "description" }]);
    const fromSelf = build([], [], [{ fromRef: ORDER, toRef: OTHER, evidenceKey: "description" }]);

    expect(fromOther.confirmed).toEqual([]);
    expect(fromOther.hints[0]?.link).toMatchObject({
      kind: "hint",
      claimWords: "Found in the description of PO-2",
      canUnlink: false,
    });
    expect(fromSelf.hints[0]?.link?.claimWords).toBe("Found in the description");
  });

  it("draws the far end from a peer when no place holds it, and a restricted peer as a locked row", () => {
    const rows = build(
      [
        { fromRef: ORDER, toRef: PEER, claim: claimOf("person") },
        { fromRef: ORDER, toRef: "quayside:order:po-4", claim: claimOf("source") },
        { fromRef: ORDER, toRef: "quayside:order:unknown", claim: claimOf("source") },
      ],
      [
        {
          ref: PEER,
          kind: "quayside/order",
          noun: "Order",
          title: "Dry goods",
          yours: false,
          restricted: false,
        },
        {
          ref: "quayside:order:po-4",
          kind: "quayside/order",
          noun: "Order",
          yours: false,
          restricted: true,
        },
      ],
    );

    expect(rows.confirmed.map((row) => [row.ref, row.isLocked])).toEqual([
      [PEER, false],
      ["quayside:order:po-4", true],
    ]);
  });

  it("draws a far end that a place and a peer both hold from the place", () => {
    const rows = build(
      [{ fromRef: ORDER, toRef: OTHER, claim: claimOf("source") }],
      [
        {
          ref: OTHER,
          kind: "quayside/order",
          noun: "Order",
          title: "Stale peer",
          yours: false,
          restricted: false,
        },
      ],
    );

    expect(rows.confirmed.map((row) => !row.isLocked && row.title)).toEqual(["Chilled crates"]);
  });

  it("leaves out a hint whose far end the user cannot open", () => {
    const rows = build(
      [],
      [{ ref: PEER, kind: "quayside/order", noun: "Order", yours: false, restricted: true }],
      [{ fromRef: ORDER, toRef: PEER }],
    );

    expect(rows.hints).toEqual([]);
  });
});

describe("the latest change of a row", () => {
  it("carries the finished words and tone of the place or peer", () => {
    const change = {
      reason: "reassigned",
      sentence: { say: "Now with Tessa", tone: "plain" },
      at: "x",
    } as const;

    const fromPlace = buildPlaceRow(place(SITE, "Depot", { latestChange: change }));
    const fromPeer = buildPeerRow({
      ref: SITE,
      kind: "quayside/site",
      noun: "Site",
      yours: false,
      restricted: false,
      latestChange: change,
    });

    for (const row of [fromPlace, fromPeer]) {
      expect(!row.isLocked && row.latestChange).toEqual({ say: "Now with Tessa", tone: "plain" });
    }
  });
});
