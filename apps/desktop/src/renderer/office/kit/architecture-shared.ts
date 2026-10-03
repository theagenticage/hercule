/**
 * Helpers the architecture kit's builders share: placing boxes,
 * merging many small parts into one mesh, and drawing text on a canvas
 * texture that follows the theme.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  Float32BufferAttribute,
  FloatType,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  SRGBColorSpace,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  paint,
  readToken,
  subscribePalette,
  writeOklch,
  type Finish,
  type Oklch,
  type Token,
} from "../engine/palette";

/**
 * Returns a box geometry `width` by `height` by `depth` whose base sits at
 * `y` and whose centre is at (`x`, `z`). The geometry is already moved into
 * place, ready to be merged with others.
 */
export function placeBox(
  width: number,
  height: number,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
): BufferGeometry {
  return new BoxGeometry(width, height, depth).translate(x, y + height / 2, z);
}

/**
 * Returns a box's four sides and its bottom, `width` by `depth`, from
 * y = -`thickness` up to 0, without a top: the top is drawn by whatever
 * covers it, such as a floor's parquet or a lawn's stripes.
 */
export function buildSlabSides(width: number, depth: number, thickness: number): BufferGeometry {
  const box = placeBox(width, thickness, depth, 0, -thickness, 0);
  // BoxGeometry orders its faces +x, -x, +y, -y, +z, -z; the +y face is dropped.
  const index = box.index!;
  const kept: number[] = [];
  for (const group of box.groups) {
    if (group.materialIndex === 2) continue;
    for (let at = group.start; at < group.start + group.count; at++) kept.push(index.getX(at));
  }
  box.setIndex(kept);
  box.clearGroups();
  return box;
}

/**
 * Merges `parts` into one geometry: every part loses its UVs (the kit paints
 * flat colours) and its index, so parts of every kind merge together.
 * Returns null when there are no parts.
 */
export function mergeParts(parts: ReadonlyArray<BufferGeometry>): BufferGeometry | null {
  if (parts.length === 0) return null;
  const prepared = parts.map((part) => {
    const flat = part.index === null ? part : part.toNonIndexed();
    for (const name of Object.keys(flat.attributes)) {
      if (name !== "position" && name !== "normal") flat.deleteAttribute(name);
    }
    return flat;
  });
  const merged = mergeGeometries(prepared, false);
  for (const part of parts) part.dispose();
  for (const part of prepared) part.dispose();
  if (merged === null) throw new Error("The architecture kit could not merge its parts.");
  return merged;
}

/** How a merged mesh takes part in shadows. */
interface ShadowRole {
  readonly cast?: boolean;
  readonly receive?: boolean;
}

/**
 * Builds one mesh from `parts` painted in `material`, or returns null when
 * there are no parts. Casts and receives shadows unless `shadows` says not.
 */
export function buildMergedMesh(
  material: Material,
  parts: ReadonlyArray<BufferGeometry>,
  shadows: ShadowRole = {},
): Mesh | null {
  const geometry = mergeParts(parts);
  if (geometry === null) return null;
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = shadows.cast ?? true;
  mesh.receiveShadow = shadows.receive ?? true;
  return mesh;
}

/** The most palette materials painted meshes can use between them. */
const PAINT_SLOTS = 256;

/**
 * The palette materials that painted meshes use, as a texture with one
 * column per material: row 0 holds its colour, row 1 its roughness and
 * metalness. The texels are floats because 8 bits per channel visibly band
 * the dark themes' colours, and a painted wall would then not match a prop
 * in the same colour.
 */
const paintTable = new DataTexture(
  new Float32Array(PAINT_SLOTS * 2 * 4),
  PAINT_SLOTS,
  2,
  RGBAFormat,
  FloatType,
);
/** Each palette material's column in `paintTable`. */
const paintSlots = new Map<MeshStandardMaterial, number>();

/** Copies a palette material's colour, roughness and metalness into its column of `paintTable`. */
function writePaintSlot(material: MeshStandardMaterial, slot: number): void {
  const data = paintTable.image.data as Float32Array;
  const { r, g, b } = material.color;
  data.set([r, g, b, 1], slot * 4);
  data.set([material.roughness, material.metalness, 0, 1], (PAINT_SLOTS + slot) * 4);
  paintTable.needsUpdate = true;
}

