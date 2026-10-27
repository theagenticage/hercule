import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tests that no code or Deco text inherits Inter's font features.
 *
 * `tokens.css` turns on Inter's tailed l, serifed I and slashed zero for the
 * whole page, and font features are inherited. Recursive (code) and Limelight
 * (the wordmark and the headline numerals) have glyphs of their own behind
 * the same feature names, so a rule that sets one of those families must
 * reset the features with `font-feature-settings: normal`. A rule that
 * forgets would draw code with Inter's choices applied to the wrong font, and
 * only a careful look at a screenshot would show it.
 *
 * The test reads every stylesheet of the renderer as text, so a rule added
 * later is checked without a change here.
 */

/** The renderer's source folder, which holds every stylesheet the test reads. */
const RENDERER = join(import.meta.dirname, "..");

/** The families whose text must not inherit Inter's features. */
const NON_INTER_FAMILIES = ["var(--font-mono)", "var(--font-deco)"];

/**
 * Returns the selectors of the rules in `css` that set a non-Inter family
 * without `font-feature-settings: normal`. A rule is a block with no block
 * inside it, so the rules inside an `@media` block are found too.
 */
function findRulesThatKeepInterFeatures(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  for (const [, selector = "", body = ""] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const family = /(?:^|[;\s])font-family:\s*([^;]+)/.exec(body)?.[1]?.trim();
    if (family === undefined || !NON_INTER_FAMILIES.includes(family)) continue;
    if (!/(?:^|[;\s])font-feature-settings:\s*normal\s*(?:;|$)/.test(body)) {
      found.push(selector.trim().replace(/\s+/g, " "));
    }
  }
  return found;
}

describe("Inter's font features", () => {
  it("are reset by every rule that sets the code font or the Deco face", () => {
    const stylesheets = readdirSync(RENDERER, { recursive: true, encoding: "utf8" }).filter(
      (path) => path.endsWith(".css"),
    );
    const offenders = stylesheets.flatMap((file) =>
      findRulesThatKeepInterFeatures(readFileSync(join(RENDERER, file), "utf8")).map(
        (selector) => `${file}: ${selector}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("are found in a rule that forgets the reset", () => {
    const css = `/* a comment */
      .ok { font-family: var(--font-mono); font-feature-settings: normal; }
      .forgot { font-family: var(--font-deco); }
      @media (min-width: 1px) { .nested { font-family: var(--font-mono); font-size: 12px; } }
      .ui { font-family: var(--font-ui); }`;
    expect(findRulesThatKeepInterFeatures(css)).toEqual([".forgot", ".nested"]);
  });
});
