/** Tests the rows of the outside graph, with an invented purchase order that sits in two delivery rounds. */
import type { EntityEdge, EntityPlace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildPlaceRow, describeLockedRow, readAncestorRows } from "./relation-rows";

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
  ])("names a %s %s without a title", (pluginName, noun, words) => {
    const row = buildPlaceRow(place(SITE, "x", { noun, restricted: true }));
    expect(row.isLocked && describeLockedRow(row, pluginName)).toBe(words);
  });
});
