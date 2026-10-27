/**
 * Turns what the UI probe and the pixel checks found on one page into the
 * numbers of `pnpm ui:metrics` (docs/research/ui-hill-climb.md, section 4.1).
 * Every function here is pure: it takes facts and returns a record of metric
 * names (see `METRICS` in ui-ratchet.ts) to numbers. The caller
 * (scripts/ui-measure.ts) gathers the facts and puts the key prefix on the
 * names.
 */
import type {
  ClippingFacts,
  DisciplineFacts,
  ProbeTarget,
  ProseFacts,
  TextFragment,
  TextRole,
  ThemeTokens,
} from "../src/renderer/specimens/ui-probe-types.ts";
import { blendOver, computeApcaContrast, computeOklchLightness } from "./ui-colour.ts";
import type { FragmentContrast } from "./ui-pixels.ts";
import { METRICS } from "./ui-ratchet.ts";

/** Metric names to the numbers measured for them. */
export type MetricValues = Record<string, number>;

/** A line of text and the contrast measured for it. */
export interface MeasuredFragment {
  readonly fragment: TextFragment;
  readonly contrast: FragmentContrast;
}

/** The roles that have a contrast target. Text of the role `other` has only the WCAG check. */
const TARGET_ROLES = ["ink", "muted", "faint", "placeholder", "disabled"] as const;

/** All roles, for the coverage counts. */
const ALL_ROLES: ReadonlyArray<TextRole> = [...TARGET_ROLES, "other"];

/** In a dark theme, ink brighter than this Lc glares (plan section 4.1). */
const INK_CEILING_LC = 95;

/** The size from which text is "large" for WCAG, in px, as the plan states it. */
const LARGE_TEXT_PX = 18;

/** The WCAG ratio that text below `LARGE_TEXT_PX` needs. */
const SMALL_TEXT_RATIO = 4.5;

/** The WCAG ratio that large text needs. */
const LARGE_TEXT_RATIO = 3;

/** Faint text is for metadata, so it may not be larger than this, in px. */
const FAINT_MAXIMUM_PX = 12;

/** Spacing values within this many px of a multiple of 4 count as on the grid. */
const GRID_TOLERANCE_PX = 0.01;

/** The prose line length that reads well, in characters (plan section 4.1). */
const PROSE_MEASURE_BAND = { minimum: 60, maximum: 75 } as const;

/** A pair of glyphs with fewer differing pixels than this is too easily confused. */
const MINIMUM_DIFFERING_PIXELS = 4;

/** The least size a click target may have, in px, for the two target-size metrics. */
const TARGET_SIZE_LIMITS = { under24: 24, under28: 28 } as const;

/** How far under a limit a size must be to count as under it: layout leaves subpixel noise on boxes. */
const SIZE_TOLERANCE_PX = 0.01;

/**
 * Returns whether the contrast of a measured line is a real measure. It is not
 * when the pixels behind the text are an estimate: the text sits in nested
 * opacity groups (`contrast.supported` is false), or a translucent layer lies
 * over part of it (`partlyCovered`).
 */
function hasSupportedContrast({ fragment, contrast }: MeasuredFragment): boolean {
  return contrast.supported && !fragment.partlyCovered;
}

/**
 * Summarizes the contrast of the measured text lines of one page at one glass
 * level, for a theme that is dark or light.
 *
 * For each of the roles ink, muted, faint, placeholder and disabled that has
 * measured text, it returns `contrast.<role>.minLc` (the lowest absolute APCA
 * Lc) and `contrast.<role>.belowTarget` (how many lines miss the role's
 * target). A role without text gets no keys. So a change that adds a role to
 * a screen or removes one changes the key set, and the ratchet then asks for a
 * baseline edit, which is the moment to look at what changed.
 *
 * It also returns the lines of ink above the ceiling (always 0 in a light
 * theme), the lines that fail WCAG (the roles placeholder and disabled are
 * exempt from WCAG, so they are skipped), and the lines whose contrast could
 * not be measured: text in nested opacity groups, and text that a translucent
 * layer lies over in part (`partlyCovered`). A line that could not be measured
 * counts as below its target and as failing WCAG, and is left out of the
 * lowest Lc, because its numbers are only an estimate.
 */
