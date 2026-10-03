/**
 * The Office's lettering: brass-framed plaques with a room's name in the UI
 * face.
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
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from "three";
import type { Hue } from "../../faces/look";
import { paint, paintHue } from "../engine/palette";

import {
  buildCanvasLabel,
  buildPaintedMesh,
  placeBox,
  readCssColor,
  uiFont,
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
 * 0.124 for the padding and the frame.
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
