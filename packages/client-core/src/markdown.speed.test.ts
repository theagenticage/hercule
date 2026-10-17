/**
 * Times `parseMarkdown` on the worst-case inputs of
 * `markdown-worst-case.testing.ts`, and fails when one takes more than
 * `CEILING_MS`. Run it with `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because wall-clock time
 * depends on the machine and on how busy it is. A test that times code fails
 * on a loaded machine with no change to the code, and a flaky test is worse
 * than none. `markdown-worst-case.test.ts` runs the same inputs in every test
 * run and checks their output, with no timing.
 *
 * What it guards is an order of magnitude. A comment is untrusted and up to
 * hundreds of kilobytes long, and the parse runs on the thread that draws the
 * app. On a 200 KB input a linear parse takes milliseconds. A parse that
 * grows faster than linear takes hundreds of milliseconds or seconds, and
 * freezes the app. The ceiling is far above the first and far below the
 * second, so it ignores the speed of the machine and finds the slow parse.
 *
 * Measured on a laptop in Bun, with the fastest of 5 runs per input:
 *
 * - The linear parse takes 0.2 to 70 ms per input. The slowest is a long run
 *   of `[^` (70 ms), then paragraphs cut by headings (56 ms).
 * - The parses that were quadratic took 17 s for 200,000 spaces in a `pre`, 19 s
 *   for 100,000 repeats of `<a` and 28 s for `<a=`. The mildest, joining
 *   `x<T>` text, took 220 ms and then 700 ms at twice the size. The ceiling
 *   does not catch that one at this size, and the output test and the
 *   other inputs do.
 *
 * Run it after changing how `parseMarkdown` or `markdown-html.ts` read their
 * input, and after upgrading `marked`.
 *
 * The inputs that are slow inside `marked` itself are not in the table, see
 * `markdown-worst-case.testing.ts`. They are slow with no code of ours in the
 * way, so this test could not tell us anything about our code.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { WORST_CASE_INPUTS } from "./markdown-worst-case.testing";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The longest a parse may take, in milliseconds: 3.5 times the slowest linear parse measured. */
const CEILING_MS = 250;

/** How often each input is parsed. The fastest run counts, so a pause on a busy machine does not. */
const RUNS = 5;

describe.runIf(SPEED_TESTS_ENABLED)("parseMarkdown speed", () => {
  it.each(WORST_CASE_INPUTS)("parses $name in under the ceiling", ({ text }) => {
    let fastest = Infinity;
    for (let run = 0; run < RUNS; run++) {
      const started = performance.now();
      parseMarkdown(text);
      fastest = Math.min(fastest, performance.now() - started);
    }

    expect(fastest).toBeLessThan(CEILING_MS);
  });
});
