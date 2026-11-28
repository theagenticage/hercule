/**
 * Turns what the UI probe and the pixel checks found on one page into the
 * numbers of `pnpm ui:metrics` (docs/research/ui-hill-climb.md, section 4.1).
 * Every function here is pure: it takes facts and returns a `MetricSummary`:
 * a record of metric names (see `METRICS` in ui-ratchet.ts) to numbers, and a
 * record of metric names to the elements behind each number, worst first, so
 * that a report can say which element made a number worse. The caller
 * (scripts/ui-measure.ts) gathers the facts and puts the key prefix on the
 * names.
 */
import type {
  ClippingFacts,
  DisciplineFacts,
  ProbeColour,
  ProbeTarget,
  ProseFacts,
  TextFragment,
  TextRole,
  ThemeTokens,
} from "../src/renderer/specimens/ui-probe-types.ts";
import { blendOver, computeApcaContrast, computeOklchLightness } from "./ui-colour.ts";
import type { FragmentContrast } from "./ui-pixels.ts";
import { isOnSpacingGrid } from "../src/renderer/specimens/ui-probe-clipping.ts";
import { METRICS, type MetricElement, type MetricElements } from "./ui-ratchet.ts";

/** Metric names to the numbers measured for them. */
export type MetricValues = Record<string, number>;

/**
 * The numbers measured for one page, and the elements behind them. A metric
 * has no entry in `elements` when nothing is behind it: its count is 0, or its
 * value comes from no element (see each function).
 */
export interface MetricSummary {
  readonly values: MetricValues;
  readonly elements: MetricElements;
}

/** Returns a summary of `values` and `elements`, without the metrics that have no elements. */
function buildSummary(
  values: MetricValues,
  elements: Record<string, ReadonlyArray<MetricElement>>,
): MetricSummary {
  return {
    values,
    elements: Object.fromEntries(Object.entries(elements).filter(([, list]) => list.length > 0)),
  };
}

/**
 * Returns `entries` with one entry per element name, ranked by contribution.
 * An element that appears more than once (one text drawn in several lines, one
 * name for several elements) is merged by `order`:
 * - `"sum"`: for counts, such as clipped characters; the contributions add up, and the largest comes first;
 * - `"smallest"`: for values where lower is worse, such as Lc; the smallest is kept, and comes first;
 * - `"largest"`: for values where higher is worse, such as a font size; the largest is kept, and comes first.
 * A tie keeps the order of first appearance.
 */
export function rankElements(
  entries: ReadonlyArray<MetricElement>,
  order: "sum" | "smallest" | "largest",
): MetricElement[] {
  const merged = new Map<string, number>();
  for (const { element, contribution } of entries) {
    const before = merged.get(element);
    merged.set(
      element,
      before === undefined
        ? contribution
        : order === "sum"
          ? before + contribution
          : order === "smallest"
            ? Math.min(before, contribution)
            : Math.max(before, contribution),
    );
  }
  const sign = order === "smallest" ? 1 : -1;
  return [...merged]
    .map(([element, contribution]) => ({ element, contribution }))
    .sort((a, b) => sign * (a.contribution - b.contribution));
}

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
 *
 * The elements of a role's lowest Lc are the one line at the minimum. For the
 * counts they are the lines counted. Their contribution is their absolute
 * Lc (the WCAG ratio for `contrast.wcag.failing`, 1 for
 * `contrast.unsupported`), the lowest first, except `contrast.ink.aboveCeiling`,
 * which lists the brightest first.
 */
