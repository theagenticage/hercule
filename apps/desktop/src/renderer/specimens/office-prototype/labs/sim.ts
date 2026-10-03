/**
 * PROTOTYPE - the sim lab: a small office of its own where real colleague
 * rigs walk the nav graph. A work room holds fifteen desks, a lounge, a tea
 * trolley and the case board; a door leads into the user's office, with
 * the user's desk, its queue, and the entrance. Open labs/sim.html.
 *
 * - `?liveliness=0|1|2` sets how lively the office is; 1 by default.
 * - `?queue=<n>` sets the number of places in the queue; 3 by default.
 * - `?paths=1` draws the route of every colleague who walks.
 * - `?style=suited` draws the suited characters instead of the beans.
 * - `?ambient=0` turns the colleagues' ambient motion off.
 *
 * The buttons in the corner trigger every sim event and answer the head of
 * the queue. `window.office.sim` is the sim, for the screenshot tool's
 * SHOT_SCRIPT: `office.sim.trigger({ kind: "ask" })`.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  Object3D,
  Vector3,
  Box3,
} from "three";
import type {
  CharacterStyle,
  ColleagueRig,
  OfficeLayout,
  Seat,
  SimEvent,
  Spot,
} from "../engine/contracts";
import { CUTAWAY_HEIGHT } from "../engine/contracts";
import { createNavBuilder } from "../engine/nav";
import { paint, readColor } from "../engine/palette";
import { createSim } from "../engine/sim";
import { buildColleagueRig, setAmbientMotion } from "../kit/character";
import * as props from "../kit/props";
import { buildWorld } from "../world/fixture";
import type { Colleague, World } from "../world/types";
import { mountLab } from "./lab";

const params = new URLSearchParams(location.search);
const liveliness = Math.min(2, Math.max(0, Number(params.get("liveliness") ?? 1))) as 0 | 1 | 2;
const queueLength = Math.max(1, Number(params.get("queue") ?? 3));
const style = (params.get("style") ?? "bean") as CharacterStyle;

/** The lab's half width: the floor runs from -HALF to HALF on both axes. */
const HALF = 10.8;
const WALL_THICKNESS = 0.15;
/** The wall between the work room and the user's office, at this x. */
const PARTITION_X = 2.5;
/** The doors, as [from, to] along their wall. */
const PARTITION_DOOR = [1.4, 2.6] as const;
const ENTRANCE_DOOR = [5.9, 7.1] as const;
const DESK_COLUMNS = [-8.8, -6.4, -4.0, -1.6, 0.8];
const DESK_ROWS = [-7.5, -4.0, -0.5];
const YOUR_DESK = new Vector3(6.5, 0, -7);
const QUEUE_SPACING = 0.85;

/**
 * The lab's colleagues: the scripted visit's pair, Triage, the waiters, a
 * few working and idle ones, Juno asleep, and one colleague the lab sends
 * away so the entrance has someone standing by it.
 */
function buildLabWorld(): World {
  const world = buildWorld("today");
  const names = new Set([
    "Fix 3-D Secure checkout",
    "Migrate ops dashboards",
    "Ship release v2.15",
    "Ada",
    "Backup timeouts",
    "Refactor cart totals",
    "Webhook retry backoff",
    "Tidy checkout CSS",
    "Stripe v14 changelog",
    "Label new issues",
    "Triage",
    "Juno",
    "Cart total rounding",
  ]);
  const colleagues = world.colleagues
    .filter((colleague) => names.has(colleague.name))
    .map((colleague): Colleague =>
      colleague.name === "Cart total rounding" ? { ...colleague, pose: "away" } : colleague,
    );
  return { ...world, colleagues };
}

/** Returns the spot an object's marker stands for, in world space. */
function readSpot(marker: Object3D): Spot {
  marker.updateWorldMatrix(true, false);
  const position = marker.getWorldPosition(new Vector3());
  const forward = marker.getWorldDirection(new Vector3());
  return { position, facing: Math.atan2(forward.x, forward.z), floor: 0 };
}

