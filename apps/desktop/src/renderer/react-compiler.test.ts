/**
 * Checks that the React Compiler compiles every component and hook of the
 * renderer. When the compiler cannot compile a function, it skips it without
 * a word, and the function then runs without the compiler's memoization.
 * This test runs the compiler over every renderer source file, with the
 * options `vite.renderer.config.ts` gives it, and fails on any function the
 * compiler reports as skipped.
 *
 * A skip that cannot be fixed goes in `ALLOWED_SKIPS` with the compiler's
 * message and the reason. An entry allows only skips in its file whose message
 * contains its text, and the test fails when an entry matches no skip, so the
 * list never keeps an entry that is no longer needed.
 *
 * A function that opts out on purpose with `"use no memo"` is not a skip: the
 * directive is visible in the source. The test reads each file as written, so
 * it does not see what the build changes before the compiler runs, such as
 * the components TanStack Router's code splitting moves into their own
 * functions, or a `"use no memo"` at the top of a whole module.
 *
 * The usual cause of a skip is a default value in a destructuring
 * (`function Chip({ size = 16 })`): the Babel 8 the build uses makes the
 * compiler refuse it. Move the default into the body (`size ?? 16`).
 */
import { transformSync } from "@babel/core";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rendererSource = dirname(fileURLToPath(import.meta.url));

/**
 * The compiler plugin as an absolute path. A bare name would be resolved from
 * the folder vitest starts in, and only this workspace links the plugin.
 */
const compilerPlugin = createRequire(import.meta.url).resolve("babel-plugin-react-compiler");

/** A function the compiler skipped. */
interface Skip {
  /** The file, as a path below `src/renderer`. */
  readonly file: string;
  /** The line where the function starts. */
  readonly line: number;
  /** The compiler's message. */
  readonly message: string;
}

/** A skip that is accepted, and why. */
interface AllowedSkip {
  readonly file: string;
  /** Text the compiler's message must contain for this entry to allow a skip. */
  readonly message: string;
  readonly reason: string;
}

/** Why the compiler skips a function that calls `useVirtualizer` from TanStack Virtual. */
const VIRTUALIZER =
  "useVirtualizer returns functions that change without the hook's result changing, so the compiler refuses to cache them. The hook's caller redraws as before.";

/** Why the compiler skips a function that disables `react-hooks/exhaustive-deps` on purpose. */
const DISABLED_DEPS_RULE =
  "The function disables react-hooks/exhaustive-deps on purpose, and the compiler skips any function that disables a React lint rule. Removing the comment changes what the effect or memo depends on.";

const ALLOWED_SKIPS: readonly AllowedSkip[] = [
  ...[
    "routes/_connected/_shell/workflows/-runs.tsx",
    "screens/session/message-list.ts",
    "screens/session/skill-list.tsx",
    "screens/use-virtual-lines.ts",
    "screens/virtual-list.tsx",
  ].map((file) => ({ file, message: "Use of incompatible library", reason: VIRTUALIZER })),
  ...[
    "screens/assistant/conversation.tsx",
    "screens/session/messages.tsx",
    "shell/use-thread-hover.ts",
  ].map((file) => ({
    file,
    message: "React ESLint rules were disabled",
    reason: DISABLED_DEPS_RULE,
  })),
];

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
 * Compiles the source of `file` and returns the functions the compiler
 * skipped, once each. A function that opts out with `"use no memo"` is not
 * returned.
 */
function listSkippedFunctions(file: string, source: string): Skip[] {
  const skipped = new Map<string, Skip>();
  const noteSkip = (event: LoggerEvent, message: string): void => {
    const line = "fnLoc" in event ? (event.fnLoc?.start.line ?? 0) : 0;
    skipped.set(`${line}: ${message}`, { file: relative(rendererSource, file), line, message });
  };
  const logger = {
    logEvent(_filename: string | null, event: LoggerEvent) {
      if (event.kind === "CompileError") noteSkip(event, event.detail.reason);
      // The compiler reports an opt-out directive as a skip too.
      else if (event.kind === "CompileSkip" && !event.reason.includes("directive"))
        noteSkip(event, event.reason);
      else if (event.kind === "PipelineError") noteSkip(event, event.data);
    },
  };
  transformSync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"] },
    plugins: [[compilerPlugin, { logger }]],
  });
  return [...skipped.values()];
}

/** Checks whether an entry of `ALLOWED_SKIPS` allows `skip`. */
function isAllowed(skip: Skip, allowed: AllowedSkip): boolean {
  return skip.file === allowed.file && skip.message.includes(allowed.message);
}

describe("the React Compiler over the renderer", () => {
  const skips = listSourceFiles(rendererSource).flatMap((file) =>
    listSkippedFunctions(file, readFileSync(file, "utf8")),
  );

  it("skips no function that is not in the allowed list", () => {
    const unexpected = skips
      .filter((skip) => !ALLOWED_SKIPS.some((allowed) => isAllowed(skip, allowed)))
      .map((skip) => `${skip.file}:${skip.line}: ${skip.message}`);
    expect(
      unexpected,
      "The React Compiler skipped these functions, so they run without its memoization. Fix the cause the message names (a default in a destructuring moves into the body), or add the skip to ALLOWED_SKIPS with a reason.",
    ).toEqual([]);
  });

  it("allows only skips the compiler still makes", () => {
    const stale = ALLOWED_SKIPS.filter(
      (allowed) => !skips.some((skip) => isAllowed(skip, allowed)),
    );
    expect(
      stale.map((allowed) => `${allowed.file}: ${allowed.message}`),
      "The compiler no longer makes these skips. Remove their entries from ALLOWED_SKIPS.",
    ).toEqual([]);
  });

  it("reports a default in a destructuring, and not a function that opts out", () => {
    const source = `
      export function Chip({ size = 16 }: { size?: number }) { return <i>{size}</i>; }
      export function Optout({ size }: { size: number }) { "use no memo"; return <i>{size}</i>; }
    `;
    const found = listSkippedFunctions(join(rendererSource, "example.tsx"), source);
    expect(found.map((skip) => skip.line)).toEqual([2]);
    expect(found[0]?.message).toContain("AssignmentPattern");
  });
});
