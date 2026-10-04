import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tests every stylesheet of the renderer against spec 17's motion rule
 * (§Performance, rule 2):
 *
 * - Keyframe animations change only `transform` and `opacity`.
 * - Transitions answer a user action, last at most `--dur-3`, and change only
 *   paint properties: color, background, border-color, box-shadow, opacity,
 *   transform.
 *
 * It also checks that:
 *
 * - Reduce motion can stop every animation;
 * - only two animations may run forever: the working pose's paws and the
 *   spinner;
 * - no rule for every element (`*`) sets a transition, because an element
 *   transitions every property by default, layout included.
 *
 * So a stylesheet that would wake the renderer while the app is idle, or run a
 * layout pass on every frame of a transition, fails the build instead of a
 * later measurement.
 *
 * The test reads the files as text, so a stylesheet added later is checked
 * without a change here.
 */

/** The renderer's source folder, which holds every stylesheet the test reads. */
const RENDERER = join(import.meta.dirname, "..");

/** The properties a transition may change: each costs a repaint, never a layout pass. */
const PAINT_PROPERTIES = [
  "color",
  "background",
  "border-color",
  "box-shadow",
  "opacity",
  "transform",
];

/** The properties a keyframe may set. The compositor can animate both without a repaint. */
const KEYFRAME_PROPERTIES = ["transform", "opacity"];

/** The design system's three duration tokens, 320 ms at most. base.css sets each to 0s under Reduce motion. */
const DURATION_TOKENS = ["--dur-1", "--dur-2", "--dur-3"];

/** The durations a transition may last: one of the three tokens. */
const DURATIONS = DURATION_TOKENS.map((token) => `var(${token})`);

const NO_PREFERENCE = "@media (prefers-reduced-motion: no-preference)";
const REDUCE = "@media (prefers-reduced-motion: reduce)";

/**
 * The rules allowed to run an animation forever:
 *
 * - the working pose's paws, which tap only beside the open thread's running
 *   turn;
 * - the spinner, which turns only while Hercule starts or a provider login
 *   waits for the browser. Both waits end.
 */
const ENDLESS_ANIMATIONS = [
  { file: "faces/face.css", rule: ".cr--working.cr--animated .cr-tap" },
  { file: "styles/controls.css", rule: ".spin" },
];

/** One declaration of a stylesheet, with the blocks it sits in. */
interface Declaration {
  /** The stylesheet's path, relative to the renderer's source folder. */
  readonly file: string;
  /** The property, in lower case, such as `transition`. */
  readonly property: string;
  /** The value, without `!important`. */
  readonly value: string;
  readonly important: boolean;
  /**
   * The preludes of the blocks around the declaration, outermost first, with
   * runs of whitespace collapsed: `["@media (...)", ".btn:hover"]`.
   */
  readonly blocks: ReadonlyArray<string>;
}

/**
 * Parses a stylesheet into its declarations. A small scanner is enough for
 * the renderer's CSS:
 *
 * - comments are removed first;
 * - a quoted string, and anything inside parentheses, is kept whole, so a `;`
 *   in a data URL or a `{` in a string does not end a declaration;
 * - a declaration ends at its `;` or at the end of its block, so a value that
 *   spans several lines is read whole;
 * - statements that start with `@`, such as `@import`, are skipped.
 */
function parseDeclarations(file: string, css: string): Declaration[] {
  const declarations: Declaration[] = [];
  const blocks: string[] = [];
  let buffer = "";
  let quote: string | null = null;
  let depth = 0;

  const endStatement = () => {
    const statement = buffer.trim();
    buffer = "";
    const colon = statement.indexOf(":");
    if (statement.startsWith("@") || colon === -1) return;
    const value = statement.slice(colon + 1).trim();
    const important = /!important$/i.test(value);
    declarations.push({
      file,
      property: statement.slice(0, colon).trim().toLowerCase(),
      value: important ? value.replace(/\s*!important$/i, "") : value,
      important,
      blocks: [...blocks],
    });
  };

  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (quote !== null) {
      buffer += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === "(" || char === ")" || depth > 0) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      buffer += char;
    } else if (char === "{") {
      blocks.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (char === ";") {
      endStatement();
    } else if (char === "}") {
      endStatement();
      blocks.pop();
    } else {
      buffer += char;
    }
  }
  return declarations;
}

