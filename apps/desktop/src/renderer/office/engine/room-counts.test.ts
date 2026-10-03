/**
 * Tests the counts a room's label and the Rooms directory share. The tests
 * check that:
 *
 * - a project room counts the colleagues seated in it, and those of them who wait;
 * - the Lounge counts the idle colleagues, wherever they are seated;
 * - Your Office counts the waiting colleagues, a request counting as waiting;
 * - a room with no seats counts nought.
 */
import { describe, expect, it } from "vitest";
import { Box3, Vector3 } from "three";
import type { ColleagueState, RoomInfo, RoomKind, Seat } from "./contracts";
import { countColleaguesByRoom } from "./room-counts";
import type { Pose } from "@hercule/client-core";

/** Returns a room of `kind` with id `id`; its place does not matter to the counts. */
const buildRoom = (id: string, kind: RoomKind): RoomInfo => ({
  id,
  label: id,
  kind,
  floor: 0,
  bounds: new Box3(),
  view: { target: new Vector3(), distance: 10, azimuth: 0, elevation: 45 },
  tint: null,
});

/** Returns a desk seat in the room with id `roomId`. */
const buildSeat = (roomId: string): Seat => ({
  position: new Vector3(),
  facing: 0,
  floor: 0,
  kind: "desk",
  roomId,
  desk: null,
});

/** Returns a state in `pose`, with no request unless `asks` is true. */
const buildState = (pose: Pose, asks = false): ColleagueState => ({
  pose,
  stateLabel: pose,
  request: asks
    ? {
        kind: "command",
        short: "Run git push?",
        prompt: "git push",
        answers: ["Allow", "Deny"],
        waitingMinutes: 1,
      }
    : null,
});

const ROOMS = [
  buildRoom("webshop", "project"),
  buildRoom("ops", "project"),
  buildRoom("lounge", "lounge"),
  buildRoom("your-office", "your-office"),
  buildRoom("lobby", "lobby"),
];

const HOMES = new Map([
  ["a", buildSeat("webshop")],
  ["b", buildSeat("webshop")],
  ["c", buildSeat("webshop")],
  ["d", buildSeat("ops")],
]);

const STATES = new Map([
  ["a", buildState("working")],
  ["b", buildState("waiting", true)],
  ["c", buildState("idle")],
  ["d", buildState("working", true)],
]);

describe("countColleaguesByRoom", () => {
  const counts = countColleaguesByRoom(ROOMS, HOMES, STATES);

  it("counts a project room's seated colleagues, and those of them who wait", () => {
    expect(counts.get("webshop")).toEqual({ colleagues: 3, waiting: 1 });
    expect(counts.get("ops")).toEqual({ colleagues: 1, waiting: 1 });
  });

  it("counts the idle colleagues in the Lounge", () => {
    expect(counts.get("lounge")).toEqual({ colleagues: 1, waiting: 0 });
  });

  it("counts the waiting colleagues in Your Office, a request counting as waiting", () => {
    expect(counts.get("your-office")).toEqual({ colleagues: 2, waiting: 2 });
  });

  it("counts nought in a room with no seats", () => {
    expect(counts.get("lobby")).toEqual({ colleagues: 0, waiting: 0 });
  });
});
