/**
 * PROTOTYPE - the Tower's own architecture, the parts no kit builds: the
 * fluted piers at the corners, the brass rail
 * along each storey's open front, the pendant lamps, the stepped Deco crown
 * and the plaza the tower stands on.
 *
 * Every builder returns an object whose origin sits on its floor, unless its
 * comment says otherwise. Repeated parts share one geometry each.
 */
import {
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  SphereGeometry,
  type Material,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LAMP, WALL_HEIGHT, type Lamp } from "../engine/contracts";
import { paint } from "../engine/palette";

const geometries = new Map<string, BufferGeometry>();

/** Returns the shared rounded box of a size, building it the first time. */
function roundedBox(width: number, height: number, depth: number, radius = 0.03): BufferGeometry {
  const key = `${width.toFixed(3)}|${height.toFixed(3)}|${depth.toFixed(3)}|${radius.toFixed(3)}`;
  let geometry = geometries.get(key);
  if (geometry === undefined) {
    geometry = new RoundedBoxGeometry(
      width,
      height,
      depth,
      2,
      Math.min(radius, width / 2, height / 2, depth / 2),
    );
    geometries.set(key, geometry);
  }
  return geometry;
}

/**
 * Returns a rounded block whose base sits at `y`, centred at (x, z). It
 * casts and takes shadows unless `shadow` is false.
 */
