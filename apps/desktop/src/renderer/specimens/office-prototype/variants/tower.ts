/**
 * PROTOTYPE - variant B, the Tower: the fleet as architecture. A slender
 * Art Deco tower seen in section, like a doll's house with its front cut
 * away. The lobby is on the ground floor, every runner has a storey of its
 * own above it in fleet order, and the assistants live in the penthouse
 * under a stepped crown. A brass lift links every storey.
 *
 * When the user looks at one storey, the storeys above it lift up and fade
 * away, so the camera looks straight into it.
 */
import { Box3, Group, Vector3, type Object3D } from "three";
import type { BuildOfficeLayout, CameraView, OfficeLayout } from "../engine/contracts";
import { COLLEAGUE_ID } from "../engine/picking";
import type { Frame } from "../engine/stage";
import { buildLift, LIFT_FOOTPRINT, WALL_THICKNESS, type LiftHandle } from "../kit/architecture";
import { planTower, type TowerPlan } from "./tower-plan";
import { createStoreyFocus } from "./tower-focus";
import {
  STOREY_HEIGHT,
  buildSpot,
  readFloorHeight,
  type TowerDraft,
  type TowerFrame,
} from "./tower-draft";
import { buildLobby, measureLobbyWidth } from "./tower-lobby";
import { buildPenthouse, buildRoof } from "./tower-penthouse";
import { buildPlaza } from "./tower-shell";
import {
  addSlab,
  buildRunnerStorey,
  measureDeskUnit,
  measureStoreyDepth,
  measureStoreyWidth,
  type DeskUnit,
} from "./tower-storey";

/** The width of the lift core at the west end of every storey. */
const CORE_WIDTH = 2.8;
/** How far the lobby reaches south of the storeys above it. */
const LOBBY_FRONT = 1.4;
/** How much wider than the storeys above the lobby is, at least. */
const PODIUM_OVERHANG = 2.4;
/** The narrowest the storeys may be, so the penthouse has room for its salon and terrace. */
const MIN_STOREY_WIDTH = 12;
/** How far the plaza reaches beyond the lobby on every side. */
const PLAZA_MARGIN = 3;
/** The camera's vertical field of view and the pane's usual shape, to fit the overview. */
const CAMERA_FOV_DEGREES = 28;
const PANE_ASPECT = 1.2;

/** Returns the measurements every storey shares, from the plan and the size of a desk. */
function measureTower(plan: TowerPlan, unit: DeskUnit): TowerFrame {
  const depth = measureStoreyDepth(unit);
  const width = Math.max(
    MIN_STOREY_WIDTH,
    ...plan.storeys.map((storey) => measureStoreyWidth(storey, unit, CORE_WIDTH)),
  );
  const half = WALL_THICKNESS / 2;
  // The lift stands in the middle of the core, its back against the north wall.
  const car = new Vector3(CORE_WIDTH / 2, 0, -depth + half + 0.05 + LIFT_FOOTPRINT / 2);
  const reach = new Vector3(LIFT_FOOTPRINT / 2, 0, LIFT_FOOTPRINT / 2);
  return {
    width,
    depth,
    coreWidth: CORE_WIDTH,
    lobbyWidth: Math.max(measureLobbyWidth(CORE_WIDTH), width + PODIUM_OVERHANG),
    lobbyFront: LOBBY_FRONT,
    salonWidth: Math.min(11, Math.max(8.5, width * 0.55)),
    shaft: new Box3(car.clone().sub(reach), car.clone().add(reach)),
    car,
  };
}

/**
 * Builds the lift through every storey from the lobby to the penthouse, and
 * hands each storey's piece of shaft to that storey's group, so it lifts
 * away with the storey. The machine room on top goes to the roof's group.
 * Blocks the shaft's closed sides in the nav graph and links each landing to
 * the next. Returns the lift.
 */
function addLift(draft: TowerDraft, root: Object3D, floors: number): LiftHandle {
  const { frame, nav } = draft;
  const lift = buildLift(floors, STOREY_HEIGHT);
  lift.object.position.copy(frame.car);
  root.add(lift.object);
  root.updateMatrixWorld(true);
  for (const child of [...lift.object.children]) {
    const floor = child.userData.liftFloor as number | undefined;
    if (floor === undefined) continue;
    const onRoof = child.position.y >= floors * STOREY_HEIGHT - 1e-3;
    draft.storeys[onRoof ? floors : floor]!.attach(child);
  }
  const { min, max } = frame.shaft;
  const side = 0.08;
  for (let floor = 0; floor < floors; floor++) {
    nav.block(floor, min.x, min.z, max.x, min.z + side);
    nav.block(floor, min.x, min.z, min.x + side, max.z);
    nav.block(floor, max.x - side, min.z, max.x, max.z);
    if (floor + 1 < floors) {
      nav.link(
        buildSpot(frame.car.x, frame.car.z, 0, floor),
        buildSpot(frame.car.x, frame.car.z, 0, floor + 1),
      );
    }
  }
  return lift;
}

/**
 * Returns the overview: the whole tower from the south-east, from a little
 * above its middle, far enough back that it fits the pane.
 */
function buildOverview(bounds: Box3, top: number): CameraView {
  const azimuth = 32;
  const width = bounds.max.x - bounds.min.x - 2 * PLAZA_MARGIN;
  const depth = bounds.max.z - bounds.min.z - 2 * PLAZA_MARGIN;
  const radians = (azimuth * Math.PI) / 180;
  const across = width * Math.cos(radians) + depth * Math.sin(radians);
  const halfHeight = Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);
  const halfWidth = halfHeight * PANE_ASPECT;
  const distance = Math.max((top / (2 * halfHeight)) * 1.4, (across / (2 * halfWidth)) * 1.3);
  const target = new Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    top * 0.41,
    (bounds.min.z + bounds.max.z) / 2,
  );
  return { target, distance, azimuth, elevation: 6 };
}