export function summarizeContrast(
  measured: ReadonlyArray<MeasuredFragment>,
  dark: boolean,
): MetricSummary {
  const values: MetricValues = {};
  const elements: Record<string, MetricElement[]> = {};
  const buildLcElement = (each: MeasuredFragment): MetricElement => ({
    element: each.fragment.element,
    contribution: Math.abs(each.contrast.apcaLc),
  });
  for (const role of TARGET_ROLES) {
    const ofRole = measured.filter(({ fragment }) => fragment.role === role);
    if (ofRole.length === 0) continue;
    const target = METRICS[`contrast.${role}.minLc`]!.target;
    const supported = ofRole.filter(hasSupportedContrast);
    if (supported.length > 0) {
      const [lowest] = rankElements(supported.map(buildLcElement), "smallest");
      values[`contrast.${role}.minLc`] = lowest!.contribution;
      // A minimum can fall while it still meets its target, so the element at the minimum is named.
      elements[`contrast.${role}.minLc`] = [lowest!];
    }
    const below = ofRole.filter(
      (each) => !hasSupportedContrast(each) || !target(Math.abs(each.contrast.apcaLc), { dark }),
    );
    values[`contrast.${role}.belowTarget`] = below.length;
    elements[`contrast.${role}.belowTarget`] = rankElements(below.map(buildLcElement), "smallest");
  }
  const aboveCeiling = dark
    ? measured.filter(
        ({ fragment, contrast }) =>
          fragment.role === "ink" && Math.abs(contrast.apcaLc) > INK_CEILING_LC,
      )
    : [];
  values["contrast.ink.aboveCeiling"] = aboveCeiling.length;
  elements["contrast.ink.aboveCeiling"] = rankElements(aboveCeiling.map(buildLcElement), "largest");
  const failingWcag = measured.filter((each) => {
    const { fragment, contrast } = each;
    if (fragment.role === "placeholder" || fragment.role === "disabled") return false;
    const needed = fragment.fontSize < LARGE_TEXT_PX ? SMALL_TEXT_RATIO : LARGE_TEXT_RATIO;
    return !hasSupportedContrast(each) || contrast.wcagRatio < needed;
  });
  values["contrast.wcag.failing"] = failingWcag.length;
  elements["contrast.wcag.failing"] = rankElements(
    failingWcag.map(({ fragment, contrast }) => ({
      element: fragment.element,
      contribution: contrast.wcagRatio,
    })),
    "smallest",
  );
  const unsupported = measured.filter((each) => !hasSupportedContrast(each));
  values["contrast.unsupported"] = unsupported.length;
  elements["contrast.unsupported"] = rankElements(
    unsupported.map(({ fragment }) => ({ element: fragment.element, contribution: 1 })),
    "sum",
  );
  return buildSummary(values, elements);
}

/**
 * Summarizes the text of one page that does not depend on glass: the lines
 * dimmed by an opacity group, the faint lines that are bigger than metadata,
 * and the coverage numbers (how many distinct pieces of text, and how many
 * lines of each role). Coverage is reported, not ratcheted.
 */
export function summarizeText(measured: ReadonlyArray<MeasuredFragment>): MetricSummary {
  const dimmed = measured.filter(({ fragment }) => fragment.opacityGroups.length > 0);
  const faintMisuse = measured.filter(
    ({ fragment }) => fragment.role === "faint" && fragment.fontSize > FAINT_MAXIMUM_PX,
  );
  const values: MetricValues = {
    "text.dimmedByOpacity": dimmed.length,
    "text.faintMisuse": faintMisuse.length,
    "coverage.texts": new Set(measured.map(({ fragment }) => fragment.sourceId)).size,
  };
  for (const role of ALL_ROLES) {
    values[`coverage.${role}`] = measured.filter(({ fragment }) => fragment.role === role).length;
  }
  return buildSummary(values, {
    // The contribution of a dimmed line is its combined opacity, the lowest first.
    "text.dimmedByOpacity": rankElements(
      dimmed.map(({ fragment }) => ({
        element: fragment.element,
        contribution: fragment.opacityGroups.reduce((product, { opacity }) => product * opacity, 1),
      })),
      "smallest",
    ),
    // The contribution of a faint line is its font size, the largest first.
    "text.faintMisuse": rankElements(
      faintMisuse.map(({ fragment }) => ({
        element: fragment.element,
        contribution: fragment.fontSize,
      })),
      "largest",
    ),
  });
}

/**
 * Summarizes the type, shape and spacing values of one page: the sizes, weights and radii in use, how many are off their token, and the share of spacing on the 4px grid.
 * `coverage.fixedSizeSamples` is how many text samples the page draws in a fixed size on purpose
 * (the four "Aa" of the Text size control), whose font sizes the sizes and the off-scale count leave out.
 * `coverage.pieceTextFragments` is how many lines of text sit inside drawn pieces (a face's z's, the avatar's
 * letter, a plugin mark's initial), whose sizes and weights are left out the same way.
 * Both are reported, so that a report shows where the exceptions apply.
 *
 * The elements of `type.sizes`, `type.weights` and `radius.distinct` are one per
 * distinct value (the first element that has it), the largest value first. The
 * elements of `type.offScale` and `radius.offToken` are the declarations. The
 * elements of `spacing.onGrid` are those that have spacing values off the grid,
 * with the property and value of each, the most off-grid values first. Every
 * number comes from the facts, never from the ranked lists.
 */