/**
 * Splits `value` at every match of `separator` that is outside parentheses,
 * so `cubic-bezier(0.2, 0, 0, 1)` stays one part. Returns the trimmed parts,
 * leaving out empty ones.
 */
function splitOutsideParentheses(value: string, separator: RegExp): string[] {
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

/** Checks whether a word of a `transition` value is a time: a duration or a delay. */
const isTime = (word: string): boolean =>
  DURATIONS.includes(word) || /^var\(--dur-/.test(word) || /^[\d.]+m?s$/.test(word);

/** Checks whether a word of a `transition` value is anything but the property it transitions. */
const isTimingOrBehaviour = (word: string): boolean =>
  /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|normal|allow-discrete)$/.test(
    word,
  ) || /^(cubic-bezier|steps|linear|var)\(/.test(word);

/** Returns where a declaration sits, for a message: its file and its innermost selector. */
const describeLocation = (declaration: Declaration): string => {
  const rule = declaration.blocks.findLast((block) => !block.startsWith("@")) ?? "(top level)";
  return `${declaration.file} ${rule}`;
};

/**
 * Checks whether a declaration's rule applies to every element, through a `*`
 * in its selector. The `*=` of an attribute selector, as in `[style*="--hue"]`,
 * is not such a `*`.
 */
const appliesToEveryElement = (declaration: Declaration): boolean =>
  /\*(?!\s*=)/.test(declaration.blocks.findLast((block) => !block.startsWith("@")) ?? "");

/** Returns the messages for one `transition` shorthand; see `findMotionViolations`. */
function checkTransition(declaration: Declaration): string[] {
  if (declaration.value === "none") return [];
  const where = describeLocation(declaration);
  return splitOutsideParentheses(declaration.value, /,/).flatMap((item) => {
    const words = splitOutsideParentheses(item, /\s/);
    const times = words.filter(isTime);
    const properties = words.filter((word) => !isTime(word) && !isTimingOrBehaviour(word));
    const messages: string[] = [];
    if (properties.length === 0) {
      messages.push(`${where}: "${item}" transitions every property; name a paint property.`);
    }
    for (const property of properties.filter((each) => !PAINT_PROPERTIES.includes(each))) {
      messages.push(`${where}: "${item}" transitions ${property}, which is not a paint property.`);
    }
    if (times.length !== 1 || !DURATIONS.includes(times[0]!)) {
      messages.push(
        `${where}: "${item}" must last var(--dur-1), var(--dur-2) or var(--dur-3), with no delay.`,
      );
    }
    return messages;
  });
}

/** Returns the messages for one declaration; see `findMotionViolations`. */
function checkDeclaration(declaration: Declaration): string[] {
  const { property, value, blocks } = declaration;
  const where = describeLocation(declaration);

  if (blocks.some((block) => block.startsWith("@keyframes"))) {
    return KEYFRAME_PROPERTIES.includes(property)
      ? []
      : [`${where}: a keyframe sets ${property}; keyframes may set only transform and opacity.`];
  }

  const messages: string[] = [];
  if ((property === "animation" || property === "animation-name") && value !== "none") {
    if (!blocks.includes(NO_PREFERENCE)) {
      messages.push(
        `${where}: ${property} is declared outside ${NO_PREFERENCE}, so Reduce motion cannot stop it.`,
      );
    }
  }
  if (property.startsWith("animation") && /\binfinite\b/.test(value)) {
    const allowed = ENDLESS_ANIMATIONS.some(
      (entry) => entry.file === declaration.file && blocks.at(-1) === entry.rule,
    );
    if (!allowed) {
      messages.push(
        `${where}: an animation runs forever. The only one allowed is the working pose's paws.`,
      );
    }
  }
  if (property.startsWith("transition") && value !== "none" && appliesToEveryElement(declaration)) {
    messages.push(
      `${where}: sets ${property} on every element, so a change to any element can start a transition. Set a transition only on the element that needs one; a rule for every element may only switch transitions off, with transition: none.`,
    );
  }
  if (property === "transition") {
    messages.push(...checkTransition(declaration));
  }
  if (property === "transition-property" && value !== "none") {
    for (const each of splitOutsideParentheses(value, /,/)) {
      if (!PAINT_PROPERTIES.includes(each)) {
        messages.push(
          `${where}: transition-property names ${each}, which is not a paint property.`,
        );
      }
    }
  }
  if (property === "transition-duration") {
    if (splitOutsideParentheses(value, /,/).some((each) => !DURATIONS.includes(each))) {
      messages.push(
        `${where}: transition-duration must be var(--dur-1), var(--dur-2) or var(--dur-3), not ${value}.`,
      );
    }
  }
  if (property === "transition-delay") {
    messages.push(`${where}: a transition answers a user action at once, so it has no delay.`);
  }
  return messages;
}

/**
 * Returns one message for each place where `declarations` break the motion
 * rule, or an empty list when they keep it. A message names the file, the
 * selector and what is wrong.
 */
function findMotionViolations(declarations: ReadonlyArray<Declaration>): string[] {
  return declarations.flatMap(checkDeclaration);
}

/** Reads every stylesheet under the renderer's source folder, by its path relative to that folder. */
const stylesheets = readdirSync(RENDERER, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".css"))
  .sort()
  .map((path) => ({ path, css: readFileSync(join(RENDERER, path), "utf8") }));

const declarations = stylesheets.flatMap(({ path, css }) => parseDeclarations(path, css));

describe("the renderer's motion", () => {
  it("reads the stylesheets the app ships", () => {
    // Guards the scan itself: a wrong folder would find nothing and pass.
    expect(stylesheets.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["styles/base.css", "styles/controls.css", "styles/tokens.css"]),
    );
    expect(declarations).toContainEqual(
      expect.objectContaining({ file: "styles/controls.css", property: "transition" }),
    );
  });

  it("keeps the motion rule in every stylesheet", () => {
    expect(findMotionViolations(declarations)).toEqual([]);
  });

  it("snaps a theme change, and stops every transition under Reduce motion, in base.css", () => {
    const base = declarations.filter((declaration) => declaration.file === "styles/base.css");
    expect(base).toContainEqual({
      file: "styles/base.css",
      property: "transition",
      value: "none",
      important: true,
      blocks: [
        "html[data-theme-changing] *, html[data-theme-changing] *::before, html[data-theme-changing] *::after",
      ],
    });
    // Every transition lasts a token, so a token of 0s stops every transition.
    expect(base.filter((declaration) => declaration.blocks.includes(REDUCE))).toEqual(
      DURATION_TOKENS.map((token) => ({
        file: "styles/base.css",
        property: token,
        value: "0s",
        important: false,
        blocks: [REDUCE, ":root"],
      })),
    );
  });

  it("moves the first run's room only when a step finishes, and nothing else on the first run", () => {
    // Spec 17, The first run: the camera moves one layer's transform, new
    // pieces settle from 14px above with transform and opacity, each over
    // --dur-3, and nothing else moves. The lights coming on with the
    // controller fade the veil over the same time.
    const isMotion = (declaration: Declaration): boolean =>
      /^(transition|animation)/.test(declaration.property) &&
      !declaration.blocks.some((block) => block.startsWith("@keyframes"));
    const describeMotion = (declaration: Declaration) => ({
      rule: declaration.blocks.join(" › "),
      [declaration.property]: declaration.value,
    });
    const room = declarations.filter(
      (declaration) => declaration.file === "screens/office/office.css" && isMotion(declaration),
    );
    expect(room.map(describeMotion)).toEqual([
      {
        rule: ".office-room .room-camera.is-moving",
        transition: "transform var(--dur-3) var(--ease-out)",
      },
      { rule: ".office-room .room-veil", transition: "opacity var(--dur-3) var(--ease-out)" },
      {
        rule: `${NO_PREFERENCE} › .office-room .room-arrival`,
        animation: "room-settle var(--dur-3) var(--ease-out) both",
      },
      {
        rule: `${NO_PREFERENCE} › .office-room .room-arrival--character`,
        "animation-timing-function": "var(--ease-spring)",
      },
      {
        rule: `${NO_PREFERENCE} › .office-room .tag.is-new`,
        animation: "room-label-settle var(--dur-3) var(--ease-out) both",
      },
      {
        // A piece that arrives while the camera moves waits for it to stop.
        rule: `${NO_PREFERENCE} › .office-room .room-arrival.is-late, .office-room .is-late .tag.is-new`,
        "animation-delay": "var(--dur-3)",
      },
    ]);
    expect(
      declarations
        .filter((declaration) => declaration.file === "screens/office/office.css")
        .filter((declaration) => declaration.blocks[0] === "@keyframes room-settle")
        .map(({ property, value }) => ({ [property]: value })),
    ).toEqual([{ opacity: "0" }, { transform: "translateY(-14px)" }]);
    // The card and its steps draw no motion of their own.
    expect(
      declarations.filter(
        (declaration) =>
          ["screens/first-run/first-run.css", "screens/step/step.css"].includes(declaration.file) &&
          isMotion(declaration),
      ),
    ).toEqual([]);
  });

  it("reports each way a stylesheet can break the rule", () => {
    // Proves the checks can fail: a check that never fails guards nothing.
    const css = `
      @keyframes grow { from { width: 0; } to { width: 10px; opacity: 1; } }
      @media (prefers-reduced-motion: no-preference) {
        .spinner { animation: spin 1s linear infinite; }
      }
      .pulse { animation: pulse var(--dur-2); }
      .card {
        transition:
          height var(--dur-1),
          color 150ms,
          opacity var(--dur-2) var(--dur-1),
          var(--dur-1);
      }
      .link { transition-property: all; transition-duration: 1s; transition-delay: 50ms; }
      @media (prefers-reduced-motion: reduce) {
        *, *::before { transition-duration: 0.01ms !important; }
      }
      .calm { transition: box-shadow var(--dur-3) var(--ease-out); animation: none; }
      [title*="x"] { transition: color var(--dur-1); }
      .snap * { transition: none; }
    `;
    expect(findMotionViolations(parseDeclarations("sample.css", css))).toEqual([
      "sample.css from: a keyframe sets width; keyframes may set only transform and opacity.",
      "sample.css to: a keyframe sets width; keyframes may set only transform and opacity.",
      "sample.css .spinner: an animation runs forever. The only one allowed is the working pose's paws.",
      `sample.css .pulse: animation is declared outside ${NO_PREFERENCE}, so Reduce motion cannot stop it.`,
      'sample.css .card: "height var(--dur-1)" transitions height, which is not a paint property.',
      'sample.css .card: "color 150ms" must last var(--dur-1), var(--dur-2) or var(--dur-3), with no delay.',
      'sample.css .card: "opacity var(--dur-2) var(--dur-1)" must last var(--dur-1), var(--dur-2) or var(--dur-3), with no delay.',
      'sample.css .card: "var(--dur-1)" transitions every property; name a paint property.',
      "sample.css .link: transition-property names all, which is not a paint property.",
      "sample.css .link: transition-duration must be var(--dur-1), var(--dur-2) or var(--dur-3), not 1s.",
      "sample.css .link: a transition answers a user action at once, so it has no delay.",
      "sample.css *, *::before: sets transition-duration on every element, so a change to any element can start a transition. Set a transition only on the element that needs one; a rule for every element may only switch transitions off, with transition: none.",
      "sample.css *, *::before: transition-duration must be var(--dur-1), var(--dur-2) or var(--dur-3), not 0.01ms.",
    ]);
  });
});