/** Warns about every colleague whose home cannot be reached from the front door. */
function checkHomesReachable(layout: OfficeLayout): void {
  for (const [id, home] of layout.homes) {
    if (layout.nav.findPath(layout.spots.entrance, home) === null) {
      console.warn(
        `Tower: no path from the front door to ${id}'s home on storey ${String(home.floor)}.`,
      );
    }
  }
}

/** Returns the storey a point at height `y` stands on, counted from 0 at the lobby. */
function readStoreyAt(y: number, storeys: number): number {
  return Math.min(storeys - 1, Math.max(0, Math.floor((y + 0.5) / STOREY_HEIGHT)));
}

export const buildTower: BuildOfficeLayout = ({ world, nav }) => {
  const plan = planTower(world);
  const unit = measureDeskUnit();
  const frame = measureTower(plan, unit);
  const root = new Group();
  root.name = "tower";
  // One group per storey from the lobby to the penthouse, and one for the roof.
  const groups = Array.from({ length: plan.penthouseFloor + 2 }, (_, index) => {
    const group = new Group();
    group.name = `storey-${String(index)}`;
    group.position.y = readFloorHeight(index);
    root.add(group);
    return group;
  });
  root.updateMatrixWorld(true);
  const draft: TowerDraft = { frame, storeys: groups, rooms: [], homes: new Map(), nav };

  const lobby = buildLobby(draft, plan, world);
  for (const storey of plan.storeys) {
    // The first storey stands on the podium's roof, which the lobby builds.
    if (storey.floor > 1) {
      addSlab(groups[storey.floor]!, {
        minX: -WALL_THICKNESS / 2,
        maxX: frame.width + WALL_THICKNESS / 2,
        minZ: -frame.depth - WALL_THICKNESS / 2,
        maxZ: 0,
      });
    }
    buildRunnerStorey(draft, storey, unit);
  }
  buildPenthouse(draft, plan, unit);
  const crownTop = buildRoof(draft);
  const lift = addLift(draft, root, plan.penthouseFloor + 1);
  const plaza = buildPlaza(
    frame.lobbyWidth + 2 * PLAZA_MARGIN,
    frame.depth + frame.lobbyFront + 2 * PLAZA_MARGIN,
  );
  plaza.position.set(frame.lobbyWidth / 2, -0.1, (frame.lobbyFront - frame.depth) / 2);
  root.add(plaza);
  root.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(root);
  const top = readFloorHeight(plan.penthouseFloor + 1) + crownTop;
  const focus = createStoreyFocus(groups);
  let proposals = world.proposals.total;
  // The colleagues the tower hid because their storey lifted away.
  const hidden = new Set<Object3D>();
  // The lift's cable hangs from the top of the shaft, so it hides while any storey is away.
  const cable = lift.object.children.filter((child) => child !== lift.car);

  /** Returns the colleagues' rigs: the scene's children that carry a colleague's id. */
  const listRigs = (): Object3D[] =>
    (root.parent?.children ?? []).filter(
      (child) => typeof child.userData[COLLEAGUE_ID] === "string",
    );

  /**
   * Moves the lift's car with whoever rides it, so nobody floats up the
   * shaft. A rider is a rig inside the shaft's footprint between two floors.
   */
  const carryRiders = (frameTime: Frame): boolean => {
    const { min, max } = frame.shaft;
    const rider = listRigs().find((rig) => {
      const { x, y, z } = rig.position;
      const between = Math.abs(y - Math.round(y / STOREY_HEIGHT) * STOREY_HEIGHT) > 0.01;
      return between && x > min.x && x < max.x && z > min.z && z < max.z;
    });
    if (rider !== undefined) lift.car.position.y = rider.position.y;
    return lift.update(frameTime) || rider !== undefined;
  };

  /** Hides the colleagues on storeys that lifted away, and the car when it is on one. */
  const hideLiftedStoreys = (): void => {
    const away = (y: number): boolean => focus.readAmount(readStoreyAt(y, groups.length)) > 0;
    for (const rig of listRigs()) {
      if (away(rig.position.y)) {
        rig.visible = false;
        hidden.add(rig);
      } else if (hidden.delete(rig)) {
        rig.visible = true;
      }
    }
    lift.car.visible = !away(lift.car.position.y);
    const anyAway = groups.some((_, index) => focus.readAmount(index) > 0);
    for (const part of cable) part.visible = !anyAway;
  };

  const spots = lobby.spots;
  const layout: OfficeLayout = {
    root,
    rooms: draft.rooms,
    homes: draft.homes,
    spots,
    nav: nav.build(),
    overview: buildOverview(bounds, top),
    bounds,
    update(frameTime) {
      const lifting = focus.update(frameTime);
      const riding = carryRiders(frameTime);
      hideLiftedStoreys();
      return lifting || riding;
    },
    focusFloor(floor) {
      focus.focus(floor);
    },
    pinProposal() {
      proposals += 1;
      lobby.caseBoard.setCards(proposals, world.proposals.burning);
    },
    dispose() {
      for (const rig of hidden) rig.visible = true;
      hidden.clear();
      focus.dispose();
    },
  };
  checkHomesReachable(layout);
  return layout;
};
