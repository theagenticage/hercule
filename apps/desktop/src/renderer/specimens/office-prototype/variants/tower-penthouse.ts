/**
 * PROTOTYPE - the top of the Tower: the penthouse where the assistants live,
 * and the roof over it with the stepped Deco crown and the wordmark.
 *
 * The penthouse is a salon at the west end, over the lift, and an open
 * terrace east of it with a view over the town. The assistants that run a
 * heartbeat work at desks in the salon; one that runs no session sits in an
 * armchair. The crown stands on the salon's roof only, so the terrace stays
 * open to the sky.
 */
import { paint } from "../engine/palette";
import { buildFloor, buildWordmark, WALL_THICKNESS } from "../kit/architecture";
import {
  buildArmchair,
  buildBench,
  buildBookshelf,
  buildDesk,
  buildFloorLamp,
  buildPlant,
  buildRug,
} from "../kit/props";
import type { TowerPlan } from "./tower-plan";
import {
  FRONT_KEEP_OUT,
  GALLERY_DEPTH,
  addRoom,
  addWall,
  measureObject,
  placeObject,
  readFloorHeight,
  readSeat,
  type PlanRect,
  type TowerDraft,
} from "./tower-draft";
import { buildBlock, buildCrown, buildFrontRail, buildPendant } from "./tower-shell";
import { addSlab, addStoreyFront, type DeskUnit } from "./tower-storey";

const SALON_ID = "penthouse/salon";
const TERRACE_ID = "penthouse/terrace";
/** The wordmark on the crown's south face. */
const WORDMARK = "Hercule";

/**
 * Builds the penthouse into its storey's group: the slab under it, the
 * salon with the assistants' desks and armchairs, the terrace, the front
 * rail with the storey's plaque, and the storey's nav floor.
 */
export function buildPenthouse(draft: TowerDraft, plan: TowerPlan, unit: DeskUnit): void {
  const { frame, nav } = draft;
  const floor = plan.penthouseFloor;
  const group = draft.storeys[floor]!;
  const width = frame.width;
  const depth = frame.depth;
  const salon = frame.salonWidth;
  const half = WALL_THICKNESS / 2;
  const north = -depth + half;

  addSlab(group, { minX: -half, maxX: width + half, minZ: -depth - half, maxZ: 0 });
  placeObject(group, buildFloor(salon, depth, { inlay: "room-inlay-2" }), salon / 2, -depth / 2);
  placeObject(
    group,
    buildFloor(width - salon, depth, { inlay: "room-plant" }),
    (salon + width) / 2,
    -depth / 2,
  );

  // The salon's walls, anticlockwise from the north-east corner. Its east
  // wall has the door to the terrace, near the front.
  addWall(draft, {
    floor,
    from: [salon + half, -depth],
    to: [-half, -depth],
    options: { windows: true, cutaway: { roomId: SALON_ID, exterior: true } },
  });
  addWall(draft, {
    floor,
    from: [0, north],
    to: [0, 0],
    options: { cutaway: { roomId: SALON_ID, exterior: true } },
  });
  // Along this wall, local x runs north from its middle at z = -depth / 2.
  const doorZ = -GALLERY_DEPTH - 0.9;
  addWall(draft, {
    floor,
    from: [salon, 0],
    to: [salon, north],
    options: {
      windows: true,
      doors: [{ at: -doorZ - depth / 2 + half / 2, width: 1.1 }],
      cutaway: { roomId: SALON_ID, exterior: true },
    },
  });

  // The assistants that run a heartbeat work at desks in a row, facing the
  // open front; the others sit in armchairs by the bookshelf.
  const working = plan.assistants.filter((colleague) => colleague.runnerId !== null);
  const resting = plan.assistants.filter((colleague) => colleague.runnerId === null);
  const pitch = unit.width + 0.7;
  working.forEach((colleague, index) => {
    const desk = buildDesk();
    const x = frame.coreWidth + 0.5 + unit.width / 2 + index * pitch;
    placeObject(group, desk.object, x, -GALLERY_DEPTH - unit.front, Math.PI);
    nav.blockObject(floor, desk.object);
    draft.homes.set(colleague.id, readSeat(desk.seatMarker, floor, "desk", SALON_ID, desk));
  });
  const nook = salon - 1.9;
  placeObject(group, buildRug(2.6, 2.0), nook, north + 2.6);
  draft.nav.blockObject(floor, placeObject(group, buildBookshelf(2.4), nook, north + 0.18));
  resting.forEach((colleague, index) => {
    const chair = buildArmchair();
    placeObject(group, chair.object, nook - 0.5 + index * 1.0, north + 2.6, 0.25);
    nav.blockObject(floor, chair.object);
    draft.homes.set(colleague.id, readSeat(chair.seatMarker, floor, "armchair", SALON_ID, null));
  });
  const lamp = buildFloorLamp().object;
  nav.blockObject(floor, placeObject(group, lamp, salon - 0.45, north + 1.6));
  nav.blockObject(floor, placeObject(group, buildPlant("tall"), salon - 0.45, -GALLERY_DEPTH));
  placeObject(group, buildPendant(), salon * 0.35, -depth / 2);
  placeObject(group, buildPendant(), salon * 0.75, -depth / 2);

  // The terrace: rails round its open sides, tall plants in its corners, and
  // a bench facing the view.
  const terrace = width - salon;
  const rail = 0.62;
  placeObject(group, buildFrontRail(depth - 0.3, rail), width - 0.12, -depth / 2, Math.PI / 2);
  placeObject(group, buildFrontRail(terrace - 0.3, rail), salon + terrace / 2, north + 0.08);
  nav.block(floor, width - 0.2, -depth, width, 0);
  for (const z of [north + 0.45, -0.75]) {
    nav.blockObject(floor, placeObject(group, buildPlant("tall"), width - 0.5, z));
  }
  const bench = placeObject(group, buildBench(3).object, salon + terrace / 2, north + 1.2);
  nav.blockObject(floor, bench);

  addStoreyFront(group, width, frame.coreWidth, "Penthouse");

  const salonRect: PlanRect = { minX: 0, maxX: salon, minZ: -depth, maxZ: 0 };
  const terraceRect: PlanRect = { minX: salon, maxX: width, minZ: -depth, maxZ: 0 };
  addRoom(draft, { id: SALON_ID, label: "Salon", kind: "library", floor, rect: salonRect });
  addRoom(draft, { id: TERRACE_ID, label: "Terrace", kind: "hall", floor, rect: terraceRect });
  const storeyRect: PlanRect = { minX: 0, maxX: width, minZ: -depth, maxZ: 0 };
  addRoom(draft, { id: "penthouse", label: "Penthouse", kind: "floor", floor, rect: storeyRect });

  nav.addFloor(floor, readFloorHeight(floor), half, north, width - half, -FRONT_KEEP_OUT);
}

