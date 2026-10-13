/**
 * Writes the Android app's design tokens as Kotlin, from the Crew Bureau
 * book's `docs/design/crew-bureau-2/tokens.css`.
 *
 * Run it with `pnpm gen:android-tokens` after tokens.css changes. The Kotlin
 * file is checked in because Gradle does not run TypeScript, and
 * `gen-android-tokens.test.ts` fails when the checked-in file is stale.
 *
 * What it writes:
 * - `BureauColors`, one field per colour token, with two instances: the light
 *   theme Whitehaven and the dark theme Orient Express. The other three themes
 *   of the book are left out because the app does not offer them.
 * - The four colours of each crew hue (`--who`, `--who-shade`, `--who-ink`,
 *   `--who-tint`) per theme, worked out here so the app does no oklch maths.
 * - `BureauScales`, the theme-independent numbers: type sizes, weights,
 *   spacing, radii, durations, easings and hue angles.
 *
 * Colours are converted to Display P3, not sRGB: the phone's screen is wide
 * gamut, and several of the book's oklch colours lie outside sRGB. A colour
 * outside P3 as well is clamped per channel in P3, and the Kotlin line says so.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The book's tokens, the one source of the app's colours. */
export const TOKENS_CSS_PATH = "docs/design/crew-bureau-2/tokens.css";

/** The generated Kotlin file, relative to the repository root. */
export const TOKENS_KOTLIN_PATH =
  "apps/android/app/src/main/kotlin/dev/hercule/android/theme/Tokens.kt";

/** A colour in OKLab with straight (not premultiplied) alpha. */
export interface OklabColor {
  readonly l: number;
  readonly a: number;
  readonly b: number;
  readonly alpha: number;
}

/** A colour in Display P3, each channel gamma-encoded in 0..1. */
export interface DisplayP3Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
  /** True when the colour lies outside Display P3 and its channels were clamped into it. */
  readonly clamped: boolean;
}

type Matrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];
type Vector = readonly [number, number, number];

