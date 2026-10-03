/**
 * PROTOTYPE - the Tower lab: variant B's building on its own, with no
 * colleagues, no overlay and no walking. Open labs/tower.html.
 *
 * - `?fleet=today|growing|ten-x` picks the world, `today` by default.
 * - `?storey=<n>` shows one storey's group alone (0 is the lobby, the last
 *   is the roof with the crown), to count what one storey costs.
 * - `?focus=<n>` focuses storey n, so the storeys above it lift away.
 *
 * The camera starts at the tower's overview, or at the storey's view with
 * `?storey=`, unless `?view=` says otherwise. Room lights are lit at
 * `?time=evening` and `?time=night`, as the office's director lights them.
 */
import type { Object3D } from "three";
import { LAMP, type CameraView, type Lamp, type NavBuilder } from "../engine/contracts";
import { buildWorld } from "../world/fixture";
import type { FleetSize } from "../world/types";
import { buildTower } from "../variants/tower";
import { mountLab } from "./lab";

/** Returns a nav builder that records nothing and finds every path, so the lab needs no nav engine. */
function createIdleNav(): NavBuilder {
  const ignore = (): void => undefined;
  return {
    addFloor: ignore,
    block: ignore,
    blockObject: ignore,
    open: ignore,
    link: ignore,
    build: () => ({ findPath: () => [] }),
  };
}

/** Returns every room light under `root`. */
function findLamps(root: Object3D): Lamp[] {
  const lamps: Lamp[] = [];
  root.traverse((object) => {
    const lamp = object.userData[LAMP] as Lamp | undefined;
    if (lamp !== undefined) lamps.push(lamp);
  });
  return lamps;
}

/** Writes a camera view as the lab's `?view=` value. */
function writeView({ target, distance, azimuth, elevation }: CameraView): string {
  return [distance, azimuth, elevation, target.x, target.y, target.z]
    .map((value) => value.toFixed(2))
    .join(",");
}

const params = new URLSearchParams(location.search);
const fleet = (params.get("fleet") ?? "today") as FleetSize;
const layout = buildTower({ world: buildWorld(fleet), nav: createIdleNav() });
const storey = params.get("storey");
const focus = params.get("focus");

if (storey !== null) {
  for (const child of layout.root.children) child.visible = child.name === `storey-${storey}`;
}
if (!params.has("view")) {
  const room = layout.rooms.find((info) => info.kind === "floor" && String(info.floor) === storey);
  params.set("view", writeView(room?.view ?? layout.overview));
  history.replaceState(null, "", `?${params.toString()}`);
}

mountLab((stage) => {
  stage.scene.add(layout.root);
  stage.setShadowBounds(layout.bounds);
  const time = stage.resolveTimeOfDay();
  for (const lamp of findLamps(layout.root)) lamp.setOn(time === "evening" || time === "night");
  if (focus !== null) layout.focusFloor?.(Number(focus));
  return (frame) => layout.update?.(frame) ?? false;
}, 0.01);
