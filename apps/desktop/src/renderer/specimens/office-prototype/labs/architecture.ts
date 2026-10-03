/**
 * PROTOTYPE - the architecture lab: a small room with four walls, a door,
 * windows and a cut wall, a floor with a project inlay, a column, plaques, a
 * wordmark, a three-storey lift, a tube with capsules, and the outdoors.
 * Open labs/architecture.html.
 *
 * `?cut=<0..1>` lowers the south wall: 0 is full height, 1 (the default) is
 * down to the dado rail.
 */
import { Group, Vector3, type Object3D } from "three";
import { CUTAWAY, LAMP, type Cutaway, type Lamp } from "../engine/contracts";
import {
  WALL_THICKNESS,
  buildColumn,
  buildFloor,
  buildLamppost,
  buildLawn,
  buildLift,
  buildPath,
  buildPlaque,
  buildTree,
  buildTubes,
  buildWall,
  buildWordmark,
} from "../kit/architecture";
import { mountLab } from "./lab";

/** The room's floor: its width (x) and depth (z). */
const ROOM_WIDTH = 6;
const ROOM_DEPTH = 5;

/** Adds `object` to `parent` at (x, z), turned `yaw` about y, and returns it. */
function place(parent: Object3D, object: Object3D, x: number, z: number, yaw = 0, y = 0) {
  object.position.set(x, y, z);
  object.rotation.y = yaw;
  parent.add(object);
  return object;
}

/** Builds the room: the floor, four walls (the south one cut), a column and two plaques. */
function buildRoom(parent: Object3D, cut: number): void {
  place(parent, buildFloor(ROOM_WIDTH, ROOM_DEPTH, { inlay: "proj-webshop" }), 0, 0);
  // Each wall runs half a wall's thickness past each corner, so the corners close.
  const long = ROOM_WIDTH + WALL_THICKNESS;
  const short = ROOM_DEPTH + WALL_THICKNESS;
  place(parent, buildWall(long, { windows: true }), 0, -ROOM_DEPTH / 2, Math.PI);
  place(
    parent,
    buildWall(short, { doors: [{ at: -0.8, width: 0.9 }] }),
    ROOM_WIDTH / 2,
    0,
    Math.PI / 2,
  );
  place(parent, buildWall(short, { windows: true }), -ROOM_WIDTH / 2, 0, -Math.PI / 2);
  const south = place(
    parent,
    buildWall(long, {
      windows: true,
      doors: [{ at: 1.6, width: 0.9 }],
      cutaway: { roomId: "lab", exterior: true },
    }),
    0,
    ROOM_DEPTH / 2,
  );
  (south.userData[CUTAWAY] as Cutaway).setCut(cut);
  place(parent, buildColumn(), -ROOM_WIDTH / 2 + 0.6, -ROOM_DEPTH / 2 + 0.6);
  const face = -ROOM_DEPTH / 2 + WALL_THICKNESS / 2;
  place(parent, buildPlaque("Webshop", { hue: "teal" }), -0.85, face, 0, 1.45);
  place(parent, buildPlaque("Payments", { hue: "orchid" }), 0.85, face, 0, 1.45);
  place(parent, buildPlaque("Front desk"), 0.85, face, 0, 1.2);
}

/** Builds the garden south of the room: lawns, a path from the door, trees, lampposts, a wordmark. */
function buildGarden(parent: Object3D): void {
  place(parent, buildPath(1.2, 7.4), 1.6, 6.3);
  place(parent, buildLawn(6.4, 6.8), -2.3, 6.6);
  place(parent, buildLawn(3.7, 6.8), 4.15, 6.6);
  place(parent, buildTree(), -4.4, 4.4);
  place(parent, buildTree(), -0.1, 9.5);
  place(parent, buildTree(), -4.3, 8.9);
  place(parent, buildTree(), 4.9, 8.4);
  place(parent, buildLamppost(), 0.72, 4.2);
  place(parent, buildLamppost(), 2.48, 7.8);
  place(parent, buildWordmark("Hercule", 0.55), -2.4, 5.6);
}

/** Switches every lamp and window under `root` on or off, as the office's director does. */
function switchLamps(root: Object3D, on: boolean): void {
  root.traverse((object) => {
    (object.userData[LAMP] as Lamp | undefined)?.setOn(on);
  });
}

mountLab((stage) => {
  const params = new URLSearchParams(location.search);
  const cut = Number(params.get("cut") ?? "1");
  const root = new Group();
  // The lab's own floor has its top at y = 0; everything here stands just above it.
  root.position.y = 0.01;
  stage.scene.add(root);
  buildRoom(root, cut);
  buildGarden(root);
  const lift = buildLift(3, 2.9);
  place(root, lift.object, 5.4, -1.4);
  const tubes = buildTubes(
    [
      new Vector3(-8, 0, 3),
      new Vector3(-8, 2.3, 3),
      new Vector3(-8, 2.3, -4),
      new Vector3(-1, 2.3, -4),
      new Vector3(-1, 3.1, -4),
    ],
    { posts: true },
  );
  root.add(tubes.object);
  const time = stage.resolveTimeOfDay();
  switchLamps(root, time === "evening" || time === "night");

  let floor = 0;
  let nextCall = 1.5;
  let nextSend = 0.2;
  return (frame) => {
    if (frame.time > nextCall) {
      floor = (floor + 1) % 3;
      lift.callTo(floor);
      nextCall = frame.time + 4.5;
    }
    if (frame.time > nextSend) {
      tubes.send();
      nextSend = frame.time + 2.5;
    }
    lift.update(frame);
    tubes.update(frame);
    return true;
  };
}, 28);
