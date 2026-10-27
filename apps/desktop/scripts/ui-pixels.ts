import type {
  ProbeColour,
  ProbeRect,
  TextFragment,
} from "../src/renderer/specimens/ui-probe-types.ts";
import {
  blendOver,
  computeApcaContrast,
  computeWcagContrast,
  mixColours,
  packColour,
  unpackColour,
} from "./ui-colour.ts";

/**
 * Pixel maths for the UI metrics (docs/research/ui-hill-climb.md, section
 * 4.1): what the colours on a screenshot say about the contrast of text, the
 * focus ring, and the edges and marks of controls. Everything here reads
 * decoded screenshots and boxes in CSS pixels, and uses nothing of the page.
 */

/** A decoded screenshot: `width` by `height` device pixels, four bytes each (red, green, blue, alpha), row by row. `PNG.sync.read` from pngjs returns this shape. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A rectangle of whole device pixels: `left` and `top` are included, `right` and `bottom` are not. */
interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The contrast of a piece of text with the surfaces behind it. */
export interface FragmentContrast {
  /** The APCA Lc at the 10th percentile of the surfaces, by pixel count. Its sign is APCA's: negative for light text on a dark surface. */
  readonly apcaLc: number;
  /** The WCAG 2.x contrast ratio at the 10th percentile of the surfaces, by pixel count. */
  readonly wcagRatio: number;
  /** False when the text sits in two or more nested opacity groups, which the measurement cannot take apart. The numbers are then an estimate and the caller counts the fragment as failing. */
  readonly supported: boolean;
}

/** Whether a control shows a focus ring, and the pixel counts behind the answer. */
export interface FocusRingResult {
  readonly visible: boolean;
  /** Device pixels of the clip whose colour changed to one with a WCAG ratio of at least 3 against the unfocused colour. */
  readonly qualifyingPixels: number;
  /** Half the target's perimeter in device pixels: the least a ring that is seen must cover. */
  readonly requiredPixels: number;
}

/** Whether the edge or the mark of a control stands out from what surrounds it, and the pixel counts behind the answer. */
export interface NonTextResult {
  readonly passes: boolean;
  /** Device pixels in the examined region whose WCAG ratio against the outside colour is at least 3. */
  readonly qualifyingPixels: number;
  /** The least `qualifyingPixels` that passes: the box's width plus its height, in device pixels. */
  readonly requiredPixels: number;
  /** The most common colour just outside the box. Null when the box has no pixels around it on the image. */
  readonly outsideColour: ProbeColour | null;
}

/** The WCAG ratio that non-text parts and focus rings need (WCAG 1.4.11 and 2.4.13). */
const MINIMUM_NON_TEXT_RATIO = 3;

/** The share of a fragment's pixels that may have worse contrast than its reported contrast. */
const CONTRAST_PERCENTILE = 0.1;

/** How far outside a box the surrounding colour is read, in CSS px. */
const OUTSIDE_BAND = 3;

/** How far inside a box's edge a boundary is looked for, in CSS px. */
const BOUNDARY_BAND = 2;

/**
 * Converts a box in CSS px to device pixels, rounding each edge to the nearest
 * pixel, so that a pixel belongs to a box when its centre lies inside it. The
 * result is not cut to any image.
 */
function toPixelRect(box: ProbeRect, scale: number): PixelRect {
  return {
    left: Math.round(box.left * scale),
    top: Math.round(box.top * scale),
    right: Math.round(box.right * scale),
    bottom: Math.round(box.bottom * scale),
  };
}

/** Returns the part of `rect` that lies on the image. The result may have no pixels, which is when its right is not past its left or its bottom not past its top. */
function cutToImage(rect: PixelRect, image: DecodedImage): PixelRect {
  return {
    left: Math.max(rect.left, 0),
    top: Math.max(rect.top, 0),
    right: Math.min(rect.right, image.width),
    bottom: Math.min(rect.bottom, image.height),
  };
}