// The matrices are those of the CSS Color 4 sample code, as colorjs.io 0.5.2
// ships them (src/spaces/oklab.js, srgb-linear.js and p3-linear.js). All use
// the D65 white point, so no chromatic adaptation is needed between them.
const OKLAB_TO_LMS: Matrix = [
  [1.0, 0.3963377773761749, 0.2158037573099136],
  [1.0, -0.1055613458156586, -0.0638541728258133],
  [1.0, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_XYZ: Matrix = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const XYZ_TO_LMS: Matrix = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_OKLAB: Matrix = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const LINEAR_SRGB_TO_XYZ: Matrix = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const XYZ_TO_LINEAR_DISPLAY_P3: Matrix = [
  [2.493496911941425, -0.9313836179191239, -0.40271078445071684],
  [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
  [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
];

/**
 * How far a channel may stray outside 0..1 before the colour counts as out of
 * gamut. Smaller differences are rounding error in the matrices (white comes
 * out at 1.0000000002), far below one step of a 10-bit display.
 */
const GAMUT_TOLERANCE = 1e-5;

const mapVector = ([x, y, z]: Vector, transform: (value: number) => number): Vector => [
  transform(x),
  transform(y),
  transform(z),
];

const multiply = (matrix: Matrix, [x, y, z]: Vector): Vector => [
  matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
  matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
  matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z,
];

/** Converts an oklch colour (hue in degrees) to OKLab. */
export const convertOklchToOklab = (
  lightness: number,
  chroma: number,
  hue: number,
  alpha = 1,
): OklabColor => {
  const radians = (hue * Math.PI) / 180;
  return { l: lightness, a: chroma * Math.cos(radians), b: chroma * Math.sin(radians), alpha };
};

/** Converts a gamma-encoded sRGB colour (channels 0..1) to OKLab. */
export const convertSrgbToOklab = (
  red: number,
  green: number,
  blue: number,
  alpha = 1,
): OklabColor => {
  const linear = mapVector([red, green, blue], decodeGamma);
  const lms = multiply(XYZ_TO_LMS, multiply(LINEAR_SRGB_TO_XYZ, linear));
  const [l, a, b] = multiply(LMS_TO_OKLAB, mapVector(lms, Math.cbrt));
  return { l, a, b, alpha };
};

/**
 * Converts an OKLab colour to Display P3. A colour outside P3 has each channel
 * clamped to 0..1 and comes back with `clamped` set.
 */
export const convertOklabToDisplayP3 = (color: OklabColor): DisplayP3Color => {
  const lms = mapVector(multiply(OKLAB_TO_LMS, [color.l, color.a, color.b]), (v) => v ** 3);
  const encoded = mapVector(
    multiply(XYZ_TO_LINEAR_DISPLAY_P3, multiply(LMS_TO_XYZ, lms)),
    encodeGamma,
  );
  const clamped = encoded.some((v) => v < -GAMUT_TOLERANCE || v > 1 + GAMUT_TOLERANCE);
  const [red, green, blue] = mapVector(encoded, (v) => Math.min(1, Math.max(0, v)));
  return { red, green, blue, alpha: color.alpha, clamped };
};

// Display P3 uses the sRGB transfer curve. Both functions keep the sign so an
// out-of-gamut channel stays negative and can be detected.
const encodeGamma = (linear: number): number => {
  const magnitude = Math.abs(linear);
  const encoded =
    magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.sign(linear) * encoded;
};
const decodeGamma = (encoded: number): number => {
  const magnitude = Math.abs(encoded);
  const linear = magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4;
  return Math.sign(encoded) * linear;
};

/**
 * Mixes two colours as CSS `color-mix(in oklab, first p1, second p2)` does:
 * with premultiplied alpha, so mixing with `transparent` only lowers the
 * alpha. The weights are fractions that sum to at most 1; a sum below 1 scales
 * the result's alpha down, as CSS Color 5 §2.1 says.
 */
export const mixInOklab = (
  first: OklabColor,
  firstWeight: number,
  second: OklabColor,
  secondWeight: number,
): OklabColor => {
  const total = firstWeight + secondWeight;
  const p1 = firstWeight / total;
  const p2 = secondWeight / total;
  const alpha = first.alpha * p1 + second.alpha * p2;
  const mixChannel = (c1: number, c2: number): number =>
    alpha === 0 ? 0 : (c1 * first.alpha * p1 + c2 * second.alpha * p2) / alpha;
  return {
    l: mixChannel(first.l, second.l),
    a: mixChannel(first.a, second.a),
    b: mixChannel(first.b, second.b),
    alpha: alpha * Math.min(1, total),
  };
};

// ---------- Reading tokens.css ----------

/** One top-level style rule: its selectors and its custom properties in source order. */
interface StyleRule {
  readonly selectors: ReadonlyArray<string>;
  readonly properties: ReadonlyMap<string, string>;
}

/**
 * Parses the top-level style rules of a stylesheet. At-rules (`@font-face`,
 * `@media`) are skipped whole, and only custom properties (`--name`) are kept.
 */
const parseStyleRules = (css: string): Array<StyleRule> => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Array<StyleRule> = [];
  let position = 0;
  while (position < text.length) {
    const open = text.indexOf("{", position);
    if (open === -1) break;
    const prelude = text.slice(position, open).trim();
    const close = findBlockEnd(text, open);
    if (!prelude.startsWith("@")) {
      const properties = new Map<string, string>();
      for (const declaration of text.slice(open + 1, close).split(";")) {
        const match = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(declaration);
        if (match) properties.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
      }
      rules.push({ selectors: prelude.split(",").map((s) => s.trim()), properties });
    }
    position = close + 1;
  }
  return rules;
};

/** Returns the index of the `}` that closes the block opened at `open`. */
const findBlockEnd = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  throw new Error(`tokens.css has an unclosed block at offset ${open}`);
};

/**
 * Returns the custom properties that `<html data-theme="<theme>">` ends up
 * with. `:root`, `[data-theme]` and `[data-theme="<theme>"]` all have the same
 * specificity, so later rules win, as in the browser.
 */
const collectThemeProperties = (
  rules: ReadonlyArray<StyleRule>,
  theme: string,
): Map<string, string> => {
  const matches = new Set([":root", "[data-theme]", `[data-theme="${theme}"]`]);
  const properties = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.selectors.some((s) => matches.has(s))) continue;
    for (const [name, value] of rule.properties) properties.set(name, value);
  }
  return properties;
};

/**
 * Replaces every `var(--name)` and `var(--name, fallback)` in a value with the
 * named property's value, recursively. Fails on a missing property with no
 * fallback, because the browser would drop the whole declaration.
 */
