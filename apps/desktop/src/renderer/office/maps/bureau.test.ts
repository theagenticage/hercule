/**
 * Tests the Bureau's Secretariat, built as the Office screen builds it. The
 * tests check that:
 *
 * - every assistant has a home at a writing desk and an armchair, both in the
 *   Secretariat and reached by a path from Your Office, for one assistant
 *   and for five;
 * - the Secretariat stands south of Your Office, as wide as it, and grows
 *   south as assistants are hired;
 * - with no assistants there is no Secretariat, no clock and no lawn;
 * - the longcase clock's hands stand outside the building and turn to the
 *   local time, and turning them changes nothing the building's watch sees.
 *
 * Building the Bureau draws signs on 2D canvases and loads the signs' fonts,
 * and jsdom has neither. A canvas that draws nothing and fonts that are
 * always loaded stand in for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, type Object3D } from "three";
import type { AssistantRow } from "@hercule/client-core";
import { MOSS } from "@hercule/client-core/threads/testing";
import type { BuiltOffice, RoomInfo } from "../engine/contracts";
import { createNavBuilder } from "../engine/nav";
import { StillBuilding } from "../engine/still-building";
import { buildWorld } from "../world/build-world";
import { buildBureau } from "./bureau";

/** Returns the sidebar rows of `count` idle assistants with no session, ids `a0`, `a1`, and so on. */
const buildAssistants = (count: number): AssistantRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `a${index}`,
    name: `a${index}`,
    pose: "idle",
    session: null,
  }));

/** Builds the Bureau for a world of `count` assistants and no threads. */
const buildOffice = (count: number): BuiltOffice =>
  buildBureau({
    world: buildWorld({
      sessions: [],
      projects: [],
      workspaces: [],
      runners: [MOSS],
      assistants: buildAssistants(count),
      localRunnerId: MOSS.id,
    }),
    nav: createNavBuilder(),
  });

/** Returns the Secretariat of `office`. */
const findSecretariat = (office: BuiltOffice): RoomInfo =>
  office.rooms.find((room) => room.kind === "secretariat")!;

beforeEach(() => {
  const blankContext = new Proxy(
    {},
    {
      get: (_context, key) => {
        if (key === "getImageData") return () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) });
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return () => ({ addColorStop: () => {} });
        }
        if (key === "measureText") return () => ({ width: 0 });
        return () => {};
      },
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(blankContext as never);
  vi.spyOn(document, "fonts", "get").mockReturnValue({
    ready: Promise.resolve(),
    check: () => true,
    load: () => Promise.resolve([]),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Secretariat", () => {
  it.each([1, 5])(
    "gives each of %i assistants a writing desk and an armchair it can walk to",
    (count) => {
      const office = buildOffice(count);
      const secretariat = findSecretariat(office);

      expect(secretariat.label).toBe("The Secretariat");
      expect(office.armchairs.size).toBe(count);
      for (const { id } of buildAssistants(count)) {
        const home = office.homes.get(id);
        const armchair = office.armchairs.get(id);
        expect(home).toMatchObject({ kind: "desk", roomId: "secretariat" });
        expect(home?.desk).not.toBeNull();
        expect(armchair).toMatchObject({ kind: "armchair", roomId: "secretariat", desk: null });
        expect(secretariat.bounds.containsPoint(home!.position)).toBe(true);
        expect(secretariat.bounds.containsPoint(armchair!.position)).toBe(true);
        expect(office.nav.findPath(office.spots.yourDesk, home!)).not.toBeNull();
        expect(office.nav.findPath(office.spots.yourDesk, armchair!)).not.toBeNull();
      }
    },
  );

  it("stands south of Your Office and grows south as assistants are hired", () => {
    const findYourOffice = (office: BuiltOffice): RoomInfo =>
      office.rooms.find((room) => room.kind === "your-office")!;
    const [one, five] = [buildOffice(1), buildOffice(5)].map((office) => ({
      secretariat: findSecretariat(office).bounds,
      yourOffice: findYourOffice(office).bounds,
    }));

    for (const { secretariat, yourOffice } of [one!, five!]) {
      expect(secretariat.min.z).toBe(yourOffice.max.z);
      expect(secretariat.min.x).toBe(yourOffice.min.x);
      expect(secretariat.max.x).toBe(yourOffice.max.x);
    }
    expect(five!.secretariat.max.z).toBeGreaterThan(one!.secretariat.max.z);
  });

  it("is not built, nor its clock or the lawns beside it, when there are no assistants", () => {
    const office = buildOffice(0);
    const lawns: Object3D[] = [];
    office.root.traverse((object) => {
      if (object.name === "lawn") lawns.push(object);
    });

    expect(office.rooms.some((room) => room.kind === "secretariat")).toBe(false);
    expect(office.clock).toBeUndefined();
    expect(lawns).toEqual([]);
  });
});

describe("the longcase clock", () => {
  it("turns its hands outside the building, which sees no change", () => {
    const office = buildOffice(1);
    const { hands, setTime } = office.clock!;
    const watch = new StillBuilding(office.root);
    const [hour, minute] = hands.children as Mesh[];

    setTime(new Date(2026, 9, 9, 3, 30));

    let parent = hands.parent;
    while (parent !== null && parent !== office.root) parent = parent.parent;
    expect(parent).toBeNull();
    expect(hour!.castShadow).toBe(false);
    expect(minute!.castShadow).toBe(false);
    // Half past three: the hour hand is past the three, the minute hand points down.
    expect(hour!.rotation.z).toBeCloseTo(-((3.5 / 12) * Math.PI * 2));
    expect(minute!.rotation.z).toBeCloseTo(-Math.PI);
    expect(watch.detectChange()).toBe(false);
  });
});
