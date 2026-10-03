/**
 * PROTOTYPE - variant C, the Campus: the office as a campus of pavilions,
 * one per machine, round a paved plaza.
 *
 * - The headquarters closes the plaza's north end: the user's office with
 *   its queue, the Case Room where Triage sits, the lounge and the records.
 * - The pavilions stand in two rows down the plaza's long sides, doors on
 *   the plaza, the local machine's first. Each holds its runner's sessions,
 *   by code area, and grows with the runner's slots.
 * - The conservatory closes the south end, where the assistants live.
 * - Pneumatic tubes run behind each row of pavilions to the Case Room.
 *
 * This module plans where everything goes, builds the parts from the
 * `campus-*` modules, and fills in the layout's contract: homes, spots,
 * rooms, the nav graph and the views.
 */
import { Box3, Group, Vector3 } from "three";
import type {
  BuildOfficeLayout,
  NavGraph,
  OfficeLayout,
  RoomInfo,
  Seat,
  Spot,
} from "../engine/contracts";
import type { Colleague, RunnerInfo } from "../world/types";
import { buildConservatory } from "./campus-conservatory";
import { buildGrounds, PLINTH_REACH, TRUNK_OFFSET, type GroundsPavilion } from "./campus-grounds";
import { buildHeadquarters } from "./campus-hq";
import { buildRoomInfo, createNavPlan, frameRect, type Rect } from "./campus-kit";
import {
  buildPavilion,
  measureDesk,
  planPavilion,
  type Pavilion,
  type PavilionPlan,
} from "./campus-pavilion";

/** The paved forecourt between the headquarters' facade and the first pavilions. */
const FORECOURT = 3.0;
/** The lawn strip between the plaza and the pavilions' doors, which the door paths cross. */
const DOOR_STRIP = 3.0;
/** The lawn between two pavilions of a row. */
const ROW_GAP = 2.6;
/** The shortest plaza, so even a fleet of one has a garden. */
const MIN_ROW_SPAN = 16;
/** The paving south of the last pavilion, before the conservatory's path. */
const PLAZA_TAIL = 1.2;
/** The lawn between the plaza and the conservatory. */
const CONSERVATORY_GAP = 3.0;
/** The lawn round the outermost buildings and tubes, to the terrace at the lawn's edge. */
const SITE_MARGIN = 3.0;

/** Returns the smallest rectangle that holds every one of `rects`. */
function joinRects(rects: ReadonlyArray<Rect>): Rect {
  return {
    minX: Math.min(...rects.map((rect) => rect.minX)),
    minZ: Math.min(...rects.map((rect) => rect.minZ)),
    maxX: Math.max(...rects.map((rect) => rect.maxX)),
    maxZ: Math.max(...rects.map((rect) => rect.maxZ)),
  };
}

/** Returns a row's length along z: its pavilions' depths and the gaps between them. */
function measureRow(row: ReadonlyArray<PavilionPlan>): number {
  return row.reduce((sum, plan) => sum + plan.depth, 0) + Math.max(0, row.length - 1) * ROW_GAP;
}

/**
 * Splits the runners into the plaza's two rows: the local machine first, in
 * the west row, then each next runner in whichever row is shorter.
 */
function assignRows(plans: ReadonlyArray<PavilionPlan>): {
  readonly west: PavilionPlan[];
  readonly east: PavilionPlan[];
} {
  const ordered = [...plans].sort((a, b) => Number(b.runner.local) - Number(a.runner.local));
  const west: PavilionPlan[] = [];
  const east: PavilionPlan[] = [];
  for (const plan of ordered) {
    (measureRow(west) <= measureRow(east) ? west : east).push(plan);
  }
  return { west, east };
}

/** Returns a spot one step outside a door, facing the door. */
function buildDoorstep(door: Vector3, outward: Vector3): Spot {
  const position = door.clone().addScaledVector(outward, 1.0);
  return { position, facing: Math.atan2(-outward.x, -outward.z), floor: 0 };
}

/**
 * Checks that every home and spot can be walked to: each home from the
 * doorstep of its own building, and each doorstep from the entrance. That
 * covers every route through the plaza while keeping each search short.
 * Logs one warning that lists what cannot be reached.
 */
