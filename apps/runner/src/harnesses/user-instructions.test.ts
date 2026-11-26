import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Logger } from "effect";
import { cleanupHomes, createScratchHome } from "./testing";
import { readUserInstructions } from "./user-instructions";

afterAll(cleanupHomes);

/** Runs `readUserInstructions` and returns its result with every warning it logged. */
const readCapturingWarnings = (paths: ReadonlyArray<string>) => {
  const warnings: Array<string> = [];
  const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  const text = Effect.runSync(
    Effect.provide(readUserInstructions(paths), Logger.layer([collecting])),
  );
  return { text, warnings };
};

describe("readUserInstructions", () => {
  const scratch = createScratchHome("instructions");
  const writeFile = (name: string, text: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, text);
    return path;
  };

  it("returns the text of each file in the given order, joined by a blank line", () => {
    const first = writeFile("first.md", "Always answer in English.");
    const second = writeFile("second.md", "Keep commits small.\n");

    expect(readCapturingWarnings([second, first])).toEqual({
      text: "Keep commits small.\n\n\nAlways answer in English.",
      warnings: [],
    });
  });

  it("returns undefined when there are no files", () => {
    expect(readCapturingWarnings([])).toEqual({ text: undefined, warnings: [] });
  });

  it("leaves out a file with only white space", () => {
    const blank = writeFile("blank.md", "  \n");
    const real = writeFile("real.md", "Be terse.");

    expect(readCapturingWarnings([blank, real]).text).toBe("Be terse.");
    expect(readCapturingWarnings([blank]).text).toBeUndefined();
  });

  it.each([
    ["a file that does not exist", () => join(scratch, "missing.md"), "ENOENT"],
    [
      "a directory",
      () => {
        const path = join(scratch, "a-folder");
        mkdirSync(path);
        return path;
      },
      "it is not a regular file",
    ],
  ])(
    "skips %s, logs a warning with the path and the reason, and still reads the others",
    (_, makePath, reason) => {
      const path = makePath();
      const good = writeFile("good.md", "Be terse.");

      const { text, warnings } = readCapturingWarnings([path, good]);

      expect(text).toBe("Be terse.");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Did not read ${path} into the Thread's instructions: `);
      expect(warnings[0]).toContain(reason);
    },
  );

  it("returns undefined when no file could be read", () => {
    const path = join(scratch, "gone.md");

    const { text, warnings } = readCapturingWarnings([path]);

    expect(text).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
