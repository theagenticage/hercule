/**
 * Tests that the React Compiler compiles every component and hook of the
 * pages that draw a list beside an open item (Workflows, Discussions, Wiki),
 * and of the screens they share. When the compiler cannot compile a function,
 * it leaves it as written, with no memoization, and the build prints nothing.
 * The lint rules do not catch every such case, so this test runs the compiler
 * the build runs, with the same options as `reactCompilerPreset()` in
 * `vite.renderer.config.ts`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENS = join(HERE, "../../../screens");

/**
 * The folders and single files whose sources are compiled: the route folders
 * of the three pages and of a run's page, the screens they draw, the folders
 * they share, Intake's screen, the parts of its Tracking pane, and the line of a Done signal's trip. A folder is compiled
 * without its tests.
 */
const PATHS = [
  join(HERE, "workflows"),
  join(HERE, "runs"),
  join(HERE, "discussions"),
  join(HERE, "wiki"),
  join(SCREENS, "workflows"),
  join(SCREENS, "discussions"),
  join(SCREENS, "wiki"),
  join(SCREENS, "actor"),
  join(SCREENS, "project-groups"),
  join(SCREENS, "list-pane"),
  join(SCREENS, "thread/use-sender-reading.ts"),
  join(SCREENS, "intake/handoff-trip-line.tsx"),
  join(SCREENS, "intake/tracking-pane.tsx"),
  join(SCREENS, "intake/tracking-trip.tsx"),
  join(SCREENS, "intake/tracking-messages.tsx"),
  join(SCREENS, "intake/intake-screen.tsx"),
  join(SCREENS, "intake/use-held-tracking-rows.ts"),
  join(SCREENS, "intake/use-rerun-tracking.ts"),
  join(SCREENS, "intake/use-take-off-tracking.ts"),
  join(SCREENS, "intake/use-tracking-controls.ts"),
];

/**
 * The functions the compiler skips on purpose, by file, with the reason it
 * gives. The Runs list uses TanStack's virtualizer, whose return value the
 * compiler cannot memoize safely, so the compiler leaves the list alone.
 */
const EXPECTED_SKIPS: Readonly<Record<string, string>> = {
  "-runs.tsx": "Use of incompatible library",
};

/** Returns the source files at `path`: the file itself, or every file in a folder that is not a test. */
const listSources = (path: string): string[] =>
  statSync(path).isFile()
    ? [path]
    : readdirSync(path)
        .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
        .map((name) => join(path, name));

/** A function the compiler did not compile, and why. */
interface Skip {
  readonly file: string;
  readonly reason: string;
}

/** Compiles `file` with the React Compiler, and returns each function it did not compile and was not expected to skip. */
const compileSource = (file: string): Skip[] => {
  const skips: Skip[] = [];
  const name = file.split("/").at(-1)!;
  transformSync(readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [
      [
        createRequire(import.meta.url).resolve("babel-plugin-react-compiler"),
        {
          logger: {
            logEvent: (_filename: string | null, event: { kind: string; detail?: unknown }) => {
              if (event.kind === "CompileSuccess") return;
              skips.push({ file: name, reason: JSON.stringify(event.detail ?? event) });
            },
          },
        },
      ],
    ],
  });
  return skips.filter(
    (skip) => !(EXPECTED_SKIPS[name] !== undefined && skip.reason.includes(EXPECTED_SKIPS[name])),
  );
};

describe("the React Compiler", () => {
  // The test has no time limit. Compiling some fifty files takes a second on
  // a Mac, but several seconds on a CI runner busy with the other test files,
  // and the Workflows version of this test failed there at the default limit
  // of 5 s. A limit guards nothing here: the test is synchronous, so a timer
  // cannot stop it, and the compile always ends.
  it("compiles every component and hook of the list-and-open-item pages", { timeout: 0 }, () => {
    const files = PATHS.flatMap(listSources);
    expect(files.length).toBeGreaterThan(30);

    expect(files.flatMap(compileSource)).toEqual([]);
  });
});
