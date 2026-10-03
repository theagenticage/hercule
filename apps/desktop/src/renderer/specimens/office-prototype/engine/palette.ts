/**
 * PROTOTYPE - the office's colours and materials, read from the Bureau's CSS
 * tokens, so the 3D office is drawn in the same colours as the rest of the
 * app and follows every theme.
 *
 * Every material in the office comes from `paint` or `paintHue`. Both return
 * a shared material per colour and finish, and `refreshPalette` repaints
 * every one of them in place when the theme changes, so a theme switch
 * rebuilds nothing.
 */
import {
  Color,
  LinearSRGBColorSpace,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
} from "three";
import type { Hue } from "../../../faces/look";

/** A colour in OKLCH, as the tokens write them. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha: number;
}

/**
 * The tokens the office paints with: every `--room-*` token, the reserved
 * colours, the project inlays and the app's surfaces. Each names a CSS
 * custom property without its leading `--`.
 */
export type Token =
  | "room-floor"
  | "room-inlay"
  | "room-inlay-2"
  | "room-wall"
  | "room-panel"
  | "room-wood"
  | "room-desk"
  | "room-metal"
  | "room-lamp"
  | "room-plant"
  | "room-sun"
  | "room-screen"
  | "room-shade"
  | "room-fabric"
  | "room-cork"
  | "room-paper"
  | "brass"
  | "accent"
  | "you"
  | "fail"
  | "ok"
  | "proj-webshop"
  | "proj-payments"
  | "proj-ops"
  | "bg"
  | "surface"
  | "sunken"
  | "ink"
  | "muted"
  | "line"
  | "hat"
  | "face-ink"
  | "blush";

/**
 * How a surface takes the light:
 *
 * - `matte`: plaster, paint, felt-free wood;
 * - `satin`: varnished wood, painted metal;
 * - `gloss`: polished stone, glazed ceramic;
 * - `lacquer`: the Bureau's lacquer, with a clear coat over the colour;
 * - `brass`: polished metal;
 * - `metal`: brushed steel and chrome;
 * - `fabric`: upholstery and rugs, with a soft sheen;
 * - `paper`: paper and card;
 * - `glass`: window and lamp glass, see-through;
 * - `vinyl`: the colleagues, a soft toy finish with a light clear coat;
 * - `glow`: a lit surface, a lamp's shade or a window at night. Not a bloom:
 *   it only stops the surface from going dark in shadow.
 */
export type Finish =
  | "matte"
  | "satin"
  | "gloss"
  | "lacquer"
  | "brass"
  | "metal"
  | "fabric"
  | "paper"
  | "glass"
  | "vinyl"
  | "glow";

/** A shift applied to a token's colour before it is painted: lightness, chroma and hue deltas. */
export interface Shift {
  readonly dl?: number;
  readonly dc?: number;
  readonly dh?: number;
}

/** The parts of a colleague each get their own tone of the colleague's hue. */
export type HuePart = "body" | "shade" | "tint" | "ink";

const OKLCH_PATTERN =
  /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)/;

/** Parses an `oklch(...)` string; returns null for anything else. */
export function parseOklch(text: string): Oklch | null {
  const match = OKLCH_PATTERN.exec(text);
  if (match === null) return null;
  const l = Number(match[1]) / (match[2] === "%" ? 100 : 1);
  const alpha = match[5] === undefined ? 1 : Number(match[5]) / (match[6] === "%" ? 100 : 1);
  return { l, c: Number(match[3]), h: Number(match[4]), alpha };
}

/**
 * Converts an OKLCH colour to linear sRGB and writes it into `target`.
 * Colours outside sRGB are clipped per channel.
 */
export function writeOklch(target: Color, { l, c, h }: Pick<Oklch, "l" | "c" | "h">): Color {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (value: number) => Math.min(1, Math.max(0, value));
  return target.setRGB(
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    LinearSRGBColorSpace,
  );
}

/** The canvas that converts a token that is not a plain `oklch()` into sRGB. */
let probe: CanvasRenderingContext2D | null = null;

/** Reads a token from the document's current theme. */
export function readToken(name: string): Oklch {
  const style = getComputedStyle(document.documentElement);
  const raw = style.getPropertyValue(`--${name}`).trim();
  const parsed = parseOklch(raw);
  if (parsed !== null) return parsed;
  // A token written as color-mix() or var(): let the browser resolve it.
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (probe === null) throw new Error("The office could not create a 2D canvas to read colours.");
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = raw.length > 0 ? raw : "magenta";
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  const color = new Color().setRGB(r! / 255, g! / 255, b! / 255);
  // Approximate the sRGB colour back to OKLCH through three's linear sRGB.
  return { ...linearToOklch(color), alpha: a! / 255 };
}

