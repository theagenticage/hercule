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
 *   local time, and turning them changes nothing the building's watch sees;
 * - the café stands across the side street east of the building, closed and
 *   dark while nobody sits in it;
 * - a run's sessions sit side by side at one table, and an open café lights
 *   up in the evening;
 * - a crowded café, ten Agents' sessions and a run of six, seats everyone at
 *   a café seat inside its walls, where they can walk to the queue;
 * - a run's sessions in a project room sit at desks pushed together.
 *
 * Building the Bureau draws signs on 2D canvases and loads the signs' fonts,
 * and jsdom has neither. A canvas that draws nothing and fonts that are
 * always loaded stand in for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, Vector3, type Object3D } from "three";
import type { AssistantRow } from "@hercule/client-core";
import type { RunSummary, Session } from "@hercule/contract";
import { MOSS, WEBSHOP_PROJECT, buildSession } from "@hercule/client-core/threads/testing";
import { LAMP, type BuiltOffice, type RoomInfo } from "../engine/contracts";
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

/**
 * Builds the Bureau for a world of `count` assistants and `sessions`, with
 * the runs `liveRuns` live. No project is listed, so every session sits in
 * the café.
 */
const buildOffice = (
  count: number,
  sessions: readonly Session[] = [],
  liveRuns: readonly RunSummary[] = [],
): BuiltOffice =>
  buildBureau({
    world: buildWorld({
      runs: liveRuns,
      endedSince: null,
      resources: [],
      sessions,
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

describe("the café", () => {
  /** Returns the café of `office`. */
  const findCafe = (office: BuiltOffice): RoomInfo =>
    office.rooms.find((room) => room.kind === "cafe")!;
  /** Returns every light the evening switches on inside `room`: its lamps and lit windows. */
  const findLampsIn = (office: BuiltOffice, room: RoomInfo): Object3D[] => {
    office.root.updateMatrixWorld(true);
    const lamps: Object3D[] = [];
    office.root.traverse((object) => {
      if (object.userData[LAMP] === undefined) return;
      const at = object.getWorldPosition(new Vector3());
      // A window's pane stands in its wall, on the room's edge; the box grows to take it in.
      if (room.bounds.clone().expandByScalar(0.2).containsPoint(at)) lamps.push(object);
    });
    return lamps;
  };
  const RUN: RunSummary = {
    id: "run-1",
    workflowId: null,
    workflowName: "Review",
    origin: { kind: "manual", actor: "user" },
    createdAt: "2026-09-10T09:00:00.000Z",
    status: "running",
    startedAt: "2026-09-10T09:00:00.000Z",
    activeStepIds: [],
    awaitedSignalIds: [],
  };
  /** Returns the session of a step of `RUN`, created at `minute`. */
  const buildStep = (id: string, minute: number): Session =>
    buildSession({
      id,
      status: "busy",
      agentId: "a-reviewer",
      runId: RUN.id,
      stepId: id,
      runnerId: MOSS.id,
      createdAt: `2026-09-10T09:0${String(minute)}:00.000Z`,
    });

  it("stands across the side street, closed and dark, while nobody sits in it", () => {
    const office = buildOffice(0);
    const cafe = findCafe(office);
    const lobby = office.rooms.find((room) => room.kind === "lobby")!;

    expect(cafe.label).toBe("Café des Égarés");
    expect(cafe.bounds.min.x).toBeGreaterThan(lobby.bounds.max.x + 2);
    expect(cafe.bounds.max.z).toBe(lobby.bounds.max.z);
    expect([...office.homes.values()].some((seat) => seat.roomId === cafe.id)).toBe(false);
    expect(findLampsIn(office, cafe)).toEqual([]);
  });

  it("seats a run's crew side by side at one table, and lights up while open", () => {
    const thread = buildSession({ id: "s-loose", status: "busy", runnerId: MOSS.id });
    const agent = buildSession({
      id: "s-agent",
      status: "idle",
      agentId: "a-triage",
      runnerId: MOSS.id,
    });
    const office = buildOffice(
      0,
      [thread, agent, buildStep("s-plan", 1), buildStep("s-review", 2)],
      [RUN],
    );
    const cafe = findCafe(office);

    const plan = office.homes.get("s-plan")!.position;
    const review = office.homes.get("s-review")!.position;
    expect(review.z).toBeCloseTo(plan.z);
    expect(review.x - plan.x).toBeCloseTo(0.62);
    // An open café lights up in the evening.
    expect(findLampsIn(office, cafe).length).toBeGreaterThan(0);
  });

  it("seats a crowded café inside its walls, everyone able to walk to the queue", () => {
    const agents = Array.from({ length: 10 }, (_, index) =>
      buildSession({
        id: `s-agent-${String(index)}`,
        status: "busy",
        agentId: "a-triage",
        runnerId: MOSS.id,
      }),
    );
    const steps = Array.from({ length: 6 }, (_, index) =>
      buildStep(`s-step-${String(index)}`, index),
    );
    const office = buildOffice(0, [...agents, ...steps], [RUN]);
    const cafe = findCafe(office);

    for (const { id } of [...agents, ...steps]) {
      const seat = office.homes.get(id)!;
      expect(seat, id).toMatchObject({ kind: "stool", roomId: cafe.id, desk: null });
      expect(cafe.bounds.containsPoint(seat.position), id).toBe(true);
      expect(office.nav.findPath(seat, office.spots.queue[0]!), id).not.toBeNull();
    }
  });
});

describe("a project room", () => {
  it("seats a run's sessions at desks pushed together", () => {
    const run: RunSummary = {
      id: "run-1",
      workflowId: null,
      workflowName: "Review",
      origin: { kind: "manual", actor: "user" },
      createdAt: "2026-09-10T09:00:00.000Z",
      status: "running",
      startedAt: "2026-09-10T09:00:00.000Z",
      activeStepIds: [],
      awaitedSignalIds: [],
    };
    const steps = ["s-plan", "s-build", "s-ship"].map((id, index) =>
      buildSession({
        id,
        status: "busy",
        agentId: "a-reviewer",
        runId: run.id,
        stepId: id,
        projectId: WEBSHOP_PROJECT.id,
        runnerId: MOSS.id,
        createdAt: `2026-09-10T09:0${String(index)}:00.000Z`,
      }),
    );
    const office = buildBureau({
      world: buildWorld({
        runs: [run],
        endedSince: null,
        resources: [],
        sessions: steps,
        projects: [WEBSHOP_PROJECT],
        workspaces: [],
        runners: [MOSS],
        assistants: [],
        localRunnerId: MOSS.id,
      }),
      nav: createNavBuilder(),
    });
    const [plan, build, ship] = steps.map(({ id }) => office.homes.get(id)!.position);

    expect(build!.z).toBeCloseTo(plan!.z);
    expect(ship!.z).toBeCloseTo(plan!.z);
    // A clerk's desk is 1.2 wide. Pushed together, the next chair is 1.28 on; with the walk
    // between two pieces of work, it would be 1.7 on.
    expect(build!.x - plan!.x).toBeLessThan(1.45);
    expect(ship!.x - build!.x).toBeCloseTo(build!.x - plan!.x);
  });
});
