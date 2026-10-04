/**
 * The fleet on the Bureau floor. The office is planned by area of
 * the code base, so the runners are a lens over it, never its plan:
 *
 * - every desk carries a small brass tag on its front with the name of the
 *   runner its owner runs on, so a close look tells which machine hosts whom;
 * - the Lobby has a directory board, the way an office building lists its
 *   tenants: one brass plaque per runner, with how many colleagues it hosts.
 *
 * The tags are cheap at any fleet size: each runner's tags are merged into
 * one mesh for their enamel faces, and all the brass frames into one more.
 */
import {
  Box3,
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { DeskHandle } from "../engine/contracts";
import { DESK_HEIGHT } from "../engine/contracts";
import { paint } from "../engine/palette";
import { buildPlaque } from "../kit/architecture";
import { buildDesk } from "../kit/props";
import type { World } from "../world/types";
import { measureFootprint } from "./bureau-rooms";

/** How much smaller a desk tag is than a door's plaque. */
const TAG_SCALE = 0.42;
/** The space one plaque takes on the directory, top to top. */
const DIRECTORY_LINE = 0.2;

/** Returns the colleagues each runner hosts, by runner id. */
function countByRunner(world: World): Map<string, number> {
  const counts = new Map<string, number>();
  for (const colleague of world.colleagues) {
    if (colleague.runnerId === null) continue;
    counts.set(colleague.runnerId, (counts.get(colleague.runnerId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Builds the Lobby's directory: a lacquered board on two legs with a heading
 * and one plaque per runner that hosts anyone, "<runner> · <count>". It
 * stands on the floor, its back at z = 0, facing +z.
 */
export function buildDirectory(world: World): Object3D {
  const counts = countByRunner(world);
  const lines = world.runners
    .filter((runner) => (counts.get(runner.id) ?? 0) > 0)
    .map((runner) => `${runner.name} · ${String(counts.get(runner.id) ?? 0)}`);
  const plaques = [buildPlaque("Runners"), ...lines.map((line) => buildPlaque(line))];
  const widest = plaques.reduce(
    (width, plaque) => Math.max(width, new Box3().setFromObject(plaque).getSize(new Vector3()).x),
    0,
  );
  const boardWidth = widest + 0.16;
  const boardHeight = plaques.length * DIRECTORY_LINE + 0.12;
  const bottom = 0.75;
  const object = new Group();
  const wood = paint("room-wood", "lacquer");
  const board = new Mesh(new BoxGeometry(boardWidth, boardHeight, 0.04), wood);
  board.position.set(0, bottom + boardHeight / 2, 0.06);
  object.add(board);
  for (const side of [-1, 1]) {
    const leg = new Mesh(new BoxGeometry(0.05, bottom + boardHeight, 0.05), wood);
    leg.position.set(side * (boardWidth / 2 - 0.1), (bottom + boardHeight) / 2, 0.025);
    const foot = new Mesh(new BoxGeometry(0.07, 0.04, 0.36), wood);
    foot.position.set(side * (boardWidth / 2 - 0.1), 0.02, 0.06);
    object.add(leg, foot);
  }
  for (const mesh of object.children) mesh.castShadow = mesh.receiveShadow = true;
  plaques.forEach((plaque, index) => {
    plaque.position.set(0, bottom + boardHeight - 0.06 - (index + 0.5) * DIRECTORY_LINE, 0.08);
    object.add(plaque);
  });
  return object;
}

/** The desk tags: one object holding every tag, and what frees the plaques they were cut from. */
interface DeskTags {
  readonly object: Object3D;
  dispose(): void;
}

/**
 * Builds a brass tag on the front of every owned desk, with its owner's
 * runner name. Desks whose owner runs on no runner get none. The desks must
 * be in place, with their world matrices up to date.
 */
export function buildDeskTags(
  owned: ReadonlyArray<{ readonly desk: DeskHandle; readonly runnerId: string | null }>,
  world: World,
): DeskTags {
  const object = new Group();
  const templates: Object3D[] = [];
  const front = (() => {
    const footprint = measureFootprint(buildDesk().object, 0);
    return footprint.centreZ - footprint.depth / 2;
  })();
  // In the desk's own space: just under the top's front edge, facing out of the front.
  const onDesk = new Matrix4().compose(
    new Vector3(0, DESK_HEIGHT - 0.075, front - 0.003),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
    new Vector3().setScalar(TAG_SCALE),
  );
  const pieces = new Map<Material, BufferGeometry[]>();
  for (const runner of world.runners) {
    const desks = owned.filter((entry) => entry.runnerId === runner.id);
    if (desks.length === 0) continue;
    const template = buildPlaque(runner.name);
    template.updateMatrixWorld(true);
    templates.push(template);
    template.traverse((child) => {
      if (!(child instanceof Mesh) || Array.isArray(child.material)) return;
      const material = child.material as Material;
      const list = pieces.get(material) ?? [];
      for (const { desk } of desks) {
        const matrix = new Matrix4()
          .multiplyMatrices(desk.object.matrixWorld, onDesk)
          .multiply(child.matrixWorld);
        list.push((child.geometry as BufferGeometry).clone().applyMatrix4(matrix));
      }
      pieces.set(material, list);
    });
  }
  for (const [material, geometries] of pieces) {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    if (merged === null) continue;
    const mesh = new Mesh(merged, material);
    mesh.receiveShadow = true;
    object.add(mesh);
  }
  return {
    object,
    dispose() {
      // Disposing a plaque's face frees its canvas texture and material, which the merged tags share.
      for (const template of templates) {
        template.traverse((child) => {
          if (child instanceof Mesh) (child.geometry as BufferGeometry).dispose();
        });
      }
    },
  };
}
