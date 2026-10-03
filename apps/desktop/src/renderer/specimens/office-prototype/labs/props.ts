/**
 * PROTOTYPE - the props lab: every piece of furniture, as the props kit
 * builds it. Open labs/props.html.
 *
 * `?scene=` picks what is shown:
 * - `grid` (the default): every piece on a grid. Pieces that hang on a wall
 *   hang on a short piece of wall.
 * - `desks`: a clerk's desk dark, one lit with a note and a cup, and the user's desk.
 * - `walls`: a wall with the case board, the clock, the Now Serving sign and two sconces.
 * - `lounge`: an armchair corner on a rug, with a standard lamp, for the evening light.
 *
 * Room lights are lit at `?time=evening` and `?time=night`, as the office's
 * director lights them.
 */
import { BoxGeometry, Group, Mesh, type Object3D } from "three";
import { LAMP, type Lamp } from "../engine/contracts";
import { paint } from "../engine/palette";
import type { Stage } from "../engine/stage";
import * as props from "../kit/props";
import { mountLab } from "./lab";

/** Lays `pieces` on a grid `columns` wide, `spacing` apart, centred on the origin. */
function layOutGrid(stage: Stage, pieces: readonly Object3D[], columns: number, spacing: number) {
  const rows = Math.ceil(pieces.length / columns);
  pieces.forEach((piece, index) => {
    piece.position.x += ((index % columns) - (columns - 1) / 2) * spacing;
    piece.position.z += (Math.floor(index / columns) - (rows - 1) / 2) * spacing;
    stage.scene.add(piece);
  });
}

/**
 * Builds a piece of wall `width` wide and 2.6 tall whose face is at z = 0,
 * and hangs `pieces` on it, each at its own [x, y]. Returns the wall.
 */
function buildWall(
  width: number,
  pieces: ReadonlyArray<readonly [Object3D, number, number]>,
): Group {
  const wall = new Group();
  const slab = new Mesh(new BoxGeometry(width, 2.6, 0.12), paint("room-wall", "matte"));
  slab.position.set(0, 1.3, -0.06);
  slab.castShadow = true;
  slab.receiveShadow = true;
  wall.add(slab);
  for (const [piece, x, y] of pieces) {
    piece.position.set(x, y, 0);
    wall.add(piece);
  }
  return wall;
}

/** Builds the case board with seven cards, two of them burning. */
function buildBusyCaseBoard(width: number): Object3D {
  const board = props.buildCaseBoard(width);
  board.setCards(7, 2);
  return board.object;
}

/** Builds the Now Serving sign with three colleagues waiting. */
function buildWaitingSign(): Object3D {
  const sign = props.buildNowServing();
  sign.setNumber(3);
  return sign.object;
}

/**
 * Builds every piece, in the order the grid shows them. The pieces that hang
 * on a wall come first, so they stand in the back row and hide nothing.
 */
function buildEveryPiece(): Object3D[] {
  const desk = props.buildDesk();
  desk.setLamp(true);
  return [
    buildWall(1.2, [
      [props.buildWallClock(), 0, 1.75],
      [props.buildWallSconce(), 0, 0.9],
    ]),
    buildWall(2.6, [[buildBusyCaseBoard(2.4), 0, 0]]),
    buildWall(1.2, [[buildWaitingSign(), 0, 1.4]]),
    props.buildPigeonholes(),
    props.buildBookshelf(1.6),
    desk.object,
    props.buildYourDesk().object,
    props.buildLongTable(3).object,
    props.buildCabinet(),
    props.buildParcels(),
    props.buildArmchair().object,
    props.buildStool().object,
    props.buildBench(3).object,
    props.buildTeaTrolley(),
    props.buildCoatStand(),
    props.buildPlant("small"),
    props.buildPlant("tall"),
    props.buildRug(2, 1.4),
    props.buildFloorLamp().object,
  ];
}

/** Builds the desks scene: a dark clerk's desk, a lit one with a note and a cup, and the user's desk. */
function buildDesks(): Object3D[] {
  const dark = props.buildDesk();
  const lit = props.buildDesk();
  lit.setLamp(true);
  lit.setNote(true);
  lit.setCup(true);
  const yours = props.buildYourDesk();
  yours.setLamp(true);
  yours.setNote(true);
  yours.setCup(true);
  return [dark.object, lit.object, yours.object];
}

/** Builds the walls scene: one long wall with everything that hangs on a wall, and a bookshelf. */
function buildWalls(): Object3D[] {
  const wall = buildWall(8, [
    [props.buildWallSconce(), -3.3, 1.8],
    [buildBusyCaseBoard(2.4), -1.6, 0],
    [props.buildWallClock(), 0.35, 1.75],
    [buildWaitingSign(), 1.6, 1.5],
    [props.buildWallSconce({ light: false }), 3.3, 1.8],
  ]);
  wall.position.z = -1;
  const shelf = props.buildBookshelf(1.2);
  shelf.position.set(3.3, 0, -0.81);
  const desk = props.buildYourDesk();
  desk.object.position.set(1.6, 0, 0.4);
  desk.object.rotation.y = Math.PI;
  return [wall, shelf, desk.object];
}

/** Builds the lounge scene: an armchair corner on a rug, a standard lamp, a plant, and the tea trolley. */
function buildLounge(): Object3D[] {
  const wall = buildWall(6, [[props.buildWallSconce(), 1.8, 1.8]]);
  wall.position.z = -1.6;
  const side = buildWall(4, []);
  side.rotation.y = Math.PI / 2;
  side.position.set(-3, 0, 0.4);
  const rug = props.buildRug(2.6, 1.8);
  const left = props.buildArmchair().object;
  left.position.set(-0.75, 0, -0.3);
  left.rotation.y = 0.5;
  const right = props.buildArmchair().object;
  right.position.set(0.75, 0, -0.3);
  right.rotation.y = -0.5;
  const lamp = props.buildFloorLamp().object;
  lamp.position.set(-1.9, 0, -0.9);
  const palm = props.buildPlant("tall");
  palm.position.set(2.1, 0, -1.05);
  const fern = props.buildPlant("small");
  fern.position.set(-2.4, 0, 0.8);
  const trolley = props.buildTeaTrolley();
  trolley.position.set(0, 0, 0.6);
  const stand = props.buildCoatStand();
  stand.position.set(2.6, 0, 0.6);
  const stool = props.buildStool().object;
  stool.position.set(1.4, 0, 0.9);
  return [wall, side, rug, left, right, lamp, palm, fern, trolley, stand, stool];
}

/** Switches every room light under `root` on or off, as the office's director does. */
function switchLamps(root: Object3D, on: boolean) {
  root.traverse((object) => {
    const lamp = object.userData[LAMP] as Lamp | undefined;
    lamp?.setOn(on);
  });
}

mountLab((stage) => {
  const scene = new URLSearchParams(location.search).get("scene") ?? "grid";
  if (scene === "desks") layOutGrid(stage, buildDesks(), 3, 2.6);
  else if (scene === "walls") for (const piece of buildWalls()) stage.scene.add(piece);
  else if (scene === "lounge") for (const piece of buildLounge()) stage.scene.add(piece);
  else layOutGrid(stage, buildEveryPiece(), 5, 2.8);
  const time = stage.resolveTimeOfDay();
  switchLamps(stage.scene, time === "evening" || time === "night");
  // Frames are drawn on demand, so a sign drawn after its font loads needs one more frame.
  void document.fonts.ready.then(() => stage.requestRender());
}, 16);
