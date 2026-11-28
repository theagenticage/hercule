/**
 * Checks that the React Compiler compiles every component and hook of the
 * renderer. When the compiler cannot compile a function, it skips it without
 * a word, and the function then runs without memoization: it redraws on every
 * change of its parent. This test runs the compiler over every renderer
 * source file, with the options `vite.renderer.config.ts` gives it, and fails
 * on any function the compiler reports as skipped.
 *
 * A file that cannot be fixed goes in `ALLOWED_SKIPS` with the reason. The
 * test fails when an entry no longer matches a skipped function, so the list
 * never keeps an entry that is no longer needed.
 *
 * The usual cause of a skip is a default value in a props destructuring
 * (`function Chip({ size = 16 })`): the Babel 8 the build uses makes the
 * compiler refuse it. Move the default into the body (`size ?? 16`).
 */
import { transformSync } from "@babel/core";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rendererSource = dirname(fileURLToPath(import.meta.url));

/** Why the compiler skips a function that calls `useVirtualizer` from TanStack Virtual. */
const VIRTUALIZER =
  "useVirtualizer returns functions that change without the hook's result changing, so the compiler refuses to cache them (it reports 'Use of incompatible library'). The hook's caller redraws as before.";

/** Why the compiler skips a function that disables `react-hooks/exhaustive-deps` on purpose. */
const DISABLED_DEPS_RULE =
  "The function disables react-hooks/exhaustive-deps on purpose, and the compiler skips any function that disables a React lint rule. Removing the comment changes what the effect or memo depends on.";

/**
 * The files whose skipped functions are accepted, as paths below
 * `src/renderer`, each with the reason the compiler skips it.
 */
const ALLOWED_SKIPS: Readonly<Record<string, string>> = {
  "routes/_connected/_shell/workflows/-runs.tsx": VIRTUALIZER,
  "screens/session/message-list.ts": VIRTUALIZER,
  "screens/session/skill-list.tsx": VIRTUALIZER,
  "screens/use-virtual-lines.ts": VIRTUALIZER,
  "screens/virtual-list.tsx": VIRTUALIZER,
  "screens/assistant/conversation.tsx": DISABLED_DEPS_RULE,
  "screens/session/messages.tsx": DISABLED_DEPS_RULE,
  "shell/use-thread-hover.ts": DISABLED_DEPS_RULE,
};

/** Returns the renderer's source files that ship in the app: no tests, no generated route tree. */
function listSourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    const isSource = /\.tsx?$/.test(entry.name) && !/\.(test|gen)\.tsx?$/.test(entry.name);
    return isSource ? [path] : [];
  });
}

/**
 * Compiles one file and returns a line for each function the compiler skipped:
 * the file's path, the line where the function starts, and the compiler's reason.
 */
function listSkippedFunctions(file: string): string[] {
  const skipped: string[] = [];
  const logger = {
    logEvent(
      _filename: string | null,
      event: { kind: string; fnLoc?: { start: { line: number } } | null; [key: string]: unknown },
    ) {
      if (
        event.kind !== "CompileError" &&
        event.kind !== "CompileSkip" &&
        event.kind !== "PipelineError"
      )
        return;
      const detail = event.detail as { reason?: string } | undefined;
      const reason = detail?.reason ?? (event.reason as string | undefined) ?? String(event.data);
      skipped.push(`${relative(rendererSource, file)}:${event.fnLoc?.start.line ?? 0}: ${reason}`);
    },
  };
  transformSync(readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"] },
    plugins: [["babel-plugin-react-compiler", { logger }]],
  });
  return [...new Set(skipped)];
}

describe("the React Compiler over the renderer", () => {
  const skippedByFile = new Map(
    listSourceFiles(rendererSource)
      .map((file) => [relative(rendererSource, file), listSkippedFunctions(file)] as const)
      .filter(([, skipped]) => skipped.length > 0),
  );

  it("skips no function that is not in the allowed list", () => {
    const unexpected = [...skippedByFile]
      .filter(([file]) => !(file in ALLOWED_SKIPS))
      .flatMap(([, skipped]) => skipped);
    expect(
      unexpected,
      "The React Compiler skipped these functions, so they redraw on every change of their parent. Fix the cause the reason names (a default prop moves into the body), or add the file to ALLOWED_SKIPS with a reason.",
    ).toEqual([]);
  });

  it("allows only files that still have a skipped function", () => {
    const stale = Object.keys(ALLOWED_SKIPS).filter((file) => !skippedByFile.has(file));
    expect(
      stale,
      "These files are in ALLOWED_SKIPS but the compiler no longer skips anything in them. Remove the entries.",
    ).toEqual([]);
  });
});
