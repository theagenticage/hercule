/**
 * PROTOTYPE - variant A, the Bureau floor. STUB: one plain room per area in a
 * grid, until the bureau layout part replaces it. Keep the exported
 * signature.
 */
import { Box3, BoxGeometry, Group, Mesh, Vector3 } from "three";
import type { BuildOfficeLayout, OfficeLayout, RoomInfo, Seat, Spot } from "../engine/contracts";
import { WALL_HEIGHT } from "../engine/contracts";
import { paint } from "../engine/palette";
import { buildArmchair, buildDesk, buildYourDesk } from "../kit/props";
import type { Area, Colleague } from "../world/types";

const DESK_PITCH_X = 1.9;
const DESK_PITCH_Z = 2.3;
const ROOM_GAP = 1.2;
const COLUMNS = 4;

export const buildBureau: BuildOfficeLayout = ({ world, nav }) => {
  const root = new Group();
  const homes = new Map<string, Seat>();
  const rooms: RoomInfo[] = [];
  const byArea = new Map<Area, Colleague[]>();
  for (const colleague of world.colleagues) {
    byArea.set(colleague.area, [...(byArea.get(colleague.area) ?? []), colleague]);
  }
  let column = 0;
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  for (const [area, colleagues] of byArea) {
    const perRow = Math.min(3, colleagues.length);
    const width = perRow * DESK_PITCH_X + 1;
    const depth = Math.ceil(colleagues.length / 3) * DESK_PITCH_Z + 1;
    const floor = new Mesh(new BoxGeometry(width, 0.08, depth), paint("room-floor", "matte"));
    floor.position.set(x + width / 2, -0.04, z + depth / 2);
    floor.receiveShadow = true;
    const wall = new Mesh(new BoxGeometry(width, WALL_HEIGHT, 0.12), paint("room-wall", "matte"));
    wall.position.set(x + width / 2, WALL_HEIGHT / 2, z);
    wall.castShadow = wall.receiveShadow = true;
    root.add(floor, wall);
    colleagues.forEach((colleague, index) => {
      const desk = buildDesk();
      desk.object.position.set(
        x + 0.5 + DESK_PITCH_X * (index % 3) + DESK_PITCH_X / 2,
        0,
        z + 0.9 + DESK_PITCH_Z * Math.floor(index / 3),
      );
      root.add(desk.object);
      desk.object.updateMatrixWorld(true);
      const position = desk.seatMarker.getWorldPosition(new Vector3());
      homes.set(colleague.id, {
        position,
        facing: Math.PI,
        floor: 0,
        kind: "desk",
        roomId: area,
        desk,
      });
    });
    const bounds = new Box3(new Vector3(x, 0, z), new Vector3(x + width, WALL_HEIGHT, z + depth));
    rooms.push({
      id: area,
      label: area,
      kind: "code",
      floor: 0,
      bounds,
      view: {
        target: bounds.getCenter(new Vector3()).setY(0.5),
        distance: 14,
        azimuth: 35,
        elevation: 42,
      },
      project: null,
    });
    rowDepth = Math.max(rowDepth, depth);
    x += width + ROOM_GAP;
    column += 1;
    if (column === COLUMNS) {
      column = 0;
      x = 0;
      z += rowDepth + ROOM_GAP;
      rowDepth = 0;
    }
  }
  // The user's office and the lounge, in a row south of the rooms.
  const front = z + rowDepth + ROOM_GAP + 1;
  const yourDesk = buildYourDesk();
  yourDesk.object.position.set(2, 0, front);
  root.add(yourDesk.object);
  const queue: Spot[] = Array.from({ length: 4 }, (_, index) => ({
    position: new Vector3(2, 0, front + 0.95 + index * 0.7),
    facing: Math.PI,
    floor: 0,
  }));
  const lounge: Seat[] = [0, 1, 2].map((index) => {
    const chair = buildArmchair();
    chair.object.position.set(7 + index * 1.2, 0, front);
    root.add(chair.object);
    chair.object.updateMatrixWorld(true);
    return {
      position: chair.seatMarker.getWorldPosition(new Vector3()),
      facing: 0,
      floor: 0,
      kind: "armchair",
      roomId: "lounge",
      desk: null,
    };
  });
  const bounds = new Box3().setFromObject(root);
  nav.addFloor(0, 0, bounds.min.x, bounds.min.z, bounds.max.x, bounds.max.z);
  const center = bounds.getCenter(new Vector3()).setY(0);
  const size = bounds.getSize(new Vector3());
  const layout: OfficeLayout = {
    root,
    rooms,
    homes,
    spots: {
      yourDesk: { position: new Vector3(2, 0, front - 0.85), facing: 0, floor: 0 },
      queue,
      lounge,
      caseBoard: null,
      records: null,
    },
    nav: nav.build(),
    overview: {
      target: center,
      distance: Math.max(size.x, size.z) * 2.1,
      azimuth: 35,
      elevation: 45,
    },
    bounds,
    dispose() {},
  };
  return layout;
};
