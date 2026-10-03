/**
 * The Office's lettering: brass-framed plaques with a room's name in the UI
 * face, and the large wordmark over an entrance in the Deco display face.
 *
 * A plaque's text is drawn on a canvas texture that redraws when the theme
 * changes and when the face has loaded. A plaque is sized from an estimate of
 * the face's letter widths, not from a measurement, so it has the same size
 * whether the face has loaded or not; its text is squeezed to fit if it comes
 * out wider than the estimate.
 */
import {
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector2,
} from "three";
import type { Hue } from "../../faces/look";
import { paint, paintHue } from "../engine/palette";
import { traceShapes } from "./architecture-outline";
import {
  buildCanvasLabel,
  buildPaintedMesh,
  decoFont,
  isDecoFontReady,
  placeBox,
  readCssColor,
  uiFont,
  waitForDecoFont,
  type PaintedParts,
} from "./architecture-shared";

/** The plaque's enamel face height. */
const PLAQUE_FACE_HEIGHT = 0.12;
/** The plaque's letter size: the face's em, in metres. */
const PLAQUE_EM = 0.056;
/** The extra space between letters, as a share of the em. */
const PLAQUE_TRACKING = 0.08;
/** The space between the text and the frame at each end. */
const PLAQUE_PADDING = 0.05;
/** The room a crew hue chip takes at the face's left end. */
const PLAQUE_CHIP = 0.05;
/** The brass frame around the face. */
const PLAQUE_RIM = 0.012;
/** How many canvas pixels draw one metre of a plaque's face. */
const PLAQUE_PIXELS_PER_METRE = 1600;

/**
 * Returns the estimated advance of `text` in the plaque's face, in ems,
 * without the tracking. The widths are averaged per kind of character, so a
 * plaque is the same size before and after the face loads.
 */