/** Converts a linear sRGB colour to OKLCH. */
function linearToOklch(color: Color): Omit<Oklch, "alpha"> {
  const l = Math.cbrt(0.4122214708 * color.r + 0.5363325363 * color.g + 0.0514459929 * color.b);
  const m = Math.cbrt(0.2119034982 * color.r + 0.6806995451 * color.g + 0.1073969566 * color.b);
  const s = Math.cbrt(0.0883024619 * color.r + 0.2817188376 * color.g + 0.6299787005 * color.b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** Reads a number token such as `--char-l` or `--hue-iris`. */
export function readNumber(name: string): number {
  return Number(getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim());
}

/** Returns the OKLCH colour of a colleague's part in the current theme, as tokens.css derives `--who`. */
export function readHue(hue: Hue | "you" | "fail", part: HuePart): Oklch {
  const angle = readNumber(`hue-${hue}`);
  const l = readNumber("char-l");
  const c = readNumber("char-c");
  switch (part) {
    case "body":
      return { l, c, h: angle, alpha: 1 };
    case "shade":
      return { l: l - readNumber("char-shade"), c: c * 1.05, h: angle, alpha: 1 };
    case "tint":
      return { l: readNumber("char-tint-l"), c: readNumber("char-tint-c"), h: angle, alpha: 1 };
    case "ink":
      return { l: readNumber("char-ink-l"), c: c * 1.05, h: angle, alpha: 1 };
  }
}

/** Builds a fresh material with a finish's settings. */
function buildMaterial(finish: Finish): MeshStandardMaterial {
  switch (finish) {
    case "matte":
      return new MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    case "satin":
      return new MeshStandardMaterial({ roughness: 0.62, metalness: 0 });
    case "gloss":
      return new MeshStandardMaterial({ roughness: 0.3, metalness: 0 });
    case "lacquer":
      return new MeshPhysicalMaterial({
        roughness: 0.45,
        metalness: 0,
        clearcoat: 0.7,
        clearcoatRoughness: 0.22,
      });
    case "brass":
      return new MeshStandardMaterial({ roughness: 0.32, metalness: 1 });
    case "metal":
      return new MeshStandardMaterial({ roughness: 0.38, metalness: 0.75 });
    case "fabric":
      return new MeshPhysicalMaterial({
        roughness: 1,
        metalness: 0,
        sheen: 0.6,
        sheenRoughness: 0.8,
      });
    case "paper":
      return new MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
    case "glass":
      return new MeshPhysicalMaterial({
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      });
    case "vinyl":
      return new MeshPhysicalMaterial({
        roughness: 0.5,
        metalness: 0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.45,
      });
    case "glow":
      return new MeshStandardMaterial({ roughness: 0.6, metalness: 0, emissiveIntensity: 0.9 });
  }
}

/** A shared material, and how to repaint it from the current theme. */
interface Paintable {
  readonly material: MeshStandardMaterial;
  readonly read: () => Oklch;
  readonly shift: Shift;
}

const paintables = new Map<string, Paintable>();

/** Writes the colour `read` returns, shifted, into a paintable's material. */
function applyPaint({ material, read, shift }: Paintable): void {
  const base = read();
  const color = {
    l: base.l + (shift.dl ?? 0),
    c: Math.max(0, base.c + (shift.dc ?? 0)),
    h: base.h + (shift.dh ?? 0),
  };
  writeOklch(material.color, color);
  if (material.emissiveIntensity > 0 && material.emissive.getHex() !== 0) {
    writeOklch(material.emissive, color);
  }
}

const WHITE: Oklch = { l: 1, c: 0, h: 0, alpha: 1 };

/** Returns the shared material for a key, building and painting it the first time. */
function share(key: string, finish: Finish, read: () => Oklch, shift: Shift): MeshStandardMaterial {
  const known = paintables.get(key);
  if (known !== undefined) return known.material;
  const material = buildMaterial(finish);
  if (finish === "glow") material.emissive.setRGB(1, 1, 1);
  material.name = key;
  const paintable: Paintable = { material, read, shift };
  applyPaint(paintable);
  paintables.set(key, paintable);
  return material;
}

/**
 * Returns the shared material that paints `token` in `finish`, with `shift`
 * applied to its colour. The same arguments always return the same material.
 */
export function paint(
  token: Token,
  finish: Finish = "satin",
  shift: Shift = {},
): MeshStandardMaterial {
  const key = `${token}|${finish}|${String(shift.dl ?? 0)}|${String(shift.dc ?? 0)}|${String(shift.dh ?? 0)}`;
  return share(key, finish, () => readToken(token), shift);
}

/**
 * Returns the shared material that paints a colleague's `part` in its crew
 * `hue`, in `finish`. Marigold (`you`) is the raised palm's colour.
 */
export function paintHue(
  hue: Hue | "you" | "fail",
  part: HuePart = "body",
  finish: Finish = "vinyl",
  shift: Shift = {},
): MeshStandardMaterial {
  const key = `hue:${hue}|${part}|${finish}|${String(shift.dl ?? 0)}|${String(shift.dc ?? 0)}`;
  return share(key, finish, () => readHue(hue, part), shift);
}

/**
 * Returns the shared white material in `finish` for meshes that carry their
 * colours in their vertices, such as the props kit's merged furniture. Its
 * own colour stays white so the vertex colours show unchanged.
 */
export function paintVertexColors(finish: Finish): MeshStandardMaterial {
  const material = share(`vertex-colours|${finish}`, finish, () => WHITE, {});
  material.vertexColors = true;
  return material;
}

const refreshListeners = new Set<() => void>();

/** Repaints every shared material from the current theme. Call it after the theme changes. */
export function refreshPalette(): void {
  for (const paintable of paintables.values()) applyPaint(paintable);
  for (const listener of refreshListeners) listener();
}

/**
 * Calls `listener` after every repaint, so what the palette does not paint
 * itself, such as text drawn on a canvas texture, can redraw in the new
 * theme's colours. Returns the function that unsubscribes.
 */
export function subscribePalette(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

/** Returns a token's colour as a three.js colour, for lights, fog and the background. */
export function readColor(token: Token, shift: Shift = {}): Color {
  const base = readToken(token);
  return writeOklch(new Color(), {
    l: base.l + (shift.dl ?? 0),
    c: Math.max(0, base.c + (shift.dc ?? 0)),
    h: base.h + (shift.dh ?? 0),
  });
}

/** Whether the current theme is a dark one, which the office draws as evening. */
export function isDarkTheme(): boolean {
  return getComputedStyle(document.documentElement).colorScheme.includes("dark");
}

/** Every shared material, for the performance overlay's count and for disposal. */
export function listMaterials(): ReadonlyArray<Material> {
  return [...paintables.values()].map((paintable) => paintable.material);
}