export function summarizeContrast(
  measured: ReadonlyArray<MeasuredFragment>,
  dark: boolean,
): MetricValues {
  const values: MetricValues = {};
  for (const role of TARGET_ROLES) {
    const ofRole = measured.filter(({ fragment }) => fragment.role === role);
    if (ofRole.length === 0) continue;
    const target = METRICS[`contrast.${role}.minLc`]!.target;
    const supported = ofRole.filter(hasSupportedContrast);
    if (supported.length > 0) {
      values[`contrast.${role}.minLc`] = Math.min(
        ...supported.map(({ contrast }) => Math.abs(contrast.apcaLc)),
      );
    }
    values[`contrast.${role}.belowTarget`] = ofRole.filter(
      (each) => !hasSupportedContrast(each) || !target(Math.abs(each.contrast.apcaLc), { dark }),
    ).length;
  }
  values["contrast.ink.aboveCeiling"] = dark
    ? measured.filter(
        ({ fragment, contrast }) =>
          fragment.role === "ink" && Math.abs(contrast.apcaLc) > INK_CEILING_LC,
      ).length
    : 0;
  values["contrast.wcag.failing"] = measured.filter((each) => {
    const { fragment, contrast } = each;
    if (fragment.role === "placeholder" || fragment.role === "disabled") return false;
    const needed = fragment.fontSize < LARGE_TEXT_PX ? SMALL_TEXT_RATIO : LARGE_TEXT_RATIO;
    return !hasSupportedContrast(each) || contrast.wcagRatio < needed;
  }).length;
  values["contrast.unsupported"] = measured.filter((each) => !hasSupportedContrast(each)).length;
  return values;
}

/**
 * Summarizes the text of one page that does not depend on glass: the lines
 * dimmed by an opacity group, the faint lines that are bigger than metadata,
 * and the coverage numbers (how many distinct pieces of text, and how many
 * lines of each role). Coverage is reported, not ratcheted.
 */
export function summarizeText(measured: ReadonlyArray<MeasuredFragment>): MetricValues {
  const values: MetricValues = {
    "text.dimmedByOpacity": measured.filter(({ fragment }) => fragment.opacityGroups.length > 0)
      .length,
    "text.faintMisuse": measured.filter(
      ({ fragment }) => fragment.role === "faint" && fragment.fontSize > FAINT_MAXIMUM_PX,
    ).length,
    "coverage.texts": new Set(measured.map(({ fragment }) => fragment.sourceId)).size,
  };
  for (const role of ALL_ROLES) {
    values[`coverage.${role}`] = measured.filter(({ fragment }) => fragment.role === role).length;
  }
  return values;
}

/**
 * Summarizes the type, shape and spacing values of one page: the sizes, weights and radii in use, how many are off their token, and the share of spacing on the 4px grid.
 * `coverage.fixedSizeSamples` is how many text samples the page draws in a fixed size on purpose
 * (the four "Aa" of the Text size control), whose font sizes the sizes and the off-scale count leave out.
 * `coverage.pieceTextFragments` is how many lines of text sit inside drawn pieces (a face's z's, the avatar's
 * letter, a plugin mark's initial), whose sizes and weights are left out the same way.
 * Both are reported, so that a report shows where the exceptions apply.
 */
