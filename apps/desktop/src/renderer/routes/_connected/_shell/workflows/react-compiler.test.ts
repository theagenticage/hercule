/**
 * Tests that the React Compiler compiles every component and hook of the
 * workflow pages: the route files here and a run's page's, and the screens
 * they draw. When the compiler cannot compile a function, it leaves it as written, with no
 * memoization, and the build prints nothing. The lint rules do not catch
 * every such case, so this test runs the compiler the build runs, with the
 * same options as `reactCompilerPreset()` in `vite.renderer.config.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

/** The folders whose files are compiled: this route folder, the run's page's, and the workflow screens. */
const HERE = dirname(fileURLToPath(import.meta.url));
const FOLDERS = [HERE, join(HERE, "../runs"), join(HERE, "../../../../screens/workflows")];

/**
 * The functions the compiler skips on purpose, by file, with the reason it
 * gives. The Runs list uses TanStack's virtualizer, whose return value the
 * compiler cannot memoize safely, so the compiler leaves the list alone.
 */
const EXPECTED_SKIPS: Readonly<Record<string, string>> = {
  "-runs.tsx": "Use of incompatible library",
};

/** Returns every source file in `folder` that is not a test. */
const listSources = (folder: string): string[] =>
  readdirSync(folder)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(folder, name));

/** A function the compiler did not compile, and why. */
interface Skip {
  readonly file: string;
  readonly reason: string;
}

/** Compiles `file` with the React Compiler, and returns each function it did not compile. */
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
  // Compiling every file takes under a second on a laptop, but has passed
  // the default limit of 5 s on a busy CI runner. The work is bounded, so a
  // longer limit hides no hang.
  it("compiles every component and hook of the workflow pages", { timeout: 30_000 }, () => {
    const files = FOLDERS.flatMap(listSources);
    expect(files.length).toBeGreaterThan(5);

    expect(files.flatMap(compileSource)).toEqual([]);
  });
});
