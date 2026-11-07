/** Tests the pane's rows for the outside graph, with an invented shop ticket that sits under two places. */
import type { EntityPlace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildTaskContextRows } from "./task-context-rows";

const place = (ref: string, title: string, overrides: Partial<EntityPlace> = {}): EntityPlace => ({
  ref,
  kind: "tracker/project",
  noun: "Project",
  title,
  restricted: false,
  ...overrides,
});

const TICKET = "tracker:ticket:shop-205";
const OTHER_TICKET = "tracker:ticket:shop-310";
const TEAM = "tracker:team:web";
const PROJECT = "tracker:project:photos";
const INITIATIVE = "tracker:initiative:peak";

const TICKET_PLACE = place(TICKET, "Serve smaller product photos", {
  kind: "tracker/ticket",
  noun: "Ticket",
  identifier: "SHOP-205",
});
const OTHER_TICKET_PLACE = place(OTHER_TICKET, "Cache the photo sizes", {
  kind: "tracker/ticket",
  noun: "Ticket",
});

describe("buildTaskContextRows", () => {
  it("lists every place above a linked thing by every path, each once, nearest first", () => {
    const { partOf } = buildTaskContextRows({
      entities: [TICKET_PLACE],
      places: [
        TICKET_PLACE,
        place(TEAM, "Web", { noun: "Team" }),
        place(PROJECT, "Pages under a second"),
        place(INITIATIVE, "Nothing breaks at peak", { noun: "Initiative" }),
      ],
      edges: [
        { fromRef: TICKET, toRef: TEAM },
        { fromRef: TICKET, toRef: PROJECT },
        { fromRef: PROJECT, toRef: INITIATIVE },
        { fromRef: TEAM, toRef: INITIATIVE },
      ],
    });

    expect(partOf.map((row) => row.ref)).toEqual([TEAM, PROJECT, INITIATIVE]);
  });

  it("lists a place two linked things share once, at its shortest distance, and keeps a locked place locked", () => {
    const { partOf } = buildTaskContextRows({
      entities: [TICKET_PLACE, OTHER_TICKET_PLACE],
      places: [
        TICKET_PLACE,
        OTHER_TICKET_PLACE,
        place(PROJECT, "Pages under a second"),
        place(TEAM, "Web", { noun: "Team" }),
        { ref: INITIATIVE, kind: "tracker/initiative", noun: "Initiative", restricted: true },
      ],
      edges: [
        { fromRef: TICKET, toRef: PROJECT },
        { fromRef: PROJECT, toRef: INITIATIVE },
        { fromRef: OTHER_TICKET, toRef: TEAM },
        { fromRef: OTHER_TICKET, toRef: INITIATIVE },
      ],
    });

    // The initiative is two steps above the first ticket and one above the second: one step wins.
    expect(partOf.map((row) => [row.ref, row.isLocked])).toEqual([
      [PROJECT, false],
      [INITIATIVE, true],
      [TEAM, false],
    ]);
  });

  it("draws a linked thing as its identifier and title, and a thing nobody can open as a locked row", () => {
    const { linked } = buildTaskContextRows({
      entities: [
        TICKET_PLACE,
        OTHER_TICKET_PLACE,
        { ref: "tracker:ticket:secret", kind: "tracker/ticket", noun: "Ticket", restricted: true },
      ],
      places: [],
      edges: [],
    });

    expect(linked.map((row) => (row.isLocked ? "locked" : row.title))).toEqual([
      "SHOP-205 Serve smaller product photos",
      "Cache the photo sizes",
      "locked",
    ]);
  });

  it("has no rows for a Task that links nothing", () => {
    expect(buildTaskContextRows({ entities: [], places: [], edges: [] })).toEqual({
      partOf: [],
      linked: [],
    });
  });
});
