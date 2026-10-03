/**
 * PROTOTYPE - the outdoors round the campus: toy trees, Deco lampposts,
 * paved paths and striped lawns.
 */
import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  Object3D,
  PointLight,
  SphereGeometry,
} from "three";
import { LAMP, type Lamp } from "../engine/contracts";
import { paint, readColor, subscribePalette } from "../engine/palette";
import {
  buildMergedMesh,
  buildPaintedMesh,
  buildSlabSides,
  paintMix,
  placeBox,
} from "./architecture-shared";

/** How many trees have been built, so each next one varies its shape the same way every time. */
let treesBuilt = 0;

/**
 * Builds a toy tree about 2.3 tall: a tapered trunk under a rounded canopy
 * of a few overlapping balls in two greens. Trees vary their canopy in the
 * order they are built, so a layout looks the same on every load.
 *
 * A tree is three meshes, one per palette material, rather than one painted
 * mesh: the campus merges all its trees into one mesh per material, and that
 * merge keeps only each vertex's position and normal.
 */
export function buildTree(): Object3D {
  const variant = treesBuilt++;
  // A cheap, repeatable scatter: the golden angle turns each tree's canopy.
  const turn = variant * 2.39996;
  const size = 0.92 + ((variant * 7) % 5) * 0.04;
  const trunk = [
    new CylinderGeometry(0.05, 0.085, 1.05, 10).translate(0, 0.525, 0),
    new CylinderGeometry(0.11, 0.13, 0.05, 12).translate(0, 0.025, 0),
  ];
  const light: BufferGeometry[] = [
    new SphereGeometry(0.58 * size, 18, 12).translate(0, 1.55 * size, 0),
  ];
  const dark: BufferGeometry[] = [];
  const lobes = 3 + (variant % 2);
  for (let index = 0; index < lobes; index++) {
    const angle = turn + (index * 2 * Math.PI) / lobes;
    const radius = (0.36 + 0.05 * ((variant + index) % 3)) * size;
    const ball = new SphereGeometry(radius, 16, 10).translate(
      Math.cos(angle) * 0.36 * size,
      (1.28 + 0.12 * ((index + variant) % 2)) * size,
      Math.sin(angle) * 0.36 * size,
    );
    (index % 2 === 0 ? dark : light).push(ball);
  }
  light.push(new SphereGeometry(0.3 * size, 14, 10).translate(0.08, 2.0 * size, -0.05));
  const object = new Group();
  for (const mesh of [
    buildMergedMesh(paint("room-wood", "satin", { dl: -0.1 }), trunk),
    buildMergedMesh(paint("room-plant", "matte"), light),
    buildMergedMesh(paint("room-plant", "matte", { dl: -0.07, dc: 0.01 }), dark),
  ]) {
    if (mesh !== null) object.add(mesh);
  }
  return object;
}

/** The lamppost's lantern centre, above its foot. */
const LANTERN_HEIGHT = 2.2;
/** How bright a lit lamppost's light is, in candela: enough to pool on the ground below. */
const LAMP_CANDELA = 10;

/**
 * Builds a Deco street lamp 2.43 tall: a stepped dark base, a slim pole with
 * brass rings, and a milk-glass globe under a stepped brass cap. It stores a
 * `Lamp` in its `userData[LAMP]`: when on, the globe glows warm and one point
 * light, which casts no shadow, lights the ground round it. The light is
 * always there, at intensity 0 when off, so turning lamps on and off never
 * changes the number of lights and never makes three.js rebuild its shaders.
 */
export function buildLamppost(): Object3D {
  const iron = [
    placeBox(0.26, 0.06, 0.26),
    placeBox(0.19, 0.1, 0.19, 0, 0.06),
    placeBox(0.13, 0.08, 0.13, 0, 0.16),
    new CylinderGeometry(0.026, 0.038, 1.86, 12).translate(0, 0.24 + 0.93, 0),
  ];
  const brass = [
    new CylinderGeometry(0.05, 0.05, 0.03, 14).translate(0, 0.25, 0),
    new CylinderGeometry(0.04, 0.04, 0.025, 14).translate(0, 1.1, 0),
    // The cup under the globe, and the stepped cap and finial over it.
    new CylinderGeometry(0.07, 0.035, 0.06, 16).translate(0, 2.1 - 0.03 + 0.02, 0),
    new CylinderGeometry(0.06, 0.11, 0.05, 16).translate(0, LANTERN_HEIGHT + 0.12, 0),
    new CylinderGeometry(0.03, 0.06, 0.05, 16).translate(0, LANTERN_HEIGHT + 0.17, 0),
    new CylinderGeometry(0.004, 0.018, 0.07, 8).translate(0, LANTERN_HEIGHT + 0.23, 0),
  ];
  const object = new Group();
  object.add(
    buildPaintedMesh([
      [paint("room-inlay-2", "satin", { dl: -0.06 }), iron],
      [paint("brass", "brass"), brass],
    ])!,
  );
  const unlit = paint("room-paper", "gloss", { dl: -0.04 });
  const globe = new Mesh(new SphereGeometry(0.115, 20, 14), unlit);
  globe.position.y = LANTERN_HEIGHT;
  object.add(globe);
  const light = new PointLight(0xffffff, 0, 6, 2);
  light.position.y = LANTERN_HEIGHT - 0.05;
  light.castShadow = false;
  object.add(light);
  // The light takes the lit globe's warm brass, and follows it when the theme changes.
  const repaintLight = () => light.color.copy(readColor("brass", { dl: 0.14, dc: -0.03 }));
  repaintLight();
  subscribePalette(repaintLight);
  const lamp: Lamp = {
    setOn(on) {
      globe.material = on ? paint("brass", "glow", { dl: 0.14, dc: -0.03 }) : unlit;
      light.intensity = on ? LAMP_CANDELA : 0;
    },
  };
  object.userData[LAMP] = lamp;
  return object;
}

