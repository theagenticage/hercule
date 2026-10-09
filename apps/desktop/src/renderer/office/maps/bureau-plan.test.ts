/**
 * Tests the Bureau plan's annex: a room south of one front-row room, as wide
 * as it, entered only through it, with a lawn either side between the front
 * row and the street.
 */
import { describe, expect, it } from "vitest";
import { planFloor, type PlanRequest, type RoomRequest } from "./bureau-plan";

/** Returns a fixed room's request with no tint. */
const requestRoom = (id: string, width: number, depth: number, doorAt?: number): RoomRequest => ({
  id,
  label: id,
  kind: "lounge",
  tint: null,
  width,
  depth,
  ...(doorAt === undefined ? {} : { doorAt }),
});

/** A front row of three rooms and the Lobby, and an annex `annexDepth` deep south of `office`. */
const buildRequest = (annexWidth: number, annexDepth: number): PlanRequest => ({
  code: [requestRoom("code", 20, 6)],
  back: [],
  front: [
    requestRoom("triage", 6, 6),
    requestRoom("lounge", 6, 6),
    requestRoom("office", 6, 6),
    requestRoom("lobby", 6, 6),
  ],
  annex: { room: requestRoom("annex", annexWidth, annexDepth, 0.7), southOf: "office" },
});

describe("planFloor's annex", () => {
  it("stands south of its room, as wide as it, from the front row to the street", () => {
    const plan = planFloor(buildRequest(4, 5));
    const office = plan.rooms.find((room) => room.id === "office")!;
    const annex = plan.rooms.find((room) => room.id === "annex")!;
    expect(annex.rect).toEqual({
      minX: office.rect.minX,
      minZ: office.rect.maxZ,
      maxX: office.rect.maxX,
      maxZ: plan.depth,
    });
    expect(plan.depth).toBe(office.rect.maxZ + 5);
  });

  it("widens its room when it needs more width than the room", () => {
    const narrow = planFloor(buildRequest(4, 5));
    const wide = planFloor(buildRequest(12, 5));
    const measureWidth = (plan: typeof narrow, id: string): number => {
      const { rect } = plan.rooms.find((room) => room.id === id)!;
      return rect.maxX - rect.minX;
    };
    expect(measureWidth(wide, "office")).toBeGreaterThan(measureWidth(narrow, "office"));
    expect(measureWidth(wide, "annex")).toBe(measureWidth(wide, "office"));
  });

  it("grows the building south and never wider", () => {
    const shallow = planFloor(buildRequest(4, 5));
    const deep = planFloor(buildRequest(4, 15));
    expect(deep.width).toBe(shallow.width);
    expect(deep.depth).toBe(shallow.depth + 10);
  });

  it("opens only into its room, at its door", () => {
    const plan = planFloor(buildRequest(4, 5));
    const annex = plan.rooms.find((room) => room.id === "annex")!;
    const walls = plan.walls.filter((wall) => wall.ownerId === "annex" || wall.otherId === "annex");
    const doors = walls.flatMap((wall) => wall.doors.map((door) => ({ wall, door })));
    expect(doors).toHaveLength(1);
    expect(doors[0]!.wall).toMatchObject({ axis: "x", line: annex.rect.minZ, ownerId: "office" });
    expect(doors[0]!.door.at).toBeCloseTo(
      annex.rect.minX + (annex.rect.maxX - annex.rect.minX) * 0.7,
    );
  });

  it("leaves a lawn either side of it, and the front door in the Lobby's south wall", () => {
    const plan = planFloor(buildRequest(4, 5));
    const annex = plan.rooms.find((room) => room.id === "annex")!;
    const lobby = plan.rooms.find((room) => room.id === "lobby")!;
    expect(plan.lawns).toEqual([
      { minX: 0, minZ: annex.rect.minZ, maxX: annex.rect.minX, maxZ: plan.depth },
      { minX: annex.rect.maxX, minZ: annex.rect.minZ, maxX: plan.width, maxZ: plan.depth },
    ]);
    expect(plan.frontDoor.line).toBe(lobby.rect.maxZ);
    const frontWall = plan.walls.find(
      (wall) => wall.ownerId === "lobby" && wall.axis === "x" && wall.line === lobby.rect.maxZ,
    );
    expect(frontWall?.doors).toEqual([{ at: plan.frontDoor.at, width: plan.frontDoor.width }]);
  });

  it("fails when the annex names a room that is not in the front row", () => {
    const request = buildRequest(4, 5);
    expect(() =>
      planFloor({ ...request, annex: { room: request.annex!.room, southOf: "code" } }),
    ).toThrow(/front row has no room with that id/);
  });

  it("leaves no lawn when there is no annex", () => {
    const plan = planFloor({ ...buildRequest(4, 5), annex: null });
    const lobby = plan.rooms.find((room) => room.id === "lobby")!;
    expect(plan.lawns).toEqual([]);
    expect(plan.depth).toBe(lobby.rect.maxZ);
  });
});
