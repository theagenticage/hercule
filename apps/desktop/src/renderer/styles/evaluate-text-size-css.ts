/**
 * Computes what the stylesheets give a custom property at each step of the
 * Text size, for tests: jsdom computes no `calc()`, so a test that wants to
 * know the height of a row at the largest step evaluates the formulas of the
 * stylesheets itself. It reads the formulas, not their spelling, so a formula
 * written another way that comes to the same length passes.
 */
import base from "./base.css?raw";
import rowHeights from "./row-heights.css?raw";
import tokens from "./tokens.css?raw";
import type { TextSizeStep } from "../../ipc/appearance";

/** The `--name: value;` declarations of `css`, by name. A later one replaces an earlier one. */
const readCustomProperties = (css: string): Map<string, string> =>
  new Map(
    [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map(
      ([, name, value]) => [name!, value!.trim()] as const,
    ),
  );

const FORMULAS = new Map([...readCustomProperties(tokens), ...readCustomProperties(rowHeights)]);

/**
 * Returns what `--text-size-step` is, in pixels, at `step`: the rule of
 * base.css that sets it for the step, or tokens.css's default when no rule
 * names the step. A rule may spell its selector any way that names the
 * attribute and its value.
 */
export const computeTextSizeStepPx = (step: TextSizeStep): number => {
  for (const [, selector, body] of base.matchAll(/([^{}]*data-text-size[^{}]*)\{([^}]*)\}/g)) {
    const named = /data-text-size\s*=\s*["']?(\d)["']?/.exec(selector!)?.[1];
    const declared = /--text-size-step\s*:\s*(-?[\d.]+)px/.exec(body!)?.[1];
    if (named === String(step) && declared !== undefined) return Number(declared);
  }
  return Number.parseFloat(FORMULAS.get("--text-size-step")!);
};

/**
 * Returns the length in pixels that the custom property `name` of tokens.css
 * or row-heights.css computes to at `step`. Fails on a formula it cannot
 * read: only `calc()`, `var()`, numbers, `px`, and `+ - * /`.
 */
export const computeLengthAtStep = (name: string, step: TextSizeStep): number => {
  const resolve = (text: string): string =>
    text.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, used: string) => {
      if (used === "--text-size-step") return `${String(computeTextSizeStepPx(step))}px`;
      const formula = FORMULAS.get(used);
      if (formula === undefined) throw new Error(`${used} has no formula.`);
      return `(${resolve(formula)})`;
    });
  const tokens = resolve(FORMULAS.get(name) ?? `var(${name})`)
    .replace(/calc/g, "")
    .match(/[-+*/()]|[\d.]+(?:px)?/g);
  if (tokens === null) throw new Error(`${name} has no formula.`);
  let position = 0;
  // sum := product (("+" | "-") product)*; product := factor (("*" | "/") factor)*
  const parseSum = (): number => {
    let total = parseProduct();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const sign = tokens[position++] === "+" ? 1 : -1;
      total += sign * parseProduct();
    }
    return total;
  };
  const parseProduct = (): number => {
    let total = parseFactor();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++];
      const factor = parseFactor();
      total = operator === "*" ? total * factor : total / factor;
    }
    return total;
  };
  const parseFactor = (): number => {
    const token = tokens[position++];
    if (token === "(") {
      const inner = parseSum();
      position++;
      return inner;
    }
    if (token === "-") return -parseFactor();
    return Number.parseFloat(token ?? "NaN");
  };
  const result = parseSum();
  if (position !== tokens.length || Number.isNaN(result)) {
    throw new Error(`The formula of ${name} cannot be read.`);
  }
  return result;
};
