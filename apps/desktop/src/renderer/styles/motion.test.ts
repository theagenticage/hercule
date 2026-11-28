import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAYOUT_TRANSITIONS,
  listTransitionedProperties,
  MOTION_FOLDERS,
  parseTransition,
  splitOutsideParentheses,
} from "./motion-policy.ts";

/**
 * Tests every stylesheet of the renderer against spec 17's motion rule
 * (§Performance, rule 2):
 *
 * - Keyframe animations change only `transform` and `opacity`.
 * - Transitions answer a user action and last at most `--dur-3`. Which
 *   properties a transition may change is not checked here: the ESLint rule
 *   `desktop/transition-properties` owns that, from `motion-policy.ts`. This
 *   test only checks that each entry of the policy's layout allowlist still
 *   matches a transition in a stylesheet.
 *
 * It also checks that:
 *
 * - Reduce motion can stop every animation;
 * - only three animations may run forever: the working pose's paws, the
 *   spinner, and the paws on a card of the desk;
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
 *   waits for the browser. Both waits end;
 * - the paws of a colleague on a card of the desk, which tap in short bursts
 *   with long pauses for as long as a Thread works on the card. The Still
 *   colleagues setting stops them.
 */
const ENDLESS_ANIMATIONS = [
  { file: "faces/face.css", rule: ".cr--working.cr--animated .cr-tap" },
  { file: "styles/controls.css", rule: ".spin" },
  {
    file: "screens/desk/card.css",
    rule: '.card-paws[data-pose="working"]:not([data-still]) i',
  },
];

/** The `--m-*` durations the motion folders (see `MOTION_FOLDERS`) may transition for. */
const DESK_DURATIONS = ["--m-press", "--m-quick", "--m-base", "--m-slow", "--m-long"].map(
  (token) => `var(${token})`,
);
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