export function buildBlock(
  material: Material,
  width: number,
  height: number,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
  shadow = true,
): Mesh {
  const mesh = new Mesh(roundedBox(width, height, depth), material);
  mesh.position.set(x, y + height / 2, z);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Builds a piece of a fluted Deco pier `height` tall, standing on y = 0: a
 * square shaft with three ribs on its south face and three on its east
 * face. The ribs stop short of both ends, so pieces stacked storey on storey
 * show a band at every floor.
 */
export function buildPier(height: number): Object3D {
  const pier = new Group();
  const size = 0.46;
  pier.add(buildBlock(paint("room-panel", "satin"), size, height, size));
  const ribs: BufferGeometry[] = [];
  for (const offset of [-0.13, 0, 0.13]) {
    ribs.push(
      new RoundedBoxGeometry(0.06, height - 0.3, 0.06, 1, 0.02).translate(
        offset,
        height / 2,
        size / 2 + 0.02,
      ),
      new RoundedBoxGeometry(0.06, height - 0.3, 0.06, 1, 0.02).translate(
        size / 2 + 0.02,
        height / 2,
        offset,
      ),
    );
  }
  const flutes = new Mesh(mergeGeometries(ribs), paint("room-panel", "satin", { dl: 0.06 }));
  flutes.castShadow = true;
  pier.add(flutes);
  return pier;
}

/**
 * Builds the brass rail along an open front `length` long, along x, centred
 * on the origin: a handrail at the dado rail's height on slim posts.
 */
export function buildFrontRail(length: number, height: number): Object3D {
  const rail = new Group();
  const bar = new Mesh(new CylinderGeometry(0.03, 0.03, length, 10), paint("brass", "brass"));
  bar.rotation.z = Math.PI / 2;
  bar.position.y = height;
  bar.castShadow = true;
  rail.add(bar);
  const posts: BufferGeometry[] = [];
  const count = Math.max(2, Math.round(length / 1.15) + 1);
  for (let index = 0; index < count; index++) {
    const x = -length / 2 + 0.05 + (index * (length - 0.1)) / (count - 1);
    posts.push(new CylinderGeometry(0.018, 0.022, height, 8).translate(x, height / 2, 0));
  }
  const post = new Mesh(mergeGeometries(posts), paint("brass", "brass"));
  post.castShadow = true;
  rail.add(post);
  return rail;
}

/**
 * Builds a pendant lamp hung from a storey's ceiling, at `WALL_HEIGHT`: a
 * brass rod and rose, and an opal bowl that glows in the evening. Its origin
 * is on the floor below it. It stores a `Lamp` in `userData[LAMP]`.
 */
export function buildPendant(): Object3D {
  const pendant = new Group();
  const drop = 0.6;
  const bowlY = WALL_HEIGHT - drop;
  const brass = new Mesh(
    mergeGeometries([
      new CylinderGeometry(0.012, 0.012, drop, 6).translate(0, WALL_HEIGHT - drop / 2, 0),
      new CylinderGeometry(0.07, 0.09, 0.04, 16).translate(0, WALL_HEIGHT - 0.02, 0),
      new CylinderGeometry(0.05, 0.2, 0.05, 20).translate(0, bowlY + 0.025, 0),
    ]),
    paint("brass", "brass"),
  );
  const bowl = new Mesh(
    new SphereGeometry(0.2, 20, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    paint("room-paper", "satin"),
  );
  bowl.position.y = bowlY;
  pendant.add(brass, bowl);
  const lamp: Lamp = {
    setOn(on) {
      bowl.material = paint("room-paper", on ? "glow" : "satin");
    },
  };
  pendant.userData[LAMP] = lamp;
  return pendant;
}

/** What the crown needs to know of the storey it stands on. */
export interface CrownSize {
  readonly width: number;
  readonly depth: number;
}

/**
 * Builds the stepped Deco crown, standing on y = 0 and centred on the
 * origin: three setbacks, each with a brass bead and fluting, and a spire.
 * Returns the crown and the height of its first tier's south face, where
 * the wordmark goes.
 */
export function buildCrown({ width, depth }: CrownSize): {
  readonly object: Object3D;
  readonly faceHeight: number;
  readonly height: number;
} {
  const crown = new Group();
  const tiers = [
    { inset: 0.5, height: 1.9 },
    { inset: 1.5, height: 1.5 },
    { inset: 2.4, height: 1.2 },
    { inset: 3.1, height: 0.9 },
  ];
  let y = 0;
  const flutes: BufferGeometry[] = [];
  for (const [index, tier] of tiers.entries()) {
    const w = Math.max(1.2, width - tier.inset * 2);
    const d = Math.max(1.2, depth - tier.inset * 2);
    crown.add(
      buildBlock(paint("room-wall", "satin", { dl: 0.02 }), w, tier.height, d, 0, y, 0),
      buildBlock(paint("brass", "brass"), w + 0.08, 0.06, d + 0.08, 0, y + tier.height - 0.06),
    );
    // Fluting on the south and east faces, except on the first tier's south
    // face, where the wordmark stands.
    const ribs = Math.max(2, Math.floor(w / 0.55));
    for (let rib = 0; rib < ribs; rib++) {
      const x = -w / 2 + ((rib + 0.5) * w) / ribs;
      if (index > 0) {
        flutes.push(
          new RoundedBoxGeometry(0.08, tier.height - 0.3, 0.06, 1, 0.02).translate(
            x,
            y + tier.height / 2 - 0.05,
            d / 2 + 0.02,
          ),
        );
      }
    }
    const sideRibs = Math.max(2, Math.floor(d / 0.55));
    for (let rib = 0; rib < sideRibs; rib++) {
      const z = -d / 2 + ((rib + 0.5) * d) / sideRibs;
      flutes.push(
        new RoundedBoxGeometry(0.06, tier.height - 0.3, 0.08, 1, 0.02).translate(
          w / 2 + 0.02,
          y + tier.height / 2 - 0.05,
          z,
        ),
      );
    }
    y += tier.height;
  }
  const fluting = new Mesh(mergeGeometries(flutes), paint("room-panel", "satin"));
  fluting.castShadow = true;
  crown.add(fluting);
  // The spire: a slim stepped needle with a brass finial.
  const needle = new Mesh(new CylinderGeometry(0.05, 0.16, 3.2, 12), paint("room-panel", "satin"));
  needle.position.y = y + 1.6;
  needle.castShadow = true;
  const finial = new Mesh(new SphereGeometry(0.12, 16, 10), paint("brass", "brass"));
  finial.position.y = y + 3.25;
  crown.add(needle, finial);
  return { object: crown, faceHeight: tiers[0]!.height, height: y + 3.4 };
}

/** Builds the plaza the tower stands on, `width` by `depth`, its top at y = 0. */
export function buildPlaza(width: number, depth: number): Object3D {
  const plaza = new Group();
  const stone = buildBlock(
    paint("room-floor", "matte", { dl: -0.03 }),
    width,
    0.5,
    depth,
    0,
    -0.5,
    0,
    false,
  );
  const kerb = buildBlock(
    paint("room-panel", "satin"),
    width + 0.3,
    0.18,
    depth + 0.3,
    0,
    -0.6,
    0,
    false,
  );
  plaza.add(stone, kerb);
  return plaza;
}
