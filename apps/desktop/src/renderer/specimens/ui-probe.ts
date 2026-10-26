/**
 * The page side of `pnpm ui:metrics` (scripts/ui-metrics.ts): functions that
 * read the DOM of a ready specimen page and return plain data, typed in
 * ui-probe-types.ts. The Node script loads this module into each page with
 * `import("/specimens/ui-probe.ts")`, calls the functions it needs, and does
 * the maths on the results.
 *
 * Plain DOM only. The module imports nothing of the app, so a page that
 * loads it draws exactly what it drew before.
 *
 * Several functions mark elements with a `data-ui-probe-*` attribute, so the
 * Node side can name them in a later call, and several inject a `<style>`
 * element with a `data-ui-probe` attribute. Both stay in the page until the
 * matching `show…` or `remove…` function runs, or the page closes.
 */
import type {
  ClippingFacts,
  DisciplineFacts,
  FocusOutcome,
  GlyphSpecimen,
  Perturbation,
  ProbeColour,
  ProbeRect,
  ProbeTarget,
  ProseFacts,
  TextFragment,
  TextRole,
  ThemeTokens,
} from "./ui-probe-types";

// ---------- Constants ----------

/** The elements whose children are never text a user reads. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TITLE",
]);

/** The input types whose value the browser draws as a line of text. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "button",
  "submit",
  "reset",
]);

/** The elements a user can click or focus, as plan section 4.1 lists them. */
const TARGET_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The paragraphs and list items of a transcript message. Messages hold
 * markdown inside `.msg-body` (agent messages, conversation and discussion
 * posts) or `.bubble` (the user's messages), as screens/session/markdown.css
 * styles it. Tool rows, headings, tables and code blocks are not in it.
 */
const PROSE_SELECTOR = ":is(.msg-body, .bubble) :is(p, li)";

/** The block elements inside a message whose text is not prose. */
const NOT_PROSE_SELECTOR = "pre, table";

/** The theme tokens `resolveThemeTokens` reads, in the order of `ThemeTokens`. */
const THEME_TOKEN_NAMES = ["bg", "surface", "raised", "line", "ink", "muted", "faint"] as const;

/** Two fragments overlap only when their boxes share more than this many square pixels. */
const OVERLAP_THRESHOLD_PX2 = 2;

/** Fragments whose tops differ by at most this many pixels sit on the same line. */
const SAME_LINE_TOLERANCE_PX = 2;

/** The characters of the glyph specimen, in the order it draws them. */
const GLYPH_CHARACTERS = ["I", "l", "1", "O", "0"] as const;

/** The pairs of easily confused characters of the glyph specimen: each is two of `GLYPH_CHARACTERS`. */
const GLYPH_PAIRS = ["Il", "I1", "l1", "O0"] as const;

/** The side of the square cell that holds one glyph of the glyph specimen, in px. */
const GLYPH_CELL_PX = 24;

/** The gap between two cells, and around the cells, in px. It keeps the anti-aliasing of one glyph out of the next cell. */
const GLYPH_GAP_PX = 8;

/** How far a glyph starts from the left edge of its cell, in px. The same for every glyph, so equal shapes land on equal pixels. */
const GLYPH_INDENT_PX = 6;

/** The attribute that marks the element `showGlyphSpecimen` adds. */
const GLYPH_SPECIMEN_ATTRIBUTE = "data-ui-probe-glyphs";

/**
 * The properties of the page's text that the glyph specimen copies from the
 * element that holds the UI text. They are what changes the shape of a glyph:
 * the font and its features and axes, the spacing and kerning, and how the
 * browser smooths the glyph.
 */
const GLYPH_TYPOGRAPHY_PROPERTIES = [
  "font-family",
  "font-feature-settings",
  "font-variation-settings",
  "font-optical-sizing",
  "font-kerning",
  "letter-spacing",
  "text-rendering",
  "-webkit-font-smoothing",
] as const;

/** The attribute that names an element with a see-through ancestor group. */
const GROUP_ATTRIBUTE = "data-ui-probe-group";

/** The attribute that names a target for `focusTarget`. */
const TARGET_ATTRIBUTE = "data-ui-probe-target";

/** The properties of `border-radius`, the shorthand first. */
const RADIUS_SHORTHAND = "border-radius";
const RADIUS_LONGHANDS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "border-start-start-radius",
  "border-start-end-radius",
  "border-end-start-radius",
  "border-end-end-radius",
] as const;

/** The properties of the spacing grid. */
const SPACING_PROPERTIES = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "row-gap",
  "column-gap",
] as const;

// ---------- Rectangles ----------