export function summarizeDiscipline(facts: DisciplineFacts): MetricSummary {
  const onGrid = facts.spacingValues.filter(isOnSpacingGrid).length;
  const values = {
    "type.sizes": facts.fontSizes.length,
    "type.weights": facts.fontWeights.length,
    "type.offScale": facts.offScaleFontSizes.length,
    "coverage.fixedSizeSamples": facts.fixedSizeSamples,
    "coverage.pieceTextFragments": facts.pieceTextFragments,
    "radius.distinct": facts.radii.length,
    "radius.offToken": facts.offTokenRadii.length,
    "spacing.onGrid": facts.spacingValues.length === 0 ? 1 : onGrid / facts.spacingValues.length,
  };
  const { examples } = facts;
  const describeDeclarations = (declarations: ReadonlyArray<string>): MetricElement[] =>
    declarations.map((declaration) => ({ element: declaration, contribution: 1 }));
  return buildSummary(values, {
    // One element per distinct value, the first on the page, with the value as its contribution (the first number of a radius).
    "type.sizes": rankElements(
      facts.fontSizes.map((size) => ({
        element: `font-size ${String(size)}px: ${examples.fontSizes[String(size)] ?? ""}`,
        contribution: size,
      })),
      "largest",
    ),
    "type.weights": rankElements(
      facts.fontWeights.map((weight) => ({
        element: `font-weight ${String(weight)}: ${examples.fontWeights[String(weight)] ?? ""}`,
        contribution: weight,
      })),
      "largest",
    ),
    "radius.distinct": rankElements(
      facts.radii.map((radius) => ({
        element: `radius ${radius}: ${examples.radii[radius] ?? ""}`,
        contribution: Number.parseFloat(radius),
      })),
      "largest",
    ),
    // A declaration off its token is a stylesheet rule, so it is named by the rule and not by an element.
    "type.offScale": describeDeclarations(facts.offScaleFontSizes),
    "radius.offToken": describeDeclarations(facts.offTokenRadii),
    // The contribution of an element is how many of its spacing values are off the grid.
    "spacing.onGrid": rankElements(
      facts.offGridSpacing.map(({ element, values: offGrid }) => ({
        element: `${element}: ${offGrid.join(", ")}`,
        contribution: offGrid.length,
      })),
      "sum",
    ),
  });
}

/**
 * Summarizes the click targets of one page: how many there are, and how many
 * are under 24 and under 28 px in width or height. A link inside prose is
 * exempt from the size (WCAG 2.5.8), so it counts as a control only.
 */
export function summarizeTargets(targets: ReadonlyArray<ProbeTarget>): MetricSummary {
  const filterUnder = (limit: number): ProbeTarget[] =>
    targets.filter(
      ({ box, inlineInProse }) =>
        !inlineInProse &&
        (box.right - box.left < limit - SIZE_TOLERANCE_PX ||
          box.bottom - box.top < limit - SIZE_TOLERANCE_PX),
    );
  // The count is the length of the filtered targets: two targets with the same name are two targets.
  const under24 = filterUnder(TARGET_SIZE_LIMITS.under24);
  const under28 = filterUnder(TARGET_SIZE_LIMITS.under28);
  const rankBySmallestSide = (under: ReadonlyArray<ProbeTarget>): MetricElement[] =>
    rankElements(
      under.map(({ box, element }) => ({
        element,
        contribution: Math.min(box.right - box.left, box.bottom - box.top),
      })),
      "smallest",
    );
  return buildSummary(
    {
      "coverage.controls": targets.length,
      "target.under24": under24.length,
      "target.under28": under28.length,
    },
    // The contribution of a target is its smaller side in px, the smallest first.
    {
      "target.under24": rankBySmallestSide(under24),
      "target.under28": rankBySmallestSide(under28),
    },
  );
}

/**
 * Summarizes how a page's text survives a change: `prefix` is the metrics'
 * name for the change (`textSpacing`, `textSize`, `reflow` or `rest`), and
 * the result holds the clipped characters and the overlapping pairs.
 */
export function summarizeResilience(
  prefix: "textSpacing" | "textSize" | "reflow" | "rest",
  facts: ClippingFacts,
): MetricSummary {
  return buildSummary(
    {
      [`resilience.${prefix}.clippedCharacters`]: facts.clippedCharacters,
      [`resilience.${prefix}.overlaps`]: facts.overlappingPairs,
    },
    {
      // The contribution of a clipped text is its lost characters, and of an overlap the shared area in square px, the largest first.
      [`resilience.${prefix}.clippedCharacters`]: rankElements(
        facts.clippedTexts.map(({ element, characters }) => ({
          element,
          contribution: characters,
        })),
        "sum",
      ),
      [`resilience.${prefix}.overlaps`]: rankElements(
        facts.overlaps.map(({ first, second, area }) => ({
          element: `${first} overlaps ${second}`,
          contribution: area,
        })),
        "sum",
      ),
    },
  );
}