function checkReachability(
  nav: NavGraph,
  checks: ReadonlyArray<{ readonly label: string; readonly from: Spot; readonly to: Spot }>,
): void {
  const started = performance.now();
  const failures = checks.filter(({ from, to }) => nav.findPath(from, to) === null);
  const milliseconds = Math.round(performance.now() - started);
  if (failures.length > 0) {
    console.warn(
      `Campus: ${failures.length} of ${checks.length} places cannot be reached on foot (${milliseconds} ms): ` +
        failures.map(({ label }) => label).join(", "),
    );
  } else {
    console.info(
      `Campus: all ${checks.length} places can be reached on foot (${milliseconds} ms).`,
    );
  }
}

export const buildCampus: BuildOfficeLayout = (context) => {
  const { world } = context;
  const root = new Group();
  root.name = "campus";
  const nav = createNavPlan();

  // Who goes where: sessions to their runner's pavilion, Triage to the
  // headquarters, the assistants to the conservatory.
  const sessionsByRunner = new Map<string, Colleague[]>();
  const triage: Colleague[] = [];
  const assistants: Colleague[] = [];
  for (const colleague of world.colleagues) {
    if (colleague.role === "triage") triage.push(colleague);
    else if (colleague.role === "assistant") assistants.push(colleague);
    else if (colleague.runnerId !== null) {
      const list = sessionsByRunner.get(colleague.runnerId);
      if (list === undefined) sessionsByRunner.set(colleague.runnerId, [colleague]);
      else list.push(colleague);
    }
  }
  const desk = measureDesk();
  const plans = world.runners.map((runner: RunnerInfo) =>
    planPavilion(runner, sessionsByRunner.get(runner.id) ?? [], desk),
  );
  const rows = assignRows(plans);
  const rowSpan = Math.max(MIN_ROW_SPAN, measureRow(rows.west), measureRow(rows.east));
  const plazaWidth = Math.min(30, Math.max(14, Math.round(rowSpan * 0.42)));
  const plazaSouth = rowSpan + PLAZA_TAIL;
  const plaza: Rect = {
    minX: -plazaWidth / 2,
    maxX: plazaWidth / 2,
    minZ: -FORECOURT,
    maxZ: plazaSouth,
  };

  // The buildings.
  const pavilions: Array<{ readonly built: Pavilion; readonly outward: Vector3 }> = [];
  for (const [row, doorSide] of [
    [rows.west, "east"],
    [rows.east, "west"],
  ] as const) {
    const doorX = doorSide === "east" ? plaza.minX - DOOR_STRIP : plaza.maxX + DOOR_STRIP;
    let z = (rowSpan - measureRow(row)) / 2;
    for (const plan of row) {
      const built = buildPavilion(plan, { doorSide, doorX, minZ: z }, nav);
      root.add(built.object);
      pavilions.push({ built, outward: new Vector3(doorSide === "east" ? 1 : -1, 0, 0) });
      z += plan.depth + ROW_GAP;
    }
  }
  const headquarters = buildHeadquarters(-FORECOURT, triage, nav);
  root.add(headquarters.object);
  const conservatory = buildConservatory(plazaSouth + CONSERVATORY_GAP, assistants, nav);
  root.add(conservatory.object);

  // The grounds, round everything built.
  const toGrounds = (pavilion: Pavilion): GroundsPavilion => ({
    rect: pavilion.rect,
    door: pavilion.door,
  });
  const westBuilt = pavilions
    .filter(({ outward }) => outward.x > 0)
    .map(({ built }) => toGrounds(built));
  const eastBuilt = pavilions
    .filter(({ outward }) => outward.x < 0)
    .map(({ built }) => toGrounds(built));
  const buildingsRect = joinRects([
    headquarters.rect,
    conservatory.rect,
    plaza,
    ...pavilions.map(({ built }) => built.rect),
  ]);
  // The tubes run behind the rows, so the site reaches past them.
  const site: Rect = {
    minX: buildingsRect.minX - TRUNK_OFFSET - SITE_MARGIN,
    maxX: buildingsRect.maxX + TRUNK_OFFSET + SITE_MARGIN,
    minZ: buildingsRect.minZ - SITE_MARGIN,
    maxZ: buildingsRect.maxZ + SITE_MARGIN,
  };
  const grounds = buildGrounds(
    {
      plaza,
      gardenNorth: 1.0,
      site,
      west: westBuilt,
      east: eastBuilt,
      headquarters: headquarters.rect,
      conservatory: conservatory.rect,
      conservatoryDoor: conservatory.door,
      receiver: headquarters.receiver,
    },
    nav,
  );
  root.add(grounds.object);
  root.updateMatrixWorld(true);

  // The homes: every colleague of the world has exactly one.
  const homes = new Map<string, Seat>();
  for (const { built } of pavilions) for (const [id, seat] of built.homes) homes.set(id, seat);
  for (const [id, seat] of headquarters.homes) homes.set(id, seat);
  for (const [id, seat] of conservatory.homes) homes.set(id, seat);
  const homeless = world.colleagues.filter((colleague) => !homes.has(colleague.id));
  if (homeless.length > 0) {
    console.warn(
      `Campus: ${homeless.length} colleagues have no seat, because their runner is not in the world: ` +
        homeless.map((colleague) => colleague.id).join(", "),
    );
  }

  // The nav graph: one floor over the whole site, then the obstacles, then the doors.
  context.nav.addFloor(0, 0, site.minX, site.minZ, site.maxX, site.maxZ);
  nav.applyTo(context.nav);
  const graph = context.nav.build();

  const spots = {
    yourDesk: headquarters.yourDesk,
    queue: headquarters.queue,
    lounge: headquarters.lounge,
    caseBoard: headquarters.caseBoardSpot,
    records: headquarters.records,
    entrance: headquarters.entrance,
    tea: headquarters.tea,
  };
  const checks: Array<{ label: string; from: Spot; to: Spot }> = [];
  const conservatoryStep = buildDoorstep(conservatory.door, new Vector3(0, 0, -1));
  checks.push({ label: "conservatory door", from: spots.entrance, to: conservatoryStep });
  for (const colleague of assistants) {
    const home = homes.get(colleague.id);
    if (home !== undefined) checks.push({ label: colleague.id, from: conservatoryStep, to: home });
  }
  for (const { built, outward } of pavilions) {
    const step = buildDoorstep(built.door, outward);
    checks.push({
      label: `${built.rooms[0]?.id ?? "pavilion"} door`,
      from: spots.entrance,
      to: step,
    });
    for (const [id, seat] of built.homes) checks.push({ label: id, from: step, to: seat });
  }
  for (const [id, seat] of headquarters.homes)
    checks.push({ label: id, from: spots.entrance, to: seat });
  const hqSpots: Array<readonly [string, Spot]> = [
    ["your desk", spots.yourDesk],
    ["queue head", spots.queue[0]!],
    ["queue tail", spots.queue[spots.queue.length - 1]!],
    ["case board", spots.caseBoard],
    ["records", spots.records],
    ["tea", spots.tea],
    ...spots.lounge.map((seat, index) => [`lounge seat ${index + 1}`, seat] as const),
  ];
  for (const [label, spot] of hqSpots) checks.push({ label, from: spots.entrance, to: spot });
  checkReachability(graph, checks);

  const rooms: RoomInfo[] = [
    buildRoomInfo("plaza", "Plaza", "hall", plaza, null),
    ...headquarters.rooms,
    ...pavilions.flatMap(({ built }) => built.rooms),
    conservatory.room,
  ];

  // The overview frames the whole plinth, so the campus shows as a diorama with a clean edge.
  const overview = frameRect(
    {
      minX: site.minX - PLINTH_REACH,
      maxX: site.maxX + PLINTH_REACH,
      minZ: site.minZ - PLINTH_REACH,
      maxZ: site.maxZ + PLINTH_REACH,
    },
    1.02,
  );

  headquarters.caseBoard.setCards(world.proposals.total, world.proposals.burning);
  headquarters.nowServing.setNumber(
    world.colleagues.filter((colleague) => colleague.pose === "waiting").length,
  );
  let pinned = world.proposals.total;
  let nextTrunk = 0;

  const layout: OfficeLayout = {
    root,
    rooms,
    homes,
    spots,
    nav: graph,
    overview,
    bounds: new Box3().setFromObject(root),
    update(frame) {
      let moving = false;
      for (const trunk of grounds.trunks) moving = trunk.update(frame) || moving;
      return moving;
    },
    sendCapsule() {
      const trunk = grounds.trunks[nextTrunk % Math.max(1, grounds.trunks.length)];
      if (trunk === undefined) return 0;
      nextTrunk += 1;
      trunk.send();
      return trunk.rideSeconds;
    },
    // A capsule sent while the tubes are hidden still rides; nobody sees it.
    setFlow(on) {
      for (const tube of grounds.tubes) tube.visible = on;
    },
    pinProposal() {
      pinned += 1;
      headquarters.caseBoard.setCards(pinned, world.proposals.burning);
    },
    // The office frees the geometry. Every material comes from the palette or
    // the kit, which share them across builds, so the campus has nothing more to free.
    dispose() {},
  };
  return layout;
};
