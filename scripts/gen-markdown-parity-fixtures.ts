/**
 * Writes the trees that client-core's `parseMarkdown` builds for every input
 * of `scripts/markdown-parity-corpus.json`, as the fixture that the Android
 * app's markdown port is tested against (spec 18, "Logic ported from
 * client-core").
 *
 * Run it with `pnpm gen:markdown-parity` after a change to client-core's
 * markdown parser or to the corpus. The fixture is checked in because Gradle
 * does not run TypeScript, and `gen-markdown-parity-fixtures.test.ts` fails
 * when the checked-in fixture is stale. Never edit the fixture by hand.
 *
 * Each input is parsed in the three ways the apps parse a message:
 *
 * - `agent`: an agent's text, with no line breaks and with embedded HTML.
 * - `user`: the user's own message bubble, with line breaks and no HTML.
 * - `otherAgent`: a bubble another agent sent, with line breaks and HTML.
 *
 * When `parseMarkdown` refuses a text that nests deeper than
 * `MAX_MARKDOWN_NESTING`, the case holds `"fallback"`: the apps then show the
 * raw text. Keep the corpus's deep cases below the depth at which marked runs
 * out of stack, a few hundred levels, so that the rule decides them and not
 * the engine; the Android app's worst-case test covers deeper text.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  MarkdownTooDeepError,
  parseMarkdown,
  type MarkdownDocument,
} from "../packages/client-core/src/markdown";

/** The inputs, each with an id that says where it comes from. Written by hand. */
export const PARITY_CORPUS_PATH = "scripts/markdown-parity-corpus.json";

/** The generated fixture, relative to the repository root. */
export const PARITY_FIXTURE_PATH = "apps/android/app/src/test/resources/markdown/parity.json";

/** One input of the corpus. */
export interface ParityInput {
  readonly id: string;
  readonly input: string;
}

/** The three ways the apps parse a message, by the name the fixture gives each. */
const PARSE_MODES = {
  agent: { breaks: false, embeddedHtml: true },
  user: { breaks: true, embeddedHtml: false },
  otherAgent: { breaks: true, embeddedHtml: true },
} as const;

/**
 * Returns the document `parseMarkdown` builds, or `"fallback"` when it refuses the text by its
 * nesting rule, `MarkdownTooDeepError`, which the Android port follows too. Any other error
 * fails the run: a case that only fails by running out of stack depends on the engine, and has
 * no place in the fixture.
 */
const parseOrFallBack = (
  input: string,
  options: { readonly breaks: boolean; readonly embeddedHtml: boolean },
): MarkdownDocument | "fallback" => {
  try {
    return parseMarkdown(input, options);
  } catch (error) {
    if (error instanceof MarkdownTooDeepError) return "fallback";
    throw error;
  }
};

/**
 * Builds the fixture's text for `corpus`: a JSON array with one case per
 * line, so that a change to the parser shows in a diff as the cases it
 * changes. Fails when two inputs share an id.
 */
export const buildParityFixture = (corpus: ReadonlyArray<ParityInput>): string => {
  const ids = new Set<string>();
  const lines = corpus.map(({ id, input }) => {
    if (ids.has(id))
      throw new Error(`The corpus holds the id ${id} twice; give each input its own.`);
    ids.add(id);
    const trees = Object.fromEntries(
      Object.entries(PARSE_MODES).map(([mode, options]) => [mode, parseOrFallBack(input, options)]),
    );
    return JSON.stringify({ id, input, ...trees });
  });
  return `[\n${lines.join(",\n")}\n]\n`;
};

/** Reads the corpus from the repository whose root is `root`. */
export const readParityCorpus = async (root: string): Promise<ParityInput[]> =>
  JSON.parse(await readFile(`${root}${PARITY_CORPUS_PATH}`, "utf8")) as ParityInput[];

if (import.meta.main) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const corpus = await readParityCorpus(root);
  await writeFile(`${root}${PARITY_FIXTURE_PATH}`, buildParityFixture(corpus));
  console.log(`Wrote ${corpus.length} cases to ${PARITY_FIXTURE_PATH}`);
}