/** Returns the rectangle in the shape the probe's results use. */
function toProbeRect(rect: DOMRectReadOnly): ProbeRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** Returns the area of a rectangle in square pixels. */
function computeArea(rect: ProbeRect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

/** Returns the part both rectangles cover, or null when they share no area. */
function intersectRects(first: ProbeRect, second: ProbeRect): ProbeRect | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** Returns whether two rectangles are the same, ignoring sub-pixel noise below 0.01 px. */
function isSameRect(first: ProbeRect, second: ProbeRect): boolean {
  const noise = 0.01;
  return (
    Math.abs(first.left - second.left) < noise &&
    Math.abs(first.top - second.top) < noise &&
    Math.abs(first.right - second.right) < noise &&
    Math.abs(first.bottom - second.bottom) < noise
  );
}

/** Returns the window as a rectangle: what the user sees of the page. */
function readWindowRect(): ProbeRect {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

// ---------- Colours ----------

/** The colours `resolveColour` sets before a colour to learn whether the canvas accepted the colour. */
const SENTINEL_COLOURS = ["#010203", "#fdfcfb"] as const;

let colourContext: CanvasRenderingContext2D | undefined;
const resolvedColours = new Map<string, ProbeColour>();

/** Returns the 1x1 canvas context that converts CSS colours, creating it on first use. */
function readColourContext(): CanvasRenderingContext2D {
  if (colourContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("The browser gave no 2D canvas context.");
    // "copy" replaces the pixel instead of blending the colour over the last one.
    context.globalCompositeOperation = "copy";
    colourContext = context;
  }
  return colourContext;
}

/**
 * Converts a CSS colour in any notation (oklch, color-mix, color(), named) to
 * sRGB: red, green and blue from 0 to 255 and alpha from 0 to 1. A canvas
 * does the conversion, so the result is what the browser draws. Fails when
 * the canvas does not accept `css`, because a computed colour always parses
 * and a failure means the caller passed something else.
 */
function resolveColour(css: string): ProbeColour {
  const known = resolvedColours.get(css);
  if (known !== undefined) return known;
  const context = readColourContext();
  // A canvas ignores a colour it cannot parse and keeps the old fill style.
  // Setting a sentinel first shows that; two sentinels cover a colour that is
  // equal to the first one.
  const accepted = SENTINEL_COLOURS.some((sentinel) => {
    context.fillStyle = sentinel;
    const before = context.fillStyle;
    context.fillStyle = css;
    return context.fillStyle !== before;
  });
  if (!accepted) {
    throw new Error(`The canvas does not accept "${css}" as a colour.`);
  }
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
  const colour: ProbeColour = [red, green, blue, alpha / 255];
  resolvedColours.set(css, colour);
  return colour;
}

/** Returns whether two colours are the same within the rounding of 8-bit channels. */
function isSameColour(first: ProbeColour, second: ProbeColour): boolean {
  return (
    Math.abs(first[0] - second[0]) < 1 &&
    Math.abs(first[1] - second[1]) < 1 &&
    Math.abs(first[2] - second[2]) < 1 &&
    Math.abs(first[3] - second[3]) < 1 / 255
  );
}

/**
 * Returns the colour of a theme token as it is in `scope`, in sRGB. It puts a
 * probe element with `color: var(--name)` in the scope and reads the computed
 * colour, so a token that refers to other tokens resolves the way the page
 * resolves it. Fails when the scope does not define the token, because the
 * probe would then inherit some other colour and the metric would be wrong
 * without anyone noticing.
 */
function resolveToken(scope: Element, name: string): ProbeColour {
  if (getComputedStyle(scope).getPropertyValue(`--${name}`).trim() === "") {
    throw new Error(`The theme scope <${scope.tagName.toLowerCase()}> does not define --${name}.`);
  }
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(--${name})`;
  scope.append(probe);
  const colour = resolveColour(getComputedStyle(probe).color);
  probe.remove();
  return colour;
}

/** Returns the nearest element that sets a theme: the closest `[data-theme]`, else `<html>`. */
function findThemeScope(element: Element): Element {
  return element.closest("[data-theme]") ?? document.documentElement;
}

/**
 * Resolves the ink, muted and faint tokens of the theme scope of an element,
 * remembering each scope's answer. The Appearance cards nest other themes
 * inside the page's theme, so one page has several scopes.
 */
function createRoleTokens(): (element: Element) => Pick<ThemeTokens, "ink" | "muted" | "faint"> {
  const byScope = new Map<Element, Pick<ThemeTokens, "ink" | "muted" | "faint">>();
  return (element) => {
    const scope = findThemeScope(element);
    let tokens = byScope.get(scope);
    if (tokens === undefined) {
      tokens = {
        ink: resolveToken(scope, "ink"),
        muted: resolveToken(scope, "muted"),
        faint: resolveToken(scope, "faint"),
      };
      byScope.set(scope, tokens);
    }
    return tokens;
  };
}

/**
 * Returns the theme tokens of the page's top-level theme (the one on
 * `<html>`) in sRGB. Fails when the page does not define one of them.
 */
export function resolveThemeTokens(): ThemeTokens {
  const root = document.documentElement;
  const [bg, surface, raised, line, ink, muted, faint] = THEME_TOKEN_NAMES.map((name) =>
    resolveToken(root, name),
  );
  return {
    bg: bg!,
    surface: surface!,
    raised: raised!,
    line: line!,
    ink: ink!,
    muted: muted!,
    faint: faint!,
  };
}

// ---------- Per-element facts ----------

/** The kind of ancestor an element escapes: an absolute element is clipped only by its containing block's chain, a fixed one by none. */
type Escape = "none" | "absolute" | "fixed";

/** What the probe reads from one element's computed style, read once per call. */
interface ElementFacts {
  readonly style: CSSStyleDeclaration;
  /** Whether the element draws and clips its content: overflow other than visible on a box that can clip. */
  readonly clipsContent: boolean;
  /** Whether the element cuts its content along each axis for good: overflow `hidden` or `clip`, on a box that can clip. */
  readonly cutsX: boolean;
  readonly cutsY: boolean;
  /** Whether the element scrolls its overflow along each axis (`auto` or `scroll`), on a box that can clip. */
  readonly scrollsX: boolean;
  readonly scrollsY: boolean;
  readonly position: string;
  /** Whether an absolutely positioned descendant is placed against this element. */
  readonly containsAbsolute: boolean;
  /** Whether a fixed descendant is placed against this element (a transform, filter and the like). */
  readonly containsFixed: boolean;
  readonly opacity: number;
}

/** Returns whether a value of a `will-change` or `contain` property makes the element a containing block. */
function mentionsContainment(value: string, words: ReadonlyArray<string>): boolean {
  return words.some((word) => value.includes(word));
}

/** Returns whether an overflow value cuts the content for good, which no scrolling reaches. */
function isCutting(overflow: string): boolean {
  return overflow === "hidden" || overflow === "clip";
}

/** Returns whether an overflow value lets the user scroll to the content that overflows. */
function isScrolling(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll";
}

/** Reads the facts of an element from its computed style. */
function readElementFacts(element: Element): ElementFacts {
  const style = getComputedStyle(element);
  const clipsOverflow = style.overflowX !== "visible" || style.overflowY !== "visible";
  // `overflow` does not apply to inline boxes. An outer <svg> is replaced
  // content, which clips by its own overflow although its display is inline.
  const isSvgRoot = element instanceof SVGSVGElement;
  const canClip = isSvgRoot || (element instanceof HTMLElement && style.display !== "inline");
  const hasTransform =
    style.transform !== "none" ||
    style.translate !== "none" ||
    style.rotate !== "none" ||
    style.scale !== "none" ||
    style.filter !== "none" ||
    style.perspective !== "none" ||
    mentionsContainment(style.willChange, ["transform", "perspective", "filter"]) ||
    mentionsContainment(style.contain, ["layout", "paint", "strict", "content"]);
  const containsFixed = hasTransform || style.backdropFilter !== "none";
  return {
    style,
    clipsContent: clipsOverflow && canClip,
    cutsX: canClip && isCutting(style.overflowX),
    cutsY: canClip && isCutting(style.overflowY),
    scrollsX: canClip && isScrolling(style.overflowX),
    scrollsY: canClip && isScrolling(style.overflowY),
    position: style.position,
    containsAbsolute: containsFixed || style.position !== "static",
    containsFixed,
    opacity: Number.parseFloat(style.opacity),
  };
}

/** Returns a function that reads an element's facts, remembering each element's answer for the life of the returned function. */
function createFactsReader(): (element: Element) => ElementFacts {
  const cache = new Map<Element, ElementFacts>();
  return (element) => {
    let facts = cache.get(element);
    if (facts === undefined) {
      facts = readElementFacts(element);
      cache.set(element, facts);
    }
    return facts;
  };
}

type ReadFacts = (element: Element) => ElementFacts;

/**
 * Returns the area an element clips its content to: its padding box. A
 * scroll bar is not part of it. The sizes `clientWidth` and `clientHeight`
 * are whole numbers, so only the border and scroll bar widths come from
 * them; the position comes from the fractional bounding box.
 */
function readClipRect(element: Element): ProbeRect {
  const box = element.getBoundingClientRect();
  if (!(element instanceof HTMLElement)) return toProbeRect(box);
  const rightInset = element.offsetWidth - element.clientWidth - element.clientLeft;
  const bottomInset = element.offsetHeight - element.clientHeight - element.clientTop;
  return {
    left: box.left + element.clientLeft,
    top: box.top + element.clientTop,
    right: box.right - rightInset,
    bottom: box.bottom - bottomInset,
  };
}

/**
 * Returns the part of `rect` the user can see: cut to the window and to
 * every ancestor from `from` upward whose overflow is not visible. Returns
 * null when nothing is left.
 *
 * An absolutely positioned element is clipped only by the ancestors from its
 * containing block up, and a fixed element by none, so `escape` says what
 * the content being cut already escapes. `from` itself may clip the content.
 */
function clipToAncestors(
  rect: ProbeRect,
  from: Element | null,
  escape: Escape,
  readFacts: ReadFacts,
): ProbeRect | null {
  let visible = intersectRects(rect, readWindowRect());
  let currentEscape = escape;
  for (let element = from; element !== null && visible !== null; element = element.parentElement) {
    const facts = readFacts(element);
    if (
      (currentEscape === "absolute" && facts.containsAbsolute) ||
      (currentEscape === "fixed" && facts.containsFixed)
    ) {
      currentEscape = "none";
    }
    if (currentEscape === "none" && facts.clipsContent) {
      visible = intersectRects(visible, readClipRect(element));
    }
    if (facts.position === "fixed") currentEscape = "fixed";
    else if (facts.position === "absolute" && currentEscape === "none") currentEscape = "absolute";
  }
  return visible;
}

/**
 * Returns how far to move the span [low, high] so that it lies inside
 * [clipLow, clipHigh], the way scrolling moves content into view. A span
 * longer than the clip starts at its start.
 */
function computeShiftIntoView(
  low: number,
  high: number,
  clipLow: number,
  clipHigh: number,
): number {
  if (high - low >= clipHigh - clipLow || low < clipLow) return clipLow - low;
  return high > clipHigh ? clipHigh - high : 0;
}

/** Moves a rectangle by `delta` along one axis and cuts it to the span of `clip` along that axis. Returns null when nothing is left. */
function moveAndCutAlongAxis(
  rect: ProbeRect | null,
  axis: "x" | "y",
  delta: number,
  clip: ProbeRect,
): ProbeRect | null {
  if (rect === null) return null;
  return axis === "x"
    ? intersectRects(
        { ...rect, left: rect.left + delta, right: rect.right + delta },
        { left: clip.left, right: clip.right, top: -Infinity, bottom: Infinity },
      )
    : intersectRects(
        { ...rect, top: rect.top + delta, bottom: rect.bottom + delta },
        { left: -Infinity, right: Infinity, top: clip.top, bottom: clip.bottom },
      );
}

/** An ancestor that cuts or scrolls its content, with the area it clips the content to. */
interface ClippingAncestor {
  readonly facts: ElementFacts;
  readonly clip: ProbeRect;
}

/**
 * Returns the ancestors, from `from` outward, that clip the content of a box
 * and apply to it: the ones that cut or scroll along some axis, innermost
 * first. `from` and `escape` work as in `clipToAncestors`.
 */
function listClippingAncestors(
  from: Element | null,
  escape: Escape,
  readFacts: ReadFacts,
): ClippingAncestor[] {
  const ancestors: ClippingAncestor[] = [];
  let currentEscape = escape;
  for (let element = from; element !== null; element = element.parentElement) {
    const facts = readFacts(element);
    if (
      (currentEscape === "absolute" && facts.containsAbsolute) ||
      (currentEscape === "fixed" && facts.containsFixed)
    ) {
      currentEscape = "none";
    }
    if (
      currentEscape === "none" &&
      (facts.cutsX || facts.cutsY || facts.scrollsX || facts.scrollsY)
    ) {
      ancestors.push({ facts, clip: readClipRect(element) });
    }
    if (facts.position === "fixed") currentEscape = "fixed";
    else if (facts.position === "absolute" && currentEscape === "none") currentEscape = "absolute";
  }
  return ancestors;
}

/**
 * Returns the part of a scroller's area that the user can see, or null when
 * none is left. It is the scroller's `clip`, cut by every outer ancestor that
 * cuts along an axis, and by the window unless an outer ancestor scrolls (the
 * user then scrolls the scroller itself into view, and that ancestor gets its
 * own turn in `computeLostShare`). `outer` holds the ancestors around the
 * scroller, innermost first.
 */
function computeVisibleScrollerArea(
  clip: ProbeRect,
  outer: ReadonlyArray<ClippingAncestor>,
): ProbeRect | null {
  let visible: ProbeRect | null = clip;
  let hasOuterScroller = false;
  for (const { facts, clip: outerClip } of outer) {
    if (facts.cutsX) visible = moveAndCutAlongAxis(visible, "x", 0, outerClip);
    if (facts.cutsY) visible = moveAndCutAlongAxis(visible, "y", 0, outerClip);
    if (facts.scrollsX || facts.scrollsY) hasOuterScroller = true;
  }
  return hasOuterScroller || visible === null ? visible : intersectRects(visible, readWindowRect());
}

/**
 * Returns the share of `box`, from 0 to 1, that is lost: cut off for good,
 * with no scrolling that reaches it. The rules, from the box outward:
 *
 * - An ancestor with overflow `hidden` or `clip` cuts the box along that axis.
 * - An ancestor that scrolls along an axis (overflow `auto` or `scroll`) lets
 *   the user scroll the box into view along that axis, but only into the
 *   part of the scroller the user can see: its area cut by the outer
 *   ancestors that cut and by the window. The walk moves the box into that
 *   part and goes on from there, so the ancestors around the scroller judge
 *   the box where scrolling puts it, not where it lies now. Along an axis
 *   that does not scroll, the scroller cuts like overflow `hidden`.
 * - A scroller whose visible part is empty (a panel placed outside the
 *   window) loses everything inside it, because no scrolling brings the
 *   content into view.
 * - The window cuts the box only when no ancestor scrolls.
 *
 * `from` and `escape` work as in `clipToAncestors`.
 */
function computeLostShare(
  box: ProbeRect,
  from: Element | null,
  escape: Escape,
  readFacts: ReadFacts,
): number {
  const ancestors = listClippingAncestors(from, escape, readFacts);
  // `reference` is the box as scrolling would put it. The lost share is
  // what `kept` lacks of it, so moving a box into view loses nothing.
  let reference: ProbeRect | null = box;
  let kept: ProbeRect | null = box;
  let hasScroller = false;
  for (let index = 0; index < ancestors.length && kept !== null; index++) {
    const { facts, clip } = ancestors[index]!;
    if (facts.cutsX) kept = moveAndCutAlongAxis(kept, "x", 0, clip);
    if (facts.cutsY) kept = moveAndCutAlongAxis(kept, "y", 0, clip);
    if (!facts.scrollsX && !facts.scrollsY) continue;
    hasScroller = true;
    const view = computeVisibleScrollerArea(clip, ancestors.slice(index + 1));
    if (view === null) return 1;
    if (facts.scrollsX && reference !== null) {
      const delta = computeShiftIntoView(reference.left, reference.right, view.left, view.right);
      reference = moveAndCutAlongAxis(reference, "x", delta, view);
      kept = moveAndCutAlongAxis(kept, "x", delta, view);
    }
    if (facts.scrollsY && reference !== null) {
      const delta = computeShiftIntoView(reference.top, reference.bottom, view.top, view.bottom);
      reference = moveAndCutAlongAxis(reference, "y", delta, view);
      kept = moveAndCutAlongAxis(kept, "y", delta, view);
    }
  }
  if (kept !== null && !hasScroller) kept = intersectRects(kept, readWindowRect());
  if (kept === null || reference === null) return 1;
  return Math.max(0, 1 - computeArea(kept) / computeArea(reference));
}

/** Returns what an element's own position makes it escape, for the clipping of its box. */
function readEscape(element: Element, readFacts: ReadFacts): Escape {
  const { position } = readFacts(element);
  return position === "fixed" ? "fixed" : position === "absolute" ? "absolute" : "none";
}

/** Returns whether the element draws something at all: it has a box and is not hidden. */
function hasVisibleBox(element: Element, readFacts: ReadFacts): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && readFacts(element).style.visibility === "visible";
}

// ---------- Text ----------

/** A text fragment with the paragraph it belongs to, for the prose measure. */
interface CollectedFragment {
  readonly fragment: TextFragment;
  /** The closest paragraph or list item of a message when the text is prose, else null. */
  readonly paragraph: Element | null;
  /**
   * Whether the fragment's box is a stand-in. A pseudo-element's string has no
   * box of its own in the DOM, so its fragment takes the box of its element,
   * which also holds that element's own text.
   */
  readonly hasStandInBox: boolean;
  /** The element that draws the text: a text node's parent, the input of a field, or the host of a pseudo-element. */
  readonly owner: Element;
  /** The share of `fragment.box` that is lost, from 0 to 1: see `computeLostShare`. */
  readonly lostShare: number;
}

/** The state of one `collectText` pass. */
interface TextPass {
  readonly readFacts: ReadFacts;
  readonly readRoleTokens: (element: Element) => Pick<ThemeTokens, "ink" | "muted" | "faint">;
  readonly pseudoHosts: ReadonlySet<Element>;
  readonly fragments: CollectedFragment[];
  nextSourceId: number;
  nextGroupId: number;
}

/** Returns whether the element or the control around it is disabled. */
function isInDisabledControl(element: Element): boolean {
  return (
    element.closest(
      'button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]',
    ) !== null
  );
}

/** Decides the role of a piece of text from its colour and its element. See `TextRole`. */
function decideRole(pass: TextPass, element: Element, colour: ProbeColour): TextRole {
  if (isInDisabledControl(element)) return "disabled";
  const tokens = pass.readRoleTokens(element);
  if (isSameColour(colour, tokens.ink)) return "ink";
  if (isSameColour(colour, tokens.muted)) return "muted";
  if (isSameColour(colour, tokens.faint)) return "faint";
  return "other";
}

/**
 * Returns the opacity groups around an element: it and every ancestor with an
 * opacity above 0 and below 1, outermost first. Each group's element gets the
 * `data-ui-probe-group` attribute with its id, so `hideOpacityGroups` can find
 * it. An element keeps the id it was given by an earlier call. Returns null,
 * and marks nothing, when the element or an ancestor has opacity 0, because
 * nothing inside it is drawn.
 */
function readOpacityGroups(
  pass: TextPass,
  from: Element,
): ReadonlyArray<{ readonly id: number; readonly opacity: number }> | null {
  const groups: Array<{ readonly id: number; readonly opacity: number }> = [];
  const dimmed: Element[] = [];
  for (let element: Element | null = from; element !== null; element = element.parentElement) {
    const { opacity } = pass.readFacts(element);
    if (opacity === 0) return null;
    if (opacity < 1) dimmed.push(element);
  }
  // Outermost first, so that an outer group gets a lower id than the groups inside it.
  for (const element of dimmed.reverse()) {
    let id = Number(element.getAttribute(GROUP_ATTRIBUTE));
    if (!element.hasAttribute(GROUP_ATTRIBUTE)) {
      id = pass.nextGroupId++;
      element.setAttribute(GROUP_ATTRIBUTE, String(id));
    }
    groups.push({ id, opacity: pass.readFacts(element).opacity });
  }
  return groups;
}

/**
 * Counts the characters of a text node that the browser draws on each line
 * fragment, given the line fragments of the whole node. A collapsed space has
 * no box and counts for no line. For a single line the count is the length of
 * the text with its whitespace collapsed; only a wrapped text asks the
 * browser for the box of each character.
 */
function countCharactersPerLine(
  node: Text,
  lines: ReadonlyArray<DOMRect>,
  preservesWhitespace: boolean,
): number[] {
  const text = node.data;
  if (lines.length === 1) {
    return [preservesWhitespace ? text.length : text.replace(/\s+/g, " ").trim().length];
  }
  const counts = lines.map(() => 0);
  const range = document.createRange();
  for (let index = 0; index < text.length;) {
    const length = text.codePointAt(index)! > 0xffff ? 2 : 1;
    range.setStart(node, index);
    range.setEnd(node, index + length);
    index += length;
    const box = range.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const centre = (box.top + box.bottom) / 2;
    let nearest = 0;
    let nearestDistance = Infinity;
    lines.forEach((line, lineIndex) => {
      const distance = Math.abs((line.top + line.bottom) / 2 - centre);
      if (distance < nearestDistance) {
        nearest = lineIndex;
        nearestDistance = distance;
      }
    });
    counts[nearest] = (counts[nearest] ?? 0) + 1;
  }
  return counts;
}

/**
 * Returns the colour a text node draws in, in sRGB. HTML text is drawn in
 * `color`. Text in an SVG is drawn in `fill`, and `fill-opacity` scales its
 * alpha. Fails when the fill is not a plain colour, such as a gradient,
 * because the contrast of such text has no single colour.
 */
function readTextColour(style: CSSStyleDeclaration, parent: Element): ProbeColour {
  if (!(parent instanceof SVGElement)) return resolveColour(style.color);
  const [red, green, blue, alpha] = resolveColour(style.fill);
  return [red, green, blue, alpha * Number.parseFloat(style.fillOpacity)];
}

/** Returns the number of the next piece of text in this pass. */
function takeSourceId(pass: TextPass): number {
  return pass.nextSourceId++;
}

/** Returns whether the element itself is drawn: its `visibility` is visible. */
function isVisible(element: Element, readFacts: ReadFacts): boolean {
  return readFacts(element).style.visibility === "visible";
}

/** Returns the opacity an element is drawn with: its own opacity times that of every ancestor. */
function readEffectiveOpacity(element: Element, readFacts: ReadFacts): number {
  let opacity = 1;
  for (let each: Element | null = element; each !== null; each = each.parentElement) {
    opacity *= readFacts(each).opacity;
  }
  return opacity;
}

/** Returns whether an element is replaced content (an image, svg, canvas, video or iframe), whose own pixels decide what shows through it. */
function isReplacedElement(element: Element): boolean {
  return (
    element instanceof HTMLImageElement ||
    element instanceof SVGSVGElement ||
    element instanceof HTMLCanvasElement ||
    element instanceof HTMLVideoElement ||
    element instanceof HTMLIFrameElement
  );
}

/**
 * The effective opacity and background alpha from which an element hides what
 * is behind it. Only text that is confidently out of sight is left out of the
 * metrics, so the bar is high: a layer that is 90 % opaque still lets the
 * text show through.
 */
const HIDING_ALPHA = 0.95;

/**
 * The paint alpha above which an element that does not hide a point still
 * covers it partly. Below it the layer is too faint to change what the reader
 * sees (a 1 % hover tint), and it is ignored.
 */
const PARTLY_COVERING_ALPHA = 0.05;

/** Returns whether a computed `backdrop-filter` value blurs: it holds a `blur()` with a radius above 0. */
function blursBackdrop(backdropFilter: string): boolean {
  return Array.from(backdropFilter.matchAll(/blur\(\s*([\d.]+)/g)).some(
    ([, radius]) => Number.parseFloat(radius ?? "0") > 0,
  );
}

/** How an element sitting above a point of text affects that point. */
type Coverage = "hidden" | "partly" | "clear";

/**
 * Returns how an element that lies over a point affects the text at that
 * point, from what the element paints and the opacity it is drawn with (its
 * own times that of every ancestor).
 *
 * An element paints in one of four ways: a background colour, a background
 * image, replaced content (an image, svg, canvas, video or iframe), or a
 * backdrop filter that blurs. The first has the alpha of the colour; the
 * others count as alpha 1. The paint alpha is that alpha times the effective
 * opacity.
 *
 * - "hidden": the effective opacity is at least 0.95 and the element has a
 *   background colour with alpha of at least 0.95, or a backdrop filter that
 *   blurs (a frosted layer blurs what is behind it past reading).
 * - "partly": the element does not hide the point, but its paint alpha is
 *   above 0.05. A wash of 50 % is an example. A background image or replaced
 *   content is never taken as hiding, because whether it is transparent at
 *   the point cannot be read from its style: a gradient of `transparent`
 *   hides nothing. Text under it stays measured, as unsupported.
 * - "clear": anything else, including an element that paints nothing, such
 *   as one with only text or a border.
 */
function readCoverageOfPoint(element: Element, readFacts: ReadFacts): Coverage {
  const { style } = readFacts(element);
  const backgroundAlpha = resolveColour(style.backgroundColor)[3];
  const blurs = blursBackdrop(style.backdropFilter);
  const paintsOtherwise = isReplacedElement(element) || style.backgroundImage !== "none" || blurs;
  const opacity = readEffectiveOpacity(element, readFacts);
  if (opacity >= HIDING_ALPHA && (blurs || backgroundAlpha >= HIDING_ALPHA)) {
    return "hidden";
  }
  const paintAlpha = (paintsOtherwise ? 1 : backgroundAlpha) * opacity;
  return paintAlpha > PARTLY_COVERING_ALPHA ? "partly" : "clear";
}

/**
 * Returns how other elements cover a fragment: "hidden" when nobody sees it
 * (a tray that slides over a list, a floating header over the transcript),
 * "partly" when something translucent lies over some of it, and "clear"
 * otherwise. Five points are tried: the centre and the four corners of the
 * visible box, each moved 1px inward (less in a box thinner than 2px).
 *
 * At each point the walk goes down the elements at that point from the
 * topmost, as `readCoverageOfPoint` judges them:
 *
 * - An element that hides the point ends the walk: the point is hidden.
 * - An element that covers the point partly marks it, and the walk goes on.
 * - The walk skips elements that are not drawn (`visibility` hidden, or too
 *   faint to count), such as the sidebar's hover buttons over the row text,
 *   and elements that paint nothing, such as a second block of text at the
 *   same place.
 * - The walk ends, with what was found so far, at the owner, an element
 *   inside it, or an element around it.
 * - An element with `pointer-events: none` is not in the list the browser
 *   gives, so such an overlay never covers anything.
 *
 * The fragment is "hidden" when all five points are hidden, "partly" when
 * it is not hidden and some point is covered partly, else "clear". A
 * fragment with no visible box, or whose owner ignores the pointer (the
 * browser leaves such an element out of the list, so nothing can be said),
 * is "clear".
 */
function readCoverage(readFacts: ReadFacts, { fragment, owner }: CollectedFragment): Coverage {
  const box = fragment.visibleBox;
  if (box === null || readFacts(owner).style.pointerEvents === "none") return "clear";
  const insetX = Math.min(1, (box.right - box.left) / 2);
  const insetY = Math.min(1, (box.bottom - box.top) / 2);
  const points = [
    [(box.left + box.right) / 2, (box.top + box.bottom) / 2],
    [box.left + insetX, box.top + insetY],
    [box.right - insetX, box.top + insetY],
    [box.left + insetX, box.bottom - insetY],
    [box.right - insetX, box.bottom - insetY],
  ] as const;
  let hiddenPoints = 0;
  let hasPartlyCoveredPoint = false;
  for (const [x, y] of points) {
    let partly = false;
    let hidden = false;
    for (const element of document.elementsFromPoint(x, y)) {
      if (element === owner || owner.contains(element) || element.contains(owner)) break;
      if (!isVisible(element, readFacts)) continue;
      const coverage = readCoverageOfPoint(element, readFacts);
      if (coverage === "hidden") {
        hidden = true;
        break;
      }
      if (coverage === "partly") partly = true;
    }
    if (hidden) hiddenPoints += 1;
    else if (partly) hasPartlyCoveredPoint = true;
  }
  if (hiddenPoints === points.length) return "hidden";
  return hasPartlyCoveredPoint ? "partly" : "clear";
}

/** Reads the line fragments of one text node and adds them to the pass. */
function readTextNode(pass: TextPass, node: Text, parent: Element): void {
  if (!/\S/.test(node.data)) return;
  const facts = pass.readFacts(parent);
  if (facts.style.visibility !== "visible") return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const lines = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (lines.length === 0) return;
  const opacityGroups = readOpacityGroups(pass, parent);
  if (opacityGroups === null) return;
  const preservesWhitespace = facts.style.whiteSpace.startsWith("pre");
  const counts = countCharactersPerLine(node, lines, preservesWhitespace);

  const colour = readTextColour(facts.style, parent);
  const sourceId = takeSourceId(pass);
  const role = decideRole(pass, parent, colour);
  const paragraph =
    parent.closest(NOT_PROSE_SELECTOR) === null ? parent.closest(PROSE_SELECTOR) : null;
  lines.forEach((line, index) => {
    const length = counts[index] ?? 0;
    if (length === 0) return;
    const box = toProbeRect(line);
    pass.fragments.push({
      paragraph,
      hasStandInBox: false,
      owner: parent,
      lostShare: computeLostShare(box, parent, "none", pass.readFacts),
      fragment: {
        sourceId,
        length,
        box,
        visibleBox: clipToAncestors(box, parent, "none", pass.readFacts),
        fontSize: Number.parseFloat(facts.style.fontSize),
        fontWeight: Number.parseFloat(facts.style.fontWeight),
        colour,
        role,
        opacityGroups,
        isProse: paragraph !== null,
        partlyCovered: false,
      },
    });
  });
}

/** Returns the area inside an input's border and padding, where its text is drawn. */
function readContentBox(element: Element, style: CSSStyleDeclaration): ProbeRect {
  const box = element.getBoundingClientRect();
  const read = (property: string): number =>
    Number.parseFloat(style.getPropertyValue(property)) || 0;
  return {
    left: box.left + read("border-left-width") + read("padding-left"),
    top: box.top + read("border-top-width") + read("padding-top"),
    right: box.right - read("border-right-width") - read("padding-right"),
    bottom: box.bottom - read("border-bottom-width") - read("padding-bottom"),
  };
}

/**
 * Reads the text of an input, a textarea or a select as one fragment: its
 * value, or its placeholder when it is empty. The box is the field's content
 * box.
 */
function readField(
  pass: TextPass,
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): void {
  if (field instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(field.type)) return;
  if (!hasVisibleBox(field, pass.readFacts)) return;
  const value =
    field instanceof HTMLSelectElement ? (field.selectedOptions[0]?.text ?? "") : field.value;
  const isPlaceholder = value === "" && !(field instanceof HTMLSelectElement);
  const text = isPlaceholder ? field.placeholder : value;
  if (text === "") return;

  // The placeholder has a style of its own, which inherits the field's.
  const fieldStyle = pass.readFacts(field).style;
  const style = isPlaceholder ? getComputedStyle(field, "::placeholder") : fieldStyle;
  const box = readContentBox(field, fieldStyle);
  if (computeArea(box) === 0) return;
  const opacityGroups = readOpacityGroups(pass, field);
  if (opacityGroups === null) return;
  const colour = resolveColour(style.color);
  const escape = readEscape(field, pass.readFacts);
  pass.fragments.push({
    paragraph: null,
    hasStandInBox: false,
    owner: field,
    lostShare: computeLostShare(box, field.parentElement, escape, pass.readFacts),
    fragment: {
      sourceId: takeSourceId(pass),
      length: text.length,
      box,
      visibleBox: clipToAncestors(box, field.parentElement, escape, pass.readFacts),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight),
      colour,
      role: isPlaceholder ? "placeholder" : decideRole(pass, field, colour),
      opacityGroups,
      isProse: false,
      partlyCovered: false,
    },
  });
}

/**
 * Returns the string a computed `content` value draws, or null when it draws
 * none or draws something that is not a string (a counter, an image, a quote
 * mark). The browser writes `attr()` out as its string, and writes alternative
 * text after a slash, which this ignores because it is not drawn.
 */
function parseDrawnContent(content: string): string | null {
  const drawn = content.replace(/\s\/\s.*$/s, "");
  if (!/^(?:"(?:[^"\\]|\\.)*"\s*)+$/s.test(drawn)) return null;
  const strings = drawn.match(/"(?:[^"\\]|\\.)*"/gs) ?? [];
  const text = strings
    .map((quoted) =>
      quoted
        .slice(1, -1)
        .replace(
          /\\([0-9a-f]{1,6})\s?|\\(.)/gis,
          (_match, hex: string | undefined, other: string | undefined) =>
            hex === undefined ? (other ?? "") : String.fromCodePoint(Number.parseInt(hex, 16)),
        ),
    )
    .join("");
  return /\S/.test(text) ? text : null;
}

/** Reads the `::before` or `::after` of an element as one fragment when it draws a string. */
function readPseudoElement(pass: TextPass, host: Element, pseudo: "::before" | "::after"): void {
  const style = getComputedStyle(host, pseudo);
  const text = parseDrawnContent(style.content);
  if (text === null || style.display === "none" || style.visibility !== "visible") return;
  const hostBox = host.getBoundingClientRect();
  if (hostBox.width <= 0 || hostBox.height <= 0) return;
  const box = toProbeRect(hostBox);
  const opacityGroups = readOpacityGroups(pass, host);
  if (opacityGroups === null) return;
  const colour = resolveColour(style.color);
  // The editor draws its placeholder as the ::before of its empty paragraph and keeps the hint in `data-placeholder`.
  const isPlaceholder = host.hasAttribute("data-placeholder");
  pass.fragments.push({
    paragraph: null,
    hasStandInBox: true,
    owner: host,
    lostShare: computeLostShare(box, host, "none", pass.readFacts),
    fragment: {
      sourceId: takeSourceId(pass),
      length: text.length,
      box,
      visibleBox: clipToAncestors(box, host, "none", pass.readFacts),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseFloat(style.fontWeight),
      colour,
      role: isPlaceholder ? "placeholder" : decideRole(pass, host, colour),
      opacityGroups,
      isProse: false,
      partlyCovered: false,
    },
  });
}

/** Reads an element, its children and its pseudo-elements in document order. */
function readElement(pass: TextPass, element: Element): void {
  if (SKIPPED_TAGS.has(element.tagName.toUpperCase())) return;
  if (pass.pseudoHosts.has(element)) readPseudoElement(pass, element, "::before");
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    readField(pass, element);
  }
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLSelectElement)) {
    for (const child of element.childNodes) {
      if (child instanceof Text) readTextNode(pass, child, element);
      else if (child instanceof Element) readElement(pass, child);
    }
  }
  if (pass.pseudoHosts.has(element)) readPseudoElement(pass, element, "::after");
}

/**
 * Reads every piece of text on the page that is visible in principle, in
 * document order, with the paragraph of each prose fragment. Text that
 * another element paints over is still here; `readPaintedTextFragments`
 * leaves it out.
 */
function readTextFragments(readFacts: ReadFacts): CollectedFragment[] {
  const existingGroups = Array.from(document.querySelectorAll(`[${GROUP_ATTRIBUTE}]`), (element) =>
    Number(element.getAttribute(GROUP_ATTRIBUTE)),
  );
  const pass: TextPass = {
    readFacts,
    readRoleTokens: createRoleTokens(),
    pseudoHosts: findPseudoHosts(),
    fragments: [],
    nextSourceId: 0,
    nextGroupId: Math.max(-1, ...existingGroups) + 1,
  };
  readElement(pass, document.body);
  return pass.fragments;
}

/**
 * Reads the text of the page like `readTextFragments`, without the text that
 * another element hides: the text a user sees. A fragment that something
 * translucent lies over has `partlyCovered` set.
 */
function readPaintedTextFragments(): CollectedFragment[] {
  const readFacts = createFactsReader();
  const painted: CollectedFragment[] = [];
  for (const collected of readTextFragments(readFacts)) {
    const coverage = readCoverage(readFacts, collected);
    if (coverage === "hidden") continue;
    painted.push(
      coverage === "partly"
        ? { ...collected, fragment: { ...collected.fragment, partlyCovered: true } }
        : collected,
    );
  }
  return painted;
}

/**
 * Returns every visible piece of text on the page, one fragment per line of
 * each text node, input value, placeholder and drawn `::before` or `::after`
 * string, in document order. See `TextFragment` for what a fragment holds.
 *
 * Text that another element hides is left out, and text that something
 * translucent lies over is marked `partlyCovered`: see `readCoverage`.
 *
 * An element with an opacity above 0 and below 1 around the text gets a
 * `data-ui-probe-group` attribute that names it in `opacityGroups`. Text
 * inside an element of opacity 0 is not drawn, so it is left out.
 */
export function collectText(): TextFragment[] {
  return readPaintedTextFragments().map((collected) => collected.fragment);
}

// ---------- Hiding text and see-through groups ----------

/** Adds a `<style>` element that holds `css`, replacing the one with the same `key` if there is one. */
function injectStyle(key: string, css: string): void {
  removeStyle(key);
  const style = document.createElement("style");
  style.dataset.uiProbe = key;
  style.textContent = css;
  document.head.append(style);
}

/** Removes the `<style>` element `injectStyle` added under `key`, if there is one. */
function removeStyle(key: string): void {
  document.head.querySelector(`style[data-ui-probe="${key}"]`)?.remove();
}

/**
 * Makes every glyph, text decoration, text shadow and caret transparent, and
 * nothing else. The page keeps its layout, its backgrounds and its icons, so a
 * screenshot shows what lies behind the text. It sets the text fill, not
 * `color`, because `color: transparent` would also erase borders and icons
 * drawn in `currentColor`. Text in an SVG is drawn with `fill` and `stroke`,
 * which the text fill does not reach, so these are made transparent on
 * `<text>` and `<tspan>` only.
 */
export function hideText(): void {
  injectStyle(
    "hide-text",
    `*, *::before, *::after, *::placeholder {
      -webkit-text-fill-color: transparent !important;
      text-decoration-color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
    }
    text, tspan {
      fill: transparent !important;
      stroke: transparent !important;
    }`,
  );
}

/** Undoes `hideText`. */
export function showText(): void {
  removeStyle("hide-text");
}

/**
 * Hides the elements `collectText` marked with these group ids (the
 * `visibility` of each becomes hidden), so a screenshot shows what lies
 * behind a see-through group. An id no element holds hides nothing.
 */
export function hideOpacityGroups(ids: ReadonlyArray<number>): void {
  if (ids.length === 0) {
    removeStyle("hide-groups");
    return;
  }
  const selector = ids.map((id) => `[${GROUP_ATTRIBUTE}="${id}"]`).join(", ");
  injectStyle("hide-groups", `${selector} { visibility: hidden !important; }`);
}

/** Undoes `hideOpacityGroups`. */
export function showOpacityGroups(): void {
  removeStyle("hide-groups");
}

// ---------- Glass ----------

/** What the page's `<html>` held for glass before `setGlass` changed it. */
interface GlassState {
  readonly percent: string;
  readonly percentPriority: string;
  readonly isSolid: boolean;
}

let originalGlass: GlassState | undefined;

/**
 * Sets the Glass level of the page the way `applySheetAppearance` does: the
 * `--glass-percent` property, and the `data-solid-glass` attribute when the
 * level is 0, which turns the backdrop filter off as well. The level 40 is
 * what the page was captured at, so it restores exactly what `<html>` held
 * before the first call.
 */
export function setGlass(percent: number): void {
  const root = document.documentElement;
  originalGlass ??= {
    percent: root.style.getPropertyValue("--glass-percent"),
    percentPriority: root.style.getPropertyPriority("--glass-percent"),
    isSolid: root.hasAttribute("data-solid-glass"),
  };
  if (percent === 40) {
    if (originalGlass.percent === "") root.style.removeProperty("--glass-percent");
    else
      root.style.setProperty(
        "--glass-percent",
        originalGlass.percent,
        originalGlass.percentPriority,
      );
    root.toggleAttribute("data-solid-glass", originalGlass.isSolid);
    return;
  }
  root.style.setProperty("--glass-percent", String(percent));
  root.toggleAttribute("data-solid-glass", percent === 0);
}

// ---------- Stylesheet rules ----------

/** Splits a selector list at its top-level commas, so `:is(a, b), c` is two selectors. */
function splitSelectorList(selectors: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < selectors.length; index++) {
    const character = selectors[index]!;
    if (quote !== null) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    else if (character === "," && depth === 0) {
      parts.push(selectors.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selectors.slice(start).trim());
  return parts;
}

/**
 * Returns the full selector of a rule nested in a style rule: each nested
 * selector with `&` replaced by the parent, or placed under the parent as a
 * descendant when it has no `&`.
 */
function resolveNestedSelector(selector: string, parent: string): string {
  return splitSelectorList(selector)
    .map((part) =>
      part.includes("&") ? part.replaceAll("&", `:is(${parent})`) : `:is(${parent}) ${part}`,
    )
    .join(", ");
}

/** A style rule with the selector it applies under, nested rules resolved. */
interface AuthoredRule {
  readonly rule: CSSStyleRule;
  readonly selector: string;
}

/**
 * Calls `visit` for every style rule that applies to the page, in every style
 * sheet: rules inside `@layer`, `@container`, `@import`, and CSS nesting, and
 * inside an `@media` or `@supports` whose condition holds now. Rules in
 * keyframes, font faces and `@starting-style` are not visited.
 */
function visitStyleRules(visit: (authored: AuthoredRule) => void): void {
  const walk = (rules: CSSRuleList, parentSelector: string | null): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const selector =
          parentSelector === null
            ? rule.selectorText
            : resolveNestedSelector(rule.selectorText, parentSelector);
        visit({ rule, selector });
        walk(rule.cssRules, selector);
      } else if (rule instanceof CSSMediaRule) {
        if (window.matchMedia(rule.media.mediaText).matches) walk(rule.cssRules, parentSelector);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) walk(rule.cssRules, parentSelector);
      } else if (rule instanceof CSSLayerBlockRule || rule instanceof CSSContainerRule) {
        walk(rule.cssRules, parentSelector);
      } else if (rule instanceof CSSImportRule && rule.styleSheet !== null) {
        walk(rule.styleSheet.cssRules, parentSelector);
      }
    }
  };
  for (const sheet of document.styleSheets) walk(sheet.cssRules, null);
}

/**
 * Returns the selector with its pseudo-elements removed, so it matches the
 * element a pseudo-element belongs to, or null when nothing is left (such as
 * `::selection`, which belongs to every element). `a:hover::before` becomes
 * `a:hover`, and `*::before` becomes `*`, which matches every element.
 */
function stripPseudoElements(selector: string): string | null {
  const stripped = selector.replace(/::?(?:before|after)\b|::[\w-]+(?:\([^)]*\))?/gi, "").trim();
  return stripped === "" ? null : stripped;
}

/**
 * Returns the elements that have a `::before` or `::after` with a `content`
 * declaration in some style sheet. Only these can draw a pseudo-element
 * string, so asking every element for its pseudo-element styles is not needed.
 */
function findPseudoHosts(): Set<Element> {
  const hosts = new Set<Element>();
  visitStyleRules(({ rule, selector }) => {
    if (rule.style.getPropertyValue("content") === "") return;
    for (const part of splitSelectorList(selector)) {
      if (!/::?(?:before|after)\b/i.test(part)) continue;
      const hostSelector = stripPseudoElements(part);
      if (hostSelector === null) continue;
      for (const host of document.querySelectorAll(hostSelector)) hosts.add(host);
    }
  });
  return hosts;
}

// ---------- Discipline ----------

/** Returns whether the value is a CSS-wide keyword, which takes its value from elsewhere and adds no value of its own. */
function isInheritedKeyword(value: string): boolean {
  return /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(value);
}

/** Returns whether a font size is a `var(--t-…)` of the type scale, with or without a fallback. */
function isOnScaleFontSize(value: string): boolean {
  return isInheritedKeyword(value) || /^var\(\s*--t-[\w-]+\s*(?:,.*)?\)$/s.test(value);
}

/**
 * Returns whether every corner of a radius value is on the radius scale: a
 * `var(--r-…)`, zero, or a pill or circle (50 % or more, or 999 px or more,
 * or `100vmax`).
 */
function isOnTokenRadius(value: string): boolean {
  if (isInheritedKeyword(value)) return true;
  // Split at spaces and slashes outside parentheses, so `var(--r-md, 4px)` stays whole.
  const corners = value.match(/(?:[^\s/(]|\((?:[^()]|\([^()]*\))*\))+/g) ?? [];
  return corners.every(
    (corner) =>
      /^var\(\s*--r-[\w-]+\s*(?:,.*)?\)$/s.test(corner) ||
      /^0(?:px|%)?$/.test(corner) ||
      /^(?:[5-9]\d|\d{3,})(?:\.\d+)?%$/.test(corner) ||
      /^(?:9\d{2}|\d{4,})(?:\.\d+)?px$/.test(corner) ||
      /^\d+vmax$/.test(corner),
  );
}

/** Returns the declarations of a style declaration that set a font size or radius, as `[property, value]`. */
function readShapeDeclarations(style: CSSStyleDeclaration): {
  fontSizes: Array<[string, string]>;
  radii: Array<[string, string]>;
} {
  const fontSizes: Array<[string, string]> = [];
  const fontSize = style.getPropertyValue("font-size").trim();
  if (fontSize !== "") fontSizes.push(["font-size", fontSize]);
  const font = style.getPropertyValue("font").trim();
  if (font !== "" && !isInheritedKeyword(font) && !/var\(\s*--t-/.test(font)) {
    fontSizes.push(["font", font]);
  }
  const radii: Array<[string, string]> = [];
  const shorthand = style.getPropertyValue(RADIUS_SHORTHAND).trim();
  if (shorthand !== "") radii.push([RADIUS_SHORTHAND, shorthand]);
  // When the shorthand serializes, it already holds every longhand it sets.
  for (const longhand of shorthand === "" ? RADIUS_LONGHANDS : []) {
    const value = style.getPropertyValue(longhand).trim();
    if (value !== "") radii.push([longhand, value]);
  }
  return { fontSizes, radii };
}

/** Returns a short name for an element in reports: its tag and its first two classes. */
function describeElement(element: Element): string {
  const classes = Array.from(element.classList).slice(0, 2);
  return [element.tagName.toLowerCase(), ...classes].join(".");
}

/** Returns every visible element of the page: it has a box, is not hidden, and the box touches the window. */
function listVisibleElements(readFacts: ReadFacts): Element[] {
  const window_ = readWindowRect();
  return Array.from(document.body.querySelectorAll("*")).filter((element) => {
    if (SKIPPED_TAGS.has(element.tagName.toUpperCase())) return false;
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      readFacts(element).style.visibility === "visible" &&
      intersectRects(toProbeRect(box), window_) !== null
    );
  });
}

/**
 * Returns the type, shape and spacing values of the page: see
 * `DisciplineFacts`. The authored declarations come from the style sheets
 * (every rule whose selector matches a visible element) and from inline
 * `style` attributes. A pill or a circle, and zero, are not off-token radii.
 */
export function collectDiscipline(): DisciplineFacts {
  const readFacts = createFactsReader();
  const visible = listVisibleElements(readFacts);
  const visibleSet = new Set(visible);

  const fontSizes = new Set<number>();
  const fontWeights = new Set<number>();
  for (const { fragment } of readPaintedTextFragments()) {
    fontSizes.add(fragment.fontSize);
    fontWeights.add(fragment.fontWeight);
  }

  const radii = new Set<string>();
  const spacingValues: number[] = [];
  for (const element of visible) {
    const style = readFacts(element).style;
    for (const longhand of RADIUS_LONGHANDS.slice(0, 4)) {
      const radius = style.getPropertyValue(longhand).trim();
      if (!/^0(?:px|%)?(?: 0(?:px|%)?)?$/.test(radius)) radii.add(radius);
    }
    const styleMap = element.computedStyleMap();
    for (const property of SPACING_PROPERTIES) {
      // The typed value keeps `auto` and `normal` as keywords, where the
      // resolved value of an `auto` margin is the number of pixels it grew to.
      const value = styleMap.get(property);
      if (value instanceof CSSUnitValue && value.unit === "px" && value.value !== 0) {
        spacingValues.push(value.value);
      }
    }
  }

  const offScaleFontSizes = new Set<string>();
  const offTokenRadii = new Set<string>();
  const noteDeclarations = (name: string, style: CSSStyleDeclaration): void => {
    const declarations = readShapeDeclarations(style);
    for (const [property, value] of declarations.fontSizes) {
      if (property === "font-size" ? !isOnScaleFontSize(value) : true) {
        offScaleFontSizes.add(`${name} { ${property}: ${value} }`);
      }
    }
    for (const [property, value] of declarations.radii) {
      if (!isOnTokenRadius(value)) offTokenRadii.add(`${name} { ${property}: ${value} }`);
    }
  };

  const hasVisibleMatch = new Map<string, boolean>();
  const matchesVisibleElement = (selector: string): boolean => {
    let matches = hasVisibleMatch.get(selector);
    if (matches === undefined) {
      matches = splitSelectorList(selector).some((part) => {
        const elementSelector = stripPseudoElements(part);
        if (elementSelector === null) return false;
        for (const element of document.querySelectorAll(elementSelector)) {
          if (visibleSet.has(element)) return true;
        }
        return false;
      });
      hasVisibleMatch.set(selector, matches);
    }
    return matches;
  };
  visitStyleRules(({ rule, selector }) => {
    const { fontSizes: sizes, radii: corners } = readShapeDeclarations(rule.style);
    if (sizes.length === 0 && corners.length === 0) return;
    if (matchesVisibleElement(selector)) noteDeclarations(selector, rule.style);
  });
  for (const element of visible) {
    if (element.hasAttribute("style") && "style" in element) {
      noteDeclarations(`${describeElement(element)}[style]`, element.style as CSSStyleDeclaration);
    }
  }

  const numeric = (first: number, second: number): number => first - second;
  const text = (first: string, second: string): number =>
    first.localeCompare(second, "en", { numeric: true });
  return {
    fontSizes: [...fontSizes].sort(numeric),
    fontWeights: [...fontWeights].sort(numeric),
    radii: [...radii].sort(text),
    offScaleFontSizes: [...offScaleFontSizes].sort(text),
    offTokenRadii: [...offTokenRadii].sort(text),
    spacingValues,
  };
}

// ---------- Targets and focus ----------

/**
 * Returns a short name for a target: its accessible name or the text it
 * shows, else its tag and classes. A field shows its label, its placeholder or
 * its selected option.
 */
function nameTarget(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const field =
    element instanceof HTMLSelectElement
      ? (element.selectedOptions[0]?.text ?? "")
      : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? (element.labels?.[0]?.textContent ?? element.placeholder)
        : "";
  const candidates = [
    element.getAttribute("aria-label"),
    labelledText,
    field,
    field === "" ? element.textContent : "",
    element.getAttribute("title"),
  ];
  for (const candidate of candidates) {
    const name = (candidate ?? "").replace(/\s+/g, " ").trim();
    if (name !== "") return name.slice(0, 60);
  }
  return describeElement(element);
}

/** Returns whether an element sits in the prose of a message. See `PROSE_SELECTOR`. */
function isInProse(element: Element): boolean {
  return element.closest(PROSE_SELECTOR) !== null && element.closest(NOT_PROSE_SELECTOR) === null;
}

/**
 * Returns the elements a user can click or focus that are visible (part of
 * the box is in the window and not clipped), enabled, and not inside an inert
 * subtree, in document order. Each gets a `data-ui-probe-target` attribute
 * with its id, for `focusTarget`; the ids of an earlier call are dropped, and
 * so are the scroll containers `focusTarget` found.
 *
 * `inWindow` is true when nothing of the box is cut, by the window or by a
 * clipping ancestor, because the focus check needs the whole ring in view.
 */
export function collectTargets(): ProbeTarget[] {
  scrollContainers = undefined;
  for (const marked of document.querySelectorAll(`[${TARGET_ATTRIBUTE}]`)) {
    marked.removeAttribute(TARGET_ATTRIBUTE);
  }
  const readFacts = createFactsReader();
  const targets: ProbeTarget[] = [];
  for (const element of document.querySelectorAll(TARGET_SELECTOR)) {
    if (!hasVisibleBox(element, readFacts)) continue;
    if (element.closest('[inert], [aria-disabled="true"]') !== null) continue;
    if (element.matches(":disabled")) continue;
    const box = toProbeRect(element.getBoundingClientRect());
    const visibleBox = clipToAncestors(
      box,
      element.parentElement,
      readEscape(element, readFacts),
      readFacts,
    );
    if (visibleBox === null) continue;
    const id = targets.length;
    element.setAttribute(TARGET_ATTRIBUTE, String(id));
    targets.push({
      id,
      box,
      name: nameTarget(element),
      inlineInProse: element.tagName === "A" && isInProse(element),
      inWindow: isSameRect(box, visibleBox),
    });
  }
  return targets;
}

/**
 * The elements that have scrolled content, found once for the page by the
 * first `focusTarget` after a `collectTargets` (which forgets them). Only
 * these can change their scroll position when an element gets the focus, so
 * `focusTarget` and `blurTarget` save and restore only these instead of
 * looking at every element each time. They stay valid because nothing changes
 * the page's layout while the focus is measured.
 */
let scrollContainers: ReadonlyArray<Element> | undefined;

/** The element `focusTarget` focused, with the scroll positions to put back when it is blurred. */
let focusSnapshot:
  | {
      readonly element: HTMLElement;
      readonly window: { readonly left: number; readonly top: number };
      readonly scrolled: ReadonlyArray<{
        readonly element: Element;
        readonly left: number;
        readonly top: number;
      }>;
    }
  | undefined;

/** Returns every element under the body whose content is larger than its box, so that it has a scroll position. */
function findScrollContainers(): Element[] {
  return Array.from(document.body.querySelectorAll("*")).filter(
    (each) => each.scrollHeight > each.clientHeight || each.scrollWidth > each.clientWidth,
  );
}

/**
 * Focuses the target `collectTargets` gave this id, as a keyboard user would
 * (`focusVisible`), without scrolling anything into view. Returns whether the
 * element is now the active element and matches `:focus-visible`. Fails when
 * no element has the id.
 *
 * A target focused by an earlier call is blurred first, so a caller that
 * checks many targets in a row needs one call per target, and one
 * `blurTarget` at the end.
 */
export function focusTarget(id: number): FocusOutcome {
  const element = document.querySelector(`[${TARGET_ATTRIBUTE}="${id}"]`);
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
    throw new Error(`No focusable element carries the target id ${id}. Call collectTargets first.`);
  }
  if (focusSnapshot !== undefined) blurTarget();
  scrollContainers ??= findScrollContainers();
  // `preventScroll` should keep every scroll position, but a script can scroll
  // on focus all the same, and the screenshots must see the page where it was.
  focusSnapshot = {
    element: element as HTMLElement,
    window: { left: window.scrollX, top: window.scrollY },
    scrolled: scrollContainers.map((each) => ({
      element: each,
      left: each.scrollLeft,
      top: each.scrollTop,
    })),
  };
  const options: FocusOptions & { focusVisible: boolean } = {
    focusVisible: true,
    preventScroll: true,
  };
  (element as HTMLElement).focus(options);
  return { focused: document.activeElement === element && element.matches(":focus-visible") };
}

/**
 * Removes focus from the target `focusTarget` focused and puts every scroll
 * position back as it was before. Fails when no target is focused.
 */
export function blurTarget(): void {
  if (focusSnapshot === undefined) {
    throw new Error("No target is focused. Call focusTarget first.");
  }
  const snapshot = focusSnapshot;
  focusSnapshot = undefined;
  snapshot.element.blur();
  if (window.scrollX !== snapshot.window.left || window.scrollY !== snapshot.window.top) {
    window.scrollTo(snapshot.window.left, snapshot.window.top);
  }
  for (const { element, left, top } of snapshot.scrolled) {
    if (element.scrollLeft !== left || element.scrollTop !== top) element.scrollTo(left, top);
  }
}

/**
 * Returns, for each selector, the visible box of every element it matches:
 * the box cut to the window and to the clipping ancestors. An element that is
 * hidden or fully cut away is left out, so a selector that matches nothing
 * visible gives an empty array. Fails on a selector the browser rejects.
 */
export function measureParts(selectors: ReadonlyArray<string>): ProbeRect[][] {
  const readFacts = createFactsReader();
  return selectors.map((selector) => {
    const boxes: ProbeRect[] = [];
    for (const element of document.querySelectorAll(selector)) {
      if (!hasVisibleBox(element, readFacts)) continue;
      const visibleBox = clipToAncestors(
        toProbeRect(element.getBoundingClientRect()),
        element.parentElement,
        readEscape(element, readFacts),
        readFacts,
      );
      if (visibleBox !== null) boxes.push(visibleBox);
    }
    return boxes;
  });
}

// ---------- Perturbations ----------

/** Undoes the perturbation that is applied now, or is undefined when there is none. */
let undoPerturbation: (() => void) | undefined;

/** Reads the layout so the browser applies pending style changes now, and a measure that follows sees them. */
function forceLayout(): void {
  document.documentElement.getBoundingClientRect();
}

/**
 * Changes the page to test how its text survives, and returns once the new
 * layout is in place:
 *
 * - "text-spacing": the text spacing of WCAG 1.4.12 (line height 1.5, letter
 *   spacing 0.12em, word spacing 0.16em, and 2em after each paragraph).
 * - "largest-text-size": the largest Text size step of Settings > Appearance,
 *   set the way `public/theme-init.js` sets it: `data-text-size="4"` on the
 *   root element, which base.css turns into type tokens two pixels larger.
 *   Removing the perturbation puts back exactly what the attribute was, a
 *   step a page may have set from its URL or no attribute at all.
 *
 * Fails when a perturbation is already applied.
 */
export function applyPerturbation(perturbation: Perturbation): void {
  if (undoPerturbation !== undefined) {
    throw new Error("A perturbation is already applied. Call removePerturbation first.");
  }
  if (perturbation === "text-spacing") {
    injectStyle(
      "perturbation",
      `* {
        line-height: 1.5 !important;
        letter-spacing: 0.12em !important;
        word-spacing: 0.16em !important;
      }
      p { margin-bottom: 2em !important; }`,
    );
    undoPerturbation = () => removeStyle("perturbation");
  } else {
    const root = document.documentElement;
    const before = root.getAttribute("data-text-size");
    root.setAttribute("data-text-size", "4");
    undoPerturbation = () => {
      if (before === null) root.removeAttribute("data-text-size");
      else root.setAttribute("data-text-size", before);
    };
  }
  forceLayout();
}

/** Undoes the perturbation `applyPerturbation` applied. It does nothing when none is applied. */
export function removePerturbation(): void {
  undoPerturbation?.();
  undoPerturbation = undefined;
  forceLayout();
}

// ---------- Measures of the text ----------

/**
 * Returns how much text is lost or overlapping in the page as it is now,
 * from the fragments `collectText` reads, plus the ones it leaves out because
 * another element paints over them. Covered text still counts as lost
 * characters: a layout that fits the text should not depend on a tray or a
 * header happening to hide the clipped part. It does not count in the
 * overlaps, because an overlap is two pieces of text that visibly collide,
 * and text under a tray is not visible. Text with opacity 0 is not counted
 * at all.
 *
 * - A fragment's lost characters are its length times its lost share,
 *   rounded to whole characters. An ancestor with overflow `hidden` or
 *   `clip` cuts the box along that axis for good. An ancestor with `auto` or
 *   `scroll` does not: the user scrolls the box into view, so a transcript
 *   far below the fold loses nothing. The window cuts the box only when no
 *   ancestor scrolls. See `computeLostShare`.
 * - Two fragments of different sources overlap when their visible boxes
 *   (cut by the window and every clipping ancestor, scrolling ones too)
 *   share more than 2 square pixels. A part that is cut away is not drawn,
 *   so it cannot overlap anything. A fragment that another element
 *   hides (see `readCoverage`) is left out of the pairs.
 * - The string of a pseudo-element is left out of the overlaps, because its
 *   box is its element's box, which holds other text.
 *
 * Text inside an element of opacity 0 is not in the fragments at all.
 */
export function measureClipping(): ClippingFacts {
  const readFacts = createFactsReader();
  const collected = readTextFragments(readFacts);
  let clippedCharacters = 0;
  for (const { fragment, lostShare } of collected) {
    clippedCharacters += Math.round(fragment.length * lostShare);
  }

  // Sweep from left to right: a fragment can overlap only the fragments that start before it ends.
  const drawn = collected
    .filter(
      (each) =>
        each.fragment.visibleBox !== null &&
        !each.hasStandInBox &&
        readCoverage(readFacts, each) !== "hidden",
    )
    .map(({ fragment }) => ({ sourceId: fragment.sourceId, box: fragment.visibleBox! }))
    .sort((first, second) => first.box.left - second.box.left);
  let overlappingPairs = 0;
  for (let first = 0; first < drawn.length; first++) {
    const one = drawn[first]!;
    for (let second = first + 1; second < drawn.length; second++) {
      const other = drawn[second]!;
      if (other.box.left >= one.box.right) break;
      if (other.sourceId === one.sourceId) continue;
      const shared = intersectRects(one.box, other.box);
      if (shared !== null && computeArea(shared) > OVERLAP_THRESHOLD_PX2) overlappingPairs++;
    }
  }
  return { clippedCharacters, overlappingPairs };
}

/**
 * Returns the measure of the prose of the transcript's messages: the mean
 * number of characters on a full line. A paragraph's fragments are split
 * into lines by their top (within 2 px), the last line of each paragraph is
 * left out because it is shorter by nature, and a line counts only when none
 * of its fragments is cut by the window or a clipping ancestor. The last line
 * is chosen among all lines of the paragraph, also those out of view.
 */
export function measureProse(): ProseFacts {
  const byParagraph = new Map<Element, TextFragment[]>();
  for (const { fragment, paragraph } of readPaintedTextFragments()) {
    if (paragraph === null) continue;
    const group = byParagraph.get(paragraph);
    if (group === undefined) byParagraph.set(paragraph, [fragment]);
    else group.push(fragment);
  }

  let lines = 0;
  let characters = 0;
  for (const fragments of byParagraph.values()) {
    const sorted = [...fragments].sort(
      (first, second) => first.box.top - second.box.top || first.box.left - second.box.left,
    );
    const paragraphLines: TextFragment[][] = [];
    for (const fragment of sorted) {
      const current = paragraphLines.at(-1);
      if (
        current !== undefined &&
        fragment.box.top - current[0]!.box.top <= SAME_LINE_TOLERANCE_PX
      ) {
        current.push(fragment);
      } else {
        paragraphLines.push([fragment]);
      }
    }
    for (const line of paragraphLines.slice(0, -1)) {
      const isFullyVisible = line.every(
        (fragment) => fragment.visibleBox !== null && isSameRect(fragment.box, fragment.visibleBox),
      );
      if (!isFullyVisible) continue;
      lines++;
      characters += line.reduce((sum, fragment) => sum + fragment.length, 0);
    }
  }
  return { lines, meanCharactersPerLine: lines === 0 ? null : characters / lines };
}

/**
 * Draws the glyph specimen over the top left of the page and returns where
 * its glyphs are, so a screenshot of two boxes shows two easily confused
 * characters as the UI draws them. It adds one fixed element with the
 * characters "I", "l", "1", "O" and "0", one span per character, each in a
 * 24 x 24 px inline-block cell. The glyphs are black on white and nothing is
 * transformed, so the same shape lands on the same pixels in every cell.
 * Returns the boxes of the two cells of each pair: "Il", "I1", "l1" and "O0".
 * Both cells of a pair have the same size. A second call replaces the first
 * specimen.
 *
 * The specimen copies its typography from `<body>`. The stylesheet
 * base.css sets the UI font on `<html>` and `<body>` once, and the UI text of
 * every screen inherits it, so `<body>` has the font family, the font
 * features and axes (such as the alternate shapes of "1" and "0"), the
 * kerning and the glyph smoothing that UI text has. The size (13px) and the
 * weight (400) are the ones of body UI text, set here because a screen may
 * give its body another size. A canvas would not do: it takes only the
 * family, size and weight, so it draws other glyph shapes than the page.
 *
 * The page's fonts are already loaded when the page is ready, so the specimen
 * draws with them at once. Call this only on a ready page.
 *
 * Remove the specimen with `hideGlyphSpecimen` before the next measure.
 */
export function showGlyphSpecimen(): GlyphSpecimen[] {
  hideGlyphSpecimen();
  const body = getComputedStyle(document.body);
  const specimen = document.createElement("div");
  specimen.setAttribute(GLYPH_SPECIMEN_ATTRIBUTE, "");
  const set = (target: HTMLElement, property: string, value: string): void => {
    target.style.setProperty(property, value, "important");
  };
  const layout: ReadonlyArray<readonly [string, string]> = [
    ["all", "initial"],
    ["position", "fixed"],
    ["top", "0"],
    ["left", "0"],
    ["z-index", "2147483647"],
    ["display", "block"],
    ["width", "max-content"],
    ["padding", `${String(GLYPH_GAP_PX)}px`],
    ["box-sizing", "border-box"],
    ["background", "#fff"],
    ["color", "#000"],
    ["transform", "none"],
    ["font-size", "13px"],
    ["font-weight", "400"],
    ["font-style", "normal"],
    ["line-height", `${String(GLYPH_CELL_PX)}px`],
    ["white-space", "pre"],
  ];
  for (const [property, value] of layout) set(specimen, property, value);
  for (const property of GLYPH_TYPOGRAPHY_PROPERTIES) {
    set(specimen, property, body.getPropertyValue(property));
  }
  const cells = new Map<string, HTMLElement>();
  for (const character of GLYPH_CHARACTERS) {
    const cell = document.createElement("span");
    cell.textContent = character;
    set(cell, "display", "inline-block");
    set(cell, "box-sizing", "border-box");
    set(cell, "vertical-align", "top");
    set(cell, "margin-right", `${String(GLYPH_GAP_PX)}px`);
    set(cell, "width", `${String(GLYPH_CELL_PX)}px`);
    set(cell, "height", `${String(GLYPH_CELL_PX)}px`);
    set(cell, "padding-left", `${String(GLYPH_INDENT_PX)}px`);
    specimen.append(cell);
    cells.set(character, cell);
  }
  document.body.append(specimen);
  const readCell = (character: string | undefined): ProbeRect =>
    toProbeRect(cells.get(character ?? "")!.getBoundingClientRect());
  return GLYPH_PAIRS.map((pair) => ({
    pair,
    first: readCell(pair[0]),
    second: readCell(pair[1]),
  }));
}

/** Removes the glyph specimen `showGlyphSpecimen` added. It does nothing when there is none. */
export function hideGlyphSpecimen(): void {
  document.querySelector(`[${GLYPH_SPECIMEN_ATTRIBUTE}]`)?.remove();
}
