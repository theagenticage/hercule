/**
 * Tests the groups of the room directory. The tests check that:
 *
 * - the project rooms come under "Projects", then every other room under
 *   "The Office", each in the layout's order;
 * - a group with no rooms is left out.
 */
import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import type { RoomInfo, RoomKind } from "../engine/contracts";
import { groupRooms } from "./room-directory";

/** Returns a room of `kind` with id `id`; its place does not matter to the groups. */
const buildRoom = (id: string, kind: RoomKind): RoomInfo => ({
  id,
  label: id,
  kind,
  floor: 0,
  bounds: new Box3(),
  view: { target: new Vector3(), distance: 10, azimuth: 0, elevation: 45 },
  tint: null,
});

/** Returns each group's heading and the ids of its rooms. */
const listGroups = (rooms: ReadonlyArray<RoomInfo>) =>
  groupRooms(rooms).map((group) => [group.heading, group.rooms.map((room) => room.id)]);

describe("groupRooms", () => {
  it("puts the project rooms under Projects, then the other rooms under The Office", () => {
    const rooms = [
      buildRoom("lobby", "lobby"),
      buildRoom("webshop", "project"),
      buildRoom("lounge", "lounge"),
      buildRoom("ops", "project"),
    ];

    expect(listGroups(rooms)).toEqual([
      ["Projects", ["webshop", "ops"]],
      ["The Office", ["lobby", "lounge"]],
    ]);
  });

  it("leaves out a group with no rooms", () => {
    expect(listGroups([buildRoom("lounge", "lounge")])).toEqual([["The Office", ["lounge"]]]);
  });
});