/**
 * Builds the roof into the group above the penthouse: the slab over the
 * salon, and the stepped crown on it with the wordmark on its south face.
 * Returns the crown's top, measured from the roof group's floor.
 */
export function buildRoof(draft: TowerDraft): number {
  const { frame } = draft;
  const group = draft.storeys.at(-1)!;
  const salon = frame.salonWidth;
  const depth = frame.depth;
  const half = WALL_THICKNESS / 2;
  addSlab(group, { minX: -half, maxX: salon + half, minZ: -depth - half, maxZ: 0 });
  // The crown's first tier is set back 0.5 from the size it is given.
  const crown = buildCrown({ width: salon + 0.2, depth: depth + 0.2 });
  placeObject(group, crown.object, salon / 2, -depth / 2, 0, -0.1);
  const faceZ = -depth / 2 + (depth + 0.2 - 1.0) / 2;
  const letters = [...WORDMARK].length;
  // A letter is about as wide as it is tall; the first tier's face is the
  // salon less 0.8 wide, and the band leaves a margin on either side.
  const faceWidth = salon - 0.8;
  const height = Math.min(1.05, (faceWidth - 1.0) / letters);
  const wordmark = buildWordmark(WORDMARK, height);
  const size = measureObject(wordmark);
  const wide = size.max.x - size.min.x;
  const tall = size.max.y - size.min.y;
  const footY = -0.1 + (crown.faceHeight - tall) / 2;
  // The brass letters stand on a band of glazed faience, so they read in
  // the dark themes too, where the crown's plaster is as dark as the brass.
  const band = 0.04;
  group.add(
    buildBlock(
      paint("room-paper", "gloss"),
      Math.min(wide + 0.6, faceWidth - 0.3),
      tall + 0.44,
      band,
      salon / 2,
      footY - 0.22,
      faceZ + band / 2,
      false,
    ),
  );
  placeObject(group, wordmark, salon / 2, faceZ + band, 0, footY - size.min.y);
  return crown.height - 0.1;
}
