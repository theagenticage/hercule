/**
 * PROTOTYPE - the camera lab: a small mock office of six rooms, to try how
 * the user looks around and points at things. It has the camera rig, the
 * cut-away walls, the name tags and picking, without the sim or the rest of
 * the director. Open labs/camera.html.
 *
 * - Hovering a colleague highlights it; clicking selects it and the camera
 *   follows it. `0` flies back to the overview and clears the selection.
 * - `?theme=` and `?time=` set the theme and the time of day.
 * - `?tags=all|smart|none` sets the tag mode.
 * - `?walk` sends two colleagues walking, to try following.
 * - `?view=<distance>,<azimuth>,<elevation>,<x>,<y>,<z>` sets the first view.
 *
 * `window.cameraLab` holds the rig, the overlay and the picker, for the
 * screenshot tool's scripts.
 */
import "../../../styles/base-layer.css";
import { Box3, Group, Vector3 } from "three";
import { createCameraRig, placeCamera, readCameraView, type CameraRig } from "../engine/camera-rig";
import type { CameraView, ColleagueRig, RoomInfo } from "../engine/contracts";
import { createOverlay, type Overlay } from "../engine/overlay";
import { createPicker, type Picker } from "../engine/picking";
import { Stage, type TimeOfDay } from "../engine/stage";
import { buildFloor, buildWall } from "../kit/architecture";
import { buildColleagueRig } from "../kit/character";
import { onOfficeCommand, setOffice, type TagMode } from "../office-store";
import { buildWorld } from "../world/fixture";
import type { Area } from "../world/types";

declare global {
  interface Window {
    /** The camera lab's parts, for the screenshot tool's scripts. */
    cameraLab?: {
      readonly rig: CameraRig;
      readonly overlay: Overlay;
      readonly picker: Picker;
      readonly rigs: ReadonlyMap<string, ColleagueRig>;
      readonly rooms: ReadonlyArray<RoomInfo>;
      readonly overview: CameraView;
      select(id: string | null): void;
      /** Returns the camera's current view, rounded, as text. */
      readView(): string;
    };
  }
}

/** One room of the mock office: three across, two deep. */
const ROOM_WIDTH = 7;
const ROOM_DEPTH = 6;
const COLUMNS = 3;
const ROWS = 2;
const ROOM_AREAS: ReadonlyArray<{ readonly area: Area; readonly label: string }> = [
  { area: "checkout", label: "Checkout" },
  { area: "cart", label: "Cart" },
  { area: "webhooks", label: "Webhooks" },
  { area: "infra", label: "Infra" },
  { area: "dashboards", label: "Dashboards" },
  { area: "research", label: "Research" },
];
const DOOR = { at: 0, width: 1.1 };

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "whitehaven";
const container = document.createElement("div");
container.style.cssText = "position:fixed;inset:0";
document.body.style.margin = "0";
document.body.append(container);
const stage = new Stage(container);
stage.setTimeOfDay((params.get("time") as TimeOfDay | null) ?? "auto");

// ---------------------------------------------------------------------------
// The rooms.

const root = new Group();
const west = (-COLUMNS * ROOM_WIDTH) / 2;
const north = (-ROWS * ROOM_DEPTH) / 2;
const rooms: RoomInfo[] = ROOM_AREAS.map(({ area, label }, index) => {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const min = new Vector3(west + column * ROOM_WIDTH, 0, north + row * ROOM_DEPTH);
  const max = new Vector3(min.x + ROOM_WIDTH, 2.6, min.z + ROOM_DEPTH);
  const centre = new Vector3((min.x + max.x) / 2, 0.5, (min.z + max.z) / 2);
  const floor = buildFloor(ROOM_WIDTH, ROOM_DEPTH);
  floor.position.set(centre.x, 0, centre.z);
  root.add(floor);
  return {
    id: area,
    label,
    kind: "code",
    floor: 0,
    bounds: new Box3(min, max),
    view: { target: centre, distance: 14, azimuth: 35, elevation: 42 },
    project: null,
  };
});

/**
 * Adds a wall from (x0, z0) to (x1, z1), running north-south or east-west,
 * with its outward side toward `outward`: an interior wall belongs to the
 * room north or west of it, so it faces south or east; an exterior wall
 * belongs to the room inside and faces out.
 */
function addWall(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  outward: "north" | "south" | "east" | "west",
  roomId: string,
  exterior: boolean,
): void {
  const length = Math.hypot(x1 - x0, z1 - z0);
  const wall = buildWall(length, {
    cutaway: { roomId, exterior },
    windows: exterior,
    ...(exterior ? {} : { doors: [DOOR] }),
  });
  wall.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  wall.rotation.y = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 }[outward];
  root.add(wall);
}

for (let column = 0; column < COLUMNS; column += 1) {
  const x0 = west + column * ROOM_WIDTH;
  const x1 = x0 + ROOM_WIDTH;
  for (let line = 0; line <= ROWS; line += 1) {
    const z = north + line * ROOM_DEPTH;
    const owner = rooms[Math.min(line, ROWS - 1) * COLUMNS + column]!.id;
    const outward = line === 0 ? "north" : "south";
    addWall(x0, z, x1, z, outward, owner, line === 0 || line === ROWS);
  }
}
for (let row = 0; row < ROWS; row += 1) {
  const z0 = north + row * ROOM_DEPTH;
  const z1 = z0 + ROOM_DEPTH;
  for (let line = 0; line <= COLUMNS; line += 1) {
    const x = west + line * ROOM_WIDTH;
    const owner = rooms[row * COLUMNS + Math.min(line, COLUMNS - 1)]!.id;
    const outward = line === 0 ? "west" : "east";
    addWall(x, z0, x, z1, outward, owner, line === 0 || line === COLUMNS);
  }
}

