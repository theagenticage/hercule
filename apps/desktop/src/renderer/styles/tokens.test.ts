import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tests that every token the Work and Inbox pages share (the desk, the card
 * stock, the type roles, the card shape and the motion tokens) is declared for
 * all six themes in styles/tokens.css.
 *
 * A custom property that a theme does not declare is not an error: `var()`
 * resolves to nothing and the card loses its shadow or its colour without a
 * warning. So the test reads the file as text, like motion.test.ts, and checks
 * that each token is declared either in the rule that matches every element
 * with a theme (`:root, [data-theme]`) or in the block of each theme.
 */

/** The theme ids the app ships. Whitehaven is also the page's default, when no theme is set. */
const THEMES = ["whitehaven", "styles", "nile", "end-house", "blue-train", "orient-express"];

/** The selector that matches every element with a theme, so a block with it covers all six themes. */
const SHARED_SELECTOR = "[data-theme]";

/** The tokens of the shared Work and Inbox layer. A new shared token is added here. */
const SHARED_TOKENS = [
  "--desk",
  "--word-press",
  "--paper",
  "--answer",
  "--answer-fg",
  "--plan-l",
  "--plan-c",
  "--plan-soft-a",
  "--stock",
  "--stock-carry",
  "--stock-sheen",
  "--stock-flat",
  "--stock-rim",
  "--stock-rim-flat",
  "--stock-lit",
  "--stock-press",
  "--h-rest",
  "--h-hover",
  "--h-carry",
  "--type-lane",
  "--type-card",
  "--type-summary",
  "--type-meta",
  "--card-r",
  "--card-r-inner",
  "--card-pad-x",
  "--card-pad-y",
  "--card-h",
  "--card-gap",
  "--m-press",
  "--m-quick",
  "--m-base",
  "--m-slow",
  "--m-long",
  "--m-ease",
  "--m-ease-in",
  "--m-ease-both",
  "--m-settle",
  "--mark-l",
  "--mark-c",
  "--attention-ink",
  "--wait-fresh",
  "--wait-recent",
  "--wait-due",
  "--wait-over",
];

type Block = { selectors: string[]; declared: Set<string> };

/** Splits CSS text into its innermost blocks: the selectors of each, and the custom properties it declares. */
const readBlocks = (css: string): Block[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selectors: selector!.split(",").map((part) => part.trim()),
      declared: new Set([...body!.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name!)),
    }),
  );

const blocks = readBlocks(readFileSync(join(import.meta.dirname, "tokens.css"), "utf8"));

/** Returns whether a block applies to the theme: by its id, or for the default theme, by `:root`. */
const appliesToTheme = (block: Block, theme: string) =>
  block.selectors.some(
    (selector) =>
      selector === `[data-theme="${theme}"]` || (theme === "whitehaven" && selector === ":root"),
  );

describe("the shared Work and Inbox tokens", () => {
  it("finds the blocks of tokens.css", () => {
    // Guards the scan itself: a wrong parse would find no block and every check below would fail
    // for the wrong reason, or an empty list of themes would pass.
    expect(blocks.some((block) => block.selectors.includes(`[data-theme="nile"]`))).toBe(true);
  });

  it.each(THEMES)("declares every token for the %s theme", (theme) => {
    const missing = SHARED_TOKENS.filter(
      (token) =>
        !blocks.some(
          (block) =>
            block.declared.has(token) &&
            (block.selectors.includes(SHARED_SELECTOR) || appliesToTheme(block, theme)),
        ),
    );
    expect(missing).toEqual([]);
  });
});
