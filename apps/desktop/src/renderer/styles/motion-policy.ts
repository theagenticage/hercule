/**
 * The part of spec 17's motion rule (§Performance, rule 2) that says which
 * properties a transition may change. Two checks read it, so it has one owner:
 * the ESLint rule in `apps/desktop/scripts/eslint-transition-rule.ts`, which
 * refuses a stylesheet while it is written, and `motion.test.ts`, which holds
 * the rest of the motion rule.
 *
 * Paths are relative to the renderer's source folder, such as `shell/shell.css`.
 */

/**
 * The properties a transition may change: each costs a repaint, never a
 * layout pass. A `content-visibility` transition switches once, at its end
 * when it hides, so an element can stay shown while something else about it
 * slides.
 */
const PAINT_PROPERTIES = [
  "color",
  "background",
  "border-color",
  "box-shadow",
  "opacity",
  "transform",
  "content-visibility",
];

/**
 * The stylesheets of the desk (`screens/desk/`), which Work and the Inbox draw,
 * of the Work board (`screens/work/`) and of the Inbox (`screens/inbox/`) keep
 * the amended motion rule for Work and the Inbox (spec 17 §Performance, rule 2). The drawing's motion tokens run longer
 * than `--dur-3` and are named by who caused the motion, so these stylesheets
 * may transition for a `--m-*` duration, up to `--m-long` (560 ms), which is
 * for a one-off moment such as a landing ring. They may also transition
 * `filter`, `background-color` and `rotate`, which cost a repaint or a
 * composite as the paint properties do. Every other part of the rule holds
 * for them: no delay, no layout property, no transition on every element, no
 * new animation that runs forever, and an animation only when Reduce motion
 * is not asked for. Nothing outside these folders gets this.
 */
export const MOTION_FOLDERS = ["screens/desk/", "screens/work/", "screens/inbox/"];
/** The extra properties the motion folders may transition; each costs a repaint or a composite, never a layout pass. */
const DESK_PAINT_PROPERTIES = ["filter", "background-color", "rotate"];

/**
 * The rules allowed to transition a layout property, each with that property,
 * because spec 17 records a measurement showing it is cheap:
 *
 * - Intake's list, the sized column of a split, as its side pane opens or
 *   closes. The column's rows are lines of a fixed count, each cut with an
 *   ellipsis, so a frame of the transition lays the column out without
 *   measuring text again.
 * - The box that holds the shell's sidebar, as the sidebar is shown or
 *   hidden. The sidebar inside keeps its width, so a frame never lays out
 *   its rows again; it lays out the box and the main pane beside it, which
 *   was measured with a long transcript open.
 * - The rows of a Model Profile in the composer's model menu, and the 4px
 *   under them, as the profile folds or unfolds. The menu is a popover in the
 *   top layer, so a frame lays out the menu alone, and its rows are lines of
 *   one height whose width does not change while they fold.
 */
export const LAYOUT_TRANSITIONS = [
  { file: "screens/intake/intake.css", rule: ".asks-list", property: "width" },
  { file: "shell/shell.css", rule: ".side-slot", property: "width" },
  { file: "screens/thread/model-menu-list.css", rule: ".ac-body", property: "height" },
  { file: "screens/thread/model-menu-list.css", rule: ".ac-body", property: "margin-bottom" },
];

/**
 * Returns the properties a transition may change in the rule `rule` of the
 * stylesheet `file`: the paint properties, the ones of the motion folders when
 * `file` is in one, and the layout properties the rule is allowed. `rule` is
 * the rule's selector with runs of whitespace collapsed to one space.
 */
export function listAllowedTransitionProperties(file: string, rule: string | undefined): string[] {
  const layoutProperties = LAYOUT_TRANSITIONS.filter(
    (entry) => entry.file === file && entry.rule === rule,
  ).map((entry) => entry.property);
  const inMotionFolder = MOTION_FOLDERS.some((folder) => file.startsWith(folder));
  return [
    ...PAINT_PROPERTIES,
    ...layoutProperties,
    ...(inMotionFolder ? DESK_PAINT_PROPERTIES : []),
  ];
}

/**
 * Splits `value` at every match of `separator` that is outside parentheses,
 * so `cubic-bezier(0.2, 0, 0, 1)` stays one part. Returns the trimmed parts,
 * leaving out empty ones.
 */
export function splitOutsideParentheses(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let part = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && separator.test(char)) {
      parts.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  parts.push(part);
  return parts.map((each) => each.trim()).filter((each) => each !== "");
}

/** One transition of a `transition` shorthand, which lists one per comma. */
interface TransitionItem {
  /** The transition as written, such as `opacity var(--dur-2) ease`. */
  readonly text: string;
  /** The words of `text`, split at whitespace outside parentheses. */
  readonly words: string[];
  /**
   * The words of `text` that name a property: those that are not a time, an
   * easing or `var(...)`. Empty when the transition names none, which means it
   * transitions every property.
   */
  readonly properties: string[];
}

/** Checks whether a word of a `transition` value is anything but the property it transitions. */
const isNotProperty = (word: string): boolean =>
  /^[\d.]+m?s$/.test(word) ||
  /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|normal|allow-discrete)$/.test(
    word,
  ) ||
  /^(cubic-bezier|steps|linear|var)\(/.test(word);

/** Parses the value of a `transition` shorthand into its transitions. */
export function parseTransition(value: string): TransitionItem[] {
  return splitOutsideParentheses(value, /,/).map((text) => {
    const words = splitOutsideParentheses(text, /\s/);
    return { text, words, properties: words.filter((word) => !isNotProperty(word)) };
  });
}

/**
 * Returns the properties a declaration transitions, in lower case. `property`
 * is `transition` or `transition-property`, any other name returns an empty
 * list, and so does a value of `none`. A `transition` item that names no
 * property transitions every property, so it counts as `all`.
 */
export function listTransitionedProperties(property: string, value: string): string[] {
  const text = value.toLowerCase();
  if (text === "none") return [];
  if (property === "transition-property") return splitOutsideParentheses(text, /,/);
  if (property !== "transition") return [];
  return parseTransition(text).flatMap((item) =>
    item.properties.length === 0 ? ["all"] : item.properties,
  );
}