/** Checks whether a word of a `transition` value is a time: a duration or a delay. */
const isTime = (word: string): boolean =>
  DURATIONS.includes(word) ||
  DESK_DURATIONS.includes(word) ||
  /^var\(--dur-/.test(word) ||
  /^[\d.]+m?s$/.test(word);

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

/**
 * Returns the messages for one `transition` shorthand: each of its transitions
 * must last one allowed duration, with no delay. Its properties are checked by
 * the ESLint rule `desktop/transition-properties`.
 */
function checkTransition(declaration: Declaration): string[] {
  if (declaration.value === "none") return [];
  const where = describeLocation(declaration);
  const isDesk = MOTION_FOLDERS.some((folder) => declaration.file.startsWith(folder));
  const allowedDurations = isDesk ? [...DURATIONS, ...DESK_DURATIONS] : DURATIONS;
  return parseTransition(declaration.value).flatMap(({ text, words }) => {
    const times = words.filter(isTime);
    if (times.length === 1 && allowedDurations.includes(times[0]!)) return [];
    return [
      `${where}: "${text}" must last var(--dur-1), var(--dur-2) or var(--dur-3)${isDesk ? ", or a --m-* token" : ""}, with no delay.`,
    ];
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

/** Checks whether `declaration` starts motion: a transition or an animation outside a keyframe. */
const isMotion = (declaration: Declaration): boolean =>
  /^(transition|animation)/.test(declaration.property) &&
  !declaration.blocks.some((block) => block.startsWith("@keyframes"));

/** Returns `declaration` as the blocks it sits in and its value, for comparing in a test. */
const describeMotion = (declaration: Declaration) => ({
  rule: declaration.blocks.join(" › "),
  [declaration.property]: declaration.value,
});

/** Returns the declarations of `@keyframes name` in `file`, each as its keyframe, property and value. */
const readKeyframes = (file: string, name: string) =>
  declarations
    .filter((declaration) => declaration.file === file)
    .filter((declaration) => declaration.blocks[0] === `@keyframes ${name}`)
    .map(({ blocks, property, value }) => ({ at: blocks[1], [property]: value }));

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

  it("keeps an entry of the layout allowlist only while a transition in its rule needs it", () => {
    // An entry for a rule that no longer transitions its property would let a
    // later transition of that property through unchecked.
    for (const { file, rule, property } of LAYOUT_TRANSITIONS) {
      const transitioned = declarations
        .filter((declaration) => declaration.file === file && declaration.blocks.at(-1) === rule)
        .flatMap((declaration) =>
          listTransitionedProperties(declaration.property, declaration.value),
        );
      expect(transitioned, `${file} ${rule} no longer transitions ${property}`).toContain(property);
    }
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
    expect(readKeyframes("screens/office/office.css", "room-settle")).toEqual([
      { at: "from", opacity: "0" },
      { at: "from", transform: "translateY(-14px)" },
    ]);
    // The card and its steps draw no motion of their own.
    expect(
      declarations.filter(
        (declaration) =>
          ["screens/first-run/first-run.css", "screens/step/step.css"].includes(declaration.file) &&
          isMotion(declaration),
      ),
    ).toEqual([]);
  });

  it("animates the workflows only on a change, each motion once, on transform and opacity", () => {
    // Spec 17, Workflows' motion: a changed mark pops in on --ease-spring, a
    // run joining a strip steps the older marks left 11px, the open pane
    // settles in from 14px right, the graph's rings and marks come in,
    // and the timeline's first eight bars arrive 30ms apart, each mark
    // popping --dur-2 after its line. Hover transitions are not pinned here.
    const isAnimation = (declaration: Declaration): boolean =>
      isMotion(declaration) && declaration.property.startsWith("animation");
    const readAnimations = (file: string) =>
      declarations
        .filter(
          (declaration) =>
            declaration.file === `screens/workflows/${file}` && isAnimation(declaration),
        )
        .map(describeMotion);
    expect(readAnimations("workflow-list.css")).toEqual([
      {
        rule: `${NO_PREFERENCE} › :is(.table-mark, .column-mark).is-new > .mark, .strip > .strip-run.is-new`,
        animation: "mark-in var(--dur-3) var(--ease-spring)",
      },
      {
        rule: `${NO_PREFERENCE} › .strip.is-advanced > .strip-run:not(.is-new)`,
        animation: "strip-step var(--dur-3) var(--ease-out)",
      },
    ]);
    expect(readAnimations("workflow-detail.css")).toEqual([
      {
        rule: `${NO_PREFERENCE} › .open-pane:not(.run-page)`,
        animation: "open-pane-in var(--dur-3) var(--ease-out)",
      },
    ]);
    expect(readAnimations("workflow-graph.css")).toEqual([
      {
        rule: `${NO_PREFERENCE} › .node-ring.is-new`,
        animation: "node-ring-in var(--dur-3) var(--ease-out)",
      },
      {
        rule: `${NO_PREFERENCE} › .node-mark.is-new > .mark`,
        animation: "mark-in var(--dur-3) var(--ease-spring)",
      },
      {
        rule: `${NO_PREFERENCE} › .node:is(.is-waiting, .is-failed) > .node-ring.is-new::after`,
        animation: "node-ring-ping var(--dur-3) var(--ease-out)",
      },
    ]);
    expect(readAnimations("run-timeline.css")).toEqual([
      {
        rule: `${NO_PREFERENCE} › .lanes.is-arriving`,
        animation: "lanes-in var(--dur-3) var(--ease-out)",
      },
      {
        rule: `${NO_PREFERENCE} › .run-bar.is-arriving > .run-bar-line`,
        animation: "bar-line-sweep var(--dur-3) var(--ease-out) backwards",
      },
      {
        rule: `${NO_PREFERENCE} › .run-bar.is-arriving > .run-bar-line`,
        "animation-delay": "calc(var(--order) * 30ms)",
      },
      {
        rule: `${NO_PREFERENCE} › .run-bar.is-arriving > .mark, .run-bar.is-arriving > .dot--mark`,
        animation: "mark-in var(--dur-2) var(--ease-spring) backwards",
      },
      {
        rule: `${NO_PREFERENCE} › .run-bar.is-arriving > .mark, .run-bar.is-arriving > .dot--mark`,
        "animation-delay": "calc(var(--order) * 30ms + var(--dur-2))",
      },
      {
        rule: `${NO_PREFERENCE} › .run-bar.is-new > .mark, .run-bar.is-new > .dot--mark`,
        animation: "mark-in var(--dur-3) var(--ease-spring)",
      },
    ]);
    expect(readKeyframes("marks/mark.css", "mark-in")).toEqual([
      { at: "from", opacity: "0" },
      { at: "from", transform: "scale(0.6)" },
    ]);
    expect(readKeyframes("screens/workflows/workflow-list.css", "strip-step")).toEqual([
      { at: "from", transform: "translateX(calc(var(--joined-runs) * 11px))" },
    ]);
    expect(readKeyframes("screens/workflows/workflow-detail.css", "open-pane-in")).toEqual([
      { at: "from", opacity: "0" },
      { at: "from", transform: "translateX(14px)" },
    ]);
    expect(readKeyframes("screens/workflows/run-timeline.css", "lanes-in")).toEqual([
      { at: "from", opacity: "0" },
    ]);
    expect(readKeyframes("screens/workflows/run-timeline.css", "bar-line-sweep")).toEqual([
      { at: "from", opacity: "0" },
      { at: "from", transform: "scaleX(0)" },
    ]);
    // The other workflow stylesheets play no animation of their own.
    expect(
      declarations.filter(
        (declaration) =>
          declaration.file.startsWith("screens/workflows/") &&
          ![
            "workflow-list.css",
            "workflow-detail.css",
            "workflow-graph.css",
            "run-timeline.css",
          ].some((file) => declaration.file.endsWith(file)) &&
          isAnimation(declaration),
      ),
    ).toEqual([]);
  });

  it("lets only the desk's and the Work board's stylesheets transition for a --m-* duration, and holds them to the rest of the rule", () => {
    const css = `
      .card-stock { transition: box-shadow var(--m-base) var(--m-ease), filter var(--m-quick); }
      .slow { transition: opacity 260ms; }
      .late { transition-delay: 50ms; }
    `;
    expect(
      findMotionViolations(
        parseDeclarations("screens/work/sample.css", ".turn { transition: rotate var(--m-base); }"),
      ),
    ).toEqual([]);
    expect(findMotionViolations(parseDeclarations("screens/desk/sample.css", css))).toEqual([
      'screens/desk/sample.css .slow: "opacity 260ms" must last var(--dur-1), var(--dur-2) or var(--dur-3), or a --m-* token, with no delay.',
      "screens/desk/sample.css .late: a transition answers a user action at once, so it has no delay.",
    ]);
    // Outside the desk and the Work board the same durations are refused.
    expect(
      findMotionViolations(
        parseDeclarations("screens/other.css", ".card-stock { transition: filter var(--m-base); }"),
      ),
    ).toEqual([
      'screens/other.css .card-stock: "filter var(--m-base)" must last var(--dur-1), var(--dur-2) or var(--dur-3), with no delay.',
    ]);
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
          color 150ms,
          opacity var(--dur-2) var(--dur-1);
      }
      .link { transition-duration: 1s; transition-delay: 50ms; }
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
      'sample.css .card: "color 150ms" must last var(--dur-1), var(--dur-2) or var(--dur-3), with no delay.',
      'sample.css .card: "opacity var(--dur-2) var(--dur-1)" must last var(--dur-1), var(--dur-2) or var(--dur-3), with no delay.',
      "sample.css .link: transition-duration must be var(--dur-1), var(--dur-2) or var(--dur-3), not 1s.",
      "sample.css .link: a transition answers a user action at once, so it has no delay.",
      "sample.css *, *::before: sets transition-duration on every element, so a change to any element can start a transition. Set a transition only on the element that needs one; a rule for every element may only switch transitions off, with transition: none.",
      "sample.css *, *::before: transition-duration must be var(--dur-1), var(--dur-2) or var(--dur-3), not 0.01ms.",
    ]);
  });
});