/** Builds the lab's office: its furniture, the nav graph over it, and the layout the sim reads. */
function buildLabLayout(world: World): {
  readonly layout: OfficeLayout;
  readonly root: Group;
} {
  const root = new Group();
  const nav = createNavBuilder();
  nav.addFloor(0, 0, -HALF, -HALF, HALF, HALF);

  /** Adds a low wall from (minX, minZ) to (maxX, maxZ), drawn at the cut-away height. */
  const addWall = (minX: number, minZ: number, maxX: number, maxZ: number) => {
    const wall = new Mesh(
      new BoxGeometry(maxX - minX, CUTAWAY_HEIGHT, maxZ - minZ),
      paint("room-wall", "matte"),
    );
    wall.position.set((minX + maxX) / 2, CUTAWAY_HEIGHT / 2, (minZ + maxZ) / 2);
    wall.castShadow = true;
    wall.receiveShadow = true;
    root.add(wall);
  };
  const edge = HALF - WALL_THICKNESS;
  const half = WALL_THICKNESS / 2;
  // The outer walls, the entrance in the south one.
  addWall(-HALF, -HALF, HALF, -edge);
  addWall(-HALF, edge, ENTRANCE_DOOR[0], HALF);
  addWall(ENTRANCE_DOOR[1], edge, HALF, HALF);
  addWall(-HALF, -edge, -edge, edge);
  addWall(edge, -edge, HALF, edge);
  nav.block(0, -HALF, -HALF, HALF, -edge);
  nav.block(0, -HALF, edge, HALF, HALF);
  nav.block(0, -HALF, -HALF, -edge, HALF);
  nav.block(0, edge, -HALF, HALF, HALF);
  nav.open(0, ENTRANCE_DOOR[0], edge, ENTRANCE_DOOR[1], HALF);
  // The partition, its door near the middle.
  addWall(PARTITION_X - half, -edge, PARTITION_X + half, PARTITION_DOOR[0]);
  addWall(PARTITION_X - half, PARTITION_DOOR[1], PARTITION_X + half, edge);
  nav.block(0, PARTITION_X - half, -edge, PARTITION_X + half, edge);
  nav.open(0, PARTITION_X - half, PARTITION_DOOR[0], PARTITION_X + half, PARTITION_DOOR[1]);

  /** Places a piece of furniture, blocks it in the nav graph, and returns it. */
  const place = <T extends Object3D>(object: T, x: number, z: number, yaw = 0): T => {
    object.position.set(x, 0, z);
    object.rotation.y = yaw;
    root.add(object);
    object.updateWorldMatrix(true, true);
    nav.blockObject(0, object);
    return object;
  };

  // The work room: desks whose sitters face the camera, so their faces show.
  const desks: Seat[] = [];
  for (const z of DESK_ROWS) {
    for (const x of DESK_COLUMNS) {
      const desk = props.buildDesk();
      place(desk.object, x, z, Math.PI);
      desks.push({ ...readSpot(desk.seatMarker), kind: "desk", roomId: "work", desk });
    }
  }
  const lounge: Seat[] = (
    [
      [-7.4, 4.4, 0],
      [-5.8, 4.4, 0],
      [-7.4, 6.8, Math.PI],
      [-5.8, 6.8, Math.PI],
    ] as const
  ).map(([x, z, yaw]) => {
    const chair = props.buildArmchair();
    place(chair.object, x, z, yaw);
    return { ...readSpot(chair.seatMarker), kind: "armchair", roomId: "work", desk: null };
  });
  const rug = props.buildRug(3.4, 3.6);
  rug.position.set(-6.6, 0, 5.6);
  root.add(rug);
  const trolley = place(props.buildTeaTrolley(), 0.5, 6.6);
  const tea: Spot = {
    position: new Vector3(trolley.position.x, 0, trolley.position.z - 0.8),
    facing: 0,
    floor: 0,
  };
  const board = props.buildCaseBoard(2);
  place(board.object, -4, -edge);
  let pinned = world.proposals.total;
  board.setCards(pinned, world.proposals.burning);

  // The user's office: the desk, the queue in front of it, and the entrance.
  const yourDesk = props.buildYourDesk();
  place(yourDesk.object, YOUR_DESK.x, YOUR_DESK.z);
  yourDesk.setLamp(true);
  const queue: Spot[] = Array.from({ length: queueLength }, (_, index) => ({
    position: new Vector3(YOUR_DESK.x, 0, YOUR_DESK.z + 0.95 + index * QUEUE_SPACING),
    facing: Math.PI,
    floor: 0,
  }));
  place(props.buildCoatStand(), 8.6, 10.1);
  const entrance: Spot = {
    position: new Vector3((ENTRANCE_DOOR[0] + ENTRANCE_DOOR[1]) / 2, 0, edge - 0.5),
    facing: Math.PI,
    floor: 0,
  };

  const homes = new Map<string, Seat>();
  world.colleagues.forEach((colleague, index) => {
    const seat = desks[index];
    if (seat !== undefined) homes.set(colleague.id, seat);
  });

  const layout: OfficeLayout = {
    root,
    rooms: [],
    homes,
    spots: {
      yourDesk: readSpot(yourDesk.seatMarker),
      queue,
      lounge,
      caseBoard: readSpot(board.pinMarker),
      records: null,
      entrance,
      tea,
    },
    nav: nav.build(),
    overview: { target: new Vector3(), distance: 26, azimuth: 35, elevation: 45 },
    bounds: new Box3(new Vector3(-HALF, 0, -HALF), new Vector3(HALF, 3, HALF)),
    sendCapsule() {
      return 2.5;
    },
    pinProposal() {
      pinned++;
      board.setCards(pinned, world.proposals.burning);
    },
    dispose() {},
  };
  return { layout, root };
}