/** Returns the column of `paintTable` that holds `material`, adding it the first time. */
function assignPaintSlot(material: MeshStandardMaterial): number {
  const known = paintSlots.get(material);
  if (known !== undefined) return known;
  const slot = paintSlots.size;
  if (slot === PAINT_SLOTS) {
    throw new Error(
      `The architecture kit can paint with at most ${String(PAINT_SLOTS)} palette materials; raise PAINT_SLOTS.`,
    );
  }
  paintSlots.set(material, slot);
  writePaintSlot(material, slot);
  subscribeKitRepaint();
  return slot;
}

/**
 * The one material every painted mesh shares. Each vertex carries a `paint`
 * attribute, the column of `paintTable` it is painted from, so a mesh can
 * hold parts in many palette colours and finishes and still be drawn in one
 * draw call. The shader changes are methods rather than properties so that
 * `clone()` keeps them, for the copies a layout fades.
 */
class PaintedPartsMaterial extends MeshStandardMaterial {
  override onBeforeCompile(shader: WebGLProgramParametersWithUniforms): void {
    shader.uniforms.paintTable = { value: paintTable };
    const varyings = "varying vec3 vPaintColor;\nvarying vec2 vPaintSurface;\n";
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nattribute float paint;\nuniform highp sampler2D paintTable;\n${varyings}`,
      )
      .replace(
        "#include <begin_vertex>",
        [
          "#include <begin_vertex>",
          "int paintSlot = int(paint + 0.5);",
          "vPaintColor = texelFetch(paintTable, ivec2(paintSlot, 0), 0).rgb;",
          "vPaintSurface = texelFetch(paintTable, ivec2(paintSlot, 1), 0).rg;",
        ].join("\n"),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${varyings}`)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb *= vPaintColor;",
      )
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = vPaintSurface.x;")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vPaintSurface.y;");
  }

  override customProgramCacheKey(): string {
    return "architecture-painted-parts";
  }
}

const paintedParts = new PaintedPartsMaterial();
paintedParts.name = "architecture:painted-parts";

/** Geometries to paint in one palette material. */
export type PaintedParts = readonly [
  paint: MeshStandardMaterial,
  parts: ReadonlyArray<BufferGeometry>,
];

/**
 * Builds one mesh from groups of parts, each group painted in its own
 * palette material, so the whole mesh is one draw call. Returns null when
 * there are no parts. Casts and receives shadows unless `shadows` says not.
 *
 * A group keeps its material's colour, roughness and metalness, and follows
 * the theme as the material does. Anything else a material has, such as
 * transparency, a glow or a clear coat, is lost: glass and lit lamps stay
 * meshes of their own.
 *
 * The mesh's geometry carries a `paint` attribute that says which material
 * each vertex is painted in. Code that copies or merges the geometry must
 * keep that attribute.
 */
export function buildPaintedMesh(
  groups: ReadonlyArray<PaintedParts>,
  shadows: ShadowRole = {},
): Mesh | null {
  const painted: BufferGeometry[] = [];
  for (const [material, parts] of groups) {
    const geometry = mergeParts(parts);
    if (geometry === null) continue;
    const slots = new Float32Array(geometry.attributes.position!.count).fill(
      assignPaintSlot(material),
    );
    geometry.setAttribute("paint", new Float32BufferAttribute(slots, 1));
    painted.push(geometry);
  }
  if (painted.length === 0) return null;
  const geometry = mergeGeometries(painted, false);
  for (const part of painted) part.dispose();
  if (geometry === null) throw new Error("The architecture kit could not merge its parts.");
  const mesh = new Mesh(geometry, paintedParts);
  mesh.castShadow = shadows.cast ?? true;
  mesh.receiveShadow = shadows.receive ?? true;
  return mesh;
}

/** Returns the colour `share` of the way from `from` to `to`, mixed in OKLab as CSS color-mix() does. */
function mixOklch(from: Oklch, to: Oklch, share: number): Pick<Oklch, "l" | "c" | "h"> {
  const toLab = ({ c, h }: Oklch) => [
    c * Math.cos((h * Math.PI) / 180),
    c * Math.sin((h * Math.PI) / 180),
  ];
  const [fa, fb] = toLab(from) as [number, number];
  const [ta, tb] = toLab(to) as [number, number];
  const a = fa + (ta - fa) * share;
  const b = fb + (tb - fb) * share;
  return {
    l: from.l + (to.l - from.l) * share,
    c: Math.hypot(a, b),
    h: (Math.atan2(b, a) * 180) / Math.PI,
  };
}