const substituteVariables = (
  value: string,
  properties: ReadonlyMap<string, string>,
  depth = 0,
): string => {
  if (depth > 20) throw new Error(`tokens.css has a var() cycle in "${value}"`);
  const start = value.indexOf("var(");
  if (start === -1) return value;
  let end = start + 4;
  for (let level = 1; level > 0; end++) {
    if (value[end] === "(") level++;
    else if (value[end] === ")") level--;
    if (end >= value.length) throw new Error(`Unbalanced var() in "${value}"`);
  }
  const inner = value.slice(start + 4, end - 1);
  const comma = inner.indexOf(",");
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const replacement =
    properties.get(name) ?? (comma === -1 ? undefined : inner.slice(comma + 1).trim());
  if (replacement === undefined) throw new Error(`tokens.css uses ${name}, which is not defined`);
  const substituted = substituteVariables(replacement, properties, depth + 1);
  return substituteVariables(
    value.slice(0, start) + substituted + value.slice(end),
    properties,
    depth,
  );
};

// ---------- Evaluating colour values ----------

/** A number with its CSS unit: "" for a plain number, "%" for a percentage. */
interface Dimension {
  readonly value: number;
  readonly unit: string;
}

/**
 * Parses a colour value of tokens.css after var() substitution. It handles
 * exactly what the file uses: `oklch()` with optional alpha, `calc()` and
 * `min()` inside it, `color-mix(in oklab, ...)`, and the keywords `white` and
 * `transparent`. Anything else fails with the offending text.
 */
