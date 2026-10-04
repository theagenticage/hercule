/**
 * Where the office keeps things: the filing cabinet.
 */
import type { Object3D } from "three";
import {
  PartList,
  buildBlock,
  buildPropGroup,
  buildSheet,
  memoize,
  type PartSink,
  type Surface,
} from "./shared";

// ---------------------------------------------------------------------------
// The filing cabinet.

const CABINET_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  drawer: { token: "room-wood", finish: "lacquer", shift: { dl: 0.05, dc: -0.01 }, shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
  paper: { token: "room-paper", finish: "paper", shadow: false },
} as const satisfies Record<string, Surface>;

/** Adds a brass card holder with its paper card, and a brass pull under it, centred at the origin. */
function addDrawerFittings(parts: PartSink<"brass" | "paper">, width: number): void {
  parts.add("brass", buildBlock(width, width * 0.5, 0.008, 0.003, 1), { y: 0.02 });
  parts.add("paper", buildSheet(width * 0.82, width * 0.36, 0.004), { y: 0.027, z: 0.005 });
  parts.add("brass", buildBlock(width * 1.05, 0.022, 0.024, 0.01, 1), { y: -0.03, z: 0.006 });
}

const readCabinetGeometry = memoize(() => {
  const parts = new PartList(CABINET_SURFACES);
  parts.add("wood", buildBlock(0.46, 0.06, 0.54, 0.012, 1), { z: -0.01 });
  parts.add("wood", buildBlock(0.5, 1.18, 0.58, 0.025, 2), { y: 0.06, z: -0.01 });
  // A stepped cornice.
  parts.add("wood", buildBlock(0.52, 0.03, 0.6, 0.012, 1), { y: 1.24 });
  parts.add("wood", buildBlock(0.47, 0.03, 0.55, 0.012, 1), { y: 1.27, z: -0.01 });
  // Four drawers, each with a card holder and a pull.
  for (let drawer = 0; drawer < 4; drawer++) {
    const y = 0.1 + drawer * 0.285;
    parts.add("drawer", buildBlock(0.43, 0.255, 0.026, 0.012, 2), { y, z: 0.29 });
    parts.nest({ y: y + 0.17, z: 0.305 }, () => addDrawerFittings(parts, 0.1));
  }
  return parts.merge();
});

/**
 * Builds a filing cabinet of four drawers, each with a brass card holder
 * and pull: 0.52 wide, 1.3 tall and 0.62 deep (z from -0.31 to 0.31).
 */
export function buildCabinet(): Object3D {
  return buildPropGroup("cabinet", readCabinetGeometry());
}