/** Builds the panel of buttons that trigger the sim's events. */
function buildButtons(actions: ReadonlyArray<readonly [string, () => void]>): HTMLElement {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "top:12px",
    "left:12px",
    "display:flex",
    "flex-wrap:wrap",
    "gap:6px",
    "max-width:420px",
    "padding:8px",
    "border-radius:10px",
    "background:var(--raised)",
    "box-shadow:var(--shadow-1)",
    "font:12px/1 system-ui",
  ].join(";");
  for (const [label, act] of actions) {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText =
      "padding:6px 10px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--surface);color:var(--ink);cursor:pointer";
    button.addEventListener("click", act);
    panel.append(button);
  }
  return panel;
}

/** Draws each walker's route as a line just above the floor, while it walks. */
function createRouteLines(parent: Object3D) {
  const material = new LineBasicMaterial({ color: readColor("accent") });
  const lines = new Map<string, { readonly route: ReadonlyArray<Vector3>; readonly line: Line }>();
  return (routes: ReadonlyMap<string, ReadonlyArray<Vector3>>): void => {
    for (const [id, drawn] of lines) {
      if (routes.get(id) === drawn.route) continue;
      parent.remove(drawn.line);
      drawn.line.geometry.dispose();
      lines.delete(id);
    }
    for (const [id, route] of routes) {
      if (lines.has(id)) continue;
      const geometry = new BufferGeometry().setFromPoints(
        route.map((point) => point.clone().setY(point.y + 0.03)),
      );
      const line = new Line(geometry, material);
      parent.add(line);
      lines.set(id, { route, line });
    }
  };
}

/** What the lab puts on `window.office` besides the stage, for SHOT_SCRIPT and the console. */
const exposed: Record<string, unknown> = {};

mountLab((stage) => {
  const world = buildLabWorld();
  const { layout, root } = buildLabLayout(world);
  stage.scene.add(root);
  setAmbientMotion(params.get("ambient") !== "0");
  const rigs = new Map<string, ColleagueRig>();
  for (const colleague of world.colleagues) {
    const rig = buildColleagueRig(colleague, style);
    stage.scene.add(rig.object);
    rigs.set(colleague.id, rig);
  }
  const sim = createSim({ world, layout, rigs, stage });
  sim.setLiveliness(liveliness);
  const trigger = (event: SimEvent) => () => sim.trigger(event);
  document.body.append(
    buildButtons([
      ["Ask", trigger({ kind: "ask" })],
      [
        "Answer head",
        () => {
          const head = sim.listWaitingColleagues()[0];
          if (head !== undefined) sim.answer(head, "Yes");
        },
      ],
      ["Visit (Ada)", trigger({ kind: "visit" })],
      ["Arrive", trigger({ kind: "arrive" })],
      ["Fail", trigger({ kind: "fail" })],
      ["Finish", trigger({ kind: "finish" })],
      ["Event", trigger({ kind: "event" })],
      ["Still", () => sim.setLiveliness(0)],
      ["Calm", () => sim.setLiveliness(1)],
      ["Bustling", () => sim.setLiveliness(2)],
    ]),
  );
  Object.assign(exposed, { sim, layout, world });
  const drawRoutes = params.get("paths") === "1" ? createRouteLines(stage.scene) : null;
  return (frame) => {
    const moving = sim.update(frame);
    drawRoutes?.(sim.readWalkPaths());
    return moving;
  };
}, HALF * 2);
// The lab harness sets `window.office` after the setup has run.
Object.assign(window.office ?? {}, exposed);