export function summarizeDiscipline(facts: DisciplineFacts): MetricValues {
  const onGrid = facts.spacingValues.filter((value) => {
    const distance = Math.abs(value - 4 * Math.round(value / 4));
    return distance <= GRID_TOLERANCE_PX;
  }).length;
  return {
    "type.sizes": facts.fontSizes.length,
    "type.weights": facts.fontWeights.length,
    "type.offScale": facts.offScaleFontSizes.length,
    "coverage.fixedSizeSamples": facts.fixedSizeSamples,
    "coverage.pieceTextFragments": facts.pieceTextFragments,
    "radius.distinct": facts.radii.length,
    "radius.offToken": facts.offTokenRadii.length,
    "spacing.onGrid": facts.spacingValues.length === 0 ? 1 : onGrid / facts.spacingValues.length,
  };
}

/**
 * Summarizes the click targets of one page: how many there are, and how many
 * are under 24 and under 28 px in width or height. A link inside prose is
 * exempt from the size (WCAG 2.5.8), so it counts as a control only.
 */
export function summarizeTargets(targets: ReadonlyArray<ProbeTarget>): MetricValues {
  const countUnder = (limit: number): number =>
    targets.filter(
      ({ box, inlineInProse }) =>
        !inlineInProse &&
        (box.right - box.left < limit - SIZE_TOLERANCE_PX ||
          box.bottom - box.top < limit - SIZE_TOLERANCE_PX),
    ).length;
  return {
    "coverage.controls": targets.length,
    "target.under24": countUnder(TARGET_SIZE_LIMITS.under24),
    "target.under28": countUnder(TARGET_SIZE_LIMITS.under28),
  };
}

/**
 * Summarizes how a page's text survives a change: `prefix` is the metrics'
 * name for the change (`textSpacing`, `textSize`, `reflow` or `rest`), and
 * the result holds the clipped characters and the overlapping pairs.
 */
export function summarizeResilience(
  prefix: "textSpacing" | "textSize" | "reflow" | "rest",
  facts: ClippingFacts,
): MetricValues {
  return {
    [`resilience.${prefix}.clippedCharacters`]: facts.clippedCharacters,
    [`resilience.${prefix}.overlaps`]: facts.overlappingPairs,
  };
}

/**
 * Returns `reading.proseMeasureOff`: 0 when the mean line length of the
 * prose is inside 60 to 75 characters, else the distance to the nearest end of
 * that band. Returns an empty record when the page has no full line of prose.
 */
export function summarizeProse(facts: ProseFacts): MetricValues {
  const mean = facts.meanCharactersPerLine;
  if (mean === null) return {};
  const { minimum, maximum } = PROSE_MEASURE_BAND;
  return { "reading.proseMeasureOff": Math.max(minimum - mean, mean - maximum, 0) };
}

/**
 * Returns the tokens' metrics of a theme: `line.minLc` is the lowest absolute
 * APCA Lc of the line colour drawn over bg, surface and raised, and
 * `surface.minStep` is the smaller of the lightness steps (OKLCH L) from bg to
 * surface and from surface to raised. Fails when a surface token is not
 * opaque, because a surface that shows what is behind it has no lightness.
 */
export function summarizeTokens(tokens: ThemeTokens): MetricValues {
  const { bg, surface, raised, line } = tokens;
  const lineContrasts = [bg, surface, raised].map((base) =>
    Math.abs(computeApcaContrast(blendOver(line, base), base)),
  );
  return {
    "line.minLc": Math.min(...lineContrasts),
    "surface.minStep": Math.min(
      computeOklchLightness(surface) - computeOklchLightness(bg),
      computeOklchLightness(raised) - computeOklchLightness(surface),
    ),
  };
}

/** A pair of easily confused glyphs, such as "Il", and how many pixels differ between their two drawings. */
export interface MeasuredGlyphPair {
  readonly pair: string;
  readonly differingPixels: number;
}

/** Returns `glyphs.confusablePairs`: how many pairs of glyphs differ in fewer than 4 pixels. */
export function summarizeGlyphs(pairs: ReadonlyArray<MeasuredGlyphPair>): MetricValues {
  return {
    "glyphs.confusablePairs": pairs.filter(
      ({ differingPixels }) => differingPixels < MINIMUM_DIFFERING_PIXELS,
    ).length,
  };
}