export const parseColor = (text: string): OklabColor => {
  const tokens = text.match(/\d*\.?\d+[a-z%]*|[a-z][\w-]*|[(),/*+-]/gi) ?? [];
  let index = 0;
  const fail = (why: string): never => {
    throw new Error(`Cannot read the colour "${text}": ${why}`);
  };
  const peek = (): string | undefined => tokens[index];
  const take = (expected?: string): string => {
    const token = tokens[index++] ?? fail("it ends too early");
    if (expected !== undefined && token !== expected)
      fail(`expected "${expected}", found "${token}"`);
    return token;
  };

  const readSum = (): Dimension => {
    let left = readProduct();
    while (peek() === "+" || peek() === "-") {
      const sign = take() === "+" ? 1 : -1;
      const right = readProduct();
      if (left.unit !== right.unit)
        fail(`cannot add ${left.unit || "a number"} and ${right.unit || "a number"}`);
      left = { value: left.value + sign * right.value, unit: left.unit };
    }
    return left;
  };
  const readProduct = (): Dimension => {
    let left = readFactor();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const right = readFactor();
      if (operator === "/" && right.unit !== "") fail("cannot divide by a dimension");
      if (left.unit !== "" && right.unit !== "") fail("cannot multiply two dimensions");
      const value = operator === "*" ? left.value * right.value : left.value / right.value;
      left = { value, unit: left.unit || right.unit };
    }
    return left;
  };
  const readFactor = (): Dimension => {
    const token = take();
    if (token === "-") {
      const factor = readFactor();
      return { value: -factor.value, unit: factor.unit };
    }
    if (token === "(" || token === "calc") {
      if (token === "calc") take("(");
      const sum = readSum();
      take(")");
      return sum;
    }
    if (token === "min") {
      take("(");
      const values = [readSum()];
      while (peek() === ",") {
        take();
        values.push(readSum());
      }
      take(")");
      if (values.some((v) => v.unit !== values[0]!.unit)) fail("min() mixes units");
      return { value: Math.min(...values.map((v) => v.value)), unit: values[0]!.unit };
    }
    const match = /^(\d*\.?\d+)([a-z%]*)$/i.exec(token) ?? fail(`unexpected "${token}"`);
    return { value: Number(match[1]), unit: match[2]! };
  };
  const readNumber = (): number => {
    const dimension = readFactor();
    if (dimension.unit !== "") fail(`expected a plain number, found unit "${dimension.unit}"`);
    return dimension.value;
  };
  const readPercentage = (): number | undefined => {
    const next = peek();
    if (next === undefined || next === "," || next === ")") return undefined;
    const dimension = readFactor();
    if (dimension.unit !== "%") fail("a color-mix() weight must be a percentage");
    return dimension.value / 100;
  };

  const readColor = (): OklabColor => {
    const token = take();
    if (token === "white") return convertSrgbToOklab(1, 1, 1);
    // `transparent` is rgb(0 0 0 / 0); its channels never matter because
    // color-mix() premultiplies them by alpha 0.
    if (token === "transparent") return { l: 0, a: 0, b: 0, alpha: 0 };
    if (token === "oklch") {
      take("(");
      const [lightness, chroma, hue] = [readNumber(), readNumber(), readNumber()];
      let alpha = 1;
      if (peek() === "/") {
        take();
        alpha = readNumber();
      }
      take(")");
      return convertOklchToOklab(lightness, chroma, hue, alpha);
    }
    if (token === "color-mix") {
      take("(");
      take("in");
      take("oklab");
      take(",");
      const first = readColor();
      const firstWeight = readPercentage();
      take(",");
      const second = readColor();
      const secondWeight = readPercentage();
      take(")");
      const p1 = firstWeight ?? (secondWeight === undefined ? 0.5 : 1 - secondWeight);
      const p2 = secondWeight ?? 1 - p1;
      return mixInOklab(first, p1, second, p2);
    }
    return fail(`"${token}" is not a colour this script reads`);
  };

  const color = readColor();
  if (index !== tokens.length) fail(`unexpected "${tokens[index]}" after the colour`);
  return color;
};

/** Checks whether a value, after var() substitution, is written as a single colour. */
const isColorValue = (value: string): boolean =>
  /^(oklch\(|color-mix\(|white$|transparent$)/.test(value);

// ---------- Writing Kotlin ----------

/** The two themes the app offers, by their `data-theme` id. */
const APP_THEMES = [
  { id: "whitehaven", kotlinName: "WhitehavenColors", title: "Whitehaven, the light theme" },
  {
    id: "orient-express",
    kotlinName: "OrientExpressColors",
    title: "Orient Express, the dark theme",
  },
] as const;

/** The reserved `--hue-*` angles that belong to no colleague and so get no crew colours. */
const RESERVED_HUES = new Set(["--hue-you", "--hue-fail"]);

/** The four colleague colours the `.who` rule derives from `--hue`. */
const CREW_TOKENS = ["--who", "--who-shade", "--who-ink", "--who-tint"] as const;

/** Converts a CSS custom property name to a Kotlin identifier: `--line-soft` becomes `lineSoft`. */
const convertToCamelCase = (name: string): string =>
  name
    .replace(/^--/, "")
    .split("-")
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");

const formatFloat = (value: number): string => `${value.toFixed(6)}f`;

/**
 * Returns one Kotlin argument line, `<indent><name> = Color(...),`, with a
 * trailing comment when the colour was clamped into Display P3.
 */
const buildColorArgument = (indent: string, name: string, color: OklabColor): string => {
  const p3 = convertOklabToDisplayP3(color);
  const channels = [p3.red, p3.green, p3.blue, p3.alpha].map(formatFloat).join(", ");
  const note = p3.clamped ? " // outside Display P3, clamped" : "";
  return `${indent}${convertToCamelCase(name)} = Color(${channels}, ColorSpaces.DisplayP3),${note}`;
};

/** Returns the Kotlin expression for one theme-independent number, or undefined when it has no Kotlin form. */
const buildScaleExpression = (name: string, value: string): string | undefined => {
  const pixels = /^(\d+)px$/.exec(value);
  if (pixels) return name.startsWith("--t-") ? `${pixels[1]}.sp` : `${pixels[1]}.dp`;
  const millis = /^(\d+)ms$/.exec(value);
  if (millis) return millis[1];
  const bezier = /^cubic-bezier\(([^)]*)\)$/.exec(value);
  if (bezier)
    return `CubicBezierEasing(${bezier[1]!
      .split(",")
      .map((v) => `${Number(v)}f`)
      .join(", ")})`;
  if (/^\d+$/.test(value)) return value;
  if (/^\d*\.\d+$/.test(value)) return `${Number(value)}f`;
  return undefined;
};

/**
 * Builds the Kotlin source of `Tokens.kt` from the text of tokens.css. The
 * output depends only on the input, so the staleness test can compare it with
 * the checked-in file byte for byte.
 */
export const buildTokensKotlin = (css: string): string => {
  const rules = parseStyleRules(css);
  const crewRule = rules.find((rule) => rule.selectors.includes(".who"));
  if (!crewRule) throw new Error("tokens.css has no .who rule for the crew colours");
  const scalesRule = rules.find(
    (rule) => rule.selectors.length === 1 && rule.selectors[0] === ":root",
  );
  if (!scalesRule) throw new Error("tokens.css has no :root rule for the theme-independent scales");
  const crewHues = [...scalesRule.properties.keys()].filter(
    (name) => name.startsWith("--hue-") && !RESERVED_HUES.has(name),
  );
  // Glass colours derive from --glass-level, which the user can change at run
  // time; they are generated at its default from the :root rule.
  const glassLevel = scalesRule.properties.get("--glass-level");

  const themes = APP_THEMES.map((theme) => {
    const properties = collectThemeProperties(rules, theme.id);
    const colors = new Map<string, OklabColor>();
    const skipped: Array<string> = [];
    for (const [name, value] of properties) {
      if (scalesRule.properties.has(name)) continue;
      const resolved = substituteVariables(value, properties);
      if (isColorValue(resolved)) colors.set(name, parseColor(resolved));
      else skipped.push(name);
    }
    const crew = crewHues.map((hue) => {
      const withHue = new Map([...properties, ["--hue", `var(${hue})`]]);
      return CREW_TOKENS.map((token) =>
        parseColor(substituteVariables(crewRule.properties.get(token) ?? "", withHue)),
      );
    });
    return { ...theme, colors, skipped, crew };
  });

  const [light, dark] = themes;
  const fields = [...light!.colors.keys()];
  if (fields.join() !== [...dark!.colors.keys()].join())
    throw new Error("Whitehaven and Orient Express define different colour tokens");
  const skipped = [...new Set(themes.flatMap((theme) => theme.skipped))];

  const hueName = (hue: string): string => convertToCamelCase(hue.replace(/^--hue-/, "--"));
  const lines: Array<string> = [
    "// Generated by scripts/gen-android-tokens.ts. Do not edit.",
    "package dev.hercule.android.theme",
    "",
    "import androidx.compose.animation.core.CubicBezierEasing",
    "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.graphics.colorspace.ColorSpaces",
    "import androidx.compose.ui.unit.dp",
    "import androidx.compose.ui.unit.sp",
    "",
    "/*",
    ` * The Crew Bureau design tokens from ${TOKENS_CSS_PATH}.`,
    " *",
    ' * Colours are in Display P3. A colour marked "outside Display P3, clamped" had a',
    " * channel outside 0..1 and was clamped per channel.",
    ` * Glass colours are worked out at --glass-level ${glassLevel ?? "(unset)"}, the book's default.`,
    " * Tokens that are not a single colour are left out:",
    ...skipped.map((name) => ` *   ${name}`),
    " */",
    "",
    "/** The colours of one Crew Bureau theme. Each field is the CSS token of the same name. */",
    "data class BureauColors(",
    ...fields.map((name) => `    val ${convertToCamelCase(name)}: Color,`),
    "    val crew: CrewPalette,",
    ")",
    "",
    "/** The four colours of one colleague's hue: its face, the face's rim, its name ink and a quiet tint. */",
    "data class CrewColors(",
    ...CREW_TOKENS.map((token) => `    val ${convertToCamelCase(token)}: Color,`),
    ")",
    "",
    "/** The colours of every hue on the crew wheel, in one theme. */",
    "data class CrewPalette(",
    ...crewHues.map((hue) => `    val ${hueName(hue)}: CrewColors,`),
    ")",
  ];
  for (const theme of themes) {
    lines.push(
      "",
      `/** ${theme.title} (data-theme="${theme.id}"). */`,
      `val ${theme.kotlinName} = BureauColors(`,
      ...fields.map((name) => buildColorArgument("    ", name, theme.colors.get(name)!)),
      "    crew = CrewPalette(",
      ...crewHues.flatMap((hue, i) => [
        `        ${hueName(hue)} = CrewColors(`,
        ...CREW_TOKENS.map((token, j) =>
          buildColorArgument("            ", token, theme.crew[i]![j]!),
        ),
        "        ),",
      ]),
      "    ),",
      ")",
    );
  }
  lines.push(
    "",
    "/**",
    " * The theme-independent scales. Each field is the CSS token of the same name:",
    " * sizes in dp (type in sp), durations in milliseconds, hues in oklch degrees.",
    " */",
    "object BureauScales {",
  );
  for (const [name, value] of scalesRule.properties) {
    const expression = buildScaleExpression(name, value);
    if (expression !== undefined) lines.push(`    val ${convertToCamelCase(name)} = ${expression}`);
  }
  lines.push("}", "");
  return lines.join("\n");
};

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const kotlin = buildTokensKotlin(await readFile(`${root}${TOKENS_CSS_PATH}`, "utf8"));
  await mkdir(dirname(`${root}${TOKENS_KOTLIN_PATH}`), { recursive: true });
  await writeFile(`${root}${TOKENS_KOTLIN_PATH}`, kotlin);
}
