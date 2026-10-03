/**
 * The office's furniture and props, in the Crew Bureau's Art
 * Deco. The code in `maps/` imports every builder from here; the pieces live in the
 * files beside this one, by kind.
 *
 * Every builder returns an object whose origin sits on the floor, in the
 * middle of its footprint, with its front facing +z, unless its comment says
 * otherwise. Each piece's geometry is built once and shared by every copy,
 * merged into one mesh per finish, with its colours painted into the vertices.
 */
export { buildDesk, buildYourDesk } from "./desk";
export { buildArmchair, buildBench } from "./seating";
export { buildCabinet } from "./storage";
export { buildCaseBoard, buildNowServing, buildWallClock, type NowServingHandle } from "./walls";
export { buildCoatStand, buildPlant, buildRug, buildTeaTrolley } from "./decor";
export { buildFloorLamp } from "./lights";