const mixedMaterials = new Map<string, MeshStandardMaterial>();
/** Repaints each mixed material from the current theme. */
const mixRepaints: Array<() => void> = [];

/**
 * Returns a shared material in `finish` painted `share` of the way from
 * `token` to `toward`, like `color-mix(in oklab, token, toward share)`. It
 * repaints after every palette repaint. The palette's `paint` shifts one
 * token; the design book mixes two for a few surfaces, such as wall tops.
 */
export function paintMix(
  token: Token,
  toward: Token,
  share: number,
  finish: Finish = "satin",
): MeshStandardMaterial {
  const key = `${token}|${toward}|${String(share)}|${finish}`;
  const known = mixedMaterials.get(key);
  if (known !== undefined) return known;
  const material = paint(token, finish).clone();
  material.name = `mix:${key}`;
  const repaint = () => {
    writeOklch(material.color, mixOklch(readToken(token), readToken(toward), share));
  };
  repaint();
  mixRepaints.push(repaint);
  subscribeKitRepaint();
  mixedMaterials.set(key, material);
  return material;
}

let repaintSubscribed = false;

/**
 * Repaints what the kit paints itself after every palette repaint, in order:
 * the mixed materials first, because painted meshes copy their colours, then
 * `paintTable`, then the canvas labels.
 */
function subscribeKitRepaint(): void {
  if (repaintSubscribed) return;
  repaintSubscribed = true;
  subscribePalette(() => {
    for (const repaint of mixRepaints) repaint();
    for (const [material, slot] of paintSlots) writePaintSlot(material, slot);
    redrawLabels();
  });
}

/** Returns a token's colour as a CSS colour a canvas accepts. */
export function readCssColor(token: Token, lightness = 0): string {
  const { l, c, h, alpha } = readToken(token);
  return `oklch(${String(l + lightness)} ${String(c)} ${String(h)} / ${String(alpha)})`;
}

/**
 * Returns the UI face's CSS shorthand at a pixel size, in the app's bold
 * weight (`--w-bold`). Room names are drawn in the UI face, like every name
 * in the app; the display face is kept for numerals. The
 * generic family keeps a canvas drawn before the face loads in a sans-serif.
 */
export function uiFont(pixels: number): string {
  return `640 ${String(pixels)}px "Bricolage Grotesque", sans-serif`;
}

/** A canvas texture that redraws itself when the theme changes and when the display face arrives. */
interface CanvasLabel {
  readonly texture: CanvasTexture;
  readonly canvas: HTMLCanvasElement;
}

/** The labels alive now. A label that was garbage collected drops out at the next repaint. */
const labels = new Set<WeakRef<{ redraw: () => void }>>();

/** Redraws every living label. */
function redrawLabels(): void {
  for (const reference of labels) {
    const label = reference.deref();
    if (label === undefined) labels.delete(reference);
    else label.redraw();
  }
}

/**
 * Builds a canvas texture `width` by `height` pixels and paints it with
 * `draw`, which writes in `font`, a CSS font shorthand. `draw` runs again
 * after every palette repaint and once more when `font` has loaded, so the
 * text never stays in a fallback face. Returns the texture and its canvas.
 */
export function buildCanvasLabel(
  width: number,
  height: number,
  font: string,
  draw: (context: CanvasRenderingContext2D) => void,
): CanvasLabel {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The architecture kit could not create a 2D canvas.");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  const redraw = (): void => {
    context.clearRect(0, 0, width, height);
    draw(context);
    texture.needsUpdate = true;
  };
  redraw();
  const owner = { redraw };
  labels.add(new WeakRef(owner));
  // The texture holds the owner, so the label lives exactly as long as its texture.
  texture.userData.owner = owner;
  subscribeKitRepaint();
  if (!document.fonts.check(font)) {
    // The scene asks for a frame once the page's fonts are ready, which shows the redrawn text.
    void document.fonts.load(font).then(redraw);
  }
  return { texture, canvas };
}