// ---------------------------------------------------------------------------
// The colleagues: every colleague of today's world, standing in a room.

const world = buildWorld("today");
const rigs = new Map<string, ColleagueRig>();
const crowd = new Map<string, number>();
world.colleagues.forEach((colleague, index) => {
  const room =
    rooms.find((candidate) => candidate.id === colleague.area) ?? rooms[index % rooms.length]!;
  const place = crowd.get(room.id) ?? 0;
  crowd.set(room.id, place + 1);
  const rig = buildColleagueRig(colleague, "bean");
  const centre = room.bounds.getCenter(new Vector3());
  rig.object.position.set(
    centre.x - 2.2 + (place % 4) * 1.5,
    0,
    centre.z - 1.3 + Math.floor(place / 4) * 1.6,
  );
  rig.setAction(colleague.pose === "waiting" ? "raise-hand" : "stand");
  rig.setFace(colleague.pose);
  root.add(rig.object);
  rigs.set(colleague.id, rig);
});
stage.scene.add(root);

const bounds = new Box3().setFromObject(root);
stage.setShadowBounds(bounds);
const overview: CameraView = {
  target: new Vector3(0, 0, 0),
  distance: Math.max(COLUMNS * ROOM_WIDTH, ROWS * ROOM_DEPTH) * 2.1,
  azimuth: 35,
  elevation: 45,
};

// ---------------------------------------------------------------------------
// The camera, the tags and the picker, wired as the director wires them.

const canvas = stage.renderer.domElement;
const rig = createCameraRig(stage.camera, canvas, () => stage.requestRender());
rig.setBounds(bounds);
rig.trackWalls(root);
const overlay = createOverlay(container, stage.camera, rigs, rooms);
overlay.setMode((params.get("tags") as TagMode | null) ?? "smart");
const picker = createPicker(canvas, stage.camera, rigs);

const [distance, azimuth, elevation, x, y, z] = (params.get("view") ?? "")
  .split(",")
  .filter((part) => part !== "")
  .map(Number);
const firstView: CameraView =
  distance === undefined
    ? overview
    : {
        target: new Vector3(x ?? 0, y ?? 0, z ?? 0),
        distance,
        azimuth: azimuth ?? 35,
        elevation: elevation ?? 45,
      };
placeCamera(stage.camera, firstView);
rig.flyTo(firstView);

let hoveredId: string | null = null;
let selectedId: string | null = null;

/** Hovers a colleague, as the director does: the rig glows and its tag shows. */
const hover = (id: string | null): void => {
  if (id === hoveredId) return;
  if (hoveredId !== null) rigs.get(hoveredId)?.setHovered(false);
  hoveredId = id;
  if (id !== null) rigs.get(id)?.setHovered(true);
  canvas.style.cursor = id === null ? "" : "pointer";
  overlay.setHovered(id);
  setOffice({ hoveredId: id });
  stage.requestRender();
};

/** Selects a colleague and flies to it, or clears the selection and flies to `fallback`. */
const select = (id: string | null, fallback: CameraView = overview): void => {
  if (selectedId !== null) rigs.get(selectedId)?.setSelected(false);
  selectedId = id;
  const selected = id === null ? undefined : rigs.get(id);
  selected?.setSelected(true);
  overlay.setSelected(id);
  rig.follow(selected === undefined ? null : () => selected.object.getWorldPosition(new Vector3()));
  rig.flyTo(
    selected === undefined
      ? fallback
      : {
          target: selected.object.getWorldPosition(new Vector3()).setY(0.55),
          distance: 7.5,
          azimuth: 28,
          elevation: 30,
        },
  );
  stage.requestRender();
};

let pressedAt: { x: number; y: number } | null = null;
canvas.addEventListener("pointermove", (event) => {
  if (event.buttons === 0) hover(picker.pick(event.clientX, event.clientY));
});
canvas.addEventListener("pointerleave", () => hover(null));
canvas.addEventListener("pointerdown", (event) => {
  pressedAt = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener("pointerup", (event) => {
  if (pressedAt === null) return;
  const travelled = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
  pressedAt = null;
  if (travelled > 5) return;
  const id = picker.pick(event.clientX, event.clientY);
  if (id !== null) select(id);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "0") select(null);
});
onOfficeCommand((command) => {
  if (command.kind === "focus-room") {
    const room = rooms.find((candidate) => candidate.id === command.roomId);
    if (room !== undefined) select(null, room.view);
  } else if (command.kind === "focus-colleague") {
    select(command.colleagueId);
  }
});

// ---------------------------------------------------------------------------
// Two walkers, to try following.

const walkers = params.has("walk") ? [...rigs.values()].slice(0, 2) : [];
stage.onFrame((frame) => {
  walkers.forEach((walker, index) => {
    const angle = frame.time * 0.25 + index * Math.PI;
    walker.object.position.set(Math.cos(angle) * 7, 0, Math.sin(angle) * 3);
    walker.object.rotation.y = -angle;
  });
  const moving = rig.update(frame) || walkers.length > 0;
  overlay.update();
  return moving;
});

window.office = { stage };
window.cameraLab = {
  rig,
  overlay,
  picker,
  rigs,
  rooms,
  overview,
  select: (id) => select(id),
  readView: () => {
    const view = readCameraView(stage.camera);
    if (view === null) return "no view";
    const { target, distance, azimuth, elevation } = view;
    const round = (value: number): string => value.toFixed(2);
    return `target ${round(target.x)},${round(target.y)},${round(target.z)} distance ${round(distance)} azimuth ${round(azimuth)} elevation ${round(elevation)}`;
  },
};