/** A paving slab's size along the path, and the most a slab spans across it. */
const SLAB_LENGTH = 0.42;
const SLAB_WIDTH = 0.62;
const GROUT = 0.02;
const KERB = 0.07;

/**
 * Builds a paved path `width` wide and `length` long, along local z, its top
 * at y = 0.01. Slabs in a running bond, in two close tones, sit on a darker
 * bed and between two kerbs.
 */
export function buildPath(width: number, length: number): Object3D {
  const bed = [placeBox(width, 0.006, length)];
  const kerbs = [
    placeBox(KERB, 0.014, length, -width / 2 + KERB / 2),
    placeBox(KERB, 0.014, length, width / 2 - KERB / 2),
  ];
  const slabs: [BufferGeometry[], BufferGeometry[]] = [[], []];
  const inner = width - 2 * KERB - GROUT;
  const across = Math.max(1, Math.round(inner / SLAB_WIDTH));
  const slabWidth = inner / across;
  const rows = Math.max(1, Math.round(length / SLAB_LENGTH));
  const rowLength = length / rows;
  for (let row = 0; row < rows; row++) {
    const z = -length / 2 + (row + 0.5) * rowLength;
    // Every other row is shifted by half a slab; its ends are cut to fit.
    const offset = row % 2 === 0 ? 0 : slabWidth / 2;
    for (let column = -1; column <= across; column++) {
      const from = Math.max(0, column * slabWidth + offset);
      const to = Math.min(inner, (column + 1) * slabWidth + offset);
      if (to - from < 0.05) continue;
      const x = -inner / 2 + (from + to) / 2;
      const tone = (row * 3 + column * 5) % 7 === 0 ? 1 : 0;
      slabs[tone].push(placeBox(to - from - GROUT, 0.004, rowLength - GROUT, x, 0.006, z));
    }
  }
  const object = new Group();
  object.add(
    buildPaintedMesh(
      [
        [paint("room-inlay-2", "matte", { dl: 0.1, dc: -0.01 }), bed],
        [paint("room-inlay-2", "satin", { dl: 0.04 }), kerbs],
        [paint("room-inlay", "matte", { dl: 0.04 }), slabs[0]],
        [paint("room-inlay", "matte", { dl: -0.02 }), slabs[1]],
      ],
      { cast: false },
    )!,
  );
  return object;
}

/** The width of one mown stripe on a lawn. */
const STRIPE = 1.1;

/**
 * Builds a patch of lawn `width` by `depth`, its top at y = 0: mown stripes
 * in two greens along z, on a slab of soil 0.1 deep.
 */
export function buildLawn(width: number, depth: number): Object3D {
  const stripes: [number[], number[]] = [[], []];
  const count = Math.max(1, Math.round(width / STRIPE));
  const stripe = width / count;
  for (let index = 0; index < count; index++) {
    const ax = -width / 2 + index * stripe;
    const bx = ax + stripe;
    const az = -depth / 2;
    const bz = depth / 2;
    stripes[index % 2]!.push(ax, 0, az, ax, 0, bz, bx, 0, bz, ax, 0, az, bx, 0, bz, bx, 0, az);
  }
  const [mown, unmown] = stripes.map((positions) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute(
      "normal",
      new Float32BufferAttribute(
        positions.map((_, index) => (index % 3 === 1 ? 1 : 0)),
        3,
      ),
    );
    return positions.length === 0 ? [] : [geometry];
  }) as [BufferGeometry[], BufferGeometry[]];
  const object = new Group();
  object.add(
    buildPaintedMesh(
      [
        // The greens lean toward the floor's colour, so a lawn is pale in a light theme and deep in a dark one.
        [paintMix("room-plant", "room-floor", 0.3, "matte"), mown],
        [paintMix("room-plant", "room-floor", 0.38, "matte"), unmown],
        [paint("room-wood", "matte", { dl: -0.12 }), [buildSlabSides(width, depth, 0.1)]],
      ],
      { cast: false },
    )!,
  );
  return object;
}