/** Returns whether the pixel at `x`, `y` lies in `rect`. */
function contains(rect: PixelRect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/** Returns the pixel at `x`, `y` as one number, 0xRRGGBBAA, which is what `packColour` makes and `Buffer.readUInt32BE` reads. */
function readPackedPixel(image: DecodedImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  const { data } = image;
  return (
    (((data[offset] ?? 0) << 24) |
      ((data[offset + 1] ?? 0) << 16) |
      ((data[offset + 2] ?? 0) << 8) |
      (data[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Calls `visit` with the packed colour of every pixel of `region` that is on
 * the image and not in `excluded`, row by row. The `excluded` rectangle lets a
 * caller walk a frame (a band around or inside a box) without a second pass.
 */
function forEachPixel(
  image: DecodedImage,
  region: PixelRect,
  excluded: PixelRect | null,
  visit: (packed: number, x: number, y: number) => void,
): void {
  const onImage = cutToImage(region, image);
  for (let y = onImage.top; y < onImage.bottom; y += 1) {
    for (let x = onImage.left; x < onImage.right; x += 1) {
      if (excluded === null || !contains(excluded, x, y)) {
        visit(readPackedPixel(image, x, y), x, y);
      }
    }
  }
}

/** Counts the pixels of `region` by colour, leaving out `excluded`. */
function countColoursIn(
  image: DecodedImage,
  region: PixelRect,
  excluded: PixelRect | null,
): Map<number, number> {
  const counts = new Map<number, number>();
  forEachPixel(image, region, excluded, (packed) => {
    counts.set(packed, (counts.get(packed) ?? 0) + 1);
  });
  return counts;
}

/**
 * Counts the pixels inside `box` by colour. The box is in CSS px and `scale`
 * is the device pixel ratio of the image. The part of the box outside the
 * image is ignored, so a box that is wholly outside gives an empty map.
 * Returns packed colours (see `packColour`) mapped to their pixel counts.
 */
export function countColours(
  image: DecodedImage,
  box: ProbeRect,
  scale: number,
): Map<number, number> {
  return countColoursIn(image, toPixelRect(box, scale), null);
}

/**
 * Returns the colour with the most pixels in `counts`, or null when `counts`
 * is empty. When two colours tie, the one with the lower packed value wins, so
 * that the answer does not depend on the order of the pixels.
 */
export function findModeColour(counts: Map<number, number>): ProbeColour | null {
  let modePacked: number | null = null;
  let modeCount = 0;
  for (const [packed, count] of counts) {
    if (count > modeCount || (count === modeCount && modePacked !== null && packed < modePacked)) {
      modePacked = packed;
      modeCount = count;
    }
  }
  return modePacked === null ? null : unpackColour(modePacked);
}

/**
 * Returns the entry at `fraction` of the total weight, taking the entries in
 * ascending order of value: the first entry such that the entries up to and
 * including it hold at least `fraction` of the weight. So with `fraction` 0.1,
 * at least 10% of the weight has a value lower than or equal to the result.
 * Fails when there are no entries or their weight is zero.
 */
function selectPercentile<Entry extends { readonly value: number; readonly weight: number }>(
  entries: ReadonlyArray<Entry>,
  fraction: number,
): Entry {
  const sorted = entries.toSorted((first, second) => first.value - second.value);
  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    throw new Error("A percentile needs at least one entry with a weight above zero.");
  }
  const target = fraction * totalWeight;
  let cumulativeWeight = 0;
  for (const entry of sorted) {
    cumulativeWeight += entry.weight;
    if (cumulativeWeight >= target) {
      return entry;
    }
  }
  // Only reachable when rounding leaves the cumulative weight just under the target.
  return sorted[sorted.length - 1] as Entry;
}

/**
 * Returns the value at `fraction` (0 to 1) of the total weight: the lowest
 * value such that entries up to it hold at least `fraction` of the weight.
 * Fails when there are no entries or their weight is zero.
 */
export function computePercentile(
  values: ReadonlyArray<{ readonly value: number; readonly weight: number }>,
  fraction: number,
): number {
  return selectPercentile(values, fraction).value;
}

/** Returns `colour` with alpha 1. Compositing over an opaque colour is opaque, but rounding can leave an alpha like 0.9999999 that the contrast functions refuse. */
function toOpaque(colour: ProbeColour): ProbeColour {
  return [colour[0], colour[1], colour[2], 1];
}

/** Returns `value` cut to the range of a colour channel, 0 to 255. */
function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

/**
 * Returns the colour a viewer sees for the text of `fragment` over the
 * surface `surface`, as a function of the surface. It is the text colour
 * composited over the surface, plus what an opacity group does.
 *
 * With one opacity group `a`, `backdrop` is the colour behind the group and
 * `surface` is what the group looks like over it: `S = a * G + (1 - a) * B`,
 * where `G` is the group's own surface. So `G = (S - (1 - a) * B) / a`, and
 * the group renders text over `G` and then mixes the result with `B`.
 */
function computeEffectiveText(
  textColour: ProbeColour,
  surface: ProbeColour,
  group: { readonly opacity: number; readonly backdrop: ProbeColour } | null,
): ProbeColour {
  if (group === null) {
    return toOpaque(blendOver(textColour, surface));
  }
  const { opacity, backdrop } = group;
  const own = (index: 0 | 1 | 2): number =>
    clampChannel((surface[index] - (1 - opacity) * backdrop[index]) / opacity);
  const groupSurface: ProbeColour = [own(0), own(1), own(2), 1];
  return toOpaque(mixColours(blendOver(textColour, groupSurface), backdrop, opacity));
}

/**
 * Measures the contrast of a piece of text from two screenshots of the same
 * page. `textHidden` has the text made transparent, so each pixel of the
 * fragment's visible box is a surface the text sits on. `behind` is the same
 * page with the fragment's outermost opacity group hidden; it is read only
 * when the fragment has such a group, and fails with an error when it is
 * needed and null.
 *
 * For every surface colour in the box, the text colour over that surface is
 * compared with the surface, in APCA and in WCAG. The result is the 10th
 * percentile by pixel count of each, taken separately: the worst 10% of the
 * pixels do not count, but a surface that covers more than 10% of the box
 * does. APCA is ranked by its absolute value and keeps the sign of the colour
 * at that rank.
 *
 * Returns null when the fragment has no visible box or the box has no pixels
 * on the image. Nested opacity groups cannot be separated, so the numbers
 * treat the outermost group alone, with the product of all the opacities, and
 * `supported` is false.
 */
export function measureFragmentContrast(
  fragment: TextFragment,
  textHidden: DecodedImage,
  behind: DecodedImage | null,
  scale: number,
): FragmentContrast | null {
  if (fragment.visibleBox === null) {
    return null;
  }
  const surfaces = countColours(textHidden, fragment.visibleBox, scale);
  if (surfaces.size === 0) {
    return null;
  }

  let group: { readonly opacity: number; readonly backdrop: ProbeColour } | null = null;
  if (fragment.opacityGroups.length > 0) {
    if (behind === null) {
      throw new Error(
        "A fragment inside an opacity group needs the capture with that group hidden, but none was given.",
      );
    }
    const backdrop = findModeColour(countColours(behind, fragment.visibleBox, scale));
    if (backdrop === null) {
      throw new Error(
        "The capture with the opacity group hidden has no pixels where the fragment is. It must be a capture of the same window.",
      );
    }
    const opacity = fragment.opacityGroups.reduce((product, one) => product * one.opacity, 1);
    group = { opacity, backdrop: toOpaque(backdrop) };
  }

  const apca: Array<{ value: number; weight: number; signedLc: number }> = [];
  const wcag: Array<{ value: number; weight: number }> = [];
  for (const [packed, weight] of surfaces) {
    const surface = unpackColour(packed);
    const text = computeEffectiveText(fragment.colour, surface, group);
    const signedLc = computeApcaContrast(text, surface);
    apca.push({ value: Math.abs(signedLc), weight, signedLc });
    wcag.push({ value: computeWcagContrast(text, surface), weight });
  }

  return {
    apcaLc: selectPercentile(apca, CONTRAST_PERCENTILE).signedLc,
    wcagRatio: computePercentile(wcag, CONTRAST_PERCENTILE),
    supported: fragment.opacityGroups.length <= 1,
  };
}

/**
 * Returns a function that tells whether two packed colours have a WCAG ratio
 * of at least 3. It remembers its answers per pair, because a screenshot has
 * many pixels but few distinct colours, and the ratio is slow to compute.
 * Two equal colours have a ratio of 1, so they never qualify.
 */
function buildContrastMemo(): (first: number, second: number) => boolean {
  const answers = new Map<number, Map<number, boolean>>();
  return (first, second) => {
    if (first === second) {
      return false;
    }
    let row = answers.get(first);
    if (row === undefined) {
      row = new Map();
      answers.set(first, row);
    }
    let answer = row.get(second);
    if (answer === undefined) {
      answer =
        computeWcagContrast(unpackColour(first), unpackColour(second)) >= MINIMUM_NON_TEXT_RATIO;
      row.set(second, answer);
    }
    return answer;
  };
}

/**
 * Checks that focusing a control draws something seen. `focusedClip` is a
 * screenshot of only the `clip` region (CSS px) taken with the control
 * focused, and `unfocused` is the full-window capture taken with nothing
 * focused. Each pixel of `focusedClip` is compared with the same pixel of
 * `unfocused`, and counts when the two colours have a WCAG ratio of at least
 * 3. The ring is visible when the counted pixels number at least half of the
 * perimeter of `target` (CSS px) in device pixels, so a ring that wraps the
 * control passes and a lone changed pixel does not. `clip` must lie on the
 * window, because the pixel at the top left of `focusedClip` is taken to be
 * the clip's top left.
 *
 * `unfocused` must have no focus ring anywhere. A capture in which another
 * control still shows its ring would count that ring's disappearance, inside
 * the clip, as a change, and a control without a ring could pass.
 */
export function checkFocusRing(
  unfocused: DecodedImage,
  focusedClip: DecodedImage,
  clip: ProbeRect,
  target: ProbeRect,
  scale: number,
): FocusRingResult {
  const originX = Math.round(clip.left * scale);
  const originY = Math.round(clip.top * scale);
  const hasContrast = buildContrastMemo();
  let qualifyingPixels = 0;
  for (let y = 0; y < focusedClip.height; y += 1) {
    for (let x = 0; x < focusedClip.width; x += 1) {
      const unfocusedX = originX + x;
      const unfocusedY = originY + y;
      if (unfocusedX >= unfocused.width || unfocusedY >= unfocused.height) {
        continue;
      }
      if (
        hasContrast(
          readPackedPixel(unfocused, unfocusedX, unfocusedY),
          readPackedPixel(focusedClip, x, y),
        )
      ) {
        qualifyingPixels += 1;
      }
    }
  }
  const requiredPixels = (target.right - target.left + (target.bottom - target.top)) * scale;
  return { visible: qualifyingPixels >= requiredPixels, qualifyingPixels, requiredPixels };
}

/** A pixel differs from another when any of its channels differs by more than this (of 255). */
const MINIMUM_CHANNEL_DIFFERENCE = 32;

/**
 * Counts the pixels at which two boxes of the same image differ. `first` and
 * `second` are boxes in CSS px of the same size; the pixel at an offset in the
 * first is compared with the pixel at the same offset in the second. Two
 * pixels differ when any of their four channels differs by more than 32.
 * Fails when the boxes do not have the same size in device pixels, or when
 * one reaches outside the image, because a count over part of a glyph says
 * nothing about the glyph.
 */
export function countDifferingPixels(
  image: DecodedImage,
  first: ProbeRect,
  second: ProbeRect,
  scale: number,
): number {
  const firstPixels = toPixelRect(first, scale);
  const secondPixels = toPixelRect(second, scale);
  const width = firstPixels.right - firstPixels.left;
  const height = firstPixels.bottom - firstPixels.top;
  if (
    width !== secondPixels.right - secondPixels.left ||
    height !== secondPixels.bottom - secondPixels.top
  ) {
    throw new Error(
      `The two boxes have different sizes (${String(width)}x${String(height)} and ${String(secondPixels.right - secondPixels.left)}x${String(secondPixels.bottom - secondPixels.top)} device pixels), so they cannot be compared pixel by pixel.`,
    );
  }
  for (const pixels of [firstPixels, secondPixels]) {
    const cut = cutToImage(pixels, image);
    if (
      cut.left !== pixels.left ||
      cut.top !== pixels.top ||
      cut.right !== pixels.right ||
      cut.bottom !== pixels.bottom
    ) {
      throw new Error("A box to compare reaches outside the image.");
    }
  }
  let differing = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const firstOffset = ((firstPixels.top + y) * image.width + firstPixels.left + x) * 4;
      const secondOffset = ((secondPixels.top + y) * image.width + secondPixels.left + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const difference = Math.abs(
          (image.data[firstOffset + channel] ?? 0) - (image.data[secondOffset + channel] ?? 0),
        );
        if (difference > MINIMUM_CHANNEL_DIFFERENCE) {
          differing += 1;
          break;
        }
      }
    }
  }
  return differing;
}

/**
 * Checks that the edge or the mark of a control stands out from what is around
 * it, for WCAG 1.4.11. The outside colour is the most common colour in a band
 * 3 CSS px wide just outside `box`.
 *
 * - `boundary`: the examined pixels are a band 2 CSS px wide just inside the
 *   box's edge. A visible border passes by covering at least half of the
 *   band's perimeter with pixels that contrast with the outside.
 * - `mark`: the examined pixels are the whole box. The mark passes by
 *   covering at least as many contrasting pixels as the box's width plus its
 *   height, which a line across the box does and a single dot does not.
 *
 * Both need `box` width plus height in device pixels, which is half the
 * perimeter. Returns `passes` false when there are no pixels outside the box
 * to compare with.
 */
export function checkNonTextPart(
  image: DecodedImage,
  box: ProbeRect,
  kind: "boundary" | "mark",
  scale: number,
): NonTextResult {
  const boxPixels = toPixelRect(box, scale);
  const outerBand = toPixelRect(
    {
      left: box.left - OUTSIDE_BAND,
      top: box.top - OUTSIDE_BAND,
      right: box.right + OUTSIDE_BAND,
      bottom: box.bottom + OUTSIDE_BAND,
    },
    scale,
  );
  const outsideColour = findModeColour(countColoursIn(image, outerBand, boxPixels));
  const requiredPixels = (box.right - box.left + (box.bottom - box.top)) * scale;
  if (outsideColour === null) {
    return { passes: false, qualifyingPixels: 0, requiredPixels, outsideColour: null };
  }

  const innerBox =
    kind === "boundary"
      ? toPixelRect(
          {
            left: box.left + BOUNDARY_BAND,
            top: box.top + BOUNDARY_BAND,
            right: box.right - BOUNDARY_BAND,
            bottom: box.bottom - BOUNDARY_BAND,
          },
          scale,
        )
      : null;
  const outside = packColour(outsideColour);
  const hasContrast = buildContrastMemo();
  let qualifyingPixels = 0;
  forEachPixel(image, boxPixels, innerBox, (packed) => {
    if (hasContrast(outside, packed)) {
      qualifyingPixels += 1;
    }
  });
  return {
    passes: qualifyingPixels >= requiredPixels,
    qualifyingPixels,
    requiredPixels,
    outsideColour,
  };
}

/**
 * Returns the WCAG contrast ratio that the edge of a control reaches over at
 * least half of its perimeter. It reads the same pixels as `checkNonTextPart`
 * with the kind `boundary`: the band 2 CSS px wide just inside `box`, against
 * the most common colour in the band 3 CSS px wide just outside it. It sorts
 * the band's pixels by their ratio against that outside colour, highest
 * first, and returns the ratio of the pixel at which their number reaches
 * `box` width plus height in device pixels. So the edge passes the check
 * exactly when this number is at least 3.
 *
 * Returns 1 (no contrast at all) when fewer pixels than that lie in the band
 * or when there are no pixels outside the box to compare with.
 */
export function measureBoundaryContrast(
  image: DecodedImage,
  box: ProbeRect,
  scale: number,
): number {
  const boxPixels = toPixelRect(box, scale);
  const outerBand = toPixelRect(
    {
      left: box.left - OUTSIDE_BAND,
      top: box.top - OUTSIDE_BAND,
      right: box.right + OUTSIDE_BAND,
      bottom: box.bottom + OUTSIDE_BAND,
    },
    scale,
  );
  const outsideColour = findModeColour(countColoursIn(image, outerBand, boxPixels));
  if (outsideColour === null) {
    return 1;
  }
  const innerBox = toPixelRect(
    {
      left: box.left + BOUNDARY_BAND,
      top: box.top + BOUNDARY_BAND,
      right: box.right - BOUNDARY_BAND,
      bottom: box.bottom - BOUNDARY_BAND,
    },
    scale,
  );
  const requiredPixels = (box.right - box.left + (box.bottom - box.top)) * scale;
  const ratiosByCount = [...countColoursIn(image, boxPixels, innerBox)].map(([packed, count]) => ({
    ratio: computeWcagContrast(unpackColour(packed), outsideColour),
    count,
  }));
  ratiosByCount.sort((first, second) => second.ratio - first.ratio);
  let covered = 0;
  for (const { ratio, count } of ratiosByCount) {
    covered += count;
    if (covered >= requiredPixels) {
      return ratio;
    }
  }
  return 1;
}
