/**
 * What the UI probe (ui-probe.ts) reads from a specimen page, as plain data
 * that crosses from the page to Node: `pnpm ui:metrics`
 * (scripts/ui-metrics.ts) loads the probe into each captured page, calls its
 * functions, and turns their results into the scripted metrics of the desktop
 * UI hill climb (docs/research/ui-hill-climb.md, section 4.1).
 *
 * The page code and the Node code both import this file, so it holds only
 * types and uses nothing of the DOM.
 */

/** A rectangle in CSS pixels, measured from the top left of the window. */
export interface ProbeRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A colour in sRGB: red, green and blue from 0 to 255, and alpha from 0 to 1. */
export type ProbeColour = readonly [red: number, green: number, blue: number, alpha: number];

/**
 * The role of a piece of text, decided from its colour before any opacity:
 * the theme's `--ink`, `--muted` or `--faint`, compared in the nearest themed
 * scope. A placeholder or a disabled control wins over its colour. Any other
 * colour, such as a crew hue, `--you-ink` or `--accent-ink`, is `other`.
 */
export type TextRole = "ink" | "muted" | "faint" | "placeholder" | "disabled" | "other";

/** One line of one piece of text, as the browser lays it out. */
export interface TextFragment {
  /** The piece of text this fragment belongs to: the same number for every line of one text node, input or pseudo-element. */
  readonly sourceId: number;
  /** How many characters the fragment holds. */
  readonly length: number;
  /** The fragment's box as laid out, which may reach outside what is visible. */
  readonly box: ProbeRect;
  /** The part of `box` that is visible: cut to the window and to every ancestor that clips its content. Null when nothing is visible. */
  readonly visibleBox: ProbeRect | null;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly colour: ProbeColour;
  readonly role: TextRole;
  /** The ancestors with an opacity below 1, outermost first, as the ids `markOpacityGroups` gave them. Empty for most text. */
  readonly opacityGroups: ReadonlyArray<{ readonly id: number; readonly opacity: number }>;
  /** Whether the text is prose of a transcript message, which the prose measure reads. */
  readonly isProse: boolean;
  /**
   * Whether another element lies over the fragment without hiding it. For one
   * of the five sample points of the fragment, an element above the fragment
   * is judged by its effective opacity (its own times that of every
   * ancestor):
   *
   * - It hides the point when the effective opacity is at least 0.95 and the
   *   element has a background colour with alpha of at least 0.95 or a
   *   backdrop filter that blurs (radius above 0). A background image or
   *   replaced content never hides, because its transparency at the point is
   *   unknown. A fragment whose five points are all hidden is not collected.
   * - It covers the point partly when it paints (a background colour, a
   *   background image, replaced content or a blurring backdrop) but does not
   *   hide the point, and its paint alpha (the background alpha, or
   *   1 for the other three, times the effective opacity) is above 0.05.
   * - Anything fainter is ignored.
   *
   * True when some point is covered partly. The pixels under the text are then
   * a mix of the text's own background and the layer, so the contrast read
   * from them is only an estimate.
   */
  readonly partlyCovered: boolean;
}

/** The theme tokens a metric compares with, resolved to sRGB in the page's top-level theme. */
export interface ThemeTokens {
  readonly bg: ProbeColour;
  readonly surface: ProbeColour;
  readonly raised: ProbeColour;
  readonly line: ProbeColour;
  readonly ink: ProbeColour;
  readonly muted: ProbeColour;
  readonly faint: ProbeColour;
}

/** The type, shape and spacing values the page uses, for the discipline metrics. */
export interface DisciplineFacts {
  /** Every computed font size of visible text, in px, without repeats, sorted. Leaves out the fixed size samples and the text of drawn pieces. */
  readonly fontSizes: ReadonlyArray<number>;
  /** Every computed font weight of visible text, without repeats, sorted. Leaves out the text of drawn pieces. */
  readonly fontWeights: ReadonlyArray<number>;
  /** Every computed non-zero corner radius of a visible element, as CSS text, without repeats, sorted. */
  readonly radii: ReadonlyArray<string>;
  /** Authored font-size declarations that apply to a visible element and are not a `var(--t-*)`: "selector { font-size: value }", without repeats. */
  readonly offScaleFontSizes: ReadonlyArray<string>;
  /** Authored border-radius declarations that apply to a visible element and are not a `var(--r-*)`, a pill or a circle, without repeats. */
  readonly offTokenRadii: ReadonlyArray<string>;
  /** Every non-zero computed padding, margin and gap value of a visible element, in px, repeats kept. */
  readonly spacingValues: ReadonlyArray<number>;
  /**
   * How many text samples the page draws in a fixed size on purpose, whose
   * font sizes are left out of `fontSizes` and `offScaleFontSizes`: the four
   * "Aa" of the Text size control, or none. The probe fails when the selector
   * of these samples matches anything else.
   */
  readonly fixedSizeSamples: number;
  /**
   * How many lines of text the page draws inside the SVG roots of drawn pieces
   * (a face's z's, the user's avatar letter, a plugin mark's initial), whose
   * font sizes and weights are left out of `fontSizes` and `fontWeights`. The
   * probe fails when the selector of these roots matches something that is
   * not a piece.
   */
  readonly pieceTextFragments: number;
}

/** An element a user can click or focus. */
export interface ProbeTarget {
  /** The id `collectTargets` gave the element, which `focusTarget` takes. */
  readonly id: number;
  readonly box: ProbeRect;
  /** A short name for reports: its accessible name or its text, else its tag and classes. */
  readonly name: string;
  /** Whether it is a link inside prose, which WCAG 2.5.8 exempts from the target size. */
  readonly inlineInProse: boolean;
  /** Whether its box is fully inside the window. */
  readonly inWindow: boolean;
}

/** What happened when `focusTarget` focused an element. */
export interface FocusOutcome {
  /** Whether the element is `document.activeElement` and matches `:focus-visible`. */
  readonly focused: boolean;
}

/** A change to the page that tests how its text survives (WCAG 1.4.12, larger text, reflow). */
export type Perturbation = "text-spacing" | "largest-text-size";

/** How much text is lost or overlapping in the page as it is now. */
export interface ClippingFacts {
  /**
   * Characters of text that are lost: per fragment, its length times the share of its box that is cut off for good, rounded.
   * Ancestors with overflow `hidden` or `clip` cut it; ancestors that scroll do not, and the window cuts it only when no ancestor scrolls.
   */
  readonly clippedCharacters: number;
  /** Pairs of fragments of different sources whose visible boxes overlap by more than 2 square px. Pseudo-element strings are left out. */
  readonly overlappingPairs: number;
}

/** The measure of the transcript's prose. */
export interface ProseFacts {
  /** Full lines measured: every line of a paragraph but its last. */
  readonly lines: number;
  /** Mean characters per full line, or null when there are none. */
  readonly meanCharactersPerLine: number | null;
}

/**
 * Where two easily confused characters are drawn in the glyph specimen
 * (`showGlyphSpecimen`): the boxes of their two cells. Both boxes have the
 * same size, and each glyph starts at the same place in its cell, so equal
 * shapes give equal pixels.
 */
export interface GlyphSpecimen {
  /** The two characters, such as "Il". */
  readonly pair: string;
  /** The cell of the first character. */
  readonly first: ProbeRect;
  /** The cell of the second character. */
  readonly second: ProbeRect;
}