function estimatePlaqueAdvance(text: string): number {
  let advance = 0;
  for (const character of text) {
    if (character === " ") advance += 0.26;
    else if (/[MW]/.test(character)) advance += 0.86;
    else if (/[IJ1]/.test(character)) advance += 0.34;
    else if (/[A-Z0-9]/.test(character)) advance += 0.66;
    else if (/[.,:;'!|-]/.test(character)) advance += 0.3;
    else advance += 0.62;
  }
  return advance;
}

/**
 * Returns a plaque's width for `text` in metres, frame included. A layout can
 * call it to space plaques before it builds them.
 */
export function measurePlaque(text: string, options: { readonly hue?: Hue } = {}): number {
  return plaqueFaceWidth(text.toUpperCase(), options.hue !== undefined) + 2 * PLAQUE_RIM;
}

/** Returns the width of a plaque's enamel face for `text`, which is already upper case. */
function plaqueFaceWidth(text: string, hasChip: boolean): number {
  const characters = [...text].length;
  const textWidth =
    (estimatePlaqueAdvance(text) + PLAQUE_TRACKING * Math.max(0, characters - 1)) * PLAQUE_EM;
  return textWidth + 2 * PLAQUE_PADDING + (hasChip ? PLAQUE_CHIP : 0);
}

/**
 * Builds a brass-framed plaque with `text` in the UI face, in capitals,
 * cream on a dark enamel face. With `hue`, a small enamel chip in the crew's
 * colour sits at the left end. The frame and the chip are one mesh and the
 * face another.
 *
 * The plaque's back is at z = 0 and its centre at y = 0, so a layout hangs it
 * flat on a wall. Its face is 0.12 tall and about 0.04 wide per letter, plus
 * 0.124 for the padding and the frame; `measurePlaque` returns the exact width.
 */
export function buildPlaque(text: string, options: { readonly hue?: Hue } = {}): Object3D {
  const label = text.toUpperCase();
  const hasChip = options.hue !== undefined;
  const faceWidth = plaqueFaceWidth(label, hasChip);
  const faceHeight = PLAQUE_FACE_HEIGHT;
  const object = new Group();

  // The brass: a back plate, a rim round the face, and a stepped crest on top.
  const outerWidth = faceWidth + 2 * PLAQUE_RIM;
  const outerHeight = faceHeight + 2 * PLAQUE_RIM;
  const top = faceHeight / 2;
  const brass: BufferGeometry[] = [
    placeBox(outerWidth, outerHeight, 0.008, 0, -outerHeight / 2, 0.004),
    placeBox(outerWidth, PLAQUE_RIM, 0.016, 0, top, 0.008),
    placeBox(outerWidth, PLAQUE_RIM, 0.016, 0, -top - PLAQUE_RIM, 0.008),
    placeBox(PLAQUE_RIM, faceHeight, 0.016, -faceWidth / 2 - PLAQUE_RIM / 2, -top, 0.008),
    placeBox(PLAQUE_RIM, faceHeight, 0.016, faceWidth / 2 + PLAQUE_RIM / 2, -top, 0.008),
    placeBox(Math.min(0.16, outerWidth * 0.4), 0.014, 0.008, 0, top + PLAQUE_RIM, 0.004),
    placeBox(Math.min(0.07, outerWidth * 0.2), 0.012, 0.008, 0, top + PLAQUE_RIM + 0.014, 0.004),
  ];
  const groups: PaintedParts[] = [[paint("brass", "brass"), brass]];
  if (options.hue !== undefined) {
    // The hue chip: an enamel disc in a brass bezel, left of the text.
    const chipX = -faceWidth / 2 + PLAQUE_PADDING * 0.5 + PLAQUE_CHIP / 2;
    brass.push(
      new CylinderGeometry(0.024, 0.024, 0.004, 24).rotateX(Math.PI / 2).translate(chipX, 0, 0.014),
    );
    const chip = new CylinderGeometry(0.017, 0.017, 0.006, 24).rotateX(Math.PI / 2);
    groups.push([paintHue(options.hue, "body", "gloss"), [chip.translate(chipX, 0, 0.018)]]);
  }
  object.add(buildPaintedMesh(groups, { cast: false })!);

  // The enamel face, drawn on a canvas.
  const pixelWidth = Math.min(4096, Math.round(faceWidth * PLAQUE_PIXELS_PER_METRE));
  const pixelHeight = Math.round(faceHeight * PLAQUE_PIXELS_PER_METRE);
  const scale = pixelWidth / faceWidth;
  const textLeft = (PLAQUE_PADDING + (hasChip ? PLAQUE_CHIP : 0)) * scale;
  const textRight = pixelWidth - PLAQUE_PADDING * scale;
  const font = uiFont(Math.round(PLAQUE_EM * scale));
  const { texture } = buildCanvasLabel(pixelWidth, pixelHeight, font, (context) => {
    context.fillStyle = readCssColor("room-inlay-2", -0.06);
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    // A thin brass line inset from the rim, the plaque's Deco double frame.
    const inset = pixelHeight * 0.09;
    context.strokeStyle = readCssColor("brass");
    context.lineWidth = Math.max(2, pixelHeight * 0.018);
    context.strokeRect(inset, inset, pixelWidth - 2 * inset, pixelHeight - 2 * inset);
    context.font = font;
    context.letterSpacing = `${String(Math.round(PLAQUE_TRACKING * PLAQUE_EM * scale))}px`;
    context.fillStyle = readCssColor("room-paper", 0.02);
    context.textAlign = "center";
    const metrics = context.measureText(label);
    const baseline =
      pixelHeight / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
    context.fillText(label, (textLeft + textRight) / 2, baseline, textRight - textLeft);
  });
  const material = new MeshStandardMaterial({ map: texture, roughness: 0.42, metalness: 0 });
  const faceGeometry = new PlaneGeometry(faceWidth, faceHeight).translate(0, 0, 0.012);
  faceGeometry.addEventListener("dispose", () => {
    texture.dispose();
    material.dispose();
  });
  object.add(new Mesh(faceGeometry, material));
  return object;
}

/** A wordmark's depth, from its back to its face. */
const WORDMARK_DEPTH = 0.06;
/** The extra space between a wordmark's letters, as a share of the em. */
const WORDMARK_TRACKING = 0.06;
/** The em, in canvas pixels, that a wordmark's letters are drawn at to be traced. */
const WORDMARK_TRACE_EM = 256;

/**
 * Builds a wordmark: `text` in large Deco capitals of solid brass, 0.06 deep,
 * `height` tall from the foot of the capitals to their top, standing on y = 0,
 * centred on x = 0, with its back at z = 0 and facing +z. Each letter is
 * about `height` wide, spacing included: "Hercule" at 0.55 is 3.8 wide.
 *
 * The letters are real geometry, traced from the display face drawn on a
 * canvas. Until the face has loaded they are traced from a fallback face, and
 * traced again once it arrives.
 */
export function buildWordmark(text: string, height: number): Object3D {
  const label = text.toUpperCase();
  const mesh = new Mesh(buildWordmarkGeometry(label, height), paint("brass", "brass"));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (!isDecoFontReady()) {
    void waitForDecoFont().then(() => {
      mesh.geometry.dispose();
      mesh.geometry = buildWordmarkGeometry(label, height);
      // Nothing may be moving, so ask for a frame to show the new letters.
      window.office?.stage.requestRender();
    });
  }
  const object = new Group();
  object.add(mesh);
  return object;
}

/**
 * Returns the wordmark's letters as one extruded geometry: `label` drawn in
 * the display face on a canvas, traced, scaled so the capitals are `height`
 * tall, and centred on x = 0. Returns an empty geometry for blank text.
 */
function buildWordmarkGeometry(label: string, height: number): BufferGeometry {
  if (label.trim() === "") return new BufferGeometry();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("The architecture kit could not create a 2D canvas.");
  const setStyle = () => {
    context.font = decoFont(WORDMARK_TRACE_EM);
    context.letterSpacing = `${String(Math.round(WORDMARK_TRACKING * WORDMARK_TRACE_EM))}px`;
  };
  setStyle();
  const ink = context.measureText(label);
  const margin = 4;
  canvas.width = Math.ceil(ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight) + 2 * margin;
  canvas.height =
    Math.ceil(ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent) + 2 * margin;
  // Resizing a canvas resets its drawing state.
  setStyle();
  const baseline = margin + ink.actualBoundingBoxAscent;
  context.fillText(label, margin + ink.actualBoundingBoxLeft, baseline);
  // The capitals rise `actualBoundingBoxAscent` pixels above the baseline, which becomes y = 0.
  const metresPerPixel = height / ink.actualBoundingBoxAscent;
  const shapes = traceShapes(
    context.getImageData(0, 0, canvas.width, canvas.height),
    (x, y) => new Vector2(x * metresPerPixel, (baseline - y) * metresPerPixel),
  );
  const geometry = new ExtrudeGeometry(shapes, { depth: WORDMARK_DEPTH, bevelEnabled: false });
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  geometry.translate(-(box.min.x + box.max.x) / 2, 0, 0);
  return geometry;
}