/**
 * Returns `reading.proseMeasureOff`: 0 when the mean line length of the
 * prose is inside 60 to 75 characters, else the distance to the nearest end of
 * that band. Returns an empty record when the page has no full line of prose.
 * The elements are the paragraphs, each with its mean characters per full
 * line. When the mean is outside the band, only the paragraphs that push it the
 * way it fails are listed (those past the band's end on that side), the one
 * with the most excess characters over all its full lines first. Inside the
 * band no paragraph is listed.
 */
export function summarizeProse(facts: ProseFacts): MetricSummary {
  const mean = facts.meanCharactersPerLine;
  if (mean === null) return { values: {}, elements: {} };
  const { minimum, maximum } = PROSE_MEASURE_BAND;
  const distanceFromBand = (characters: number): number =>
    Math.max(minimum - characters, characters - maximum, 0);
  // Only paragraphs that push the mean the way it fails are listed, the heaviest push first:
  // how far the paragraph's mean is past the band's end, times its full lines.
  const pushOf = (paragraph: ProseFacts["paragraphs"][number]): number =>
    (mean > maximum
      ? paragraph.meanCharactersPerLine - maximum
      : minimum - paragraph.meanCharactersPerLine) * paragraph.lines;
  const pushing = distanceFromBand(mean) === 0 ? [] : facts.paragraphs.filter((p) => pushOf(p) > 0);
  const paragraphs = [...pushing]
    .sort((a, b) => pushOf(b) - pushOf(a))
    .map(({ element, lines, meanCharactersPerLine }) => ({
      element: `${element} (${String(lines)} full lines)`,
      contribution: meanCharactersPerLine,
    }));
  return buildSummary(
    { "reading.proseMeasureOff": distanceFromBand(mean) },
    { "reading.proseMeasureOff": paragraphs },
  );
}

/**
 * Returns the tokens' metrics of a theme:
 * - `line.minLc` is the lowest absolute APCA Lc of the line colour (the edge
 *   of content) drawn over bg, surface and raised;
 * - `divider.minLc` is the same for the divider colour (the edge of chrome);
 * - `surface.minStep` is the smaller of the lightness steps (OKLCH L) from bg
 *   to surface and from surface to raised.
 *
 * Fails when a surface token is not opaque, because a surface that shows what
 * is behind it has no lightness.
 */
export function summarizeTokens(tokens: ThemeTokens): MetricSummary {
  const { bg, surface, raised, line, divider } = tokens;
  const surfaces = [
    ["bg", bg],
    ["surface", surface],
    ["raised", raised],
  ] as const;
  /** Returns the lowest Lc of `colour` over the three surfaces, named by the token pair that gives it. */
  const lowestContrastOverSurfaces = (name: string, colour: ProbeColour): MetricElement => {
    const [lowest] = rankElements(
      surfaces.map(([surfaceName, base]) => ({
        element: `--${name} over --${surfaceName}`,
        contribution: Math.abs(computeApcaContrast(blendOver(colour, base), base)),
      })),
      "smallest",
    );
    return lowest!;
  };
  const lowestLine = lowestContrastOverSurfaces("line", line);
  const lowestDivider = lowestContrastOverSurfaces("divider", divider);
  const [smallestStep] = rankElements(
    [
      {
        element: "--bg to --surface",
        contribution: computeOklchLightness(surface) - computeOklchLightness(bg),
      },
      {
        element: "--surface to --raised",
        contribution: computeOklchLightness(raised) - computeOklchLightness(surface),
      },
    ],
    "smallest",
  );
  // Tokens belong to no element, so the elements here are the token pairs that give the minimum.
  return {
    values: {
      "line.minLc": lowestLine.contribution,
      "divider.minLc": lowestDivider.contribution,
      "surface.minStep": smallestStep!.contribution,
    },
    elements: {
      "line.minLc": [lowestLine],
      "divider.minLc": [lowestDivider],
      "surface.minStep": [smallestStep!],
    },
  };
}

/** A pair of easily confused glyphs, such as "Il", and how many pixels differ between their two drawings. */
export interface MeasuredGlyphPair {
  readonly pair: string;
  readonly differingPixels: number;
}

/**
 * Returns `glyphs.confusablePairs`: how many pairs of glyphs differ in fewer than 4 pixels.
 * The elements are those pairs, each with its differing pixels, the fewest first.
 */
export function summarizeGlyphs(pairs: ReadonlyArray<MeasuredGlyphPair>): MetricSummary {
  const confusable = pairs.filter(
    ({ differingPixels }) => differingPixels < MINIMUM_DIFFERING_PIXELS,
  );
  return buildSummary(
    { "glyphs.confusablePairs": confusable.length },
    {
      "glyphs.confusablePairs": rankElements(
        confusable.map(({ pair, differingPixels }) => ({
          element: `glyphs ${pair}`,
          contribution: differingPixels,
        })),
        "smallest",
      ),
    },
  );
}
